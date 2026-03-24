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
    let resolved = false;
    
    const check = () => {
      if (resolved) return;
      attempts++;
      console.log(`[Startup] Waiting for server... (attempt ${attempts}/${maxAttempts})`);
      
      const req = http.get(url, (res) => {
        if (resolved) return;
        resolved = true;
        console.log(`[Startup] Server is ready! (status: ${res.statusCode})`);
        res.resume(); // Consume response to free up memory
        resolve();
      });
      
      req.on('error', () => {
        if (resolved) return;
        if (attempts >= maxAttempts) {
          resolved = true;
          reject(new Error('Server failed to start'));
        } else {
          setTimeout(check, 2000);
        }
      });
      
      req.setTimeout(2000, () => {
        if (resolved) return;
        req.destroy();
        if (attempts >= maxAttempts) {
          resolved = true;
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

  // Protractor Sync Worker DISABLED - using webhooks + daily scheduled cron instead
  // The frequent polling was causing excessive API requests to Protractor
  // Daily sync runs via external scheduler (Render cron) at 2am EST
  // See: /api/cron/protractor-sync
  console.log('[3/4] Protractor Sync Worker DISABLED (using webhooks + daily cron)');

  console.log('[4/5] Starting Plan Prefetch Worker...');
  const planPrefetchWorker = spawn('npx', ['tsx', 'scripts/plan-prefetch-worker.ts'], {
    stdio: 'inherit',
    env: workerEnv
  });

  planPrefetchWorker.on('error', (err) => {
    console.error('[Plan Prefetch Worker] Failed to start:', err);
  });
  
  planPrefetchWorker.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) {
      console.error(`[Plan Prefetch Worker] Exited with code ${code}, signal: ${signal}`);
    }
  });

  const RR_WS_PORT = process.env.RESCUE_ROVER_WS_PORT || '3002';
  console.log(`[5/5] Starting Rescue Rover WebSocket Server on port ${RR_WS_PORT}...`);
  const rescueRoverWs = spawn('npx', ['tsx', 'scripts/rescue-rover-ws-server.ts'], {
    stdio: 'inherit',
    env: { ...workerEnv, RESCUE_ROVER_WS_PORT: RR_WS_PORT }
  });

  rescueRoverWs.on('error', (err) => {
    console.error('[Rescue Rover WS] Failed to start:', err);
  });

  rescueRoverWs.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) {
      console.error(`[Rescue Rover WS] Exited with code ${code}, signal: ${signal}`);
    }
  });

  console.log('');
  console.log('='.repeat(60));
  console.log('All services started!');
  console.log('- Next.js server on port ' + PORT);
  console.log('- Tekmetric Sync Worker (every 60s)');
  console.log('- Protractor Sync Worker DISABLED (daily cron + webhooks)');
  console.log('- Plan Prefetch Worker (every 30m)');
  console.log('- Rescue Rover WebSocket Server on port ' + RR_WS_PORT);
  console.log('='.repeat(60));

  process.on('SIGTERM', () => {
    console.log('[Shutdown] Received SIGTERM, stopping all processes...');
    nextServer.kill('SIGTERM');
    tekmetricWorker.kill('SIGTERM');
    planPrefetchWorker.kill('SIGTERM');
    rescueRoverWs.kill('SIGTERM');
    process.exit(0);
  });

  process.on('SIGINT', () => {
    console.log('[Shutdown] Received SIGINT, stopping all processes...');
    nextServer.kill('SIGINT');
    tekmetricWorker.kill('SIGINT');
    planPrefetchWorker.kill('SIGINT');
    rescueRoverWs.kill('SIGINT');
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
