// =============================================================================
// Local Mind Browser — OpenAI Provider
// =============================================================================
// Streaming chat with OpenAI API via SSE. Supports tool/function calling.

const { toOpenAIMessages } = require('./openai-messages');

let activeController = null;

/**
 * Stream chat from OpenAI.
 */
/** Node's fetch hides the real failure in .cause — keep it. */
function describe(err) {
  const base = err?.message || 'request failed';
  const cause = err?.cause?.code || err?.cause?.message;
  return cause ? `${base} (${cause})` : base;
}

async function streamChat(messages, model, apiKey, options = {}, onToken, onDone, onError) {
  activeController = new AbortController();
  try {
    const body = {
      model,
      messages: toOpenAIMessages(messages),
      stream: true,
      max_tokens: options.maxTokens || 4096,
      ...(options.temperature !== undefined && { temperature: options.temperature }),
      ...(options.tools && { tools: options.tools })
    };

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: activeController.signal
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`OpenAI error ${res.status}: ${errBody}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';
    let buffer = '';
    let toolCalls = [];

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
          const delta = parsed.choices?.[0]?.delta;
          if (!delta) continue;

          if (delta.content) {
            fullContent += delta.content;
            onToken(delta.content);
          }

          // Handle tool calls
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (tc.index !== undefined) {
                if (!toolCalls[tc.index]) {
                  toolCalls[tc.index] = { id: tc.id, type: tc.type, function: { name: '', arguments: '' } };
                }
                if (tc.function?.name) toolCalls[tc.index].function.name += tc.function.name;
                if (tc.function?.arguments) toolCalls[tc.index].function.arguments += tc.function.arguments;
              }
            }
          }
        } catch {} // Skip malformed
      }
    }

    onDone({ content: fullContent, model, toolCalls: toolCalls.length ? toolCalls : undefined });
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

/** Ask OpenAI what this key can use, newest first. */
async function listModels(apiKey) {
  if (!apiKey) return [];
  if (cachedModels && Date.now() - cachedAt < MODELS_TTL) return cachedModels;
  try {
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(6000)
    });
    if (!res.ok) return cachedModels || [];
    const data = await res.json();
    const skip = /embedding|whisper|tts|dall-e|moderation|audio|realtime|transcribe|image/i;
    const ids = (data.data || [])
      .map((m) => m.id)
      .filter((id) => /^(gpt|o\d)/.test(id) && !skip.test(id))
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
