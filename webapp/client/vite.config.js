import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server proxies the API and the card-tap websocket to the backend.
const backend = process.env.BACKEND_URL || 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': backend,
      '/ws': { target: backend.replace(/^http/, 'ws'), ws: true },
    },
  },
});
