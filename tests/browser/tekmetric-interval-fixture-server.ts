/** Standalone screenshot server: npx tsx tests/browser/tekmetric-interval-fixture-server.ts */
import http from "node:http";
import { fixtureHtml } from "./tekmetric-interval-fixture";

const port = Number(process.env.TEKMETRIC_FIXTURE_PORT || 5101);
http.createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  const screenshotSetup = `<script>
    document.querySelector('#sidebar').classList.add('closed');
    const header = document.querySelector('#header');
    header.style.left = 'auto';
    header.style.right = '8px';
    const button = document.querySelector('#mos-print-button');
    button.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  </script>`;
  response.end(fixtureHtml().replace('</body>', `${request.url === '/screenshot' ? screenshotSetup : ''}</body>`));
}).listen(port, "0.0.0.0", () => {
  console.log(`Offline Tekmetric fixture: http://127.0.0.1:${port}/`);
});