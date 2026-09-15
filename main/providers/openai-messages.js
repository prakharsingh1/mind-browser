// =============================================================================
// Local Mind Browser — OpenAI-shaped message conversion
// =============================================================================
// OpenAI, Groq and OpenRouter all take the same chat format, so they share this
// converter rather than each carrying their own copy.
//
// The agent loop keeps history in a neutral shape so it does not have to know
// which provider it is talking to:
//   { role:'assistant', content, toolCalls:[{ id, name, args }] }
//   { role:'tool', toolCallId, name, content }
// This maps that onto the wire format.

function toOpenAIMessages(messages) {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.toolCallId, content: String(m.content ?? '') };
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        // The API rejects an assistant turn with neither content nor tool_calls,
        // and wants null rather than '' when the turn is only tool calls.
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) }
        }))
      };
    }
    return { role: m.role, content: m.content };
  });
}

module.exports = { toOpenAIMessages };
