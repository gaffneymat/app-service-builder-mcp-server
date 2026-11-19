// The shop demo agent behind POST /api/demo/chat.
//
// It is a real MCP client: it talks JSON-RPC over HTTP to this app's own /mcp endpoint
// (initialize, tools/list, tools/call), offers the listed shop tools to the model as
// functions, and loops until the model answers. Every step is streamed to the page as
// one NDJSON line so the visitor can watch the AI decide and the MCP calls happen.
import { ModelError, MAX_MESSAGE } from './model.mjs';
import { SHOP_TOOLS } from './tools.mjs';
import { productsIn } from './catalogue.mjs';

const INSTRUCTIONS = 'You are the shop assistant for Northlight Cameras, a FICTIONAL camera shop used in a live demo '
  + 'of AI plus MCP tools. Use the tools for every fact about products, prices, stock, lens compatibility or orders; '
  + 'never invent products, prices, stock or orders. A lens only fits a camera with the same mount; never pair a lens '
  + 'with a camera that has fixedLens true, and check get_product before claiming anything fits. Prices are in SEK. Reply in the customer\'s language (Swedish '
  + 'or English). Be concise: at most about 120 words, short paragraphs or lines starting with "- ", no headings, no '
  + 'tables, no markdown links. Mention products by name and price. If the question is not about the shop, say in one '
  + 'sentence that this demo only covers the shop\'s products, stock and orders.';

export const DEMO_LIMITS = { message: 1000, history: 6, rounds: 5, toolCalls: 8, deadlineMs: 45_000 };
const clip = (text, n) => (text.length > n ? `${text.slice(0, n)}...` : text);

