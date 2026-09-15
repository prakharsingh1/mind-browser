// =============================================================================
// Local Mind Browser — Writer Agent
// =============================================================================
// Generates, rewrites, translates, and formats text using LLMs.

const providers = require('../providers/index');

const WRITER_PROMPTS = {
  rewrite: 'You are a professional writer. Rewrite the given text to be clearer, more concise, and more professional. Maintain the original meaning.',
  simplify: 'You are a teacher. Rewrite the text in simple, easy-to-understand language. Avoid jargon.',
  formal: 'You are a business writer. Rewrite the text in a formal, professional tone.',
  creative: 'You are a creative writer. Rewrite the text to be more engaging and vivid.',
  translate: 'You are a translator. Translate the text accurately and naturally.',
  summarize: 'You are an editor. Create a concise summary highlighting the key points.',
  expand: 'You are a content writer. Expand the text with additional detail and examples.',
  bullets: 'You are an organizer. Convert the text into clear, organized bullet points.',
  email: 'You are an email writer. Convert the text into a well-structured email.',
  tweet: 'You are a social media manager. Convert the text into a compelling tweet (under 280 chars).'
};

/**
 * Process text with the writer agent.
 * @param {string} text - Input text
 * @param {string} action - 'rewrite', 'simplify', 'formal', 'creative', 'translate', etc.
 * @param {string} model - LLM model
 * @param {string} apiKey - Provider API key
 * @param {Object} options - { targetLanguage, tone, contextWindow }
 * @param {Function} onToken - Streaming token callback
 * @returns {string} - Processed text
 */
async function processText(text, action, model, apiKey, options = {}, onToken) {
  const systemPrompt = WRITER_PROMPTS[action] || WRITER_PROMPTS.rewrite;

  let userPrompt = text;
  if (action === 'translate' && options.targetLanguage) {
    userPrompt = `Translate to ${options.targetLanguage}:\n\n${text}`;
  }

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ];

  let result = '';
  const { provider, providerName } = providers.getProviderForModel(model);
  await new Promise((resolve) => {
    const tokenCb = (t) => { result += t; onToken?.(t); };
    const args = providerName === 'ollama'
      ? [messages, model, { num_ctx: options.contextWindow || 8192 }]
      : [messages, model, apiKey, {}];
    provider.streamChat(...args, tokenCb, () => resolve(), () => resolve());
  });

  return result;
}

module.exports = { processText };
