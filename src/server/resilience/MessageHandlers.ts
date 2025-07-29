import type { Page } from 'puppeteer';
import type { WebSocket } from 'ws';
import { OperationManager } from './OperationManager';

export class ResilientMessageHandlers {
  static async handleNavigate(
    page: Page,
    ws: WebSocket,
    url: string
  ): Promise<void> {
    console.log('Navigation requested to:', url);
    
    await OperationManager.withRetry(async () => {
      try {
        const targetUrl = url.startsWith('http') ? url : `https://${url}`;
        console.log('Navigating to full URL:', targetUrl);
        
        // Try multiple navigation strategies
        try {
          await OperationManager.withTimeout(
            page.goto(targetUrl, {
              waitUntil: 'networkidle0',
              timeout: 30000
            }),
            35000,
            `Navigation to ${targetUrl} timed out`
          );
        } catch (firstError) {
          console.log('Trying alternative navigation strategy...');
          await OperationManager.withTimeout(
            page.goto(targetUrl, {
              waitUntil: 'domcontentloaded',
              timeout: 30000
            }),
            35000,
            `Alternative navigation to ${targetUrl} timed out`
          );
        }
        
        ws.send(JSON.stringify({
          type: 'navigation',
          status: 'success',
          url: targetUrl
        }));
      } catch (error) {
        const err = error as Error;
        console.error('Navigation error:', err.message);
        ws.send(JSON.stringify({
          type: 'navigation',
          status: 'error',
          error: err.message
        }));
        throw error; // Re-throw for retry mechanism
      }
    }, { retries: 2, backoff: 1000, timeout: 40000 });
  }

  static async handleClick(
    page: Page,
    ws: WebSocket,
    x: number,
    y: number
  ): Promise<void> {
    await OperationManager.safe(
      async () => {
        await OperationManager.withTimeout(
          page.mouse.click(x, y),
          5000,
          'Click operation timed out'
        );
        ws.send(JSON.stringify({
          type: 'click',
          status: 'success',
          x,
          y
        }));
      },
      undefined,
      (error) => {
        console.error('Click error:', error);
        ws.send(JSON.stringify({
          type: 'click',
          status: 'error',
          error: error.message
        }));
      }
    );
  }

  static async handleScroll(
    page: Page,
    ws: WebSocket,
    deltaY: number
  ): Promise<void> {
    await OperationManager.safe(
      async () => {
        await OperationManager.withTimeout(
          page.mouse.wheel({ deltaY }),
          5000,
          'Scroll operation timed out'
        );
        ws.send(JSON.stringify({
          type: 'scroll',
          status: 'success',
          deltaY
        }));
      },
      undefined,
      (error) => {
        console.error('Scroll error:', error);
        ws.send(JSON.stringify({
          type: 'scroll',
          status: 'error',
          error: error.message
        }));
      }
    );
  }

  static async handleType(
    page: Page,
    ws: WebSocket,
    text: string
  ): Promise<void> {
    await OperationManager.safe(
      async () => {
        await OperationManager.withTimeout(
          page.keyboard.type(text),
          10000,
          'Type operation timed out'
        );
        ws.send(JSON.stringify({
          type: 'type',
          status: 'success',
          text: text.substring(0, 20) + '...' // Don't echo full text for security
        }));
      },
      undefined,
      (error) => {
        console.error('Type error:', error);
        ws.send(JSON.stringify({
          type: 'type',
          status: 'error',
          error: error.message
        }));
      }
    );
  }

  static async handleEvaluate(
    page: Page,
    ws: WebSocket,
    code: string
  ): Promise<void> {
    await OperationManager.safe(
      async () => {
        const result = await OperationManager.withTimeout(
          page.evaluate((code) => {
            try {
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
          }, code),
          15000,
          'Evaluate operation timed out'
        );
        
        ws.send(JSON.stringify({
          type: 'evaluate',
          status: result.success ? 'success' : 'error',
          result: result.success ? result.result : undefined,
          error: result.success ? undefined : result.error
        }));
      },
      undefined,
      (error) => {
        console.error('Evaluation error:', error);
        ws.send(JSON.stringify({
          type: 'evaluate',
          status: 'error',
          error: error.message
        }));
      }
    );
  }

  static async handleScreenshotAndHtml(
    page: Page,
    ws: WebSocket
  ): Promise<void> {
    console.log('Screenshot and HTML requested');
    
    await OperationManager.safe(
      async () => {
        // Take screenshot
        const screenshot = await OperationManager.withTimeout(
          page.screenshot({ 
            encoding: 'base64',
            type: 'jpeg',
            quality: 90,
            fullPage: true // Full page screenshot
          }),
          10000,
          'Screenshot operation timed out'
        );
        
        // Get complete HTML
        let html = await OperationManager.withTimeout(
          page.content(),
          10000,
          'HTML extraction timed out'
        );
        
        // Remove all SVG elements from HTML
        html = html.replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, '');
        
        console.log(`Screenshot size: ${screenshot.length}, HTML size: ${html.length}`);
        
        ws.send(JSON.stringify({
          type: 'screenshot_and_html_response',
          screenshot,
          html
        }));
      },
      undefined,
      (error) => {
        console.error('Screenshot/HTML error:', error);
        ws.send(JSON.stringify({
          type: 'screenshot_and_html_response',
          status: 'error',
          error: error.message
        }));
      }
    );
  }

  static sendError(ws: WebSocket, type: string, error: string): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({
        type,
        status: 'error',
        error
      }));
    }
  }

  static sendHeartbeat(ws: WebSocket): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({
        type: 'heartbeat',
        timestamp: Date.now()
      }));
    }
  }
}