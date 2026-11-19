import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import * as z from 'zod';
import { setupPage } from './setup-page.mjs';
import { createModel, readBounded, ModelError, MAX_MESSAGE } from './model.mjs';

const MAX_BODY = 8192;
const home = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const assistantHome = readFileSync(new URL('./assistant.html', import.meta.url));
const readme = setupPage();

const matches = (actual, expected) => {
  const left = Buffer.from(actual ?? '');
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
};

/**
 * One Builder web component serving both templates:
 *   POST /mcp   - stateless MCP endpoint (text_length, ask_model)
 *   POST /agent - single-turn AI assistant API
 * Both share APP_API_TOKEN and one bounded model client. Each MCP POST owns a fresh
 * SDK server/transport, closed when its response finishes; there is no session
 * persistence and no GET event stream.
 */
export function createApp({ env = process.env, fetchImpl = fetch, timeoutMs = 10_000, credential } = {}) {
  const token = env.APP_API_TOKEN ?? '';
  const model = createModel({ env, fetchImpl, timeoutMs, credential });
  const origin = env.PUBLIC_ORIGIN ? new URL(env.PUBLIC_ORIGIN) : null;
  if (origin && (origin.protocol !== 'https:' || origin.origin !== env.PUBLIC_ORIGIN)) {
    throw new Error('PUBLIC_ORIGIN must be an exact HTTPS origin');
  }
  const origins = ['http://localhost:8080', 'http://127.0.0.1:8080', ...(origin ? [origin.origin] : [])];
  const send = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const html = (res, body, csp) => {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...(csp ? { 'Content-Security-Policy': csp } : {}),
    });
    res.end(body);
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
    const server = new McpServer({ name: 'builder-mcp-ai-sample', version: '1.1.0' });
    server.registerTool('text_length', {
      description: 'Count Unicode code points in at most 1000 UTF-16 code units of text; performs no I/O.',
      inputSchema: z.object({ text: z.string().max(1000) }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ text }) => ({
      content: [{ type: 'text', text: String(Array.from(text).length) }],
    }));
    server.registerTool('ask_model', {
      description: 'Send one plain-text question (1-2000 characters) to the app\'s configured model and return its '
        + 'single-turn reply. No tools, no memory, nothing stored; the only I/O is the model call.',
      inputSchema: z.object({
        message: z.string().max(MAX_MESSAGE).refine((value) => value.trim().length > 0, 'message must not be blank'),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, async ({ message }, extra) => {
      try {
        return { content: [{ type: 'text', text: await model.ask(message, extra?.signal) }] };
      } catch (error) {
        const code = error instanceof ModelError ? error.code : 'model_response_failed';
        return { isError: true, content: [{ type: 'text', text: code }] };
      }
    });
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

  const app = createServer(async (req, res) => {
    if (req.headers.origin !== undefined && !origins.includes(req.headers.origin)) {
      return send(res, 403, { error: 'untrusted_origin' });
    }
    const path = req.url?.split('?')[0];
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('OK\n');
    }
    if (req.method === 'GET' && path === '/') return html(res, home);
    if (req.method === 'GET' && path === '/assistant') {
      return html(res, assistantHome, "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
        + "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    }
    if (req.method === 'GET' && req.url === '/README.md') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'" });
      return res.end(readme);
    }
    if (req.method === 'GET' && (req.url === '/api/setup' || req.url === '/ready')) {
      const state = model.setup();
      return send(res, req.url === '/ready' && state.code !== 'response_verified' ? 503 : 200, state);
    }
    if (req.url === '/agent') return agent(req, res);
    if (req.url === '/mcp') return mcp(req, res);
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
