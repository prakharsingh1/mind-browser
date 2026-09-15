// =============================================================================
// Local Mind Browser — Planner Agent
// =============================================================================
// Analyzes a task and creates a structured execution plan with ordered steps.

const providers = require('../providers/index');

const PLANNER_SYSTEM_PROMPT = `You are a browser automation planner. Given a task, break it down into specific browser actions.

Output a JSON object with this structure:
{
  "goal": "Brief description of the goal",
  "steps": [
    { "action": "navigate", "detail": "Go to example.com", "url": "https://example.com" },
    { "action": "click", "detail": "Click the search button", "selector": "button#search" },
    { "action": "type", "detail": "Type the search query", "selector": "input#q", "text": "query" },
    { "action": "read", "detail": "Read the page content" },
    { "action": "extract", "detail": "Extract product prices", "format": "table" },
    { "action": "summarize", "detail": "Summarize the findings" }
  ]
}

Available actions:
- navigate: Go to a URL (add "newTab": true if you want to open it in a background tab for multi-tasking)
- click: Click an element (provide selector or description)
- type: Type text into an input (provide selector and text)
- scroll: Scroll the page (direction: up/down)
- read: Read the current page content
- extract: Extract structured data from the page
- search: Search the web for a query
- search_local_files: Search the user's Documents/Desktop for a file (provide "query": "resume" etc.)
- read_local_file: Read a specific local file (provide "detail": "absolute_file_path")
- summarize: Summarize collected information
- screenshot: Capture the page visually
- wait: Wait for a condition
- fill_form: Fill out a form with provided data
- compare: Compare data from multiple sources

Be concise. Output ONLY the JSON, no markdown fences.`;

/**
 * Create an execution plan for a task.
 * @param {string} task - The task description
 * @param {string} model - LLM model to use
 * @param {string} apiKey - API key for the provider
 * @param {Object} context - { pageContent, url, contextWindow }
 * @returns {Object} - { goal, steps[] }
 */
async function createPlan(task, model, apiKey, context = {}) {
  const messages = [
    { role: 'system', content: PLANNER_SYSTEM_PROMPT },
  ];

  // Add page context if available
  if (context.pageContent) {
    const truncated = context.pageContent.slice(0, 4000);
    messages.push({
      role: 'user',
      content: `Current page: ${context.url || 'unknown'}\nPage content (truncated):\n${truncated}`
    });
  }

  messages.push({
    role: 'user',
    content: `Task: ${task}\n\nCreate an execution plan. Output JSON only.`
  });

  // Use sync chat for planning (need full response to parse JSON)
  const { provider, providerName } = providers.getProviderForModel(model);
  let responseContent = '';

  await new Promise((resolve, reject) => {
    const streamFn = providerName === 'ollama'
      ? provider.streamChat.bind(provider, messages, model, { num_ctx: context.contextWindow || 8192 })
      : provider.streamChat.bind(provider, messages, model, apiKey, {});

    streamFn(
      (token) => { responseContent += token; },
      () => resolve(),
      (err) => reject(new Error(err))
    );
  });

  // Parse the JSON response
  try {
    // Try to extract JSON from the response (handle markdown fences)
    let jsonStr = responseContent;
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) jsonStr = fenceMatch[1];

    // Find first { to last }
    const start = jsonStr.indexOf('{');
    const end = jsonStr.lastIndexOf('}');
    if (start !== -1 && end !== -1) {
      jsonStr = jsonStr.slice(start, end + 1);
    }

    const plan = JSON.parse(jsonStr);
    return {
      goal: plan.goal || task,
      steps: Array.isArray(plan.steps) ? plan.steps : []
    };
  } catch (parseErr) {
    // If JSON parsing fails, create a simple plan
    return {
      goal: task,
      steps: [
        { action: 'search', detail: `Search for: ${task}`, query: task },
        { action: 'read', detail: 'Read the results' },
        { action: 'summarize', detail: 'Summarize findings' }
      ]
    };
  }
}

module.exports = { createPlan };
