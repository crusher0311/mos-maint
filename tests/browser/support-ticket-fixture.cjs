// Offline fixture: real support markup, styles and handlers, no extension bootstrap.
const { readFileSync } = require('node:fs');
const { createServer } = require('node:http');
const { resolve } = require('node:path');
const root = resolve(__dirname, '../../mos-tools-extension');
function fixture() {
  const html = readFileSync(`${root}/sidepanel.html`, 'utf8');
  const js = readFileSync(`${root}/sidepanel.js`, 'utf8');
  const support = js.slice(js.indexOf('// ==================== SUPPORT CHAT'),
    js.indexOf('// ==================== CONCERN ASSISTANT'));
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
    <style>${readFileSync(`${root}/sidepanel.css`, 'utf8')}</style></head><body>
    ${html.slice(html.indexOf('  <button id="support-chat-fab"'), html.indexOf('  <script src="telemetry-core.js"'))}
    <script>
    let isAuthenticated = true;
    window.serviceCalls = [];
    function sendMessage(payload) { serviceCalls.push(payload); throw Error('Live services prohibited'); }
    window.fetch = () => { throw Error('Network prohibited'); };
    ${support}
    initSupportChat();
    supportMessages = [{role:'assistant',content:'Offline fixture'}];
    openSupportChat();
    </script></body></html>`;
}
function start(port = 0) {
  return createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(fixture());
  }).listen(port, '0.0.0.0');
}
module.exports = { start };
if (require.main === module) start(5119);
