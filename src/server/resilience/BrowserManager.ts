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
      healthCheckInterval: options.healthCheckInterval ?? 10000,
      sessionTimeout: options.sessionTimeout ?? 300000, // 5 minutes
      maxHealthCheckFailures: options.maxHealthCheckFailures ?? 3
    };

    // Global cleanup interval
    setInterval(() => this.cleanupStaleSessions(), 60000);
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
        '--max-old-space-size=512' // Limit memory usage
      ],
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false
    });

    // Set up browser crash handler
    browser.on('disconnected', () => {
      console.error('Browser disconnected unexpectedly');
    });

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
        window.navigator.permissions.query = (parameters: any) => (
          parameters.name === 'notifications' ?
            Promise.resolve({ state: (window as any).Notification?.permission || 'default' }) :
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
      quality: 80,
      maxWidth: 1280,
      maxHeight: 1280,
      everyNthFrame: 1
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
        throw new Error('Browser disconnected');
      }

      // Check if page is still responsive
      await session.page.evaluate(() => true);
      
      // Reset failure count on success
      session.healthCheckFailures = 0;
      session.isHealthy = true;
    } catch (error) {
      console.error(`Health check failed for ${clientId}:`, error);
      session.healthCheckFailures++;
      
      if (session.healthCheckFailures >= this.options.maxHealthCheckFailures) {
        session.isHealthy = false;
        console.log(`Session ${clientId} marked as unhealthy, attempting recovery...`);
        await this.recoverSession(clientId);
      }
    }
  }

  private async recoverSession(clientId: string): Promise<void> {
    console.log(`Attempting to recover session for ${clientId}`);
    
    // Clean up old session
    await this.cleanupSession(clientId, false);
    
    try {
      // Create new session
      await this.createSession(clientId);
      console.log(`Successfully recovered session for ${clientId}`);
    } catch (error) {
      console.error(`Failed to recover session for ${clientId}:`, error);
      // Session will be cleaned up by caller
    }
  }

  async getSession(clientId: string): Promise<ClientSession | null> {
    const session = this.sessions.get(clientId);
    if (!session) return null;

    // Update last activity
    session.lastActivity = Date.now();

    // Return null if unhealthy
    if (!session.isHealthy) return null;

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