import { WebSocketServer } from 'ws';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { clerkMiddleware, requireAuth } from '@clerk/express';
import dotenv from 'dotenv';
import { ResilientBrowserManager } from './resilience/BrowserManager';
import { ResilientMessageHandlers } from './resilience/MessageHandlers';
import { OperationManager } from './resilience/OperationManager';

dotenv.config();

const port = parseInt(process.env.PORT || '8080', 10);
const host = '0.0.0.0';

// Get directory path for ES modules
const __dirname = fileURLToPath(new URL('.', import.meta.url));

// Create Express app
const app = express();

// Apply Clerk middleware to all routes
app.use(clerkMiddleware());

// Serve static files from dist directory
app.use('/assets', express.static(join(__dirname, 'assets')));

// Protect main route with Clerk authentication
app.get('/', requireAuth(), (req, res) => {
  try {
    const html = readFileSync(join(__dirname, 'index.html'), 'utf-8');
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    console.error('Error serving index.html:', err);
    res.status(404).send('Not found');
  }
});

// Create HTTP server from Express app
const server = app.listen(port, host, () => {
  console.log(`Breamer server running on http://${host}:${port}`);
  console.log(`WebSocket endpoint: ws://${host}:${port}`);
});

// Create resilient browser manager
const browserManager = new ResilientBrowserManager({
  maxRetries: 3,
  healthCheckInterval: 10000,
  sessionTimeout: 300000,
  maxHealthCheckFailures: 3
});

// Circuit breaker for WebSocket connections
const wsCircuitBreaker = OperationManager.createCircuitBreaker(10, 60000);

// Create WebSocket server using the HTTP server with proper CORS
const wss = new WebSocketServer({ 
  server,
  perMessageDeflate: false, // Disable compression to reduce CPU load
  maxPayload: 10 * 1024 * 1024, // 10MB max payload
  verifyClient: (info) => {
    // Allow connections from localhost during development
    const origin = info.origin || info.req.headers.origin;
    console.log('WebSocket verify client from origin:', origin);
    
    // In production, you'd want to check against allowed origins
    // For now, allow localhost connections
    if (origin && (origin.includes('localhost') || origin.includes('127.0.0.1'))) {
      return true;
    }
    
    // Allow if no origin (e.g., direct WebSocket connections)
    return !origin;
  }
});

// Track active connections for monitoring
const activeConnections = new Set<string>();

