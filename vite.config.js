import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { handleApiRequest } from './server/auth.js';

// Expose the admin authentication API (`/api/admin/*`) while running `npm run dev`,
// using the same server-side handler as the production deployments. Secrets stay
// in `.env.local` (server-side only) and are never bundled into client code.
function adminAuthApi(mode) {
  return {
    name: 'admin-auth-api',
    configureServer(server) {
      const fileEnv = loadEnv(mode, process.cwd(), '');
      for (const [key, value] of Object.entries(fileEnv)) {
        if (process.env[key] === undefined) process.env[key] = value;
      }
      server.middlewares.use((req, res, next) => {
        const pathname = (req.url || '').split('?')[0];
        if (!pathname.startsWith('/api/')) return next();
        handleApiRequest(req, res, pathname).catch((error) => {
          console.error('Admin auth API error:', error);
          if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'server_error' }));
        });
      });
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), adminAuthApi(mode)],
  base: '/',
  server: {
    host: '0.0.0.0',
    allowedHosts: true,
  },
  preview: {
    host: '0.0.0.0',
    allowedHosts: true,
  },
  build: { outDir: 'dist', sourcemap: false },
}));
