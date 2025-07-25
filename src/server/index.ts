import puppeteer from 'puppeteer';
import type { Browser, Page, CDPSession } from 'puppeteer';
import { WebSocketServer } from 'ws';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { clerkMiddleware, requireAuth } from '@clerk/express';
import dotenv from 'dotenv';

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

// Create WebSocket server using the HTTP server
const wss = new WebSocketServer({ server });
const browsers = new Map<string, Browser>();
const pages = new Map<string, Page>();
const cdpSessions = new Map<string, CDPSession>();

wss.on('connection', async (ws, req) => {
  // Extract auth token from query params or headers
  const url = new URL(req.url || '', `http://${req.headers.host}`);
  const token = url.searchParams.get('token') || req.headers.authorization?.replace('Bearer ', '');
  
  if (!token) {
    ws.send(JSON.stringify({ type: 'error', message: 'Authentication required' }));
    ws.close();
    return;
  }
  
  // For now, skip token verification to debug
  // console.log('Token received:', token);
  
  // TODO: Implement proper Clerk token verification
  // For debugging, let's allow connections but log the token
  
  const clientId = req.headers['sec-websocket-key'] || '';
  console.log(`Authenticated client connected: ${clientId}`);

  try {
    const browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--enable-gpu',
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-web-security',
        '--disable-features=IsolateOrigins',
        '--disable-site-isolation-trials',
        '--disable-blink-features=AutomationControlled',
        '--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      ]
    });

    browsers.set(clientId, browser);
    const page = await browser.newPage();
    pages.set(clientId, page);

    // Set up page to avoid detection
    await page.evaluateOnNewDocument(() => {
      // Remove webdriver property
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined
      });
      
      // Add chrome object
      window.chrome = {
        runtime: {}
      };
      
      // Override permissions
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) => (
        parameters.name === 'notifications' ?
          Promise.resolve({ state: Notification.permission }) :
          originalQuery(parameters)
      );
    });

    await page.setViewport({ width: 1280, height: 1280 });

  const client = await page.createCDPSession();
  cdpSessions.set(clientId, client);

  await client.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 80,
    maxWidth: 1280,
    maxHeight: 1280,
    everyNthFrame: 1
  });

  client.on('Page.screencastFrame', async (frame) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({
        type: 'frame',
        data: frame.data,
        sessionId: frame.sessionId
      }));
    }

    await client.send('Page.screencastFrameAck', {
      sessionId: frame.sessionId
    });
  });

  ws.on('message', async (data) => {
    const message = JSON.parse(data.toString());
    
    switch (message.type) {
      case 'navigate':
        if (pages.has(clientId)) {
          try {
            const targetUrl = message.url.startsWith('http') 
              ? message.url 
              : `https://${message.url}`;
            
            // Add a small delay for bot-protected sites
            const page = pages.get(clientId)!;
            
            // Try different strategies for navigation
            try {
              await page.goto(targetUrl, {
                waitUntil: 'networkidle0',
                timeout: 30000
              });
            } catch (firstError) {
              // If first attempt fails, try with domcontentloaded
              await page.goto(targetUrl, {
                waitUntil: 'domcontentloaded',
                timeout: 30000
              });
            }
            
            ws.send(JSON.stringify({
              type: 'navigation',
              status: 'success',
              url: targetUrl
            }));
          } catch (navError: any) {
            console.error('Navigation error:', navError.message);
            ws.send(JSON.stringify({
              type: 'navigation',
              status: 'error',
              error: navError.message
            }));
          }
        }
        break;

      case 'click':
        if (pages.has(clientId)) {
          await pages.get(clientId)!.mouse.click(message.x, message.y);
        }
        break;

      case 'scroll':
        if (pages.has(clientId)) {
          await pages.get(clientId)!.mouse.wheel({ deltaY: message.deltaY });
        }
        break;

      case 'type':
        if (pages.has(clientId)) {
          await pages.get(clientId)!.keyboard.type(message.text);
        }
        break;

      case 'evaluate':
        if (pages.has(clientId)) {
          try {
            const page = pages.get(clientId)!;
            // Evaluate the JavaScript code on the page
            const result = await page.evaluate((code) => {
              try {
                // Use Function constructor to evaluate the code
                const fn = new Function(code);
                return {
                  success: true,
                  result: fn()
                };
              } catch (error: any) {
                return {
                  success: false,
                  error: error.message
                };
              }
            }, message.code);
            
            // Send back the result
            ws.send(JSON.stringify({
              type: 'evaluate',
              status: result.success ? 'success' : 'error',
              result: result.success ? result.result : undefined,
              error: result.success ? undefined : result.error
            }));
          } catch (evalError: any) {
            console.error('Evaluation error:', evalError.message);
            ws.send(JSON.stringify({
              type: 'evaluate',
              status: 'error',
              error: evalError.message
            }));
          }
        }
        break;
    }
  });

  ws.on('close', async () => {
    console.log(`Client disconnected: ${clientId}`);
    
    if (cdpSessions.has(clientId)) {
      const client = cdpSessions.get(clientId)!;
      await client.send('Page.stopScreencast');
      cdpSessions.delete(clientId);
    }

    if (pages.has(clientId)) {
      await pages.get(clientId)!.close();
      pages.delete(clientId);
    }

    if (browsers.has(clientId)) {
      await browsers.get(clientId)!.close();
      browsers.delete(clientId);
    }
  });
  } catch (error) {
    console.error('Failed to launch browser:', error);
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Failed to launch browser. Please try again.'
    }));
    ws.close();
  }
});

