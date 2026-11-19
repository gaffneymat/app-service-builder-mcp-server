import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createApp } from './server.mjs';

const token = 'local-test-token-'.repeat(3);
const env = {
  APP_API_TOKEN: token, MODEL_SERVICE: 'azure-openai',
  AZURE_OPENAI_ENDPOINT: 'https://example-account.openai.azure.com/openai/v1/',
  AZURE_OPENAI_DEPLOYMENT: 'gpt-4.1-mini',
};
const credential = { getToken: async () => ({ token: 'identity-access-token' }) };
const reply = (output, usage = { input_tokens: 100, output_tokens: 20 }) => new Response(JSON.stringify({ status: 'completed', output, usage }));
const callTool = (name, args, id = `call_${name}`) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) });
const say = (text) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
const browser = { 'Content-Type': 'application/json', Origin: 'http://localhost:8080', 'Sec-Fetch-Site': 'same-origin' };

async function fixture(t, options = {}) {
  const app = createApp({ env, credential, ...options });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(() => new Promise((resolve) => { app.close(resolve); app.closeAllConnections(); }));
  const base = `http://127.0.0.1:${app.address().port}`;
  return (body, headers = browser) => fetch(`${base}/api/demo/chat`, { method: 'POST', headers, body: JSON.stringify(body) });
}
const events = async (response) => (await response.text()).trim().split('\n').map((line) => JSON.parse(line));

test('the demo agent lists MCP tools, runs the calls the model asks for and streams every step', async (t) => {
  const requests = [];
  const script = [
    reply([callTool('search_products', { query: 'mirrorless', maxPriceSek: 15000 })]),
    reply([callTool('check_stock', { productId: 'LUM-Z5', store: 'Stockholm' }), callTool('check_stock', { productId: 'KES-K30', store: 'Stockholm' }, 'call_2')]),
    reply([say('- **Lumora Z5**, 14 990 kr: 3 in Stockholm')]),
  ];
  const chat = await fixture(t, { fetchImpl: async (url, options) => {
    assert.equal(url, 'https://example-account.openai.azure.com/openai/v1/responses');
    requests.push(JSON.parse(options.body));
    return script.shift();
  } });
  const response = await chat({ message: 'Mirrorless under 15 000 kr in Stockholm?', history: [{ role: 'user', text: 'Hej' }, { role: 'assistant', text: 'Hej!' }] });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/x-ndjson/);
  const log = await events(response);
  assert.deepEqual(log.map((e) => e.t), ['mcp', 'mcp', 'model-start', 'model', 'tool', 'model-start', 'model', 'tool', 'tool', 'model-start', 'model', 'answer', 'done']);
  assert.equal(log[0].method, 'initialize');
  assert.deepEqual(log[1].tools, ['search_products', 'get_product', 'check_stock', 'get_order_status']);
  assert.match(log[1].request, /"tools\/list"/);
  const search = log[4];
  assert.equal(search.name, 'search_products');
  assert.equal(search.ok, true);
  assert.deepEqual(search.products.map((p) => p.id), ['LUM-Z5', 'KES-K30']);
  assert.match(search.request, /"tools\/call"/);
  assert(!JSON.stringify(log).includes(token), 'the app token never reaches the page');
  assert.equal(log.at(-2).text, '- **Lumora Z5**, 14 990 kr: 3 in Stockholm');
  assert.deepEqual({ ...log.at(-1), at: 0, ms: 0 }, { t: 'done', at: 0, ms: 0, modelCalls: 3, toolCalls: 3, tokens: { input: 300, output: 60 } });

  // The model is offered exactly the four shop tools as functions, never ask_model.
  assert.deepEqual(requests[0].tools.map((f) => f.name), ['search_products', 'get_product', 'check_stock', 'get_order_status']);
  assert(requests[0].tools.every((f) => f.type === 'function' && f.parameters.type === 'object' && !('$schema' in f.parameters)));
  assert.equal(requests[0].store, false);
  assert.deepEqual(requests[0].input.map((m) => m.role), ['user', 'assistant', 'user']);
  // Tool results go back to the model as function_call_output items keyed by call_id.
  const outputs = requests[2].input.filter((item) => item.type === 'function_call_output');
  assert.deepEqual(outputs.map((o) => o.call_id), ['call_search_products', 'call_check_stock', 'call_2']);
  assert.match(outputs[1].output, /"Stockholm","units":3/);
});

