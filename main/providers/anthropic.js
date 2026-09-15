// =============================================================================
// Local Mind Browser — Anthropic Provider
// =============================================================================
// Streaming chat with Anthropic Claude API via SSE.

let activeController = null;

/**
 * Convert OpenAI-format messages to Anthropic format.
 * Anthropic requires alternating user/assistant roles and a separate system param.
 */
/** Node's fetch hides the real failure in .cause — keep it. */
function describe(err) {
  const base = err?.message || 'request failed';
  const cause = err?.cause?.code || err?.cause?.message;
  return cause ? `${base} (${cause})` : base;
}

function convertMessages(messages) {
  let system = '';
  const converted = [];

  // Only plain-text messages may be merged. Tool blocks carry ids that must
  // stay in their own message, and concatenating an array onto a string would
  // silently produce "[object Object]".
  const push = (role, content) => {
    const prev = converted[converted.length - 1];
    if (prev && prev.role === role && typeof prev.content === 'string' && typeof content === 'string') {
      prev.content += '\n' + content;
    } else {
      converted.push({ role, content });
    }
  };

  for (const msg of messages) {
    if (msg.role === 'system') {
      system += (system ? '\n' : '') + msg.content;
      continue;
    }

    // A tool result is a user-role message carrying tool_result blocks.
    if (msg.role === 'tool') {
      push('user', [{
        type: 'tool_result',
        tool_use_id: msg.toolCallId,
        content: String(msg.content ?? '')
      }]);
      continue;
    }

    // An assistant turn that called tools becomes text + tool_use blocks.
    if (msg.role === 'assistant' && msg.toolCalls?.length) {
      const blocks = [];
      if (msg.content) blocks.push({ type: 'text', text: msg.content });
      for (const tc of msg.toolCalls) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args || {} });
      }
      push('assistant', blocks);
      continue;
    }

    push(msg.role === 'assistant' ? 'assistant' : 'user', msg.content);
  }

  // Anthropic requires first message to be 'user'
  if (converted.length > 0 && converted[0].role !== 'user') {
    converted.unshift({ role: 'user', content: '(Continue the conversation)' });
  }

  return { system, messages: converted };
}

/** Anthropic tool blocks -> the same shape the OpenAI-style providers emit, so
 *  the agent loop only ever deals with one format. */
function collectTools(blocks) {
  const out = Object.keys(blocks)
    .sort((a, b) => a - b)
    .map((i) => ({
      id: blocks[i].id,
      type: 'function',
      function: { name: blocks[i].name, arguments: blocks[i].json || '{}' }
    }));
  return out.length ? out : undefined;
}

async function streamChat(messages, model, apiKey, options = {}, onToken, onDone, onError) {
  activeController = new AbortController();
  try {
    const { system, messages: anthropicMessages } = convertMessages(messages);

    const body = {
      model,
      max_tokens: options.maxTokens || 4096,
      stream: true,
      messages: anthropicMessages,
      ...(system && { system }),
      ...(options.tools && { tools: options.tools })
    };

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: activeController.signal
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Anthropic error ${res.status}: ${errBody}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';
    let buffer = '';
    // tool_use arrives as a content_block_start followed by input_json_delta
    // fragments, so accumulate the JSON per block index and parse at the end.
    const toolBlocks = {};

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
          if (parsed.type === 'content_block_start' && parsed.content_block?.type === 'tool_use') {
            toolBlocks[parsed.index] = {
              id: parsed.content_block.id,
              name: parsed.content_block.name,
              json: ''
            };
          } else if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'input_json_delta') {
            const b = toolBlocks[parsed.index];
            if (b) b.json += parsed.delta.partial_json || '';
          } else if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
            fullContent += parsed.delta.text;
            onToken(parsed.delta.text);
          } else if (parsed.type === 'message_stop') {
            onDone({ content: fullContent, model, toolCalls: collectTools(toolBlocks) });
            return;
          }
        } catch {} // Skip malformed
      }
    }

    onDone({ content: fullContent, model, toolCalls: collectTools(toolBlocks) });
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

let cachedModels = null, cachedAt = 0;
const MODELS_TTL = 10 * 60 * 1000;

/** Ask Anthropic what this key can use, newest first. */
async function listModels(apiKey) {
  if (!apiKey) return [];
  if (cachedModels && Date.now() - cachedAt < MODELS_TTL) return cachedModels;
  try {
    const res = await fetch('https://api.anthropic.com/v1/models?limit=100', {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(6000)
    });
    if (!res.ok) return cachedModels || [];
    const data = await res.json();
    const ids = (data.data || [])
      .map((m) => m.id)
      .filter((id) => id.startsWith('claude-'))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    if (ids.length) { cachedModels = ids; cachedAt = Date.now(); }
    return ids.length ? ids : (cachedModels || []);
  } catch {
    return cachedModels || [];
  }
}

function stopStreaming() {
  if (activeController) { activeController.abort(); activeController = null; }
}

module.exports = { streamChat, listModels, stopStreaming };
