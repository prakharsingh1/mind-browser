// =============================================================================
// Local Mind Browser — Cost Optimization Router
// =============================================================================
// Picks the model per request instead of making the user choose: classify the
// task, spend free quota first, and escalate to premium only when the task
// genuinely benefits. Every decision carries a human-readable reason.
//
// Honest limits: providers do not expose "remaining free quota" over an API we
// can query, so budgets here are LOCAL COUNTERS against published daily limits,
// and costs are ESTIMATES from published per-token pricing. Both are labelled
// as estimates wherever they surface in the UI.

const { getSettings, saveSettings, getApiKey } = require('../storage');
const providers = require('../providers/index');

/**
 * Catalogue ids are an INTENT ("this family, roughly this size"), not a promise
 * that the id still exists. Providers retire models constantly: Google 404s with
 * "no longer available to new users", Groq drops a llama revision, OpenRouter
 * renames a slug. When that happens the router keeps cheerfully selecting a dead
 * id and every request fails.
 *
 * So every id is resolved against what the account can actually use right now.
 * Exact match wins; otherwise pick the live model sharing the most name tokens,
 * preferring the newest version. If the live list hasn't loaded yet the id is
 * passed through unchanged, so this can never make things worse than before.
 */
function providerOf(id) {
  if (id.startsWith('groq:')) return 'groq';
  if (id.startsWith('openrouter:')) return 'openrouter';
  if (id.startsWith('gemini-')) return 'gemini';
  if (id.startsWith('gpt-')) return 'openai';
  if (id.startsWith('claude-')) return 'anthropic';
  // Anything left is an Ollama tag (llama3.1:8b, qwen2.5, mistral-nemo...).
  // Without this branch local ids were never resolved, so a pin to a model the
  // user had since removed kept being sent and kept 404ing.
  return id ? 'ollama' : '';
}

const stripPrefix = (id) => id.replace(/^(groq|openrouter):/, '');

/** Numeric version in a model name: llama-3.3-70b -> 3.3, gemini-3.5 -> 3.5 */
function versionIn(id) {
  const m = /[-/](\d+(?:\.\d+)?)(?:[-b]|$)/.exec(id) || /(\d+(?:\.\d+)?)/.exec(id);
  return m ? parseFloat(m[1]) : 0;
}

/** Parameter size, so an 8b request doesn't resolve to a 405b model. */
function sizeIn(id) {
  const m = /(\d+)\s*b\b/i.exec(id);
  return m ? parseFloat(m[1]) : 0;
}

const tokensOf = (id) => stripPrefix(id).toLowerCase().split(/[-_/.]+/).filter(Boolean);

function resolveLive(id) {
  const prov = providerOf(id);
  if (!prov) return id;

  const live = providers.cachedFor(prov);
  if (!live.length) return id;

  const bare = stripPrefix(id);
  const liveBare = live.map(stripPrefix);
  if (liveBare.includes(bare)) return id;              // still available

  const want = new Set(tokensOf(id));
  const wantSize = sizeIn(bare);

  let best = null, bestScore = -Infinity;
  for (const cand of liveBare) {
    const shared = tokensOf(cand).filter((t) => want.has(t)).length;
    if (!shared) continue;                             // unrelated family
    const candSize = sizeIn(cand);
    // closeness in size matters more than raw recency for like-for-like swaps
    const sizePenalty = wantSize && candSize ? Math.abs(Math.log(candSize / wantSize)) : 0;
    const score = shared * 10 + versionIn(cand) - sizePenalty * 3;
    if (score > bestScore) { bestScore = score; best = cand; }
  }
  if (!best) return id;

  const prefix = id.startsWith('groq:') ? 'groq:' : id.startsWith('openrouter:') ? 'openrouter:' : '';
  return prefix + best;
}

