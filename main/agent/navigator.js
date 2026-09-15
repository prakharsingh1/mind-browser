// =============================================================================
// Local Mind Browser — Navigator Agent
// =============================================================================
// Executes individual browser automation steps from the planner's plan.
// Interacts with webviews to click, type, scroll, read, and extract.

const providers = require('../providers/index');
const fs = require('fs');
const path = require('path');
const os = require('os');

const NAVIGATOR_SYSTEM_PROMPT = `You are a browser navigator agent. You execute specific browser actions.
When asked to analyze or extract data, provide clear, structured output.
When asked to summarize, be concise and highlight key points.
Always respond with factual information based on the page content provided.`;

/**
 * Execute a single planned step.
 * @param {Object} step - { action, detail, url?, selector?, text?, query? }
 * @param {string} model - LLM model
 * @param {string} apiKey - Provider API key
 * @param {Object} context - { mainWindow, contextWindow }
 * @returns {Object} - { success, summary, data? }
 */
async function executeStep(step, model, apiKey, context = {}) {
  try {
    switch (step.action) {
      case 'navigate':
        return await handleNavigate(step, context);

      case 'click':
        return await handleClick(step, context);

      case 'type':
        return await handleType(step, context);

      case 'scroll':
        return await handleScroll(step, context);

      case 'read':
        return await handleRead(step, context);

      case 'search':
        return await handleSearch(step, context);

      case 'extract':
        return await handleExtract(step, model, apiKey, context);

      case 'summarize':
        return await handleSummarize(step, model, apiKey, context);

      case 'wait':
        return await handleWait(step);

      case 'screenshot':
        return { success: true, summary: 'Screenshot captured' };

      case 'fill_form':
        return await handleFillForm(step, context);

      case 'compare':
        return await handleCompare(step, model, apiKey, context);

      case 'search_local_files':
        return await handleSearchLocalFiles(step);

      case 'read_local_file':
        return await handleReadLocalFile(step);

      default:
        return { success: true, summary: `Action "${step.action}" acknowledged` };
    }
  } catch (err) {
    return { success: false, summary: `Error: ${err.message}`, continueOnError: true };
  }
}

// ── Action Handlers ──────────────────────────────────────────────────

async function handleNavigate(step, context) {
  const url = step.url || step.detail;
  if (context.mainWindow) {
    if (step.newTab) {
      context.mainWindow.webContents.send('agent-navigate-new-tab', { url });
    } else {
      context.mainWindow.webContents.send('agent-navigate', { url });
    }
  }
  // Wait for page to load
  await delay(2000);
  return { success: true, summary: `Navigated to ${url}${step.newTab ? ' (New Tab)' : ''}` };
}

async function handleClick(step, context) {
  if (context.mainWindow) {
    context.mainWindow.webContents.send('agent-action', {
      action: 'click',
      params: { index: step.elementIndex, selector: step.selector, description: step.detail }
    });
  }
  await delay(1000);
  return { success: true, summary: `Clicked: ${step.detail}` };
}

async function handleType(step, context) {
  if (context.mainWindow) {
    context.mainWindow.webContents.send('agent-action', {
      action: 'type',
      params: { index: step.elementIndex, selector: step.selector, text: step.text }
    });
  }
  await delay(500);
  return { success: true, summary: `Typed: "${step.text}"` };
}

async function handleScroll(step, context) {
  if (context.mainWindow) {
    context.mainWindow.webContents.send('agent-action', {
      action: 'scroll',
      params: { direction: step.direction || 'down' }
    });
  }
  await delay(800);
  return { success: true, summary: `Scrolled ${step.direction || 'down'}` };
}

async function handleRead(step, context) {
  // Request page content from the active webview
  if (context.mainWindow) {
    context.mainWindow.webContents.send('agent-request-content');
  }
  await delay(1000);
  return { success: true, summary: 'Page content read' };
}

async function handleSearch(step, context) {
  const query = step.query || step.detail;
  const url = `https://duckduckgo.com/?q=${encodeURIComponent(query)}`;
  if (context.mainWindow) {
    context.mainWindow.webContents.send('agent-navigate', { url });
  }
  await delay(2000);
  return { success: true, summary: `Searched: "${query}"` };
}