test('bad tool arguments and runaway tool loops are bounded and the model is told to answer', async (t) => {
  let calls = 0;
  const chat = await fixture(t, { fetchImpl: async (_url, options) => {
    calls++;
    const body = JSON.parse(options.body);
    if (body.tools.length === 0) return reply([say('Here is what I found.')]);
    return reply([{ type: 'function_call', call_id: `c${calls}a`, name: 'get_product', arguments: '{not json' },
      callTool('get_product', { productId: 'NOPE' }, `c${calls}b`)]);
  } });
  const log = await events(await chat({ message: 'Loop forever' }));
  const tools = log.filter((e) => e.t === 'tool');
  assert.equal(tools[0].ok, false);
  assert.match(tools[0].summary, /not valid JSON/);
  assert.equal(tools[1].ok, false);
  assert.match(tools[1].summary, /unknown_product/);
  assert(log.filter((e) => e.t === 'model').length <= 5);
  assert(tools.length <= 8);
  assert.equal(log.find((e) => e.t === 'answer').text, 'Here is what I found.');
});

test('demo route is browser same-origin only, validates input and fails closed without a model', async (t) => {
  const chat = await fixture(t, { fetchImpl: () => { throw new Error('must not call'); } });
  assert.equal((await chat({ message: 'Hi' }, { 'Content-Type': 'application/json' })).status, 403);
  assert.equal((await chat({ message: 'Hi' }, { ...browser, Origin: 'https://evil.example' })).status, 403);
  assert.equal((await chat({ message: 'Hi' }, { ...browser, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await chat({ message: 'Hi' }, { ...browser, 'Content-Type': 'text/plain' })).status, 415);
  for (const body of [{}, { message: '   ' }, { message: 'x'.repeat(1001) }, { message: 'Hi', history: [{ role: 'system', text: 'x' }] },
    { message: 'Hi', history: Array.from({ length: 7 }, () => ({ role: 'user', text: 'x' })) }]) {
    assert.equal((await chat(body)).status, 400, JSON.stringify(body).slice(0, 60));
  }
  const unconfigured = await fixture(t, { env: { APP_API_TOKEN: token } });
  const refused = await unconfigured({ message: 'Hi' });
  assert.equal(refused.status, 503);
  assert.deepEqual(await refused.json(), { error: 'model_not_configured' });
});

test('per-minute and daily caps refuse further demo questions', async (t) => {
  const chat = await fixture(t, { demoLimits: { perMinute: 2, perDay: 3 }, fetchImpl: async () => reply([say('ok')]) });
  assert.equal((await chat({ message: 'one' })).status, 200);
  assert.equal((await chat({ message: 'two' })).status, 200);
  const busy = await chat({ message: 'three' });
  assert.equal(busy.status, 429);
  assert.deepEqual(await busy.json(), { error: 'busy_try_again_in_a_minute' });
});

test('a model failure mid-conversation is reported as a sanitized step, not a crash', async (t) => {
  const chat = await fixture(t, { fetchImpl: async () => new Response('private provider detail', { status: 500 }) });
  const log = await events(await chat({ message: 'Hi' }));
  assert.deepEqual(log.map((e) => e.t), ['mcp', 'mcp', 'model-start', 'error', 'done']);
  assert.equal(log[3].code, 'model_response_failed');
  assert(!JSON.stringify(log).includes('private provider detail'));
});