export function createDemo({ model, token, perMinute = 12, perDay = 300 }) {
  let day = '';
  let dayCount = 0;
  let recent = [];

  /** Process-wide limits; they reset on restart, which is acceptable for a demo. */
  function admit() {
    const now = Date.now();
    const today = new Date(now).toISOString().slice(0, 10);
    if (today !== day) { day = today; dayCount = 0; }
    recent = recent.filter((t) => now - t < 60_000);
    if (dayCount >= perDay) return 'daily_limit_reached';
    if (recent.length >= perMinute) return 'busy_try_again_in_a_minute';
    dayCount++;
    recent.push(now);
    return null;
  }

  function parse(body) {
    let input;
    try { input = JSON.parse(body); } catch { return null; }
    if (!input || typeof input.message !== 'string' || !input.message.trim() || input.message.length > DEMO_LIMITS.message) return null;
    const history = input.history ?? [];
    if (!Array.isArray(history) || history.length > DEMO_LIMITS.history || history.some((h) => !h
      || !['user', 'assistant'].includes(h.role) || typeof h.text !== 'string' || !h.text.trim() || h.text.length > MAX_MESSAGE)) return null;
    return { message: input.message.trim(), history };
  }

  return async function chat(req, res, body) {
    const input = parse(body);
    if (!input) return { status: 400, error: 'message_must_be_1_to_1000_characters' };
    if (!model.configured()) return { status: 503, error: 'model_not_configured' };
    if (token.length < 32) return { status: 503, error: 'app_auth_not_configured' };
    const refused = admit();
    if (refused) return { status: 429, error: refused };

    const started = Date.now();
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), DEMO_LIMITS.deadlineMs);
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    const emit = (event) => { if (!res.writableEnded) res.write(`${JSON.stringify({ at: Date.now() - started, ...event })}\n`); };

    // Loopback MCP client against this same process.
    const mcpUrl = `http://127.0.0.1:${req.socket.localPort}/mcp`;
    let protocol;
    let rpcId = 0;
    async function rpc(method, params, notify = false) {
      const message = { jsonrpc: '2.0', ...(notify ? {} : { id: ++rpcId }), method, ...(params ? { params } : {}) };
      const t0 = Date.now();
      const response = await fetch(mcpUrl, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: {
          'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${token}`, ...(protocol ? { 'MCP-Protocol-Version': protocol } : {}),
        },
        body: JSON.stringify(message),
      });
      if (!response.ok) throw new Error('mcp_http_failed');
      const reply = response.status === 202 ? null : await response.json();
      if (reply?.error) throw new Error('mcp_error');
      return { message, reply, ms: Date.now() - t0 };
    }
    const wire = (value) => clip(JSON.stringify(value, null, 1), 2400);

    let modelCalls = 0;
    let toolCalls = 0;
    const tokens = { input: 0, output: 0 };
    try {
      const init = await rpc('initialize', {
        protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'northlight-demo-agent', version: '1.0.0' },
      });
      protocol = init.reply.result.protocolVersion;
      await rpc('notifications/initialized', undefined, true);
      emit({ t: 'mcp', method: 'initialize', ms: init.ms, summary: `Connected to ${init.reply.result.serverInfo?.name} (protocol ${protocol})`, request: wire(init.message), response: wire(init.reply) });

      const listed = await rpc('tools/list', {});
      const offered = listed.reply.result.tools.filter((tool) => SHOP_TOOLS.includes(tool.name));
      emit({ t: 'mcp', method: 'tools/list', ms: listed.ms, summary: `${listed.reply.result.tools.length} tools found; ${offered.length} shop tools offered to the AI`, tools: offered.map((tool) => tool.name), request: wire(listed.message), response: wire(listed.reply) });
      const functions = offered.map((tool) => {
        const { $schema, ...parameters } = tool.inputSchema ?? { type: 'object', properties: {} };
        return { type: 'function', name: tool.name, description: tool.description, parameters, strict: false };
      });

      const conversation = [...input.history.map((h) => ({ role: h.role, content: h.text })), { role: 'user', content: input.message }];
      let answer = '';
      for (let round = 1; round <= DEMO_LIMITS.rounds && !answer; round++) {
        const last = round === DEMO_LIMITS.rounds || toolCalls >= DEMO_LIMITS.toolCalls;
        emit({ t: 'model-start', round });
        const t0 = Date.now();
        const turn = await model.respond({
          instructions: last ? `${INSTRUCTIONS} Answer now with the information you already have.` : INSTRUCTIONS,
          input: conversation, tools: last ? [] : functions,
        }, controller.signal);
        modelCalls++;
        tokens.input += turn.usage.input;
        tokens.output += turn.usage.output;
        emit({
          t: 'model', round, ms: Date.now() - t0, tokens: turn.usage,
          decision: turn.calls.length ? 'tools' : 'answer',
          calls: turn.calls.map((c) => ({ name: c.name, arguments: clip(c.arguments, 400) })),
        });
        if (!turn.calls.length) { answer = turn.text; break; }
        conversation.push(...turn.calls);
        for (const call of turn.calls) {
          let output;
          if (toolCalls >= DEMO_LIMITS.toolCalls) {
            output = JSON.stringify({ error: 'tool_call_limit_reached' });
          } else {
            toolCalls++;
            let args;
            try { args = JSON.parse(call.arguments || '{}'); } catch { args = null; }
            if (!args || typeof args !== 'object') {
              output = JSON.stringify({ error: 'arguments_were_not_valid_json' });
              emit({ t: 'tool', name: call.name, arguments: clip(call.arguments, 400), ok: false, summary: 'The AI sent arguments that were not valid JSON' });
            } else {
              const called = await rpc('tools/call', { name: call.name, arguments: args });
              const result = called.reply.result;
              output = clip((result.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n'), 6000);
              let parsed = null;
              try { parsed = JSON.parse(output); } catch { /* tool returned plain text */ }
              emit({
                t: 'tool', name: call.name, arguments: args, ok: !result.isError && !parsed?.error, ms: called.ms,
                summary: describe(call.name, parsed), products: parsed ? productsIn(parsed) : [],
                request: wire(called.message), response: wire(called.reply),
              });
            }
          }
          conversation.push({ type: 'function_call_output', call_id: call.call_id, output });
        }
      }
      emit({ t: 'answer', text: answer || 'Sorry, I could not finish that within the demo limits.' });
    } catch (error) {
      const code = error instanceof ModelError ? error.code : controller.signal.aborted ? 'request_timeout' : 'demo_failed';
      emit({ t: 'error', code });
    } finally {
      clearTimeout(deadline);
      emit({ t: 'done', ms: Date.now() - started, modelCalls, toolCalls, tokens });
      res.end();
    }
    return null;
  };
}

function describe(name, parsed) {
  if (!parsed) return 'Returned text';
  if (parsed.error) return `Returned an error: ${parsed.error}`;
  if (name === 'search_products') return `${parsed.count} matching product${parsed.count === 1 ? '' : 's'}`;
  if (name === 'get_product') return `${parsed.name}: ${parsed.compatibleLensesAndAccessories?.length ?? 0} compatible items`;
  if (name === 'check_stock') return `${parsed.name}: ${parsed.stock.map((s) => `${s.store} ${s.units}`).join(', ')}`;
  if (name === 'get_order_status') return `${parsed.orderNumber}: ${parsed.status}`;
  return 'Done';
}
