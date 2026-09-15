// =============================================================================
// Local Mind Browser — Groq Provider
// =============================================================================
// Streaming chat with Groq API (OpenAI-compatible endpoint).

const { toOpenAIMessages } = require('./openai-messages');

let activeController = null;

/** Node's fetch hides the real failure in .cause — keep it. */
function describe(err) {
  const base = err?.message || 'request failed';
  const cause = err?.cause?.code || err?.cause?.message;
  return cause ? `${base} (${cause})` : base;
}

async function streamChat(messages, model, apiKey, options = {}, onToken, onDone, onError) {
  // Strip 'groq:' prefix if present
  const cleanModel = model.replace(/^groq:/, '');
  activeController = new AbortController();

  try {
    const body = {
      model: cleanModel,
      messages: toOpenAIMessages(messages),
      stream: true,
      max_tokens: options.maxTokens || 4096,
      ...(options.temperature !== undefined && { temperature: options.temperature }),
      ...(options.tools && { tools: options.tools })
    };

    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
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
      throw new Error(`Groq error ${res.status}: ${errBody}`);
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
        if (!trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') {
          onDone({ content: fullContent, model: cleanModel, toolCalls: toolCalls.length ? toolCalls : undefined });
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
          // Tool calls stream in fragments keyed by index; concatenate them.
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (tc.index === undefined) continue;
              if (!toolCalls[tc.index]) {
                toolCalls[tc.index] = { id: tc.id, type: tc.type, function: { name: '', arguments: '' } };
              }
              if (tc.id) toolCalls[tc.index].id = tc.id;
              if (tc.function?.name) toolCalls[tc.index].function.name += tc.function.name;
              if (tc.function?.arguments) toolCalls[tc.index].function.arguments += tc.function.arguments;
            }
          }
        } catch {}
      }
    }

    onDone({ content: fullContent, model: cleanModel, toolCalls: toolCalls.length ? toolCalls : undefined });
  } catch (err) {
    if (err.name === 'AbortError') {
      onDone({ content: '', model: cleanModel, cancelled: true });
    } else {
      onError(describe(err));
    }
  } finally {
    activeController = null;
  }
}

/**
 * Fetch available models from Groq API (filters out non-chat models).
 */
async function listModels(apiKey) {
  try {
    const res = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000)
    });

    if (!res.ok) return [];

    const data = await res.json();
    const excluded = ['whisper', 'tts', 'guard', 'vision', 'distil'];
    return (data.data || [])
      .filter(m => !excluded.some(ex => m.id.toLowerCase().includes(ex)))
      .map(m => m.id)
      .slice(0, 20);
  } catch {
    return [];
  }
}

function stopStreaming() {
  if (activeController) { activeController.abort(); activeController = null; }
}

module.exports = { streamChat, listModels, stopStreaming };
