// =============================================================================
// Local Mind Browser — Analyst Agent
// =============================================================================
// Analyzes data, creates comparisons, and generates insights from page content.

const providers = require('../providers/index');

const ANALYST_SYSTEM_PROMPT = `You are a data analyst. When given data or page content:
1. Identify key patterns and trends
2. Create comparison tables when comparing items
3. Provide actionable insights
4. Use numbers and statistics when available
5. Rate findings by importance (high/medium/low)

Format output clearly with headers, tables, and bullet points.`;

/**
 * Compare data from multiple sources/tabs.
 * @param {Array} sources - [{ title, url, content }]
 * @param {string} query - What to compare
 * @param {string} model - LLM model
 * @param {string} apiKey - Provider API key
 * @param {Object} options - { contextWindow }
 * @param {Function} onToken - Streaming callback
 * @returns {string} - Comparison report
 */
async function compareSources(sources, query, model, apiKey, options = {}, onToken) {
  const sourceSummaries = sources.map((s, i) => {
    const truncated = (s.content || '').slice(0, 2000);
    return `Source ${i + 1}: ${s.title} (${s.url})\n${truncated}`;
  }).join('\n\n---\n\n');

  const messages = [
    { role: 'system', content: ANALYST_SYSTEM_PROMPT },
    { role: 'user', content: `Compare the following sources:\n\n${sourceSummaries}\n\nComparison query: ${query}\n\nCreate a detailed comparison with a table and key insights.` }
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

/**
 * Analyze page content and extract insights.
 * @param {string} content - Page text content
 * @param {string} analysisType - 'insights', 'sentiment', 'entities', 'topics'
 * @param {string} model - LLM model
 * @param {string} apiKey - Provider API key
 * @param {Object} options - { contextWindow }
 * @param {Function} onToken - Streaming callback
 * @returns {string} - Analysis result
 */
async function analyzeContent(content, analysisType, model, apiKey, options = {}, onToken) {
  const prompts = {
    insights: 'Analyze this content and provide key insights, patterns, and actionable takeaways.',
    sentiment: 'Analyze the sentiment of this content. Identify positive, negative, and neutral sections.',
    entities: 'Extract all named entities (people, companies, products, locations, dates) from this content.',
    topics: 'Identify the main topics and themes discussed in this content. Rank by prominence.'
  };

  const messages = [
    { role: 'system', content: ANALYST_SYSTEM_PROMPT },
    { role: 'user', content: `${prompts[analysisType] || prompts.insights}\n\nContent:\n${content.slice(0, 6000)}` }
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

module.exports = { compareSources, analyzeContent };
