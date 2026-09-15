// =============================================================================
// Local Mind Browser — OpenRouter Provider
// =============================================================================
// Streaming chat with OpenRouter API via SSE. Supports tool/function calling.

const { toOpenAIMessages } = require('./openai-messages');

let activeController = null;

/**
 * Stream chat from OpenRouter.
 */
/** Node's fetch hides the real failure in .cause — keep it. */
function describe(err) {
  const base = err?.message || 'request failed';
  const cause = err?.cause?.code || err?.cause?.message;
  return cause ? `${base} (${cause})` : base;
}

async function streamChat(messages, model, apiKey, options = {}, onToken, onDone, onError) {
  activeController = new AbortController();
  const cleanModel = model.replace(/^openrouter:/, '');
  try {
    const body = {
      model: cleanModel,
      messages: toOpenAIMessages(messages),
      stream: true,
      max_tokens: options.maxTokens || 4096,
      ...(options.temperature !== undefined && { temperature: options.temperature }),
      ...(options.tools && { tools: options.tools })
    };

    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:3000', // OpenRouter requires these for rankings
        'X-Title': 'Mind Browser'
      },
      body: JSON.stringify(body),
      signal: activeController.signal
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`OpenRouter error ${res.status}: ${errBody}`);
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

async function listModels(apiKey) {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      headers: apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}
    });
    if (!res.ok) return [];
    const json = await res.json();
    return json.data.map(m => m.id);
  } catch {
    return [];
  }
}

function stopStreaming() {
  if (activeController) { activeController.abort(); activeController = null; }
}

module.exports = { streamChat, listModels, stopStreaming };
