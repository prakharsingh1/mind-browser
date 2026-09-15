// =============================================================================
// Local Mind Browser — Tool Schemas
// =============================================================================
// Providers that support native tool calling want JSON Schema. The registry in
// tools.js describes each tool in a compact shorthand that is also rendered
// into the system prompt for models that have no native tool support.
//
// Rather than maintain both by hand — which drifts the moment someone edits one
// and forgets the other — this parses the shorthand into JSON Schema, so the
// registry stays the single source of truth.
//
// The shorthand grammar, in full:
//   {}                                  no parameters
//   {"a": string}                       required
//   {"a"?: number}                      optional
//   {"a"?: string[]}                    array of strings
//   {"a"?: "x"|"y"}                     string with a fixed set of values

const { TOOLS } = require('./tools');

/** Split on commas that are not inside quotes or brackets. */
function splitFields(body) {
  const out = [];
  let depth = 0, inStr = false, cur = '';
  for (const c of body) {
    if (c === '"') inStr = !inStr;
    if (!inStr) {
      if (c === '[') depth++;
      else if (c === ']') depth--;
      else if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function typeOf(spec) {
  const s = spec.trim();
  if (s === 'string') return { type: 'string' };
  if (s === 'number') return { type: 'number' };
  if (s === 'boolean') return { type: 'boolean' };
  if (s === 'string[]') return { type: 'array', items: { type: 'string' } };
  if (s === 'number[]') return { type: 'array', items: { type: 'number' } };

  // Union of string literals: "down"|"up"|"bottom"
  const parts = s.split('|').map((p) => p.trim());
  if (parts.length > 1 && parts.every((p) => /^"[^"]*"$/.test(p))) {
    return { type: 'string', enum: parts.map((p) => p.slice(1, -1)) };
  }
  // Anything unrecognised is accepted as a string rather than dropped, so a new
  // shorthand type degrades to "works, loosely typed" instead of a broken tool.
  return { type: 'string' };
}

/** Compact shorthand -> JSON Schema. Throws on malformed input so a typo in the
 *  registry fails loudly at startup rather than silently shipping a broken tool. */
function parseSchema(shorthand, toolName) {
  const raw = String(shorthand || '{}').trim();
  if (!raw.startsWith('{') || !raw.endsWith('}')) {
    throw new Error(`tool "${toolName}": schema must be wrapped in braces, got ${raw}`);
  }
  const body = raw.slice(1, -1).trim();
  const properties = {};
  const required = [];
  if (!body) return { type: 'object', properties, required };

  for (const field of splitFields(body)) {
    const m = /^\s*"([A-Za-z_][A-Za-z0-9_]*)"\s*(\?)?\s*:\s*(.+?)\s*$/.exec(field);
    if (!m) throw new Error(`tool "${toolName}": cannot parse field ${field.trim()}`);
    const [, key, optional, spec] = m;
    properties[key] = typeOf(spec);
    if (!optional) required.push(key);
  }
  return { type: 'object', properties, required };
}

/** One neutral spec per tool; each provider formatter reshapes these. */
function toolSpecs() {
  return Object.entries(TOOLS).map(([name, t]) => ({
    name,
    description: t.describe,
    parameters: parseSchema(t.schema, name)
  }));
}

// ── Per-provider shapes ──────────────────────────────────────────────────────
// OpenAI, Groq, OpenRouter and Ollama all speak the OpenAI function format.
const openaiTools = () => toolSpecs().map((t) => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.parameters }
}));

const anthropicTools = () => toolSpecs().map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: t.parameters
}));

// Gemini wants one declaration list, and rejects an empty `required` array.
const geminiTools = () => [{
  functionDeclarations: toolSpecs().map((t) => {
    const p = t.parameters;
    const parameters = { type: 'object', properties: p.properties };
    if (p.required.length) parameters.required = p.required;
    return { name: t.name, description: t.description, parameters };
  })
}];

module.exports = { parseSchema, toolSpecs, openaiTools, anthropicTools, geminiTools };
