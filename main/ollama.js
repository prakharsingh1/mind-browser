// =============================================================================
// Local Mind Browser — Ollama Manager
// =============================================================================
// Manages communication with the local Ollama server at localhost:11434.
// Provides connection checking, model listing, streaming & sync chat.

const OLLAMA_BASE = 'http://localhost:11434';

/**
 * Turn a raw network failure into something a person can act on.
 *
 * A local model that isn't running produces `TypeError: fetch failed` with the
 * real reason buried in .cause. On its own that string tells the user nothing —
 * it looks like the model refused, when actually the server was never there.
 */
function describeOllamaError(err, model) {
  const code = err?.cause?.code || '';
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ENOTFOUND') {
    return `Ollama isn't running, so the local model "${model}" can't be reached ` +
           `(${code} on ${OLLAMA_BASE}). Start Ollama, or pick a cloud model in the panel.`;
  }
  if (code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return `Ollama timed out loading "${model}". Large models can take a while on first run — try again, or pick a smaller one.`;
  }
  const base = err?.message || 'Ollama streaming failed';
  return code ? `${base} (${code})` : base;
}

// =============================================================================
// Connection & Models
// =============================================================================

/**
 * Check if Ollama is running and get available models.
 * @returns {{ connected: boolean, models: string[] }}
 */
async function checkConnection() {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { connected: false, models: [] };

    const data = await res.json();
    const models = (data.models || []).map(m => m.name || m.model);
    return { connected: true, models };
  } catch {
    return { connected: false, models: [] };
  }
}

/**
 * List available Ollama models.
 * @returns {string[]}
 */
async function listModels() {
  const { models } = await checkConnection();
  return models;
}

// =============================================================================
// Streaming Chat
// =============================================================================

/** Currently active AbortController for cancellation */
let activeController = null;

/**
 * Stream a chat completion from Ollama.
 * @param {Array} messages - Chat messages array [{role, content, images?}]
 * @param {string} model - Model name (e.g., 'llama3.2')
 * @param {Object} options - { num_ctx, temperature, etc. }
 * @param {Function} onToken - Called with each token string
 * @param {Function} onDone - Called when streaming completes with full response
 * @param {Function} onError - Called on error
 */
/** Models that answered "does not support tools" once. Remembered so the next
 *  call skips the doomed attempt instead of paying for it again. */
const noToolSupport = new Set();

/** Ollama speaks the OpenAI message shape, but our loop's neutral `toolCalls`
 *  and `role:'tool'` entries still need mapping onto it. */
function convertMessages(messages) {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return { role: 'tool', content: String(m.content ?? '') };
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        content: m.content || '',
        tool_calls: m.toolCalls.map((tc) => ({
          function: { name: tc.name, arguments: tc.args || {} }
        }))
      };
    }
    return { role: m.role, content: m.content, ...(m.images && { images: m.images }) };
  });
}

/** Ollama hands back `arguments` as an object; every other provider sends a
 *  JSON string. Normalise so the loop only ever parses one shape. */
function toGeneric(calls) {
  if (!calls || !calls.length) return undefined;
  return calls.map((c, i) => ({
    id: `${c.function?.name || 'tool'}_${i}`,
    type: 'function',
    function: {
      name: c.function?.name,
      arguments: typeof c.function?.arguments === 'string'
        ? c.function.arguments
        : JSON.stringify(c.function?.arguments || {})
    }
  }));
}

const isToolUnsupported = (msg) => /does not support tools|tools.*not supported/i.test(String(msg || ''));

async function streamChat(messages, model, options = {}, onToken, onDone, onError) {
  activeController = new AbortController();

  // Ask for tools only if this model has not already refused them.
  const wantTools = !!options.tools && !noToolSupport.has(model);

  try {
    const body = {
      model,
      messages: convertMessages(messages),
      stream: true,
      ...(wantTools && { tools: options.tools }),
      options: {
        num_ctx: options.num_ctx || 8192,
        ...(options.temperature !== undefined && { temperature: options.temperature })
      }
    };

    const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: activeController.signal
    });

    if (!res.ok) {
      const errText = await res.text();
      // The model simply cannot do tool calling. Remember it, then rerun the
      // identical request in text mode so the task continues rather than dying.
      if (wantTools && isToolUnsupported(errText)) {
        noToolSupport.add(model);
        activeController = null;
        return streamChat(messages, model, { ...options, tools: null }, onToken,
          (r) => onDone({ ...r, toolsUnsupported: true }), onError);
      }
      throw new Error(`Ollama error ${res.status}: ${errText}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';
    let buffer = '';
    let calls = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Parse NDJSON lines
      const lines = buffer.split('\n');
      buffer = lines.pop(); // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.message && parsed.message.content) {
            const token = parsed.message.content;
            fullContent += token;
            onToken(token);
          }
          if (parsed.message?.tool_calls?.length) {
            calls = calls.concat(parsed.message.tool_calls);
          }
          if (parsed.done) {
            onDone({
              content: fullContent,
              model: parsed.model,
              toolCalls: toGeneric(calls),
              totalDuration: parsed.total_duration,
              evalCount: parsed.eval_count
            });
            return;
          }
        } catch (parseErr) {
          // Skip malformed lines
        }
      }
    }

    // If we exit the loop without done:true, still call onDone
    onDone({ content: fullContent, model });
  } catch (err) {
    if (err.name === 'AbortError') {
      onDone({ content: '', model, cancelled: true });
    } else {
      onError(describeOllamaError(err, model));
    }
  } finally {
    activeController = null;
  }
}

/**
 * Non-streaming chat completion.
 * @param {Array} messages - Chat messages
 * @param {string} model - Model name
 * @param {Object} options - Options including num_ctx, format, etc.
 * @returns {Object} - { content, model }
 */
async function chatSync(messages, model, options = {}) {
  const body = {
    model,
    messages,
    stream: false,
    options: {
      num_ctx: options.num_ctx || 8192
    }
  };

  if (options.format) body.format = options.format;

  const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Ollama error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  return {
    content: data.message ? data.message.content : '',
    model: data.model
  };
}

/**
 * Stop the currently active streaming request.
 */
function stopStreaming() {
  if (activeController) {
    activeController.abort();
    activeController = null;
  }
}

module.exports = {
  checkConnection,
  listModels,
  streamChat,
  chatSync,
  stopStreaming
};
