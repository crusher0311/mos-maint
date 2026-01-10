#!/usr/bin/env node
const { spawn } = require('child_process');
const http = require('http');

const PORT = process.env.PORT || 5000;
const PRODUCTION_URL = process.env.PRODUCTION_URL || `http://localhost:${PORT}`;

console.log('='.repeat(60));
console.log('MOS Maintenance MVP - Production Start');
console.log('='.repeat(60));
console.log(`Port: ${PORT}`);
console.log(`Production URL: ${PRODUCTION_URL}`);
console.log('');

function waitForServer(url, maxAttempts = 30) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const check = () => {
      attempts++;
      console.log(`[Startup] Waiting for server... (attempt ${attempts}/${maxAttempts})`);
      
      const req = http.get(url, (res) => {
        console.log(`[Startup] Server is ready! (status: ${res.statusCode})`);
        resolve();
      });
      
      req.on('error', () => {
        if (attempts >= maxAttempts) {
          reject(new Error('Server failed to start'));
        } else {
          setTimeout(check, 2000);
        }
      });
      
      req.setTimeout(2000, () => {
        req.destroy();
        if (attempts >= maxAttempts) {
          reject(new Error('Server timeout'));
        } else {
          setTimeout(check, 2000);
        }
      });
    };
    
    setTimeout(check, 3000);
  });
}

async function main() {
  console.log('[1/3] Starting Next.js server...');
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

  try {
    await waitForServer(`http://localhost:${PORT}/api/health`);
  } catch (err) {
    console.log('[Startup] Health check failed, but continuing anyway...');
  }

  // Pass COMBINED_SCRIPT=true to workers so they use localhost
  const workerEnv = { ...process.env, COMBINED_SCRIPT: 'true' };

  console.log('[2/3] Starting Tekmetric Sync Worker...');
  const tekmetricWorker = spawn('npx', ['tsx', 'scripts/tekmetric-sync-worker.ts'], {
    stdio: 'inherit',
    env: workerEnv
  });

  tekmetricWorker.on('error', (err) => {
    console.error('[Tekmetric Worker] Failed to start:', err);
  });

  console.log('[3/3] Starting Protractor Sync Worker...');
  const protractorWorker = spawn('npx', ['tsx', 'scripts/protractor-sync-worker.ts'], {
    stdio: 'inherit',
    env: workerEnv
  });

  protractorWorker.on('error', (err) => {
    console.error('[Protractor Worker] Failed to start:', err);
  });

  console.log('');
  console.log('='.repeat(60));
  console.log('All services started!');
  console.log('- Next.js server on port ' + PORT);
  console.log('- Tekmetric Sync Worker (every 10s)');
  console.log('- Protractor Sync Worker (every 60s)');
  console.log('='.repeat(60));

  process.on('SIGTERM', () => {
    console.log('[Shutdown] Received SIGTERM, stopping all processes...');
    nextServer.kill('SIGTERM');
    tekmetricWorker.kill('SIGTERM');
    protractorWorker.kill('SIGTERM');
    process.exit(0);
  });

  process.on('SIGINT', () => {
    console.log('[Shutdown] Received SIGINT, stopping all processes...');
    nextServer.kill('SIGINT');
    tekmetricWorker.kill('SIGINT');
    protractorWorker.kill('SIGINT');
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
