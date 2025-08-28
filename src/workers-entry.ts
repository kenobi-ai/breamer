// Cloudflare Workers entry point for container-based deployment
import { Container } from '@cloudflare/containers';

// Container class that runs our Express/Puppeteer server
export class BreamerContainer extends Container {
  // Express server runs on port 8080 inside the container
  defaultPort = 8080;
  
  // Keep container alive for 30 minutes after last request
  sleepAfter = '30m';
  
  // Environment variables passed to container
  envVars = {
    NODE_ENV: 'production',
    PUPPETEER_EXECUTABLE_PATH: '/usr/bin/chromium',
    PORT: '8080'
  };
}

// Worker script to route requests to the container
export default {
  async fetch(request: Request, env: any): Promise<Response> {
    try {
      // Get a single container instance
      // Since we only have max_instances = 1, we can use a fixed name
      const containerInstance = env.CONTAINER.getByName('main');
      
      // Forward the request to the container
      return await containerInstance.fetch(request);
    } catch (error) {
      console.error('Container routing error:', error);
      return new Response(JSON.stringify({ 
        error: 'Failed to route to container', 
        details: String(error) 
      }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },
};