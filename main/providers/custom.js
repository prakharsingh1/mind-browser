// =============================================================================
// Local Mind Browser — Custom / local provider
// =============================================================================
// Any OpenAI-compatible endpoint, named by the user. That one shape covers
// almost everything people actually want to plug in:
//
//   • Local runtimes — LM Studio, llama.cpp's server, vLLM, LocalAI, Jan
//   • Gateways — LiteLLM, OpenRouter-style proxies, a company's own gateway
//   • Other vendors that speak the same protocol — DeepSeek, Mistral, Together,
//     Fireworks, Cerebras, xAI
//
// Rather than adding a provider file per vendor and going stale every time one
// launches, this asks for a base URL and a key and speaks the protocol they all
// implement. Models are addressed as `custom:<id>` so the router can tell them
// apart from the built-in providers.

const { toOpenAIMessages } = require('./openai-messages');
const storage = require('../storage');

let activeController = null;

/** Node's fetch hides the real failure in .cause — keep it. */
function describe(err) {
  const base = err?.message || 'request failed';
  const cause = err?.cause?.code || err?.cause?.message;
  return cause ? `${base} (${cause})` : base;
}

/**
 * Normalise whatever the user typed into a base that ends at /v1.
 *
 * People paste all of these, and every one of them should work:
 *   http://localhost:1234              -> http://localhost:1234/v1
 *   http://localhost:1234/v1           -> unchanged
 *   http://localhost:1234/v1/          -> trailing slash removed
 *   https://api.deepseek.com/v1/chat/completions -> trimmed back to /v1
 */
function baseUrl() {
  const raw = String(storage.getSettings()?.customApiBase || '').trim();
  if (!raw) return null;

  let url = raw.replace(/\s+/g, '');
  url = url.replace(/\/+$/, '');
  url = url.replace(/\/(chat\/completions|completions|models)$/i, '');
  if (!/\/v\d+$/.test(url)) url += '/v1';
  return url;
}

/** The id the endpoint knows, without our routing prefix. */
const bareModel = (model) => String(model).replace(/^custom:/, '');

async function streamChat(messages, model, apiKey, options = {}, onToken, onDone, onError) {
  const base = baseUrl();
  if (!base) {
    onError('No endpoint is set. Add one under Settings → Models → Custom or local.');
    return;
  }

  activeController = new AbortController();
  try {
    const body = {
      model: bareModel(model),
      messages: toOpenAIMessages(messages),
      stream: true,
      max_tokens: options.maxTokens || 4096,
      ...(options.temperature !== undefined && { temperature: options.temperature }),
      ...(options.tools && { tools: options.tools })
    };

    const headers = { 'Content-Type': 'application/json' };
    // Local runtimes usually want no key at all, and some reject an empty
    // Authorization header outright, so only send one when there is one.
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: activeController.signal
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`The endpoint returned ${res.status}${errBody ? `: ${errBody.slice(0, 300)}` : ''}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';
    let buffer = '';
    const toolCalls = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') {
          onDone({ content: fullContent, model, toolCalls: toolCalls.length ? toolCalls : undefined });
          return;
        }

        try {
          const parsed = JSON.parse(data);
          const choice = parsed.choices?.[0];
          const delta = choice?.delta;
          if (!delta) continue;

          if (delta.content) {
            fullContent += delta.content;
            onToken(delta.content);
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (tc.index === undefined) continue;
              if (!toolCalls[tc.index]) {
                toolCalls[tc.index] = { id: tc.id, type: tc.type || 'function', function: { name: '', arguments: '' } };
              }
              if (tc.function?.name) toolCalls[tc.index].function.name += tc.function.name;
              if (tc.function?.arguments) toolCalls[tc.index].function.arguments += tc.function.arguments;
            }
          }
        } catch { /* skip a malformed frame rather than dropping the stream */ }
      }
    }

    onDone({ content: fullContent, model, toolCalls: toolCalls.length ? toolCalls : undefined });
  } catch (err) {
    if (err.name === 'AbortError') onDone({ content: '', model, cancelled: true });
    else onError(describe(err));
  } finally {
    activeController = null;
  }
}

/**
 * Ask the endpoint what it serves. Falls back to whatever the user typed by
 * hand, because plenty of local servers do not implement /models.
 */
async function listModels(apiKey) {
  const base = baseUrl();
  if (!base) return [];

  const manual = String(storage.getSettings()?.customModels || '')
    .split(/[,\n]/).map((s) => s.trim()).filter(Boolean);

  try {
    const headers = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(6000) });
    if (res.ok) {
      const data = await res.json();
      const ids = (data.data || data.models || [])
        .map((m) => (typeof m === 'string' ? m : m.id || m.name))
        .filter(Boolean);
      // Prefixed so the router knows where to send them, and so an id that
      // happens to start with "gpt-" is not stolen by the OpenAI provider.
      if (ids.length) return ids.map((id) => `custom:${id}`);
    }
  } catch { /* fall through to the manual list */ }

  return manual.map((id) => (id.startsWith('custom:') ? id : `custom:${id}`));
}

/** Used by Settings to tell the user whether their endpoint is reachable. */
async function testConnection(apiKey) {
  const base = baseUrl();
  if (!base) return { ok: false, error: 'No endpoint set.' };
  try {
    const headers = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(6000) });
    if (!res.ok) return { ok: false, error: `${base} returned ${res.status}.` };
    const data = await res.json();
    const count = (data.data || data.models || []).length;
    return { ok: true, base, count };
  } catch (err) {
    return { ok: false, error: `Could not reach ${base} — ${describe(err)}` };
  }
}

function stopStreaming() {
  if (activeController) { activeController.abort(); activeController = null; }
}

module.exports = { streamChat, listModels, stopStreaming, testConnection, baseUrl };
