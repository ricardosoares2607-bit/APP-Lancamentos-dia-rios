import { defineConfig } from 'vite';
import fs from 'fs';
import path from 'path';

export default defineConfig({
  server: {
    port: 3000,
    host: '0.0.0.0',
    allowedHosts: true,
    hmr: process.env.DISABLE_HMR !== 'true',
    watch: process.env.DISABLE_HMR === 'true' ? null : {}
  },
  preview: {
    allowedHosts: true
  },
  plugins: [
    {
      name: 'copy-pwa-assets',
      closeBundle() {
        const files = ['sw.js', 'manifest.json', 'icon-192.png', 'icon-512.png'];
        for (const file of files) {
          if (fs.existsSync(file)) {
            fs.copyFileSync(file, path.resolve('dist', file));
          }
        }
      }
    }
  ]
});
