import puppeteer from 'puppeteer';
import type { Browser, Page, CDPSession } from 'puppeteer';

interface ClientSession {
  browser: Browser;
  page: Page;
  cdpSession: CDPSession;
  lastActivity: number;
  healthCheckFailures: number;
  isHealthy: boolean;
}

interface BrowserManagerOptions {
  maxRetries?: number;
  healthCheckInterval?: number;
  sessionTimeout?: number;
  maxHealthCheckFailures?: number;
}

export class ResilientBrowserManager {
  private sessions = new Map<string, ClientSession>();
  private healthCheckIntervals = new Map<string, NodeJS.Timeout>();
  private options: Required<BrowserManagerOptions>;

  constructor(options: BrowserManagerOptions = {}) {
    this.options = {
      maxRetries: options.maxRetries ?? 3,
      healthCheckInterval: options.healthCheckInterval ?? 15000, // 15 seconds
      sessionTimeout: options.sessionTimeout ?? 600000, // 10 minutes
      maxHealthCheckFailures: options.maxHealthCheckFailures ?? 5
    };

    // Global cleanup interval - less aggressive
    setInterval(() => this.cleanupStaleSessions(), 300000); // 5 minutes
  }

  async createSession(clientId: string): Promise<ClientSession> {
    let retries = 0;
    let lastError: Error | null = null;

    while (retries < this.options.maxRetries) {
      try {
        const browser = await this.launchBrowser();
        const page = await this.createPage(browser);
        
        // Navigate to black page BEFORE creating CDP session
        await page.goto('data:text/html,<html><body style="background:#000;margin:0;padding:0;height:100vh;"></body></html>');
        
        const cdpSession = await page.createCDPSession();

        const session: ClientSession = {
          browser,
          page,
          cdpSession,
          lastActivity: Date.now(),
          healthCheckFailures: 0,
          isHealthy: true
        };

        this.sessions.set(clientId, session);
        this.startHealthMonitoring(clientId);
        
        return session;
      } catch (error) {
        lastError = error as Error;
        retries++;
        console.error(`Browser launch attempt ${retries} failed:`, error);
        
        if (retries < this.options.maxRetries) {
          await this.delay(1000 * retries); // Exponential backoff
        }
      }
    }

    throw new Error(`Failed to create browser session after ${retries} attempts: ${lastError?.message}`);
  }