async function handleExtract(step, model, apiKey, context) {
  // Use LLM to extract structured data from page content
  const messages = [
    { role: 'system', content: NAVIGATOR_SYSTEM_PROMPT },
    { role: 'user', content: `Extract the following from the current page: ${step.detail}\nFormat: ${step.format || 'structured text'}` }
  ];

  let result = '';
  const { provider, providerName } = providers.getProviderForModel(model);
  await new Promise((resolve) => {
    const args = providerName === 'ollama'
      ? [messages, model, { num_ctx: context.contextWindow || 8192 }]
      : [messages, model, apiKey, {}];
    provider.streamChat(...args, (t) => { result += t; }, () => resolve(), () => resolve());
  });

  return { success: true, summary: 'Data extracted', data: result };
}

async function handleSummarize(step, model, apiKey, context) {
  const messages = [
    { role: 'system', content: NAVIGATOR_SYSTEM_PROMPT },
    { role: 'user', content: `Summarize: ${step.detail}` }
  ];

  let result = '';
  const { provider, providerName } = providers.getProviderForModel(model);
  await new Promise((resolve) => {
    const args = providerName === 'ollama'
      ? [messages, model, { num_ctx: context.contextWindow || 8192 }]
      : [messages, model, apiKey, {}];
    provider.streamChat(...args, (t) => { result += t; }, () => resolve(), () => resolve());
  });

  return { success: true, summary: result.slice(0, 500) };
}

async function handleWait(step) {
  const ms = step.duration || 2000;
  await delay(ms);
  return { success: true, summary: `Waited ${ms}ms` };
}

async function handleFillForm(step, context) {
  if (context.mainWindow && step.fields) {
    for (const field of step.fields) {
      context.mainWindow.webContents.send('agent-action', {
        action: 'type',
        params: { selector: field.selector, text: field.value }
      });
      await delay(300);
    }
  }
  return { success: true, summary: 'Form filled' };
}

async function handleCompare(step, model, apiKey, context) {
  const messages = [
    { role: 'system', content: 'You are a comparison analyst. Create a clear comparison table.' },
    { role: 'user', content: `Compare: ${step.detail}. Output a markdown table.` }
  ];

  let result = '';
  const { provider, providerName } = providers.getProviderForModel(model);
  await new Promise((resolve) => {
    const args = providerName === 'ollama'
      ? [messages, model, { num_ctx: context.contextWindow || 8192 }]
      : [messages, model, apiKey, {}];
    provider.streamChat(...args, (t) => { result += t; }, () => resolve(), () => resolve());
  });

  return { success: true, summary: 'Comparison complete', data: result };
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function handleSearchLocalFiles(step) {
  const query = (step.query || '').toLowerCase();
  if (!query) return { success: false, summary: 'No search query provided' };

  const dirsToSearch = [
    path.join(os.homedir(), 'Documents'),
    path.join(os.homedir(), 'Desktop'),
    path.join(os.homedir(), 'Downloads')
  ];

  let results = [];
  function searchDir(dir, depth = 0) {
    if (depth > 3) return; // limit depth
    try {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        const fullPath = path.join(dir, file);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            searchDir(fullPath, depth + 1);
          } else if (file.toLowerCase().includes(query)) {
            results.push(fullPath);
          }
        } catch (e) { /* ignore permission errors */ }
      }
    } catch (e) { /* ignore */ }
  }

  for (const dir of dirsToSearch) searchDir(dir);

  if (results.length > 0) {
    return { success: true, summary: `Found ${results.length} files matching "${query}"`, data: results.slice(0, 20).join('\n') };
  }
  return { success: false, summary: `No files found matching "${query}"` };
}

async function handleReadLocalFile(step) {
  const filePath = step.detail;
  if (!filePath || !fs.existsSync(filePath)) {
    return { success: false, summary: 'File not found' };
  }
  try {
    const ext = path.extname(filePath).toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.pdf', '.zip'].includes(ext)) {
      return { success: true, summary: `Read ${ext} file`, data: `[Binary file: ${filePath}]` };
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    return { success: true, summary: `Read file ${path.basename(filePath)}`, data: content.substring(0, 10000) };
  } catch (err) {
    return { success: false, summary: `Failed to read file: ${err.message}` };
  }
}

module.exports = { executeStep };
