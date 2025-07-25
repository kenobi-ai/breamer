import puppeteer from 'puppeteer';
import type { Browser, Page, CDPSession } from 'puppeteer';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import type { IncomingMessage, ServerResponse } from 'http';

const port = parseInt(process.env.PORT || '8080', 10);
const host = '0.0.0.0';

// Get directory path for ES modules
const __dirname = fileURLToPath(new URL('.', import.meta.url));

// Create HTTP server
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = req.url || '/';
  
  // Serve static files from dist directory
  if (url === '/') {
    try {
      const html = readFileSync(join(__dirname, 'index.html'), 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } catch (err) {
      console.error('Error serving index.html:', err);
      res.writeHead(404);
      res.end('Not found');
    }
  } else if (url.startsWith('/assets/')) {
    try {
      const filePath = join(__dirname, url);
      const ext = url.split('.').pop();
      const contentType = ext === 'js' ? 'application/javascript' : 'text/css';
      const content = readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    } catch (err) {
      console.error('Error serving asset:', url, err);
      res.writeHead(404);
      res.end('Not found');
    }
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

// Create WebSocket server using the HTTP server
const wss = new WebSocketServer({ server });
const browsers = new Map<string, Browser>();
const pages = new Map<string, Page>();
const cdpSessions = new Map<string, CDPSession>();

wss.on('connection', async (ws, req: IncomingMessage) => {
  const clientId = req.headers['sec-websocket-key'] || '';
  console.log(`Client connected: ${clientId}`);

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
        '--disable-site-isolation-trials'
      ]
    });

    browsers.set(clientId, browser);
    const page = await browser.newPage();
    pages.set(clientId, page);

  await page.setViewport({ width: 1280, height: 720 });

  const client = await page.createCDPSession();
  cdpSessions.set(clientId, client);

  await client.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 80,
    maxWidth: 1280,
    maxHeight: 720,
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
          const targetUrl = message.url.startsWith('http') 
            ? message.url 
            : `https://${message.url}`;
          
          await pages.get(clientId)!.goto(targetUrl, {
            waitUntil: 'domcontentloaded'
          });
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

    await page.goto('https://example.com');
  } catch (error) {
    console.error('Failed to launch browser:', error);
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Failed to launch browser. Please try again.'
    }));
    ws.close();
  }
});

// Start the HTTP server
server.listen(port, host, () => {
  console.log(`Breamer server running on http://${host}:${port}`);
  console.log(`WebSocket endpoint: ws://${host}:${port}`);
});