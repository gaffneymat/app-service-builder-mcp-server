import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createApp } from './server.mjs';

const token = 'local-test-token-'.repeat(3);
const modelEnv = {
  APP_API_TOKEN: token, MODEL_SERVICE: 'azure-openai',
  AZURE_OPENAI_ENDPOINT: 'https://example-account.openai.azure.com/openai/v1/',
  AZURE_OPENAI_DEPLOYMENT: 'gpt-4.1-mini',
};
const credential = { getToken: async () => ({ token: 'identity-access-token' }) };
const completed = (text = 'A short answer') => new Response(JSON.stringify({
  status: 'completed',
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
}));

async function fixture(t, options) {
  const app = createApp({ credential, ...options });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(() => new Promise((resolve) => { app.close(resolve); app.closeAllConnections(); }));
  const base = `http://127.0.0.1:${app.address().port}`;
  return (id, method, params) => fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  }).then((response) => response.json());
}

test('ask_model is listed with an honest open-world, non-destructive contract', async (t) => {
  const rpc = await fixture(t, { env: modelEnv, fetchImpl: () => { throw new Error('must not call'); } });
  const { result } = await rpc(1, 'tools/list', {});
  const tool = result.tools.find((item) => item.name === 'ask_model');
  assert(tool);
  assert.equal(tool.annotations.openWorldHint, true);
  assert.equal(tool.annotations.destructiveHint, false);
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ['message']);
});

test('ask_model calls the configured Azure deployment with the managed-identity token', async (t) => {
  let calls = 0;
  const rpc = await fixture(t, { env: modelEnv, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, 'https://example-account.openai.azure.com/openai/v1/responses');
    assert.equal(options.headers.Authorization, 'Bearer identity-access-token');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'gpt-4.1-mini');
    assert.equal(body.input, 'What is MCP?');
    assert.equal(body.max_output_tokens, 512);
    assert.deepEqual(body.tools, []);
    return completed('MCP is a protocol.');
  } });
  const { result } = await rpc(2, 'tools/call', { name: 'ask_model', arguments: { message: 'What is MCP?' } });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.content, [{ type: 'text', text: 'MCP is a protocol.' }]);
  assert.equal(calls, 1);
});

test('ask_model fails closed with sanitized codes and never calls an unconfigured model', async (t) => {
  const rpc = await fixture(t, { env: { APP_API_TOKEN: token }, fetchImpl: () => { throw new Error('must not call'); } });
  const { result } = await rpc(3, 'tools/call', { name: 'ask_model', arguments: { message: 'Hello' } });
  assert.equal(result.isError, true);
  assert.deepEqual(result.content, [{ type: 'text', text: 'model_not_configured' }]);

  const failing = await fixture(t, { env: modelEnv, fetchImpl: async () => new Response('denied', { status: 403 }) });
  const denied = (await failing(4, 'tools/call', { name: 'ask_model', arguments: { message: 'Hello' } })).result;
  assert.equal(denied.isError, true);
  assert.deepEqual(denied.content, [{ type: 'text', text: 'model_response_failed' }]);
  assert(!JSON.stringify(denied).includes('denied'));
});

test('ask_model rejects blank and oversized messages before any model call', async (t) => {
  const rpc = await fixture(t, { env: modelEnv, fetchImpl: () => { throw new Error('must not call'); } });
  for (const message of ['   ', 'x'.repeat(2001)]) {
    const response = await rpc(5, 'tools/call', { name: 'ask_model', arguments: { message } });
    assert(response.error || response.result?.isError, `expected rejection for length ${message.length}`);
  }
});

test('the AI endpoint and the MCP tool share the same app token and model client', async (t) => {
  let calls = 0;
  const app = createApp({ credential, env: modelEnv, fetchImpl: async () => { calls++; return completed(); } });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(() => new Promise((resolve) => { app.close(resolve); app.closeAllConnections(); }));
  const base = `http://127.0.0.1:${app.address().port}`;
  const agent = await fetch(`${base}/agent`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'Hi' }),
  });
  assert.equal(agent.status, 200);
  assert.deepEqual(await agent.json(), { reply: 'A short answer' });
  const setup = await (await fetch(`${base}/api/setup`)).json();
  assert.equal(setup.code, 'response_verified');
  assert.equal((await fetch(`${base}/assistant`)).status, 200);
  assert.equal((await fetch(`${base}/assistant.html`)).status, 404);
  assert.equal(calls, 1);
});
