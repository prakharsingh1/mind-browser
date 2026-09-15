// =============================================================================
// Local Mind Browser — Researcher Agent
// =============================================================================
// Conducts deep, multi-source research by running parallel search sub-tasks.

const providers = require('../providers/index');

const RESEARCHER_SYSTEM_PROMPT = `You are a research agent. When given a topic:
1. Search multiple sources for comprehensive information
2. Cross-reference findings for accuracy
3. Cite your sources with URLs
4. Organize findings into clear sections
5. Rate confidence for each finding (high/medium/low)

Output a structured research report with sections, key findings, and citations.`;

/**
 * Run a deep research task.
 * @param {string} topic - Research topic/question
 * @param {string} model - LLM model
 * @param {string} apiKey - Provider API key
 * @param {Object} options - { contextWindow, maxSources }
 * @param {Function} onProgress - Progress callback
 * @returns {Object} - { report, sources, confidence }
 */
async function research(topic, model, apiKey, options = {}, onProgress) {
  onProgress?.({ phase: 'planning', detail: 'Creating research plan...' });

  // Generate search queries
  const queries = await generateQueries(topic, model, apiKey, options);
  onProgress?.({ phase: 'searching', detail: `Searching ${queries.length} queries...` });

  // Execute searches (simulated — in production, would use web search API)
  const searchResults = [];
  for (const query of queries) {
    onProgress?.({ phase: 'searching', detail: `Searching: "${query}"` });
    searchResults.push({
      query,
      url: `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
      snippet: `Results for: ${query}`
    });
  }

  // Synthesize findings into a report
  onProgress?.({ phase: 'synthesizing', detail: 'Synthesizing findings into report...' });

  const report = await synthesizeReport(topic, searchResults, model, apiKey, options);

  onProgress?.({ phase: 'complete', detail: 'Research complete' });

  return {
    report,
    sources: searchResults,
    queryCount: queries.length
  };
}

async function generateQueries(topic, model, apiKey, options) {
  const messages = [
    { role: 'system', content: 'Generate 4-6 diverse search queries to research a topic thoroughly. Output as a JSON array of strings. No markdown.' },
    { role: 'user', content: `Topic: ${topic}` }
  ];

  let result = '';
  const { provider, providerName } = providers.getProviderForModel(model);
  await new Promise((resolve) => {
    const args = providerName === 'ollama'
      ? [messages, model, { num_ctx: options.contextWindow || 8192 }]
      : [messages, model, apiKey, {}];
    provider.streamChat(...args, (t) => { result += t; }, () => resolve(), () => resolve());
  });

  try {
    const match = result.match(/\[[\s\S]*\]/);
    return match ? JSON.parse(match[0]) : [topic];
  } catch {
    return [topic, `${topic} overview`, `${topic} latest research`];
  }
}

async function synthesizeReport(topic, sources, model, apiKey, options) {
  const messages = [
    { role: 'system', content: RESEARCHER_SYSTEM_PROMPT },
    { role: 'user', content: `Research topic: ${topic}\n\nSources found:\n${sources.map((s, i) => `${i + 1}. ${s.query} — ${s.url}`).join('\n')}\n\nWrite a comprehensive research report with sections, key findings, and confidence ratings.` }
  ];

  let report = '';
  const { provider, providerName } = providers.getProviderForModel(model);
  await new Promise((resolve) => {
    const args = providerName === 'ollama'
      ? [messages, model, { num_ctx: options.contextWindow || 8192 }]
      : [messages, model, apiKey, {}];
    provider.streamChat(...args, (t) => { report += t; }, () => resolve(), () => resolve());
  });

  return report;
}

module.exports = { research };
