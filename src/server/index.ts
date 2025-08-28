import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { ResilientBrowserManager } from './resilience/BrowserManager.js';
import { ResilientMessageHandlers } from './resilience/MessageHandlers.js';
import { MemoryManager } from './resilience/MemoryManager.js';

console.log("Env slice::", JSON.stringify({
  PORT: process.env.PORT ?? 'not set',
}, null, 2));

const app = express();
app.use(express.json()); // Add JSON body parser
const httpServer = createServer(app);

// Configure Socket.io with CORS
const io = new Server(httpServer, {
  path: '/socket.io/',
  cors: {
    origin: '*', // Allow all origins for debugging
    methods: ['GET', 'POST', 'OPTIONS'],
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization']
  },
  // Increased timeouts for long-lived connections
  pingInterval: 60000,  // 60 seconds
  pingTimeout: 300000,  // 5 minutes
  // For Cloud Run, start with polling then upgrade to WebSocket
  transports: ['polling', 'websocket'],
  // Allow transport upgrades
  allowUpgrades: true,
  // Disable perMessageDeflate for better compatibility
  perMessageDeflate: false,
  // Disable connection state recovery to avoid session ID issues
  connectionStateRecovery: {
    maxDisconnectionDuration: 0, // Disable recovery
    skipMiddlewares: true
  },
  // Allow unlimited connections
  maxHttpBufferSize: 1e8, // 100 MB
  allowEIO3: true, // Allow older clients
  // Cloud Run specific: handle HTTP/2
  httpCompression: false
});

// Simple health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'breamer', socketio: 'enabled' });
});


// Initialize memory manager
const memoryManager = MemoryManager.getInstance();

// Initialize browser manager with long-lived connection settings
const browserManager = new ResilientBrowserManager({
  healthCheckInterval: 60000,  // 60 seconds
  sessionTimeout: 1800000,     // 30 minutes
  maxHealthCheckFailures: 5    // More tolerance for failures
});

// Make browserManager globally available for memory manager
(global as any).browserManager = browserManager;

// Debug Socket.io - only log non-session errors
io.engine.on('connection_error', (err: any) => {
  // Skip logging "Session ID unknown" errors as they're expected when clients reconnect
  if (err.message === 'Session ID unknown') {
    return;
  }
  console.log('[Socket.io] Connection error from:', err.req?.url || 'unknown');
  console.log('[Socket.io] Error type:', err.type);
  console.log('[Socket.io] Error message:', err.message);
  console.log('[Socket.io] Error code:', err.code);
  console.log('[Socket.io] Request headers:', err.req?.headers?.['user-agent']);
});

// Additional debugging
io.engine.on('initial_headers', (headers: any, req: any) => {
  console.log('[Socket.io] Initial headers from:', req.url);
});

io.engine.on('headers', (headers: any, req: any) => {
  headers['Access-Control-Allow-Private-Network'] = true;
});

