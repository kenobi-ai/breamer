import type { Page } from 'puppeteer';
import type { Socket } from 'socket.io';
import { OperationManager } from './OperationManager.js';
import { getConfig } from './config.js';

export class ResilientMessageHandlers {
  private static config = getConfig();
  static async handleNavigate(
    page: Page,
    socket: Socket,
    url: string
  ): Promise<void> {
    console.log('Navigation requested to:', url);
    
    try {
      await OperationManager.withRetry(async () => {
        const targetUrl = url.startsWith('http') ? url : `https://${url}`;
        console.log('Navigating to full URL:', targetUrl);
        
        // Try multiple navigation strategies
        try {
          await OperationManager.withTimeout(
            page.goto(targetUrl, {
              waitUntil: 'networkidle0',
              timeout: this.config.navigation.primaryTimeout
            }),
            this.config.navigation.pageTimeout,
            `Navigation to ${targetUrl} timed out`
          );
        } catch (firstError) {
          console.log('Trying alternative navigation strategy...');
          await OperationManager.withTimeout(
            page.goto(targetUrl, {
              waitUntil: 'domcontentloaded',
              timeout: this.config.navigation.fallbackTimeout
            }),
            this.config.navigation.fallbackTimeout + 5000,
            `Alternative navigation to ${targetUrl} timed out`
          );
        }
        
        socket.emit('navigation', {
          status: 'success',
          url: targetUrl
        });
      }, {
        retries: this.config.navigation.retries,
        timeout: this.config.navigation.pageTimeout + 5000,
        backoff: this.config.navigation.backoff
      });
    } catch (error) {
      const err = error as Error;
      console.error('Navigation failed after all retries:', err.message);
      
      // Send error to client but don't crash the server
      socket.emit('navigation', {
        status: 'error',
        error: err.message,
        recoverable: true
      });
      
      // Try to recover the page state
      try {
        await page.goto('about:blank', { timeout: 5000 });
      } catch (recoveryError) {
        console.error('Failed to reset page:', recoveryError);
      }
    }
  }

  static async handleClick(
    page: Page,
    socket: Socket,
    x: number,
    y: number
  ): Promise<void> {
    try {
      await OperationManager.withRetry(async () => {
        await page.mouse.click(x, y);
        socket.emit('click', {
          status: 'success',
          x,
          y
        });
      }, { 
        retries: this.config.operations.defaultRetries, 
        timeout: 5000,
        backoff: this.config.operations.defaultBackoff
      });
    } catch (error) {
      const err = error as Error;
      console.error('Click failed after retries:', err.message);
      socket.emit('click', {
        status: 'error',
        error: err.message,
        recoverable: true
      });
    }
  }

  static async handleScroll(
    page: Page,
    socket: Socket,
    deltaY: number
  ): Promise<void> {
    try {
      await OperationManager.withRetry(async () => {
        await page.evaluate((scrollAmount) => {
          window.scrollBy(0, scrollAmount);
        }, deltaY);
        
        socket.emit('scroll', {
          status: 'success',
          deltaY
        });
      }, { 
        retries: this.config.operations.defaultRetries, 
        timeout: 5000,
        backoff: this.config.operations.defaultBackoff
      });
    } catch (error) {
      const err = error as Error;
      console.error('Scroll failed after retries:', err.message);
      socket.emit('scroll', {
        status: 'error',
        error: err.message,
        recoverable: true
      });
    }
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
    try {
      await OperationManager.withRetry(async () => {
        await page.keyboard.type(text, { delay: 50 });
        socket.emit('type', {
          status: 'success',
          text
        });
      }, { 
        retries: this.config.operations.defaultRetries, 
        timeout: this.config.operations.defaultTimeout,
        backoff: this.config.operations.defaultBackoff
      });
    } catch (error) {
      const err = error as Error;
      console.error('Type failed after retries:', err.message);
      socket.emit('type', {
        status: 'error',
        error: err.message,
        recoverable: true
      });
    }
  }

  static async handleEvaluate(
    page: Page,
    socket: Socket,
    code: string
  ): Promise<void> {
    try {
      await OperationManager.withRetry(async () => {
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
      }, { 
        retries: this.config.operations.defaultRetries, 
        timeout: this.config.operations.defaultTimeout,
        backoff: this.config.operations.defaultBackoff
      });
    } catch (error) {
      const err = error as Error;
      console.error('Evaluate failed after retries:', err.message);
      socket.emit('evaluate', {
        success: false,
        error: err.message,
        recoverable: true
      });
    }
  }

  static async handleScreenshotAndHtml(
    page: Page,
    socket: Socket
  ): Promise<void> {
    try {
      await OperationManager.withRetry(async () => {
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
      }, { 
        retries: this.config.operations.defaultRetries, 
        timeout: 15000,
        backoff: this.config.operations.defaultBackoff
      });
    } catch (error) {
      const err = error as Error;
      console.error('Screenshot/HTML failed after retries:', err.message);
      socket.emit('error', {
        type: 'screenshot',
        message: err.message,
        recoverable: true
      });
    }
  }

  static sendError(socket: Socket, type: string, message: string): void {
    socket.emit('error', {
      type,
      message
    });
  }
}