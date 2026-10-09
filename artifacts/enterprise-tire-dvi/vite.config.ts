import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const port = Number(process.env.PORT || 24088);
if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('PORT must be a valid port number.');

export default defineConfig({
  base: process.env.BASE_PATH || '/tire-dvi/',
  plugins: [react()],
  root: path.resolve(import.meta.dirname),
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  build: { outDir: path.resolve(import.meta.dirname, 'dist'), emptyOutDir: true },
  server: { port, strictPort: true, host: '0.0.0.0', allowedHosts: true, fs: { strict: true, allow: [path.resolve(import.meta.dirname)] } },
  preview: { port, strictPort: true, host: '0.0.0.0', allowedHosts: true },
});