// Socket.io connection handling
io.on('connection', (socket) => {
  const clientId = socket.id;
  console.log(`[Socket.io] Client connected: ${clientId} (Active: ${io.engine.clientsCount})`);
  console.log(`[Sessions] Current browser sessions: ${Array.from(browserManager.getSessions().keys()).join(', ')}`);
  
  // Send immediate acknowledgment
  socket.emit('connected', { clientId });

  // Initialize browser session asynchronously
  setTimeout(async () => {
    try {
      // Check if session already exists (in case of quick reconnects)
      const existingSession = await browserManager.getSession(clientId);
      if (existingSession) {
        console.log(`[Socket.io] Reusing existing browser session for ${clientId}`);
        socket.emit('session_ready', { message: 'Browser session is ready' });
        return;
      }

      console.log(`[Socket.io] Creating browser session for ${clientId}...`);
      const session = await browserManager.createSession(clientId);
      if (!session) {
        socket.emit('error', { message: 'Failed to create browser session' });
        return;
      }

      console.log(`[Socket.io] Browser session created for ${clientId}`);
      
      // Initialize screencast BEFORE setting up handlers (default to 1440x1880 viewport)
      await browserManager.initializeScreencast(session.cdpSession, 1440, 1880);
      
      socket.emit('session_ready', { message: 'Browser session is ready' });

      // Set up screencast frame handler with memory management
      session.cdpSession.on('Page.screencastFrame', async (frame: any) => {
        try {
          // Check memory before processing frame
          const stats = memoryManager.getMemoryStats();
          if (stats.heapUsedPercent > 90) {
            console.warn('[Screencast] Skipping frame due to high memory usage');
            // Still acknowledge but don't send
            await session.cdpSession.send('Page.screencastFrameAck', {
              sessionId: Number(frame.sessionId)
            }).catch(() => {});
            return;
          }
          
          // Send frame to client
          socket.emit('frame', {
            data: frame.data,
            sessionId: String(frame.sessionId)
          });

          // Acknowledge frame immediately to prevent buffering
          setImmediate(async () => {
            await session.cdpSession.send('Page.screencastFrameAck', {
              sessionId: Number(frame.sessionId)
            }).catch((error) => {
              console.error('Frame ack error:', error);
            });
          });
        } catch (error) {
          console.error('Error in screencast frame handler:', error);
        }
      });

    } catch (error) {
      console.error(`Failed to initialize session for ${clientId}:`, error);
      socket.emit('error', { message: 'Failed to initialize browser session' });
    }
  }, 100); // Small delay to ensure connection is established

  // Message handlers
  socket.on('navigate', async (data) => {
    try {
      const session = await browserManager.getSession(clientId);
      if (!session) {
        socket.emit('error', { type: 'navigate', message: 'Session not available' });
        return;
      }
      await ResilientMessageHandlers.handleNavigate(session.page, socket, data.url);
    } catch (error) {
      console.error('Unhandled navigate error:', error);
      socket.emit('error', { type: 'navigate', message: 'Internal server error', recoverable: true });
    }
  });

  socket.on('click', async (data) => {
    try {
      const session = await browserManager.getSession(clientId);
      if (!session) {
        socket.emit('error', { type: 'click', message: 'Session not available' });
        return;
      }
      await ResilientMessageHandlers.handleClick(session.page, socket, data.x, data.y);
    } catch (error) {
      console.error('Unhandled click error:', error);
      socket.emit('error', { type: 'click', message: 'Internal server error', recoverable: true });
    }
  });

  socket.on('scroll', async (data) => {
    try {
      const session = await browserManager.getSession(clientId);
      if (!session) {
        socket.emit('error', { type: 'scroll', message: 'Session not available' });
        return;
      }
      await ResilientMessageHandlers.handleScroll(session.page, socket, data.deltaY);
    } catch (error) {
      console.error('Unhandled scroll error:', error);
      socket.emit('error', { type: 'scroll', message: 'Internal server error', recoverable: true });
    }
  });

  socket.on('hover', async (data) => {
    try {
      const session = await browserManager.getSession(clientId);
      if (!session) {
        socket.emit('error', { type: 'hover', message: 'Session not available' });
        return;
      }
      await ResilientMessageHandlers.handleHover(session.page, socket, data.x, data.y);
    } catch (error) {
      console.error('Unhandled hover error:', error);
      socket.emit('error', { type: 'hover', message: 'Internal server error', recoverable: true });
    }
  });

  socket.on('type', async (data) => {
    try {
      const session = await browserManager.getSession(clientId);
      if (!session) {
        socket.emit('error', { type: 'type', message: 'Session not available' });
        return;
      }
      await ResilientMessageHandlers.handleType(session.page, socket, data.text);
    } catch (error) {
      console.error('Unhandled type error:', error);
      socket.emit('error', { type: 'type', message: 'Internal server error', recoverable: true });
    }
  });

  socket.on('evaluate', async (data) => {
    try {
      const session = await browserManager.getSession(clientId);
      if (!session) {
        socket.emit('error', { type: 'evaluate', message: 'Session not available' });
        return;
      }
      await ResilientMessageHandlers.handleEvaluate(session.page, socket, data.code);
    } catch (error) {
      console.error('Unhandled evaluate error:', error);
      socket.emit('error', { type: 'evaluate', message: 'Internal server error', recoverable: true });
    }
  });

  socket.on('request_screenshot_and_html', async () => {
    try {
      const session = await browserManager.getSession(clientId);
      if (!session) {
        socket.emit('error', { type: 'screenshot', message: 'Session not available' });
        return;
      }
      await ResilientMessageHandlers.handleScreenshotAndHtml(session.page, socket);
    } catch (error) {
      console.error('Unhandled screenshot error:', error);
      socket.emit('error', { type: 'screenshot', message: 'Internal server error', recoverable: true });
    }
  });

  socket.on('set_viewport', async (data) => {
    try {
      const session = await browserManager.getSession(clientId);
      if (!session) {
        socket.emit('error', { type: 'set_viewport', message: 'Session not available' });
        return;
      }
      console.log(`[Viewport] Setting viewport for ${clientId} to ${data.width}x${data.height}`);
      await browserManager.updateViewport(clientId, data.width, data.height);
      socket.emit('viewport_updated', { width: data.width, height: data.height });
    } catch (error) {
      console.error('Unhandled set_viewport error:', error);
      socket.emit('error', { type: 'set_viewport', message: 'Internal server error', recoverable: true });
    }
  });

  // Handle disconnection
  socket.on('disconnect', async (reason) => {
    console.log(`[Socket.io] Client disconnected: ${clientId}, reason: ${reason} (Active: ${io.engine.clientsCount - 1})`);
    console.log(`[Sessions] Cleaning up browser session for ${clientId}`);
    
    // Clear frame buffers for this client
    memoryManager.clearClientFrames(clientId);
    
    await browserManager.cleanupSession(clientId);
    console.log(`[Sessions] Remaining browser sessions: ${Array.from(browserManager.getSessions().keys()).join(', ')}`);
  });

  // Handle errors
  socket.on('error', (error) => {
    console.error(`Socket error for ${clientId}:`, error);
  });
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down gracefully...');
  await browserManager.cleanupAll();
  io.close(() => {
    console.log('Socket.io server closed');
    process.exit(0);
  });
});

// Graceful shutdown handlers
const shutdown = async (signal: string) => {
  console.log(`\n${signal} received, shutting down gracefully...`);
  
  // Stop accepting new connections
  httpServer.close();
  
  // Clean up memory manager
  memoryManager.shutdown();
  
  // Clean up all browser sessions
  await browserManager.cleanupAll();
  
  // Close socket.io
  io.close(() => {
    console.log('Socket.io server closed');
    process.exit(0);
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  // Don't exit - try to recover
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't exit - try to recover
});

// Start server
// Default to 8080 for Cloudflare Workers, 3003 for traditional deployment
const PORT = process.env.PORT ? parseInt(process.env.PORT) : (process.env.CF_PAGES ? 8080 : 3003);
const HOST = '0.0.0.0'; // Listen on all interfaces
httpServer.listen(PORT, HOST, () => {
  console.log(`🚀 Breamer server running on ${HOST}:${PORT}`);
  console.log(`🔌 Socket.io server ready at http://localhost:${PORT}`);
  console.log(`📡 Socket.io path: /socket.io/`);
  console.log(`🔧 CORS: Allowing all origins (*) for debugging`);
  console.log(`🔄 Transports: websocket, polling`);
});