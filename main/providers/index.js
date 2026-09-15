// =============================================================================
// Local Mind Browser — Provider Router
// =============================================================================
// Routes chat requests to the correct LLM provider based on model name prefix.
// Provides a unified streaming interface across all providers.

const ollama = require('../ollama');
const openai = require('./openai');
const anthropic = require('./anthropic');
const gemini = require('./gemini');
const groq = require('./groq');
const openrouter = require('./openrouter');
const custom = require('./custom');

/**
 * Determine which provider to use for a given model name.
 * @param {string} model - Model name/identifier
 * @returns {{ provider: object, providerName: string }}
 */
function getProviderForModel(model) {
  if (model.startsWith('gpt-')) return { provider: openai, providerName: 'openai' };
  if (model.startsWith('claude-')) return { provider: anthropic, providerName: 'anthropic' };
  if (model.startsWith('gemini-')) return { provider: gemini, providerName: 'gemini' };
  if (model.startsWith('groq:')) return { provider: groq, providerName: 'groq' };
  if (model.startsWith('openrouter:')) return { provider: openrouter, providerName: 'openrouter' };
  // Checked before the name-prefix rules below so a custom endpoint serving a
  // model called "gpt-4o" is not routed to OpenAI.
  if (model.startsWith('custom:')) return { provider: custom, providerName: 'custom' };
  // Default to Ollama (local models)
  return { provider: ollama, providerName: 'ollama' };
}

/**
 * Unified streaming chat across all providers.
 * @param {Array} messages - Chat messages [{role, content}]
 * @param {string} model - Model name
 * @param {string} apiKey - API key (empty for Ollama)
 * @param {Object} options - Provider-specific options
 * @param {Function} onToken - Called with each token string
 * @param {Function} onDone - Called when complete
 * @param {Function} onError - Called on error
 */
async function streamChat(messages, model, apiKey, options, onToken, onDone, onError) {
  const { provider, providerName } = getProviderForModel(model);

  if (providerName === 'ollama') {
    // Ollama doesn't need API key
    return provider.streamChat(messages, model, options, onToken, onDone, onError);
  }

  return provider.streamChat(messages, model, apiKey, options, onToken, onDone, onError);
}

// Last known live model ids per provider, refreshed by listAllModels(). The
// router runs synchronously and can't await a network call, so it reads this.
const lastKnown = {};
const cachedFor = (provider) => lastKnown[provider] || [];

/**
 * List all available models across all configured providers.
 * @param {Function} getApiKeyFn - Function to get API key for a provider
 * @returns {Object} - { ollama: [], openai: [], anthropic: [], gemini: [], groq: [] }
 */
async function listAllModels(getApiKeyFn) {
  const results = {
    ollama: [],
    openai: [],
    anthropic: [],
    gemini: [],
    groq: [],
    openrouter: [],
    custom: []
  };

  // Ollama models (always check)
  try {
    results.ollama = await ollama.listModels();
  } catch {}

  // OpenAI (ask the API; a static list goes stale when models are retired)
  const openaiKey = getApiKeyFn('openai');
  if (openaiKey) {
    try { results.openai = await openai.listModels(openaiKey); } catch {}
  }

  // Anthropic (ask the API for the same reason)
  const anthropicKey = getApiKeyFn('anthropic');
  if (anthropicKey) {
    try { results.anthropic = await anthropic.listModels(anthropicKey); } catch {}
  }

  // Gemini (ask the API — a hardcoded list goes stale when Google retires one)
  const geminiKey = getApiKeyFn('gemini');
  if (geminiKey) {
    try { results.gemini = await gemini.listModels(geminiKey); } catch {}
  }

  // Groq (dynamic list if key exists)
  const groqKey = getApiKeyFn('groq');
  if (groqKey) {
    try {
      results.groq = await groq.listModels(groqKey);
    } catch {}
  }

  // OpenRouter (dynamic list if key exists)
  const openrouterKey = getApiKeyFn('openrouter');
  if (openrouterKey) {
    try {
      results.openrouter = await openrouter.listModels(openrouterKey);
    } catch {}
  }

  // Custom endpoint (local runtime or any OpenAI-compatible API). It may need
  // no key at all, so unlike the others this is attempted whenever a base URL
  // has been set rather than only when a key exists.
  try {
    results.custom = await custom.listModels(getApiKeyFn('custom'));
  } catch {}

  for (const [prov, ids] of Object.entries(results)) {
    if (Array.isArray(ids) && ids.length) lastKnown[prov] = ids;
  }
  return results;
}

/**
 * Stop all active streaming.
 */
function stopAll() {
  ollama.stopStreaming();
  openai.stopStreaming();
  anthropic.stopStreaming();
  gemini.stopStreaming();
  groq.stopStreaming();
  openrouter.stopStreaming();
  custom.stopStreaming();
}

module.exports = {
  cachedFor,
  getProviderForModel,
  streamChat,
  listAllModels,
  stopAll
};
