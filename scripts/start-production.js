#!/usr/bin/env node
const { spawn } = require('child_process');

const PORT = process.env.PORT || 3000;

console.log('='.repeat(60));
console.log('MOS Maintenance MVP - Production Start (No Workers)');
console.log('='.repeat(60));
console.log(`Port: ${PORT}`);
console.log('');
console.log('Note: This script runs Next.js only (for Autoscale deployments).');
console.log('Background sync workers should be run separately or use webhooks.');
console.log('');

const nextServer = spawn('npx', ['next', 'start', '-p', PORT, '-H', '0.0.0.0'], {
  stdio: 'inherit',
  env: process.env
});

nextServer.on('error', (err) => {
  console.error('[Next.js] Failed to start:', err);
  process.exit(1);
});

nextServer.on('exit', (code) => {
  console.log(`[Next.js] Exited with code ${code}`);
  process.exit(code || 0);
});

process.on('SIGTERM', () => {
  console.log('[Shutdown] Received SIGTERM, stopping...');
  nextServer.kill('SIGTERM');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[Shutdown] Received SIGINT, stopping...');
  nextServer.kill('SIGINT');
  process.exit(0);
});
