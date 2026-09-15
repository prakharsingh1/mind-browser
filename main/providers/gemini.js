// =============================================================================
// Local Mind Browser — Gemini Provider
// =============================================================================
// Streaming chat with Google Gemini API via SSE.

let activeController = null;

/**
 * Convert OpenAI-format messages to Gemini format.
 * Gemini uses 'user'/'model' roles and requires alternating turns.
 */
/** Node's fetch hides the real failure in .cause — keep it. */
function describe(err) {
  const base = err?.message || 'request failed';
  const cause = err?.cause?.code || err?.cause?.message;
  return cause ? `${base} (${cause})` : base;
}

function convertMessages(messages) {
  let systemInstruction = '';
  const contents = [];

  // Only merge plain text turns. A functionCall/functionResponse part has no
  // .text, so the old merge would have written onto undefined.
  const push = (role, parts) => {
    const prev = contents[contents.length - 1];
    const mergeable = prev && prev.role === role &&
      prev.parts.length === 1 && typeof prev.parts[0].text === 'string' &&
      parts.length === 1 && typeof parts[0].text === 'string';
    if (mergeable) prev.parts[0].text += '\n' + parts[0].text;
    else contents.push({ role, parts });
  };

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemInstruction += (systemInstruction ? '\n' : '') + msg.content;
      continue;
    }

    // v1beta only accepts roles "user" and "model", so a tool result is a user
    // turn carrying a functionResponse part.
    if (msg.role === 'tool') {
      push('user', [{
        functionResponse: { name: msg.name, response: { result: String(msg.content ?? '') } }
      }]);
      continue;
    }

    if (msg.role === 'assistant' && msg.toolCalls?.length) {
      const parts = [];
      if (msg.content) parts.push({ text: msg.content });
      for (const tc of msg.toolCalls) parts.push({ functionCall: { name: tc.name, args: tc.args || {} } });
      push('model', parts);
      continue;
    }

    push(msg.role === 'assistant' ? 'model' : 'user', [{ text: msg.content }]);
  }

  return { systemInstruction, contents };
}

/** Gemini function calls -> the OpenAI-shaped form the agent loop consumes.
 *  Gemini issues no call ids, so synthesise stable ones from name + position. */
function toGeneric(calls) {
  if (!calls.length) return undefined;
  return calls.map((c, i) => ({
    id: `${c.name}_${i}`,
    type: 'function',
    function: { name: c.name, arguments: JSON.stringify(c.args || {}) }
  }));
}

async function streamChat(messages, model, apiKey, options = {}, onToken, onDone, onError) {
  activeController = new AbortController();
  try {
    const { systemInstruction, contents } = convertMessages(messages);

    const body = {
      contents,
      generationConfig: {
        maxOutputTokens: options.maxTokens || 4096,
        ...(options.temperature !== undefined && { temperature: options.temperature })
      }
    };

    if (systemInstruction) {
      body.systemInstruction = { parts: [{ text: systemInstruction }] };
    }
    if (options.tools) body.tools = options.tools;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: activeController.signal
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Gemini error ${res.status}: ${errBody}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';
    let buffer = '';
    const calls = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);

        try {
          const parsed = JSON.parse(data);
          // Walk EVERY part: a turn can mix text with functionCall, and reading
          // only parts[0] silently dropped whichever came second.
          for (const part of parsed.candidates?.[0]?.content?.parts || []) {
            if (part.text) {
              fullContent += part.text;
              onToken(part.text);
            } else if (part.functionCall) {
              calls.push(part.functionCall);
            }
          }
        } catch {} // Skip malformed
      }
    }

    onDone({ content: fullContent, model, toolCalls: toGeneric(calls) });
  } catch (err) {
    if (err.name === 'AbortError') {
      onDone({ content: '', model, cancelled: true });
    } else {
      onError(describe(err));
    }
  } finally {
    activeController = null;
  }
}

/**
 * Ask Google which models this key can actually use, newest first.
 *
 * A hardcoded list goes stale silently: Google retires a model and every call
 * fails with "no longer available to new users" while the dropdown keeps
 * offering it. Discovering them means the list can never name something that
 * doesn't exist.
 *
 * Sorting is by version number descending, so "latest" is a fact about the
 * response rather than a guess baked into the source.
 */
let cachedModels = null;
let cachedAt = 0;
const MODELS_TTL = 10 * 60 * 1000;

/** "gemini-3.5-flash-lite" -> 3.5, so newer families sort first. */
function versionOf(id) {
  const m = /gemini-(\d+(?:\.\d+)?)/.exec(id);
  return m ? parseFloat(m[1]) : 0;
}

/** Rank within a family: pro > flash > flash-lite. */
function tierOf(id) {
  if (id.includes('flash-lite')) return 0;
  if (id.includes('flash')) return 1;
  if (id.includes('pro')) return 2;
  return 1;
}

async function listModels(apiKey) {
  if (!apiKey) return [];
  if (cachedModels && Date.now() - cachedAt < MODELS_TTL) return cachedModels;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=200`,
      { signal: AbortSignal.timeout(6000) }
    );
    if (!res.ok) return cachedModels || [];
    const data = await res.json();

    const ids = (data.models || [])
      // only models that can actually answer a chat turn
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => String(m.name || '').replace(/^models\//, ''))
      .filter((id) => id.startsWith('gemini-'))
      // drop dated snapshots and previews; the bare alias tracks the latest
      .filter((id) => !/-(\d{3,})$/.test(id) && !/preview|exp|tuning/.test(id));

    ids.sort((a, b) => versionOf(b) - versionOf(a) || tierOf(b) - tierOf(a) || a.localeCompare(b));

    if (ids.length) { cachedModels = ids; cachedAt = Date.now(); }
    return ids.length ? ids : (cachedModels || []);
  } catch {
    return cachedModels || [];
  }
}

/** The newest model this key can use, for callers that just want one. */
async function latestModel(apiKey) {
  const ids = await listModels(apiKey);
  return ids[0] || '';
}

function stopStreaming() {
  if (activeController) { activeController.abort(); activeController = null; }
}

module.exports = { streamChat, listModels, latestModel, stopStreaming };