// Published free-tier daily request limits (conservative).
const CATALOGUE = [
  // id, provider, tier, freePerDay (0 = paid), $/1M in, $/1M out, strength 1-10
  { id: 'groq:llama-3.1-8b-instant',      provider: 'groq',       free: 14400, in: 0,    out: 0,    power: 4 },
  { id: 'groq:llama-3.3-70b-versatile',   provider: 'groq',       free: 1000,  in: 0,    out: 0,    power: 7 },
  { id: 'groq:openai/gpt-oss-120b',       provider: 'groq',       free: 1000,  in: 0,    out: 0,    power: 8 },
  { id: 'gemini-2.5-flash-lite',          provider: 'gemini',     free: 1000,  in: 0.10, out: 0.40, power: 5 },
  { id: 'gemini-2.5-flash',               provider: 'gemini',     free: 250,   in: 0.30, out: 2.50, power: 7 },
  { id: 'gemini-2.5-pro',                 provider: 'gemini',     free: 100,   in: 1.25, out: 10.0, power: 10 }
];

const TIER_MIN_POWER = { light: 3, medium: 6, heavy: 9 };

/** Rough capability from parameter count, so a 70b local model is not treated
 *  as interchangeable with a 1b one. Unknown sizes sit mid-range. */
function localPower(id) {
  const b = sizeIn(id);
  if (!b) return 5;
  if (b >= 65) return 8;
  if (b >= 27) return 7;
  if (b >= 12) return 6;
  if (b >= 7) return 5;
  if (b >= 3) return 4;
  return 3;
}

/** Whatever Ollama currently has pulled, as catalogue entries. Free and with no
 *  daily cap, since they run on the user's own machine. */
function localCatalogue() {
  return providers.cachedFor('ollama').map((id) => ({
    id, provider: 'ollama', free: Infinity, in: 0, out: 0, power: localPower(id)
  }));
}

/** Rough token estimate — 4 chars per token is close enough for costing. */
const tokens = (text) => Math.ceil(String(text || '').length / 4);

/**
 * Classify what the task actually needs. Heuristic, but the signals are strong:
 * agent runs and multi-step reasoning are heavy almost by definition, while
 * rewrites and summaries never need a premium model.
 */
function classify(task, { isAgent = false, contextChars = 0 } = {}) {
  const t = String(task || '').toLowerCase();

  if (/\b(rewrite|rephrase|grammar|spell|shorten|tidy|format|translate|tl;?dr)\b/.test(t) && t.length < 400) {
    return { tier: 'light', why: 'simple text task' };
  }
  const heavySignal =
    isAgent ||
    contextChars > 12000 ||
    /\b(analy[sz]e|architect|design|debug|refactor|prove|strategy|compare .* and|step by step|multi-step|plan)\b/.test(t) ||
    t.length > 1200;
  if (heavySignal) {
    return { tier: 'heavy', why: isAgent ? 'agent run needs multi-step reasoning' : 'complex reasoning task' };
  }
  if (/\b(summari[sz]e|explain|list|find|search|draft|email|write)\b/.test(t)) {
    return { tier: 'medium', why: 'moderate task' };
  }
  return { tier: 'medium', why: 'general task' };
}

// ── Local usage ledger (resets daily) ────────────────────────────────────────
function ledger() {
  const s = getSettings();
  const today = new Date().toDateString();
  let u = s.usage || {};
  if (u.day !== today) u = { day: today, counts: {}, savedUsd: 0, spentUsd: 0 };
  return { settings: s, usage: u };
}

function persist(settings, usage) {
  settings.usage = usage;
  try { saveSettings(settings); } catch { /* best effort */ }
}

const remaining = (usage, m) => (m.free ? m.free - (usage.counts[m.id] || 0) : Infinity);

/**
 * Choose a model for this request.
 * @returns {{model:string, reason:string, tier:string, estimatedCost:number}}
 */
