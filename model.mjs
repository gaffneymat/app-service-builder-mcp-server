// Shared model client used by POST /agent, the ask_model MCP tool and the shop demo.
// Provider destinations stay fixed or restricted to Azure OpenAI resource origins,
// never caller-controlled URLs.

export const MAX_MESSAGE = 2000;
export const MAX_OUTPUT = 4000;
export const MAX_ACTIVE = 4;

/** Bound bytes before parsing, including chunked requests without Content-Length. */
export async function readBounded(stream, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) {
      stream.resume();
      throw new Error('body_limit');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** A sanitized failure: `code` is safe to show a caller, `status` is the HTTP status for /agent. */
export class ModelError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export function createModel({ env = process.env, fetchImpl = fetch, timeoutMs = 10_000, credential } = {}) {
  const token = env.APP_API_TOKEN ?? '';
  const azure = env.MODEL_SERVICE === 'azure-openai';
  const key = (azure ? env.AZURE_OPENAI_API_KEY : env.OPENAI_API_KEY) ?? '';
  const authMode = env.AZURE_OPENAI_AUTH_MODE ?? 'managed-identity';
  const managedIdentity = azure && authMode === 'managed-identity';
  const invalidAuth = azure && (!['managed-identity', 'api-key'].includes(authMode) || (managedIdentity && !!key.trim()));
  const model = (azure ? env.AZURE_OPENAI_DEPLOYMENT : env.OPENAI_MODEL) ?? '';
  let modelUrl = azure ? null : 'https://api.openai.com/v1/responses';
  let invalidEndpoint = false;
  if (azure && env.AZURE_OPENAI_ENDPOINT) {
    try {
      const endpoint = new URL(env.AZURE_OPENAI_ENDPOINT);
      if (endpoint.protocol !== 'https:' || endpoint.port || endpoint.username || endpoint.password
        || !['/', '/openai/v1/'].includes(endpoint.pathname) || endpoint.search || endpoint.hash
        || !/^[a-z0-9][a-z0-9-]*\.openai\.azure\.com$/.test(endpoint.hostname)) {
        throw new Error('invalid_endpoint');
      }
      modelUrl = `${endpoint.origin}/openai/v1/responses`;
    } catch {
      invalidEndpoint = true;
    }
  }
  const configured = () => !invalidAuth && ['openai', 'azure-openai'].includes(env.MODEL_SERVICE)
    && !!modelUrl && (managedIdentity || !!key.trim()) && !!model.trim();

  let active = 0;
  let outcome = 'not_checked';
  let checkedAt = 0;

  const setup = () => {
    const code = token.length < 32 ? 'app_auth_not_configured'
      : invalidEndpoint || invalidAuth ? 'model_configuration_invalid'
      : !configured() ? 'model_not_configured'
      : Date.now() - checkedAt > 300_000 ? 'not_checked' : outcome;
    return { code, model: configured() ? model : null, lastCheckedAt: checkedAt || null };
  };

  const leaks = (text, accessToken) => (key && text.includes(key))
    || (accessToken && text.includes(accessToken)) || (token && text.includes(token));

  /**
   * One bounded Responses API call. `finish(result, accessToken)` validates and shapes the
   * parsed provider result; any failure becomes a sanitized ModelError.
   */
  async function call(payload, signal, finish) {
    if (!configured()) throw new ModelError('model_not_configured', 503);
    if (active >= MAX_ACTIVE) throw new ModelError('busy', 429);
    active++;
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    let failure = 'model_response_failed';
    let accessToken = '';
    try {
      if (managedIdentity) {
        failure = 'model_access_denied';
        if (!credential) {
          const { ManagedIdentityCredential } = await import('@azure/identity');
          credential = new ManagedIdentityCredential(env.AZURE_CLIENT_ID ? { clientId: env.AZURE_CLIENT_ID } : {});
        }
        const acquired = await credential.getToken('https://cognitiveservices.azure.com/.default', { abortSignal: controller.signal });
        if (!acquired?.token) throw new Error('identity_token_unavailable');
        accessToken = acquired.token;
        failure = 'model_response_failed';
      }
      const response = await fetchImpl(modelUrl, {
        method: 'POST',
        headers: { ...(azure && !managedIdentity ? { 'api-key': key } : { Authorization: `Bearer ${managedIdentity ? accessToken : key}` }), 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, ...payload, store: false, stream: false }),
        signal: controller.signal, redirect: 'error',
      });
      if (!response.ok) {
        failure = response.status === 404 ? 'model_missing'
          : [401, 403].includes(response.status) ? 'model_access_denied'
            : response.status === 429 ? 'provider_limit' : 'provider_unavailable';
        throw new Error('upstream_failed');
      }
      // Node Readable.fromWeb permits the same byte cap for the provider response.
      const { Readable } = await import('node:stream');
      const result = JSON.parse(await readBounded(Readable.fromWeb(response.body), 65_536));
      if (result.status !== 'completed' || !Array.isArray(result.output)) throw new Error('incomplete');
      const shaped = finish(result, accessToken);
      outcome = 'response_verified';
      checkedAt = Date.now();
      return shaped;
    } catch {
      const timedOut = controller.signal.aborted;
      outcome = timedOut ? 'request_timeout' : failure;
      checkedAt = Date.now();
      throw timedOut ? new ModelError('request_timeout', 504) : new ModelError('model_response_failed', 502);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      active--;
    }
  }

  const textOf = (result) => {
    const parts = result.output.filter((item) => item.type === 'message' && item.role === 'assistant')
      .flatMap((item) => item.content ?? []).filter((item) => item.type === 'output_text');
    if (parts.some((item) => typeof item.text !== 'string')) throw new Error('invalid_output');
    return parts.map((item) => item.text).join('\n');
  };

  /** One bounded, tool-free turn. Resolves to the reply text or throws ModelError. */
  const ask = (message, signal) => call({
    input: message,
    instructions: 'You are a concise development assistant. Answer in plain text. Do not request secrets.',
    max_output_tokens: 512, tools: [],
  }, signal, (result, accessToken) => {
    const text = textOf(result);
    if (!text.trim() || text.length > MAX_OUTPUT || leaks(text, accessToken)) throw new Error('invalid_output');
    return text;
  });

  /**
   * One turn of a tool-calling conversation. Returns the function calls the model asked
   * for (if any), its text (if any), the raw output items to replay, and token usage.
   */
  const respond = ({ instructions, input, tools, maxOutputTokens = 700 }, signal) => call({
    instructions, input, tools, tool_choice: 'auto', parallel_tool_calls: true, max_output_tokens: maxOutputTokens,
  }, signal, (result, accessToken) => {
    const calls = result.output.filter((item) => item.type === 'function_call')
      .map((item) => ({ type: 'function_call', call_id: item.call_id, name: item.name, arguments: item.arguments }));
    if (calls.some((c) => typeof c.call_id !== 'string' || typeof c.name !== 'string' || typeof c.arguments !== 'string')) {
      throw new Error('invalid_output');
    }
    const text = textOf(result);
    if ((!calls.length && !text.trim()) || text.length > MAX_OUTPUT || leaks(text, accessToken)) throw new Error('invalid_output');
    return {
      calls, text,
      usage: { input: result.usage?.input_tokens ?? 0, output: result.usage?.output_tokens ?? 0 },
    };
  });

  return { ask, respond, setup, configured, get active() { return active; } };
}
