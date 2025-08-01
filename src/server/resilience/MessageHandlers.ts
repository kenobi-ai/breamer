import type { Page } from 'puppeteer';
import type { Socket } from 'socket.io';
import { OperationManager } from './OperationManager.js';

export class ResilientMessageHandlers {
  static async handleNavigate(
    page: Page,
    socket: Socket,
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
        
        socket.emit('navigation', {
          status: 'success',
          url: targetUrl
        });
      } catch (error) {
        const err = error as Error;
        console.error('Navigation error:', err.message);
        socket.emit('navigation', {
          status: 'error',
          error: err.message
        });
        throw error;
      }
    });
  }

  static async handleClick(
    page: Page,
    socket: Socket,
    x: number,
    y: number
  ): Promise<void> {
    await OperationManager.withRetry(async () => {
      try {
        await page.mouse.click(x, y);
        socket.emit('click', {
          status: 'success',
          x,
          y
        });
      } catch (error) {
        const err = error as Error;
        console.error('Click error:', err.message);
        socket.emit('click', {
          status: 'error',
          error: err.message
        });
        throw error;
      }
    });
  }

  static async handleScroll(
    page: Page,
    socket: Socket,
    deltaY: number
  ): Promise<void> {
    await OperationManager.withRetry(async () => {
      try {
        await page.evaluate((scrollAmount) => {
          window.scrollBy(0, scrollAmount);
        }, deltaY);
        
        socket.emit('scroll', {
          status: 'success',
          deltaY
        });
      } catch (error) {
        const err = error as Error;
        console.error('Scroll error:', err.message);
        socket.emit('scroll', {
          status: 'error',
          error: err.message
        });
        throw error;
      }
    });
  }

  static async handleHover(
    page: Page,
    socket: Socket,
    x: number,
    y: number
  ): Promise<void> {
    await OperationManager.withRetry(async () => {
      try {
        await page.mouse.move(x, y);
        socket.emit('hover', {
          status: 'success',
          x,
          y
        });
      } catch (error) {
        const err = error as Error;
        console.error('Hover error:', err.message);
        socket.emit('hover', {
          status: 'error',
          error: err.message
        });
        throw error;
      }
    }, { retries: 1 }); // Single attempt for hover to avoid jerkiness
  }

  static async handleType(
    page: Page,
    socket: Socket,
    text: string
  ): Promise<void> {
    await OperationManager.withRetry(async () => {
      try {
        await page.keyboard.type(text, { delay: 50 });
        socket.emit('type', {
          status: 'success',
          text
        });
      } catch (error) {
        const err = error as Error;
        console.error('Type error:', err.message);
        socket.emit('type', {
          status: 'error',
          error: err.message
        });
        throw error;
      }
    });
  }

  static async handleEvaluate(
    page: Page,
    socket: Socket,
    code: string
  ): Promise<void> {
    await OperationManager.withRetry(async () => {
      try {
        const result = await page.evaluate((codeToEval) => {
          try {
            // eslint-disable-next-line no-eval
            const evalResult = eval(codeToEval);
            return {
              success: true,
              result: JSON.stringify(evalResult, null, 2)
            };
          } catch (error) {
            return {
              success: false,
              error: (error as Error).message
            };
          }
        }, code);
        
        socket.emit('evaluate', result);
      } catch (error) {
        const err = error as Error;
        console.error('Evaluate error:', err.message);
        socket.emit('evaluate', {
          success: false,
          error: err.message
        });
        throw error;
      }
    });
  }

  static async handleScreenshotAndHtml(
    page: Page,
    socket: Socket
  ): Promise<void> {
    await OperationManager.withRetry(async () => {
      try {
        const [screenshot, html] = await Promise.all([
          page.screenshot({ 
            encoding: 'base64',
            fullPage: false,
            quality: 90,
            type: 'jpeg'
          }),
          page.content()
        ]);
        
        socket.emit('screenshot_and_html', {
          screenshot,
          html
        });
      } catch (error) {
        const err = error as Error;
        console.error('Screenshot/HTML error:', err.message);
        socket.emit('error', {
          type: 'screenshot',
          message: err.message
        });
        throw error;
      }
    });
  }

  static sendError(socket: Socket, type: string, message: string): void {
    socket.emit('error', {
      type,
      message
    });
  }
}