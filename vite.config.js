import { defineConfig } from 'vite';
import quota from './api/quota.js';
import models from './api/models.js';

export default defineConfig({
  plugins: [
    {
      name: 'same-origin-api',
      configureServer(server) {
        server.middlewares.use('/api/quota', quota);
        server.middlewares.use('/api/models', models);
      },
      configurePreviewServer(server) {
        server.middlewares.use('/api/quota', quota);
        server.middlewares.use('/api/models', models);
      },
    },
  ],
});
