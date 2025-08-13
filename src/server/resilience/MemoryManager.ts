import v8 from 'v8';
import { performance } from 'perf_hooks';

export interface MemoryStats {
  heapUsed: number;
  heapTotal: number;
  external: number;
  rss: number;
  heapUsedPercent: number;
}

export class MemoryManager {
  private static instance: MemoryManager;
  private lastGC: number = Date.now();
  private gcInterval: NodeJS.Timeout | null = null;
  private memoryCheckInterval: NodeJS.Timeout | null = null;
  
  // Thresholds
  private readonly HEAP_THRESHOLD_PERCENT = 85; // Trigger GC at 85% heap usage
  private readonly CRITICAL_HEAP_PERCENT = 95; // Emergency mode at 95%
  private readonly MIN_GC_INTERVAL = 30000; // Don't GC more than every 30s
  private readonly FRAME_BUFFER_LIMIT = 10; // Max buffered frames
  
  private frameBuffer: Map<string, Buffer[]> = new Map();
  
  private constructor() {
    this.startMonitoring();
  }
  
  static getInstance(): MemoryManager {
    if (!MemoryManager.instance) {
      MemoryManager.instance = new MemoryManager();
    }
    return MemoryManager.instance;
  }
  
  private startMonitoring(): void {
    // Check memory every 10 seconds
    this.memoryCheckInterval = setInterval(() => {
      this.checkMemoryPressure();
    }, 10000);
    
    // Force GC every 2 minutes if available
    if (global.gc) {
      this.gcInterval = setInterval(() => {
        this.forceGarbageCollection();
      }, 120000);
    }
    
    console.log('Memory monitoring started');
  }
  
  getMemoryStats(): MemoryStats {
    const memUsage = process.memoryUsage();
    const heapStats = v8.getHeapStatistics();
    
    return {
      heapUsed: memUsage.heapUsed,
      heapTotal: memUsage.heapTotal,
      external: memUsage.external,
      rss: memUsage.rss,
      heapUsedPercent: (memUsage.heapUsed / heapStats.heap_size_limit) * 100
    };
  }
  
  private checkMemoryPressure(): void {
    const stats = this.getMemoryStats();
    
    console.log(`[Memory] Heap: ${(stats.heapUsed / 1024 / 1024).toFixed(2)}MB / ${(stats.heapTotal / 1024 / 1024).toFixed(2)}MB (${stats.heapUsedPercent.toFixed(1)}%)`);
    
    if (stats.heapUsedPercent > this.CRITICAL_HEAP_PERCENT) {
      console.error('[Memory] CRITICAL: Heap usage above 95%, entering emergency mode');
      this.emergencyCleanup();
    } else if (stats.heapUsedPercent > this.HEAP_THRESHOLD_PERCENT) {
      console.warn(`[Memory] WARNING: Heap usage at ${stats.heapUsedPercent.toFixed(1)}%, triggering cleanup`);
      this.performCleanup();
    }
  }
  
  private performCleanup(): void {
    // Clear frame buffers
    this.clearFrameBuffers();
    
    // Force GC if available and enough time has passed
    if (global.gc && Date.now() - this.lastGC > this.MIN_GC_INTERVAL) {
      this.forceGarbageCollection();
    }
  }
  
  private emergencyCleanup(): void {
    console.log('[Memory] Performing emergency cleanup');
    
    // Clear all buffers immediately
    this.frameBuffer.clear();
    
    // Force immediate GC
    if (global.gc) {
      global.gc();
      console.log('[Memory] Forced emergency garbage collection');
    }
    
    // Request all sessions to reduce quality
    const browserManager = (global as any).browserManager;
    if (browserManager) {
      for (const [clientId, session] of browserManager.getSessions()) {
        this.reduceSessionQuality(clientId, session);
      }
    }
  }
  
  private forceGarbageCollection(): void {
    if (global.gc) {
      const before = process.memoryUsage().heapUsed;
      const start = performance.now();
      
      global.gc();
      
      const after = process.memoryUsage().heapUsed;
      const duration = performance.now() - start;
      const freed = (before - after) / 1024 / 1024;
      
      if (freed > 0) {
        console.log(`[Memory] GC freed ${freed.toFixed(2)}MB in ${duration.toFixed(2)}ms`);
      }
      
      this.lastGC = Date.now();
    }
  }
  
  // Frame buffer management
  addFrame(clientId: string, frame: Buffer): void {
    if (!this.frameBuffer.has(clientId)) {
      this.frameBuffer.set(clientId, []);
    }
    
    const frames = this.frameBuffer.get(clientId)!;
    frames.push(frame);
    
    // Limit frame buffer size
    if (frames.length > this.FRAME_BUFFER_LIMIT) {
      frames.shift(); // Remove oldest frame
    }
  }
  
  clearClientFrames(clientId: string): void {
    this.frameBuffer.delete(clientId);
  }
  
  private clearFrameBuffers(): void {
    let totalCleared = 0;
    for (const [clientId, frames] of this.frameBuffer) {
      totalCleared += frames.length;
      // Keep only last 2 frames
      if (frames.length > 2) {
        this.frameBuffer.set(clientId, frames.slice(-2));
      }
    }
    
    if (totalCleared > 0) {
      console.log(`[Memory] Cleared ${totalCleared} frame buffers`);
    }
  }
  
  private async reduceSessionQuality(clientId: string, session: any): Promise<void> {
    try {
      if (session.cdpSession) {
        // Stop current screencast
        await session.cdpSession.send('Page.stopScreencast').catch(() => {});
        
        // Restart with lower quality
        await session.cdpSession.send('Page.startScreencast', {
          format: 'jpeg',
          quality: 30, // Reduced quality
          maxWidth: 1024, // Reduced resolution
          maxHeight: 768,
          everyNthFrame: 2 // Skip more frames
        });
        
        console.log(`[Memory] Reduced quality for session ${clientId}`);
      }
    } catch (error) {
      console.error(`[Memory] Failed to reduce quality for ${clientId}:`, error);
    }
  }
  
  // Cleanup on shutdown
  shutdown(): void {
    if (this.gcInterval) {
      clearInterval(this.gcInterval);
    }
    if (this.memoryCheckInterval) {
      clearInterval(this.memoryCheckInterval);
    }
    this.frameBuffer.clear();
    console.log('[Memory] Memory manager shutdown');
  }
}