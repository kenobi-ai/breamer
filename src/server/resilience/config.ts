export interface ResilienceConfig {
  navigation: {
    primaryTimeout: number;
    fallbackTimeout: number;
    pageTimeout: number;
    retries: number;
    backoff: number;
  };
  operations: {
    defaultTimeout: number;
    defaultRetries: number;
    defaultBackoff: number;
  };
  circuit: {
    threshold: number;
    resetTimeout: number;
  };
}

export const defaultConfig: ResilienceConfig = {
  navigation: {
    primaryTimeout: 20000,     // Primary navigation timeout (networkidle0)
    fallbackTimeout: 15000,    // Fallback navigation timeout (domcontentloaded)
    pageTimeout: 25000,        // Overall page operation timeout
    retries: 3,
    backoff: 2000
  },
  operations: {
    defaultTimeout: 10000,
    defaultRetries: 2,
    defaultBackoff: 1000
  },
  circuit: {
    threshold: 5,
    resetTimeout: 60000
  }
};

// Allow environment variable overrides
export function getConfig(): ResilienceConfig {
  const config = { ...defaultConfig };
  
  // Navigation timeouts
  if (process.env.BREAMER_NAV_PRIMARY_TIMEOUT) {
    config.navigation.primaryTimeout = parseInt(process.env.BREAMER_NAV_PRIMARY_TIMEOUT, 10);
  }
  if (process.env.BREAMER_NAV_FALLBACK_TIMEOUT) {
    config.navigation.fallbackTimeout = parseInt(process.env.BREAMER_NAV_FALLBACK_TIMEOUT, 10);
  }
  if (process.env.BREAMER_NAV_RETRIES) {
    config.navigation.retries = parseInt(process.env.BREAMER_NAV_RETRIES, 10);
  }
  
  // Operation defaults
  if (process.env.BREAMER_OP_TIMEOUT) {
    config.operations.defaultTimeout = parseInt(process.env.BREAMER_OP_TIMEOUT, 10);
  }
  if (process.env.BREAMER_OP_RETRIES) {
    config.operations.defaultRetries = parseInt(process.env.BREAMER_OP_RETRIES, 10);
  }
  
  return config;
}