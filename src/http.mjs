import { createServer } from 'node:http';

// GitHub caps a webhook payload at 25 MB; the events the App takes are far smaller.
export const bodyLimit = 5 * 1024 * 1024;

// The webhook and the health check. No body, header value or token is ever logged.
export function httpServer({ webhook, log = () => {} }) {
  return createServer(async (request, response) => {
    const send = (status, body) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    try {
      const { pathname } = new URL(request.url, 'http://server');
      if (pathname === '/healthz' && request.method === 'GET') return send(200, { ok: true });
      if (pathname !== '/webhook') return send(404, { message: 'Not found.' });
      if (request.method !== 'POST') return send(405, { message: 'Use POST.' });
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > bodyLimit) {
          send(413, { message: 'The body is too large.' });
          return request.destroy();
        }
        chunks.push(chunk);
      }
      const result = await webhook.handle({
        event: request.headers['x-github-event'], delivery: request.headers['x-github-delivery'],
        signature: request.headers['x-hub-signature-256'], body: Buffer.concat(chunks),
      });
      send(result.status, { message: result.message });
    } catch (error) {
      log({ level: 'error', event: 'request', code: error?.code ?? 'unexpected' });
      if (!response.headersSent) send(500, { message: 'Internal error.' });
    }
  });
}