function route(task, opts = {}) {
  const { settings, usage } = ledger();
  const strategy = settings.models?.strategy || 'balanced';
  const pinned = settings.models?.pinnedModel;

  // The model picked in the AI panel for THIS run is the freshest statement of
  // intent, so it outranks the stored pin. Without this a stale pinnedModel
  // silently hijacked every run — you'd choose Gemini in the dropdown and the
  // agent would quietly call whatever was pinned months ago.
  if (opts.requestedModel) {
    return {
      model: resolveLive(opts.requestedModel),
      tier: 'requested',
      estimatedCost: 0,
      reason: `Using ${opts.requestedModel} (picked in the panel).`
    };
  }

  // Otherwise a pin is still an explicit choice — routing must not override it.
  if (pinned) return { model: resolveLive(pinned), tier: 'pinned', estimatedCost: 0, reason: `Using ${pinned} (pinned in Settings).` };

  const { tier, why } = classify(task, opts);
  const need = TIER_MIN_POWER[tier];

  // Cloud models need a key; local models need nothing but Ollama running.
  const local = localCatalogue();
  const usable = CATALOGUE.filter((m) => getApiKey(m.provider)).concat(local);
  if (!usable.length) {
    // Nothing configured at all. Naming a cloud model here guaranteed a failure;
    // say what is actually wrong instead.
    return {
      model: resolveLive('gemini-2.5-pro'),
      tier,
      estimatedCost: 0,
      reason: 'No API keys are configured and Ollama has no models, so there is nothing to run this on. Add a key in Settings, or pull a model in Ollama.'
    };
  }

  let pool = usable.filter((m) => m.power >= need && remaining(usage, m) > 0);
  if (!pool.length) pool = usable.filter((m) => remaining(usage, m) > 0);   // quota-exhausted fallback
  if (!pool.length) pool = usable;                                          // everything spent — use best anyway

  let pick;
  if (strategy === 'performance') {
    pick = pool.sort((a, b) => b.power - a.power)[0];
  } else if (strategy === 'savings') {
    // Cheapest that clears the bar; free models first.
    pick = pool.sort((a, b) => (a.in + a.out) - (b.in + b.out) || b.power - a.power)[0];
  } else {
    // Balanced: free first, then cheapest capable.
    const free = pool.filter((m) => !m.in && !m.out);
    pick = (free.length ? free : pool).sort((a, b) => (a.in + a.out) - (b.in + b.out) || b.power - a.power)[0];
  }

  const inTok = tokens(task) + tokens(opts.contextText) + 1200;   // + system prompt
  const outTok = tier === 'heavy' ? 2000 : 700;
  const cost = (inTok / 1e6) * pick.in + (outTok / 1e6) * pick.out;

  // What the strongest model would have cost, for the "saved" figure.
  const premium = usable.sort((a, b) => b.power - a.power)[0];
  const premiumCost = (inTok / 1e6) * premium.in + (outTok / 1e6) * premium.out;
  const saved = Math.max(0, premiumCost - cost);

  const isFree = !pick.in && !pick.out;
  const left = remaining(usage, pick);
  let reason;
  if (pick.provider === 'ollama') {
    // Local models cost nothing and send nothing anywhere, which is the point
    // worth making — a "$0.000 saved" figure says nothing.
    reason = `Running ${pick.id} locally for a ${tier} task (${why}). Nothing leaves your machine.`;
  } else if (isFree) {
    reason = `Used ${pick.provider} free tier for a ${tier} task (${why})` +
      (saved > 0.0005 ? ` — saved about $${saved.toFixed(3)}.` : '.') +
      (isFinite(left) ? ` ${left - 1} free requests left today.` : '');
  } else {
    reason = `Chose ${pick.id} for a ${tier} task (${why}) — estimated $${cost.toFixed(4)}.` +
      (saved > 0.0005 ? ` Saved about $${saved.toFixed(3)} vs the top model.` : '');
  }

  return { model: resolveLive(pick.id), tier, estimatedCost: cost, estimatedSaved: saved, reason };
}

/** Record a completed call so quota tracking stays accurate. */
function record(modelId, cost = 0, saved = 0) {
  const { settings, usage } = ledger();
  usage.counts[modelId] = (usage.counts[modelId] || 0) + 1;
  usage.spentUsd = +( (usage.spentUsd || 0) + cost ).toFixed(5);
  usage.savedUsd = +( (usage.savedUsd || 0) + saved ).toFixed(5);
  persist(settings, usage);
}

/** Escalate one tier when the first attempt looks weak. */
function escalate(currentModel) {
  const { usage } = ledger();
  const cur = CATALOGUE.find((m) => m.id === currentModel);
  const stronger = CATALOGUE
    .filter((m) => getApiKey(m.provider) && m.power > (cur?.power || 0) && remaining(usage, m) > 0)
    .sort((a, b) => a.power - b.power)[0];
  return stronger
    ? { model: stronger.id, reason: `Escalated to ${stronger.id} — the task needed deeper reasoning.` }
    : null;
}

const stats = () => ledger().usage;

module.exports = { route, record, escalate, classify, stats, CATALOGUE };
