export interface OperationOptions {
  timeout?: number;
  retries?: number;
  backoff?: number;
}

export class OperationManager {
  static async withTimeout<T>(
    operation: Promise<T>,
    timeoutMs: number,
    errorMessage = 'Operation timed out'
  ): Promise<T> {
    const timeoutPromise = new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
    });

    return Promise.race([operation, timeoutPromise]);
  }

  static async withRetry<T>(
    operation: () => Promise<T>,
    options: OperationOptions = {}
  ): Promise<T> {
    const { retries = 3, backoff = 1000, timeout = 30000 } = options;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const result = await this.withTimeout(
          operation(),
          timeout,
          `Operation timed out after ${timeout}ms (attempt ${attempt + 1}/${retries})`
        );
        return result;
      } catch (error) {
        lastError = error as Error;
        console.error(`Operation failed (attempt ${attempt + 1}/${retries}):`, error);

        if (attempt < retries - 1) {
          const delay = backoff * Math.pow(2, attempt); // Exponential backoff
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw new Error(`Operation failed after ${retries} attempts: ${lastError?.message}`);
  }

  static async safe<T>(
    operation: () => Promise<T>,
    fallback: T,
    errorHandler?: (error: Error) => void
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      const err = error as Error;
      if (errorHandler) {
        errorHandler(err);
      } else {
        console.error('Safe operation failed:', err);
      }
      return fallback;
    }
  }

  static createCircuitBreaker(
    threshold: number = 5,
    resetTimeout: number = 60000
  ) {
    let failures = 0;
    let lastFailureTime = 0;
    let isOpen = false;

    return {
      async execute<T>(operation: () => Promise<T>): Promise<T> {
        // Check if circuit should be reset
        if (isOpen && Date.now() - lastFailureTime > resetTimeout) {
          failures = 0;
          isOpen = false;
          console.log('Circuit breaker reset');
        }

        // If circuit is open, fail fast
        if (isOpen) {
          throw new Error('Circuit breaker is open - operation blocked');
        }

        try {
          const result = await operation();
          failures = 0; // Reset on success
          return result;
        } catch (error) {
          failures++;
          lastFailureTime = Date.now();

          if (failures >= threshold) {
            isOpen = true;
            console.error(`Circuit breaker opened after ${failures} failures`);
          }

          throw error;
        }
      },

      reset() {
        failures = 0;
        isOpen = false;
        lastFailureTime = 0;
      },

      getState() {
        return { isOpen, failures, lastFailureTime };
      }
    };
  }
}