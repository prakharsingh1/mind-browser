// =============================================================================
// Local Mind Browser — Agent Engine (Orchestrator)
// =============================================================================
// Manages the multi-agent loop: Planner → Navigator → sub-agents.
// Runs tasks autonomously with progress streaming to the renderer.

const ollama = require('../ollama');
const providers = require('../providers/index');
const { getApiKey, getSettings } = require('../storage');
const planner = require('./planner');
const navigator = require('./navigator');

let isRunning = false;
let shouldStop = false;

/**
 * Run an agent task end-to-end.
 * @param {string} task - Natural language task description
 * @param {string} model - Model name to use
 * @param {Object} options - { maxSteps, pageContent, url, elements }
 * @param {Function} onProgress - Called with { step, action, detail, status, icon }
 * @param {BrowserWindow} mainWindow - For webview automation
 * @returns {Object} - { success, result, steps }
 */
async function runAgent(task, model, options = {}, onProgress, mainWindow) {
  if (isRunning) {
    return { success: false, error: 'An agent task is already running' };
  }

  isRunning = true;
  shouldStop = false;

  const settings = getSettings();
  const maxSteps = options.maxSteps || settings.general?.maxAgentSteps || 50;
  const apiKey = getApiKey(providers.getProviderForModel(model).providerName);

  const steps = [];
  let stepCount = 0;

  onProgress({ step: 0, action: 'Starting', detail: `Task: ${task}`, status: 'active', icon: '🚀' });

  try {
    // Step 1: Create a plan
    onProgress({ step: 1, action: 'Planning', detail: 'Analyzing task and creating a plan...', status: 'active', icon: '📋' });

    const planModel = settings.models?.plannerModel || model;
    const planApiKey = getApiKey(providers.getProviderForModel(planModel).providerName);
    const plan = await planner.createPlan(task, planModel, planApiKey, {
      pageContent: options.pageContent,
      url: options.url,
      contextWindow: settings.general?.contextWindow || 8192
    });

    steps.push({ agent: 'planner', action: 'plan', result: plan });
    onProgress({ step: 1, action: 'Plan Created', detail: `${plan.steps.length} steps planned`, status: 'completed', icon: '📋' });

    // Step 2: Execute each planned step
    for (let i = 0; i < plan.steps.length && i < maxSteps; i++) {
      if (shouldStop) {
        onProgress({ step: i + 2, action: 'Stopped', detail: 'Task cancelled by user', status: 'cancelled', icon: '⏹️' });
        break;
      }

      const plannedStep = plan.steps[i];
      stepCount = i + 2;

      onProgress({
        step: stepCount,
        action: plannedStep.action,
        detail: plannedStep.detail || `Executing step ${i + 1}...`,
        status: 'active',
        icon: getActionIcon(plannedStep.action)
      });

      const execModel = settings.models?.navigatorModel || model;
      const execApiKey = getApiKey(providers.getProviderForModel(execModel).providerName);
      // Execute the step via navigator
      const result = await navigator.executeStep(plannedStep, execModel, execApiKey, {
        mainWindow,
        contextWindow: settings.general?.contextWindow || 8192
      });

      steps.push({ agent: 'navigator', step: i + 1, action: plannedStep.action, result });

      onProgress({
        step: stepCount,
        action: plannedStep.action,
        detail: result.summary || 'Step completed',
        status: result.success ? 'completed' : 'error',
        icon: result.success ? '✅' : '❌'
      });

      if (!result.success && !result.continueOnError) {
        break;
      }
    }

    // Final summary
    const lastResult = steps[steps.length - 1]?.result;
    onProgress({
      step: stepCount + 1,
      action: 'Complete',
      detail: lastResult?.summary || 'Task finished',
      status: 'completed',
      icon: '🎉'
    });

    isRunning = false;
    return { success: true, steps, result: lastResult };

  } catch (err) {
    isRunning = false;
    onProgress({
      step: stepCount + 1,
      action: 'Error',
      detail: err.message,
      status: 'error',
      icon: '❌'
    });
    return { success: false, error: err.message, steps };
  }
}

function stopAgent() {
  shouldStop = true;
  isRunning = false;
}

function getActionIcon(action) {
  const icons = {
    navigate: '🌐', click: '👆', type: '⌨️', scroll: '📜',
    read: '📖', search: '🔍', extract: '📊', summarize: '📝',
    screenshot: '📸', wait: '⏳', download: '📥', fill_form: '📋'
  };
  return icons[action] || '⚡';
}

module.exports = { runAgent, stopAgent };
