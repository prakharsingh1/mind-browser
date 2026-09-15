// =============================================================================
// Local Mind Browser — Persistent Memory System
// =============================================================================
// Stores, retrieves, and searches through AI memories.
// Uses a JSON-based file store with keyword indexing for fast retrieval.

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

let memoryFile = '';
let memories = [];

/**
 * Initialize memory system.
 */
function initMemory() {
  const dataDir = path.join(app.getPath('userData'), 'local-mind-data');
  memoryFile = path.join(dataDir, 'memories.json');

  if (fs.existsSync(memoryFile)) {
    try {
      memories = JSON.parse(fs.readFileSync(memoryFile, 'utf-8'));
    } catch {
      memories = [];
    }
  } else {
    memories = [];
    save();
  }
}

/**
 * Save all memories to disk.
 */
function save() {
  try {
    const dir = path.dirname(memoryFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(memoryFile, JSON.stringify(memories, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to save memories:', err.message);
  }
}

/**
 * Add a new memory.
 * @param {Object} memory - { type, content, source, url, tags?, metadata? }
 * @returns {Object} - Saved memory with ID
 */
function addMemory(memory) {
  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    type: memory.type || 'fact',          // fact, preference, conversation, page, note
    content: memory.content,
    source: memory.source || 'user',      // user, ai, page, system
    url: memory.url || '',
    tags: memory.tags || [],
    keywords: extractKeywords(memory.content),
    createdAt: new Date().toISOString(),
    accessCount: 0,
    lastAccessed: null,
    metadata: memory.metadata || {}
  };

  memories.push(entry);
  save();
  return entry;
}

/**
 * Search memories by query string.
 * Returns ranked results based on keyword overlap and recency.
 * @param {string} query - Search query
 * @param {number} limit - Max results (default 20)
 * @returns {Array} - Matching memories sorted by relevance
 */
function searchMemories(query, limit = 20) {
  if (!query) return memories.slice(-limit).reverse();

  const queryKeywords = extractKeywords(query);

  // Score each memory by keyword overlap
  const scored = memories.map(mem => {
    const keywordOverlap = queryKeywords.filter(k =>
      mem.keywords.some(mk => mk.includes(k) || k.includes(mk))
    ).length;

    const contentMatch = mem.content.toLowerCase().includes(query.toLowerCase()) ? 5 : 0;
    const tagMatch = mem.tags.some(t => query.toLowerCase().includes(t.toLowerCase())) ? 3 : 0;

    // Recency boost (newer = higher score)
    const ageHours = (Date.now() - new Date(mem.createdAt).getTime()) / 3600000;
    const recencyBoost = Math.max(0, 2 - ageHours / 168); // Decays over 1 week

    const score = keywordOverlap * 2 + contentMatch + tagMatch + recencyBoost;
    return { ...mem, _score: score };
  });

  return scored
    .filter(m => m._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, limit)
    .map(({ _score, ...mem }) => mem);
}

/**
 * Get all memories, optionally filtered by type.
 * @param {string} type - Optional type filter
 * @returns {Array}
 */
function getMemories(type) {
  if (type) return memories.filter(m => m.type === type);
  return [...memories];
}

/**
 * Delete a memory by ID.
 * @param {string} id
 * @returns {{ success: boolean }}
 */
function deleteMemory(id) {
  const idx = memories.findIndex(m => m.id === id);
  if (idx === -1) return { success: false };
  memories.splice(idx, 1);
  save();
  return { success: true };
}

/**
 * Clear all memories.
 */
function clearAll() {
  memories = [];
  save();
  return { success: true };
}

/**
 * Get memory stats.
 */
function getStats() {
  const types = {};
  memories.forEach(m => {
    types[m.type] = (types[m.type] || 0) + 1;
  });
  return { total: memories.length, byType: types };
}

/**
 * Auto-learn from page content — extract key facts and preferences.
 * @param {string} content - Page text
 * @param {string} url - Page URL
 * @param {string} title - Page title
 */
function learnFromPage(content, url, title) {
  // Don't store if content is too short
  if (!content || content.length < 100) return;

  // Store a condensed page memory
  const truncated = content.slice(0, 500);
  addMemory({
    type: 'page',
    content: `Visited "${title}": ${truncated}`,
    source: 'system',
    url,
    tags: ['browsing', 'auto-learned'],
    metadata: { title, contentLength: content.length }
  });
}

/**
 * Extract keywords from text for indexing.
 */
function extractKeywords(text) {
  if (!text) return [];
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
    'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'and',
    'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either', 'neither',
    'it', 'its', 'this', 'that', 'these', 'those', 'i', 'me', 'my',
    'we', 'our', 'you', 'your', 'he', 'she', 'they', 'them', 'their'
  ]);

  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w))
    .filter((w, i, arr) => arr.indexOf(w) === i) // unique
    .slice(0, 30);
}

/**
 * Build a context string from relevant memories for LLM prompts.
 * @param {string} query - Current query/topic
 * @param {number} maxTokens - Approximate max characters
 * @returns {string} - Memory context block
 */
function getMemoryContext(query, maxTokens = 2000) {
  const relevant = searchMemories(query, 10);
  if (relevant.length === 0) return '';

  let context = '## Relevant Memories\n';
  let charCount = context.length;

  for (const mem of relevant) {
    const entry = `- [${mem.type}] ${mem.content}\n`;
    if (charCount + entry.length > maxTokens) break;
    context += entry;
    charCount += entry.length;
  }

  return context;
}

module.exports = {
  initMemory,
  addMemory,
  searchMemories,
  getMemories,
  deleteMemory,
  clearAll,
  getStats,
  learnFromPage,
  getMemoryContext
};