wss.on('connection', async (ws, req) => {
  const clientId = req.headers['sec-websocket-key'] || '';
  let isAuthenticated = false;
  const frameQueue: Array<{ data: any; sessionId: string }> = [];
  let isSending = false;
  
  console.log('New WebSocket connection attempt from:', req.headers.origin);

  try {
    // Extract auth token
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const token = url.searchParams.get('token') || req.headers.authorization?.replace('Bearer ', '');
    
    console.log('Token received:', token ? 'Yes' : 'No');
    
    if (!token) {
      ResilientMessageHandlers.sendError(ws, 'auth', 'Authentication required');
      ws.close();
      return;
    }

    // TODO: Implement proper Clerk token verification
    isAuthenticated = true;
    activeConnections.add(clientId);
    console.log(`Authenticated client connected: ${clientId} (Active: ${activeConnections.size})`);

    // Create browser session with circuit breaker protection
    const session = await wsCircuitBreaker.execute(async () => {
      return await browserManager.createSession(clientId);
    });

    if (!session) {
      throw new Error('Failed to create browser session');
    }

    // Queue management functions
    const processFrameQueue = async () => {
      if (isSending || frameQueue.length === 0 || ws.readyState !== ws.OPEN) {
        return;
      }
      
      isSending = true;
      
      while (frameQueue.length > 0 && ws.readyState === ws.OPEN) {
        const frame = frameQueue.shift();
        if (!frame) break;
        
        try {
          // Check WebSocket bufferedAmount to avoid overwhelming the connection
          if (ws.bufferedAmount > 5 * 1024 * 1024) { // 5MB threshold
            console.warn(`WebSocket buffer full (${ws.bufferedAmount} bytes), pausing frame sending`);
            frameQueue.unshift(frame); // Put it back
            setTimeout(() => processFrameQueue(), 100); // Retry after 100ms
            break;
          }
          
          ws.send(JSON.stringify({
            type: 'frame',
            data: frame.data,
            sessionId: frame.sessionId
          }));
        } catch (sendError) {
          console.error('Failed to send frame:', sendError);
          // Don't put it back in queue, just skip this frame
        }
      }
      
      isSending = false;
    };

    // Start the screencast immediately
    await browserManager.initializeScreencast(session.cdpSession);

    // Set up resilient screencast frame handler
    session.cdpSession.on('Page.screencastFrame', async (frame) => {
      try {
        const frameSize = frame.data?.length || 0;
        console.log('Received frame:', frame.sessionId, 'data length:', frameSize);
        
        // Check if frame is unusually large (>100KB)
        if (frameSize > 100000) {
          console.warn(`Large frame detected: ${frameSize} bytes`);
        }
        
        // Add frame to queue instead of sending directly
        if (ws.readyState === ws.OPEN) {
          // Drop old frames if queue is too large
          if (frameQueue.length > 10) {
            console.warn('Frame queue full, dropping oldest frame');
            frameQueue.shift();
          }
          
          frameQueue.push({ data: frame.data, sessionId: frame.sessionId });
          processFrameQueue();
        } else {
          console.warn('WebSocket not open, skipping frame');
        }

        // Always acknowledge the frame to prevent backpressure
        try {
          await session.cdpSession.send('Page.screencastFrameAck', {
            sessionId: frame.sessionId
          });
        } catch (ackError) {
          console.error('Frame ack error:', ackError);
          // If we can't ack frames, the session is likely broken
          if (ackError.message?.includes('Session closed') || ackError.message?.includes('Target closed')) {
            console.error(`CDP session appears broken for client ${clientId}, marking for recovery`);
            const currentSession = await browserManager.getSession(clientId);
            if (currentSession) {
              currentSession.isHealthy = false;
            }
          }
        }
      } catch (error) {
        console.error('Fatal error in screencast frame handler:', error);
      }
    });

    // Set up WebSocket error handling
    ws.on('error', (error) => {
      console.error(`WebSocket error for ${clientId}:`, error);
    });

    // Monitor WebSocket buffer status
    const bufferMonitorInterval = setInterval(() => {
      if (ws.readyState === ws.OPEN && ws.bufferedAmount > 0) {
        console.log(`WebSocket buffer for ${clientId}: ${ws.bufferedAmount} bytes, queue: ${frameQueue.length} frames`);
      }
    }, 5000);

    // Set up ping/pong for connection health
    const pingInterval = setInterval(() => {
      if (ws.readyState === ws.OPEN) {
        // Skip ping if buffer is too full
        if (ws.bufferedAmount > 1024 * 1024) {
          console.warn(`Skipping ping for ${clientId} due to full buffer (${ws.bufferedAmount} bytes)`);
          return;
        }
        ws.ping();
      }
    }, 30000);

    let pongReceived = true;
    ws.on('pong', () => {
      pongReceived = true;
    });

    // Check for dead connections
    const connectionHealthInterval = setInterval(() => {
      if (!pongReceived) {
        console.log(`Client ${clientId} failed to respond to ping, closing connection`);
        ws.terminate();
      }
      pongReceived = false;
    }, 45000); // Increased from 35s to 45s for 15s grace period

    // Handle incoming messages with resilience
    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());
        const currentSession = await browserManager.getSession(clientId);
        
        if (!currentSession) {
          ResilientMessageHandlers.sendError(ws, message.type, 'Session not available');
          return;
        }

        switch (message.type) {
          case 'navigate':
            console.log(`Client ${clientId} requested navigation to:`, message.url);
            await ResilientMessageHandlers.handleNavigate(
              currentSession.page,
              ws,
              message.url
            );
            break;

          case 'click':
            await ResilientMessageHandlers.handleClick(
              currentSession.page,
              ws,
              message.x,
              message.y
            );
            break;

          case 'scroll':
            await ResilientMessageHandlers.handleScroll(
              currentSession.page,
              ws,
              message.deltaY
            );
            break;

          case 'type':
            await ResilientMessageHandlers.handleType(
              currentSession.page,
              ws,
              message.text
            );
            break;

          case 'evaluate':
            await ResilientMessageHandlers.handleEvaluate(
              currentSession.page,
              ws,
              message.code
            );
            break;

          case 'heartbeat':
            ResilientMessageHandlers.sendHeartbeat(ws);
            break;

          case 'request_screenshot_and_html':
            await ResilientMessageHandlers.handleScreenshotAndHtml(
              currentSession.page,
              ws
            );
            break;

          default:
            ResilientMessageHandlers.sendError(ws, message.type, `Unknown message type: ${message.type}`);
        }
      } catch (error) {
        console.error(`Message handling error for ${clientId}:`, error);
        ResilientMessageHandlers.sendError(ws, 'message', 'Failed to process message');
      }
    });

    // Clean up on disconnect
    ws.on('close', async () => {
      console.log(`Client disconnected: ${clientId} (Active: ${activeConnections.size - 1})`);
      console.log(`Final buffer state: ${ws.bufferedAmount} bytes, queue: ${frameQueue.length} frames`);
      
      clearInterval(pingInterval);
      clearInterval(connectionHealthInterval);
      clearInterval(bufferMonitorInterval);
      activeConnections.delete(clientId);
      
      await OperationManager.safe(
        async () => {
          await browserManager.cleanupSession(clientId);
        },
        undefined,
        (error) => console.error(`Cleanup error for ${clientId}:`, error)
      );
    });

  } catch (error) {
    console.error('Connection setup failed:', error);
    ResilientMessageHandlers.sendError(ws, 'connection', 'Failed to establish connection');
    
    if (isAuthenticated) {
      activeConnections.delete(clientId);
    }
    
    ws.close();
  }
});

// Graceful shutdown handler
const gracefulShutdown = async (signal: string) => {
  console.log(`\nReceived ${signal}, starting graceful shutdown...`);
  
  // Stop accepting new connections
  server.close(() => {
    console.log('HTTP server closed');
  });

  // Close all WebSocket connections
  wss.clients.forEach((ws) => {
    ws.close();
  });

  // Clean up all browser sessions
  await browserManager.cleanupAll();
  
  console.log('Graceful shutdown complete');
  process.exit(0);
};

// Handle shutdown signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  // Don't exit - try to recover
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at:', promise, 'reason:', reason);
  // Don't exit - try to recover
});

// Health check endpoint
app.get('/health', (req, res) => {
  const health = {
    status: 'ok',
    uptime: process.uptime(),
    activeConnections: activeConnections.size,
    circuitBreaker: wsCircuitBreaker.getState(),
    timestamp: Date.now()
  };
  res.json(health);
});

console.log('Cockroach mode activated 🪳');