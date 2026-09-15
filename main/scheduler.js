// =============================================================================
// Local Mind Browser — Task Scheduler
// =============================================================================
// Schedules recurring and one-time tasks (e.g., check price, monitor page).

const fs = require('fs');
const path = require('path');
const { app, Notification } = require('electron');

let tasksFile = '';
let tasks = [];
let timers = new Map();

function initScheduler() {
  const dataDir = path.join(app.getPath('userData'), 'local-mind-data');
  tasksFile = path.join(dataDir, 'scheduled-tasks.json');

  if (fs.existsSync(tasksFile)) {
    try {
      tasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));
    } catch {
      tasks = [];
    }
  } else {
    tasks = [];
    save();
  }

  // Restart active tasks
  tasks.filter(t => t.status === 'active').forEach(startTask);
}

function save() {
  try {
    const dir = path.dirname(tasksFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tasksFile, JSON.stringify(tasks, null, 2), 'utf-8');
  } catch {}
}

/**
 * Create a new scheduled task.
 * @param {Object} task - { name, type, interval, url, query, action }
 *  type: 'once', 'recurring'
 *  interval: ms between runs (for recurring)
 *  action: 'check-price', 'monitor-page', 'run-query', 'notify'
 * @returns {Object} - Created task
 */
function createTask(task) {
  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: task.name || 'Untitled Task',
    type: task.type || 'once',
    interval: task.interval || 3600000, // Default 1 hour
    url: task.url || '',
    query: task.query || '',
    action: task.action || 'notify',
    status: 'active',
    createdAt: new Date().toISOString(),
    lastRun: null,
    runCount: 0,
    results: []
  };

  tasks.push(entry);
  save();
  startTask(entry);
  return entry;
}

/**
 * Start/resume a scheduled task.
 */
function startTask(task) {
  if (timers.has(task.id)) return;

  const execute = () => {
    task.lastRun = new Date().toISOString();
    task.runCount++;
    task.results.push({ time: task.lastRun, status: 'completed' });

    // Keep only last 50 results
    if (task.results.length > 50) {
      task.results = task.results.slice(-50);
    }

    save();

    // Send notification
    if (Notification.isSupported()) {
      new Notification({
        title: `Task: ${task.name}`,
        body: `Scheduled task "${task.name}" completed (run #${task.runCount})`
      }).show();
    }

    // If one-time, mark as completed
    if (task.type === 'once') {
      task.status = 'completed';
      clearTimer(task.id);
      save();
    }
  };

  if (task.type === 'once') {
    const timer = setTimeout(execute, task.interval);
    timers.set(task.id, timer);
  } else {
    const timer = setInterval(execute, task.interval);
    timers.set(task.id, timer);
  }
}

function clearTimer(id) {
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer);
    clearInterval(timer);
    timers.delete(id);
  }
}

function deleteTask(id) {
  clearTimer(id);
  tasks = tasks.filter(t => t.id !== id);
  save();
  return { success: true };
}

function pauseTask(id) {
  clearTimer(id);
  const task = tasks.find(t => t.id === id);
  if (task) { task.status = 'paused'; save(); }
  return { success: true };
}

function resumeTask(id) {
  const task = tasks.find(t => t.id === id);
  if (task) { task.status = 'active'; startTask(task); save(); }
  return { success: true };
}

function getTasks() {
  return tasks.map(t => ({
    ...t,
    results: t.results.slice(-5) // Only return last 5 results
  }));
}

function cleanup() {
  for (const [id] of timers) {
    clearTimer(id);
  }
}

module.exports = { initScheduler, createTask, deleteTask, pauseTask, resumeTask, getTasks, cleanup };
