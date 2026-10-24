// Offline preview of the real Preferences page. No Next server or database imports.
const http = require('node:http');
const { build } = require('esbuild');
const postcss = require('postcss');
const tailwind = require('@tailwindcss/postcss');

async function createFixture() {
  const result = await build({
    stdin: {
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import Preferences from './app/dashboard/settings/preferences/page';
        window.fixtureWrites = [];
        window.fetch = async (url, options = {}) => {
          const shop = new URL(location.href).searchParams.get('shop') || '1';
          const key = 'fixture-prefs-' + shop;
          const prefs = JSON.parse(localStorage.getItem(key) || '{}');
          let data;
          if (url === '/api/settings/preferences') {
            if (options.method === 'PUT') {
              const body = JSON.parse(options.body);
              window.fixtureWrites.push(body);
              localStorage.setItem(key, JSON.stringify({ ...prefs, ...body }));
              data = { success: true };
            } else data = { ...prefs, canManageTekmetricMaintenanceColor: new URL(location.href).searchParams.get('role') !== 'viewer' };
          } else if (url === '/api/settings/integrations') data = { tekmetric: { configured: shop !== '3' } };
          else if (url === '/api/tekmetric/labels') data = { labels: [] };
          else throw Error('Unexpected fixture request ' + url);
          return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
        };
        createRoot(document.getElementById('root')).render(<Preferences />);
      `,
      resolveDir: process.cwd(), loader: 'tsx',
    },
    bundle: true, write: false, jsx: 'automatic', platform: 'browser',
    plugins: [{ name: 'unrelated-sharing-panel', setup(b) {
      b.onResolve({ filter: /^@\/components\/vehicle-history-sharing-settings$/ }, () => ({ path: 'sharing', namespace: 'fixture' }));
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export default function Sharing(){return null}', loader: 'js' }));
    } }],
  });
  const css = (await postcss([tailwind()]).process(
    '@import "tailwindcss" source(none); @source "../../app/dashboard/settings/preferences/page.tsx";',
    { from: 'tests/browser/maintenance-fixture.css' },
  )).css;
  return http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.url === '/app.js') {
      res.setHeader('Content-Type', 'application/javascript');
      res.end(result.outputFiles[0].text);
    } else {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<html><head><style>${css}</style></head><body><div id="root"></div><script src="/app.js"></script></body></html>`);
    }
  });
}
module.exports = { createFixture };
if (require.main === module) createFixture().then(s => s.listen(5000, '0.0.0.0', () => console.log('Offline maintenance preference preview on 5000')));
