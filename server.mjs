import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { createModel, readBounded, ModelError, MAX_MESSAGE } from './model.mjs';
import { createMcpServer } from './tools.mjs';
import { createDemo } from './demo.mjs';

const MAX_BODY = 8192;
const MAX_DEMO_BODY = 16_384;
const home = readFileSync(new URL('./index.html', import.meta.url));
const PAGE_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; "
  + "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const matches = (actual, expected) => {
  const left = Buffer.from(actual ?? '');
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
};

/**
 * One Builder web component:
 *   GET  /               - the Northlight Cameras demo page (AI + MCP, invented data)
 *   POST /api/demo/chat  - the demo agent; trusts Builder's visitor sign-in, same-origin only, rate limited
 *   POST /mcp            - stateless MCP endpoint (shop tools + ask_model), needs APP_API_TOKEN
 *   POST /agent          - single-turn AI API, needs APP_API_TOKEN
 *   GET  /health, /ready - liveness and model readiness
 */
export function createApp({ env = process.env, fetchImpl = fetch, timeoutMs = 10_000, credential, demoLimits } = {}) {
  const token = env.APP_API_TOKEN ?? '';
  const model = createModel({ env, fetchImpl, timeoutMs, credential });
  const origin = env.PUBLIC_ORIGIN ? new URL(env.PUBLIC_ORIGIN) : null;
  if (origin && (origin.protocol !== 'https:' || origin.origin !== env.PUBLIC_ORIGIN)) {
    throw new Error('PUBLIC_ORIGIN must be an exact HTTPS origin');
  }
  const origins = ['http://localhost:8080', 'http://127.0.0.1:8080', ...(origin ? [origin.origin] : [])];
  const demo = createDemo({
    model, token,
    perMinute: demoLimits?.perMinute ?? Number(env.DEMO_PER_MINUTE ?? 12),
    perDay: demoLimits?.perDay ?? Number(env.DEMO_PER_DAY ?? 300),
  });
  const send = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  async function agent(req, res) {
    if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
    if (token.length < 32) return send(res, 503, { error: 'app_auth_not_configured' });
    if (!matches(req.headers.authorization, `Bearer ${token}`)) return send(res, 401, { error: 'unauthorized' });
    if (!model.configured()) return send(res, 503, { error: 'model_not_configured' });
    if (req.headers['content-type']?.split(';')[0] !== 'application/json') {
      return send(res, 415, { error: 'expected_json' });
    }
    if (model.active >= 4) return send(res, 429, { error: 'busy' });
    let input;
    try {
      input = JSON.parse(await readBounded(req, MAX_BODY));
    } catch {
      return send(res, 400, { error: 'invalid_or_oversized_json' });
    }
    if (!input || Object.keys(input).length !== 1 || typeof input.message !== 'string'
      || !input.message.trim() || input.message.length > MAX_MESSAGE) {
      return send(res, 400, { error: 'message_must_be_1_to_2000_characters' });
    }
    const controller = new AbortController();
    const disconnected = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', disconnected);
    try {
      send(res, 200, { reply: await model.ask(input.message, controller.signal) });
    } catch (error) {
      const failure = error instanceof ModelError ? error : new ModelError('model_response_failed', 502);
      if (!res.destroyed) send(res, failure.status, { error: failure.code });
    } finally {
      res.off('close', disconnected);
    }
  }

  async function mcp(req, res) {
    if (req.method !== 'POST') return send(res, 405, { error: 'post_only' });
    if (token.length < 32) return send(res, 503, { error: 'app_auth_not_configured' });
    if (!matches(req.headers.authorization, `Bearer ${token}`)) return send(res, 401, { error: 'unauthorized' });
    if (req.headers['content-type']?.split(';')[0] !== 'application/json') {
      return send(res, 415, { error: 'expected_json' });
    }
    let body;
    try {
      body = JSON.parse(await readBounded(req, MAX_BODY));
    } catch (error) {
      return error.message === 'body_limit' ? send(res, 413, { error: 'body_limit' }) : send(res, 400, { error: 'invalid_json' });
    }
    const server = createMcpServer({ model });
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, enableJsonResponse: true,
      enableDnsRebindingProtection: true, allowedOrigins: origins,
    });
    // One cleanup callback covers normal completion and client disconnect.
    res.once('close', () => { void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent) send(res, 500, { error: 'protocol_failed' });
      await server.close();
    }
  }

  async function demoChat(req, res) {
    if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
    // Browser-only route: Builder's Entra sign-in admits the visitor; the app additionally
    // requires a same-origin browser request so other sites and scripts cannot drive it.
    if (req.headers.origin === undefined || !origins.includes(req.headers.origin)
      || (req.headers['sec-fetch-site'] !== undefined && req.headers['sec-fetch-site'] !== 'same-origin')) {
      return send(res, 403, { error: 'same_origin_browser_requests_only' });
    }
    if (req.headers['content-type']?.split(';')[0] !== 'application/json') {
      return send(res, 415, { error: 'expected_json' });
    }
    let body;
    try {
      body = await readBounded(req, MAX_DEMO_BODY);
    } catch {
      return send(res, 413, { error: 'body_limit' });
    }
    const refused = await demo(req, res, body);
    if (refused) send(res, refused.status, { error: refused.error });
  }

  const app = createServer(async (req, res) => {
    if (req.headers.origin !== undefined && !origins.includes(req.headers.origin)) {
      return send(res, 403, { error: 'untrusted_origin' });
    }
    const path = req.url?.split('?')[0];
    if (req.method === 'GET' && path === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('OK\n');
    }
    if (req.method === 'GET' && path === '/') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': PAGE_CSP,
      });
      return res.end(home);
    }
    if (req.method === 'GET' && path === '/ready') {
      const state = model.setup();
      return send(res, state.code === 'response_verified' ? 200 : 503, state);
    }
    if (path === '/api/demo/chat') return demoChat(req, res);
    if (path === '/agent') return agent(req, res);
    if (path === '/mcp') return mcp(req, res);
    return send(res, 404, { error: 'not_found' });
  });
  app.requestTimeout = 15_000;
  app.headersTimeout = 10_000;
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createApp();
  server.listen(8080, '0.0.0.0');
  process.once('SIGTERM', () => server.close());
  process.once('SIGINT', () => server.close());
}
