import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import type { Plugin } from 'vite';

/** Keep the workspace's original Preview address usable without booting Next.
 * Both ports serve the same isolated Vite process, including its HMR socket.
 * The target is fixed loopback, never a request-supplied URL.
 */
export function workspacePreviewPort(port: number): Plugin {
  return {
    name: 'isolated-workspace-preview',
    configureServer(vite) {
      if (port === 5000) return;
      const preview = createServer((req, res) => {
        const upstream = request({
          hostname: '127.0.0.1', port, path: req.url, method: req.method, headers: req.headers,
        }, response => {
          res.writeHead(response.statusCode ?? 502, response.headers);
          response.pipe(res);
        });
        upstream.on('error', () => { res.writeHead(502); res.end('Demo preview is starting.'); });
        req.pipe(upstream);
      });
      preview.on('upgrade', (req, socket, head) => {
        const upstream = connect(port, '127.0.0.1', () => {
          upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`);
          for (let i=0; i<req.rawHeaders.length; i+=2) upstream.write(`${req.rawHeaders[i]}: ${req.rawHeaders[i+1]}\r\n`);
          upstream.write('\r\n');
          if (head.length) upstream.write(head);
          socket.pipe(upstream).pipe(socket);
        });
        upstream.on('error', () => socket.destroy());
        socket.on('error', () => upstream.destroy());
        socket.on('close', () => upstream.destroy());
      });
      preview.on('error', error => vite.config.logger.error(`Demo Preview port 5000: ${error.message}`));
      preview.listen(5000, '0.0.0.0');
      vite.httpServer?.once('close', () => preview.close());
    },
  };
}
