import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: 'src/client',
  build: {
    outDir: '../../dist'
  },
  server: {
    port: 3003
  },
  envDir: '../../'  // Load .env from project root
});