  private async launchBrowser(): Promise<Browser> {
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
        '--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        '--max-old-space-size=2048', // Increased memory limit to 2GB
        '--disable-gpu-sandbox',
        '--disable-software-rasterizer'
      ],
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false
    });

    // Set up browser crash handler
    browser.on('disconnected', () => {
      console.error('Browser disconnected unexpectedly');
      // Mark all sessions using this browser as unhealthy
      for (const [clientId, session] of this.sessions.entries()) {
        if (session.browser === browser) {
          session.isHealthy = false;
          console.error(`Marking session ${clientId} as unhealthy due to browser disconnect`);
        }
      }
    });

    // Monitor browser process
    const browserProcess = browser.process();
    if (browserProcess) {
      browserProcess.on('exit', (code, signal) => {
        console.error(`Browser process exited with code ${code} and signal ${signal}`);
      });
      
      browserProcess.on('error', (error) => {
        console.error('Browser process error:', error);
      });
    }

    return browser;
  }

  private async createPage(browser: Browser): Promise<Page> {
    const page = await browser.newPage();

    // Page crash handler
    page.on('error', (error) => {
      console.error('Page crashed:', error);
    });

    // Set up page to avoid detection
    await page.evaluateOnNewDocument(() => {
      // Remove webdriver property
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined
      });
      
      // Add chrome object
      (window as any).chrome = {
        runtime: {}
      };
      
      // Override permissions only if they exist
      if (window.navigator.permissions) {
        const originalQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = (parameters: any): Promise<PermissionStatus> => (
          parameters.name === 'notifications' ?
            Promise.resolve({ 
              state: (window as any).Notification?.permission || 'default',
              name: 'notifications' as PermissionName,
              onchange: null,
              addEventListener: () => {},
              removeEventListener: () => {},
              dispatchEvent: () => false
            } as PermissionStatus) :
            originalQuery(parameters)
        );
      }
    });

    await page.setViewport({ width: 1280, height: 1280 });
    
    // Set reasonable timeouts
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(30000);

    return page;
  }

  async initializeScreencast(cdpSession: CDPSession): Promise<void> {
    console.log('Starting screencast...');
    
    // Enable page first
    await cdpSession.send('Page.enable');
    
    await cdpSession.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 60, // Reduced from 80 to reduce frame size
      maxWidth: 1280,
      maxHeight: 1280,
      everyNthFrame: 2 // Only capture every 2nd frame to reduce load
    });
    console.log('Screencast started');
  }

  private startHealthMonitoring(clientId: string): void {
    const interval = setInterval(async () => {
      await this.checkSessionHealth(clientId);
    }, this.options.healthCheckInterval);

    this.healthCheckIntervals.set(clientId, interval);
  }

  private async checkSessionHealth(clientId: string): Promise<void> {
    const session = this.sessions.get(clientId);
    if (!session) return;

    try {
      // Check if browser is still connected
      if (!session.browser.isConnected()) {
        console.error(`Browser disconnected for session ${clientId}`);
        throw new Error('Browser disconnected');
      }

      // Check browser process
      const browserProcess = session.browser.process();
      if (!browserProcess || browserProcess.killed) {
        console.error(`Browser process dead for session ${clientId}`);
        throw new Error('Browser process dead');
      }

      // Check if page is still responsive
      await session.page.evaluate(() => true);
      
      // Check CDP session
      try {
        await session.cdpSession.send('Runtime.evaluate', {
          expression: '1+1',
          returnByValue: true
        });
      } catch (cdpError) {
        console.error(`CDP session unresponsive for ${clientId}:`, cdpError);
        throw new Error('CDP session unresponsive');
      }
      
      // Reset failure count on success
      session.healthCheckFailures = 0;
      session.isHealthy = true;
    } catch (error) {
      console.error(`Health check failed for ${clientId}:`, error);
      session.healthCheckFailures++;
      
      if (session.healthCheckFailures >= this.options.maxHealthCheckFailures) {
        session.isHealthy = false;
        console.log(`Session ${clientId} marked as unhealthy after ${session.healthCheckFailures} failures, attempting recovery...`);
        await this.recoverSession(clientId);
      }
    }
  }

  private async recoverSession(clientId: string): Promise<void> {
    console.log(`[Recovery] Starting session recovery for ${clientId} at ${new Date().toLocaleTimeString()}`);
    
    const oldSession = this.sessions.get(clientId);
    if (oldSession) {
      console.log(`[Recovery] Old session state: isHealthy=${oldSession.isHealthy}, healthCheckFailures=${oldSession.healthCheckFailures}`);
    }
    
    // Clean up old session
    await this.cleanupSession(clientId, false);
    
    try {
      // Create new session
      await this.createSession(clientId);
      console.log(`[Recovery] Successfully recovered session for ${clientId} at ${new Date().toLocaleTimeString()}`);
      
      // Send recovery notification to client
      const ws = (global as any).activeConnections?.get(clientId);
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({
          type: 'session_recovered',
          message: 'Browser session was recovered successfully'
        }));
      }
    } catch (error) {
      console.error(`[Recovery] Failed to recover session for ${clientId}:`, error);
      // Session will be cleaned up by caller
    }
  }

  async getSession(clientId: string): Promise<ClientSession | null> {
    const session = this.sessions.get(clientId);
    if (!session) return null;

    // Update last activity
    session.lastActivity = Date.now();

    // If session is unhealthy, attempt recovery
    if (!session.isHealthy) {
      console.log(`Session ${clientId} is unhealthy, attempting recovery...`);
      await this.recoverSession(clientId);
      
      // Get the newly created session
      const newSession = this.sessions.get(clientId);
      if (!newSession || !newSession.isHealthy) {
        console.error(`Failed to recover session ${clientId}`);
        return null;
      }
      
      return newSession;
    }

    return session;
  }

  async cleanupSession(clientId: string, removeFromMap = true): Promise<void> {
    const session = this.sessions.get(clientId);
    if (!session) return;

    // Stop health monitoring
    const interval = this.healthCheckIntervals.get(clientId);
    if (interval) {
      clearInterval(interval);
      this.healthCheckIntervals.delete(clientId);
    }

    // Clean up resources with error handling
    try {
      if (session.cdpSession) {
        await session.cdpSession.send('Page.stopScreencast').catch(() => {});
      }
    } catch (error) {
      console.error('Error stopping screencast:', error);
    }

    try {
      if (session.page && !session.page.isClosed()) {
        await session.page.close();
      }
    } catch (error) {
      console.error('Error closing page:', error);
    }

    try {
      if (session.browser && session.browser.isConnected()) {
        await session.browser.close();
      }
    } catch (error) {
      console.error('Error closing browser:', error);
    }

    if (removeFromMap) {
      this.sessions.delete(clientId);
    }
  }

  private async cleanupStaleSessions(): Promise<void> {
    const now = Date.now();
    
    for (const [clientId, session] of this.sessions.entries()) {
      if (now - session.lastActivity > this.options.sessionTimeout) {
        console.log(`Cleaning up stale session: ${clientId}`);
        await this.cleanupSession(clientId);
      }
    }
  }

  async cleanupAll(): Promise<void> {
    console.log('Cleaning up all browser sessions...');
    
    // Stop all health checks
    for (const interval of this.healthCheckIntervals.values()) {
      clearInterval(interval);
    }
    this.healthCheckIntervals.clear();

    // Cleanup all sessions
    const cleanupPromises = Array.from(this.sessions.keys()).map(clientId =>
      this.cleanupSession(clientId)
    );
    
    await Promise.allSettled(cleanupPromises);
    this.sessions.clear();
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}