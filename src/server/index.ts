import puppeteer from 'puppeteer';
import type { Browser, Page, CDPSession } from 'puppeteer';
import { WebSocketServer } from 'ws';
import type { IncomingMessage } from 'http';

const wss = new WebSocketServer({ port: 8080 });
const browsers = new Map<string, Browser>();
const pages = new Map<string, Page>();
const cdpSessions = new Map<string, CDPSession>();

wss.on('connection', async (ws, req: IncomingMessage) => {
  const clientId = req.headers['sec-websocket-key'] || '';
  console.log(`Client connected: ${clientId}`);

  const browser = await puppeteer.launch({
    headless: true,
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
});

console.log('Breamer server running on ws://localhost:8080');