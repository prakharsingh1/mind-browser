// =============================================================================
// Local Mind Browser — Agent Loop (ReAct)
// =============================================================================
// The model sees the task and a tool catalogue, picks ONE tool, gets the real
// result back, then decides what to do next — repeating until it answers.
//
// Why not the old design: it planned every step up front, before seeing a
// single page, then executed the list blindly. It could not react to what it
// found, and its "read"/"extract" steps never actually received page content.
//
// Tool calls travel as JSON in the model's text rather than provider-native
// function calling, so the exact same loop works on Gemini, OpenAI, Anthropic,
// Groq, OpenRouter and local Ollama models.

const providers = require('../providers/index');
const { getApiKey, getSettings } = require('../storage');
const { toolCatalogue, runTool, toolMeta, clip } = require('./tools');
const router = require('./router');
const { openaiTools, anthropicTools, geminiTools } = require('./tool-schema');

let running = false;
let stopRequested = false;

const RULES = `RULES
- One tool per reply. Wait for the result before the next call.
- Never invent facts, numbers, quotes or URLs. If you did not read it from a tool result, do not state it.
- WORK IN THE BROWSER. This is a browser agent: open real tabs so the user can watch. Use new_tab/open_page to visit sources, and switch_tab to move between them. Only use fetch_url for quick background facts where a visible tab adds nothing.
- For research across several subjects, open a tab per subject (new_tab with background:true), then read each one.
- Search first, then read the most promising 2-4 sources before answering.
- If a tool errors, adapt: change the query, try another source, or use a different tool.
- Numbers matter: quote figures exactly as the source gives them, and say which source each came from.
- Your final "answer" must be self-contained and directly useful — the user only sees that. Include concrete findings, not a description of what you did.
- If the request is conversational, or about something you already know for certain and that cannot have changed (definitions, explanations, code, writing help), just answer immediately with {"thought","answer"} — no tools needed.
- But ANYTHING current, factual or specific — prices, news, dates, statistics, "latest", anything about a real page or company — MUST come from tools. Never answer those from memory, and never claim to have checked something you did not.
- If the user asks for an exact number of items (e.g. "top 50"), COUNT what you have before finishing. If a source yields fewer, scroll or open another source to fill the gap — and if you still cannot reach it, state plainly how many you actually found and why.
- NEVER substitute a different category for the one asked. "Metal" means metal producers (steel, aluminium, copper products — ArcelorMittal, Nippon Steel, POSCO, Nucor, Alcoa); it is NOT "mining" (BHP, Rio Tinto, Newmont), which also covers coal, gold and fertiliser. If the exact category is hard to find, keep looking or say plainly that you could not find it — do not quietly widen the request and report success.
- For ANY ranked list, table or set of figures on a page, use extract_table — reading prose loses rows and scrambles order, which is how counts end up wrong.
- Use calculate for arithmetic rather than doing it mentally.
- Do NOT answer after a single search. Visit the actual sources and read them before answering.
- Keep going until the task is genuinely DONE. If the user asked you to write something somewhere, actually write it — don't just report what you found.

ANSWER FORMAT — the user only ever sees the "answer" field, so it has to stand alone
- LEAD WITH THE ANSWER. First line answers the question directly. No preamble, no "I searched for", no recap of your steps.
- BE CONCISE. Aim for under 150 words unless the user asked for a list, a table or a document. Cut every sentence that does not carry a fact.
- Use markdown deliberately: "##" for sections only when there is more than one, "-" bullets for parallel facts, and a | table | whenever you have 3+ rows of comparable figures. Never wrap the whole answer in a code fence.
- Put the source on the fact: [CNBC](https://…) inline, not a bibliography at the end.
- INCLUDE AN IMAGE when it genuinely helps (a chart, a product shot, a logo, a photo of the thing being discussed) using ![alt](https://…). Only ever use an image URL you actually saw in a tool result — never guess one, and never link to an image you have not seen. Skip images entirely for code, definitions and pure text answers.
- Bold the numbers that matter. Give units and currency every time.
- Never mention tools, steps, JSON or that you are an agent.

RESEARCH OVER TOR
- onion_search and onion_fetch reach material that is not on the clearnet:
  reporting censored in the country hosting it, mirrors of blocked sites,
  SecureDrop instances, onion-only services.
- Reach for them when the clearnet search comes back empty or obviously
  filtered, or when the user asks about something specifically on Tor. They are
  slow and start Tor on first use, so do not use them as a default search.
- Cite the URL for every claim that came from an onion source. An unsourced
  assertion about onion material is worth nothing, and the user cannot check it
  the way they could check a clearnet link.
- Say plainly when a source is an onion service and when you could not reach it.
  "No results" from an onion index means the index found nothing, NOT that the
  thing does not exist — say which you mean.
- These are research tools. Help with journalism, security research and reaching
  blocked information. Decline to help locate or transact with services for
  buying drugs, weapons, stolen data or other criminal trade, and say so plainly
  rather than searching and reporting back.

RICH OUTPUT — use these in your final answer when they genuinely help
- Comparing numbers across categories? Emit a chart instead of a list:
  \`\`\`chart
  {"type": "bar", "title": "Revenue by company", "data": [{"label": "Apple", "value": 383}, {"label": "Microsoft", "value": 212}]}
  \`\`\`
  "type" is "bar" or "line". Every value must be a real number you actually
  found — never invent a data point to round out a chart.
- Structured comparisons belong in a markdown table.
- Diagrams, layouts or styled output: emit a \`\`\`html or \`\`\`svg block and it
  renders live. It is sandboxed, so scripts will not run — keep it static.
- Do not wrap ordinary prose in any of these. A one-line answer stays one line.

VERIFY BEFORE YOU FINISH
Re-read the user's original request and check EVERY constraint before you answer:
  1. Category — is this exactly what they asked for, not a near neighbour?
  2. Count — do you have the exact number requested?
  3. Order — ascending/descending as specified, and actually sorted that way?
  4. Destination — if they asked for it in a document, did you really write it there?
If any check fails, fix it with another tool call instead of finishing. If you cannot fix it, say exactly which constraint you missed and why — never claim success for something you did not do.

WORKING IN WEB APPS (Google Docs, Notion, Gmail, forms)
- open_page the app, wait_for a known bit of its UI, then use type_into_editor for rich-text editors — plain type_text does NOT work there.
- press_key handles Enter/Tab and shortcuts (e.g. {"key":"Enter"}).
- For a NEW Google Doc use https://docs.google.com/document/create — wait_for the editor, then type_into_editor.
- If a site needs a login you don't have, stop and say so plainly rather than guessing.

MULTI-STEP RESEARCH
- For anything covering several subjects (e.g. "top 5 companies"), call research ONCE with all the queries — it runs them in parallel and is far faster than one search at a time.
- Gather every fact you need BEFORE you start writing into a document.

`;

/** Text protocol: for models with no native tool calling (older local models).
 *  Tool calls travel as JSON inside the reply and are parsed by parseDecision. */
const SYSTEM = (catalogue, ctx) => `You are Mind Browser's autonomous agent. You complete real tasks by using tools, not by guessing.

TOOLS
${catalogue}

PROTOCOL — every reply must be exactly ONE of:

1. To use a tool, reply with ONLY this JSON (no prose, no code fences):
{"thought": "<one short sentence on why>", "tool": "<name>", "args": { ... }}

2. When you have enough information to answer, reply with ONLY:
{"thought": "<why you're done>", "answer": "<the complete answer in markdown>"}

${RULES}

${ctx}`;

/** Native protocol: the model calls tools through the provider's own tool API.
 *  Describing the JSON protocol here is harmful — it talks models into printing
 *  tool calls as text instead of actually issuing them. */
const SYSTEM_NATIVE = (ctx) => `You are Mind Browser's autonomous agent. You complete real tasks by using tools, not by guessing.

You have tools available. Call them directly. Do not describe a tool call in text
and do not print JSON — issue the actual call. Call several tools at once when
they are independent of each other; it is much faster than one at a time.

When you have gathered enough to answer, reply with the complete answer in
markdown and no tool call.

${RULES}

${ctx}`;

/**
 * Extract the JSON decision from a model reply. Models like to wrap JSON in
 * fences or add a stray sentence, so this is deliberately forgiving.
 */
function parseDecision(text) {
  if (!text) return null;
  let s = text.trim();

  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) s = fence[1].trim();

  const tryParse = (str) => {
    try {
      const o = JSON.parse(str);
      if (o && typeof o === 'object' && (o.tool || o.answer)) return o;
    } catch { /* not JSON */ }
    return null;
  };

  const direct = tryParse(s);
  if (direct) return direct;

  // Models routinely write unescaped quotes inside "thought" (e.g. the full
  // "metal" industry), which makes the whole object invalid JSON. The tool and
  // args are what actually matter, so pull those out directly rather than
  // discarding an otherwise perfectly good tool call.
  const toolName = /"tool"\s*:\s*"([a-z_]+)"/i.exec(s);
  if (toolName) {
    const argsAt = s.indexOf('"args"');
    if (argsAt >= 0) {
      const open = s.indexOf('{', argsAt);
      if (open >= 0) {
        let depth = 0;
        for (let i = open; i < s.length; i++) {
          if (s[i] === '{') depth++;
          else if (s[i] === '}') {
            depth--;
            if (depth === 0) {
              try {
                return { tool: toolName[1], args: JSON.parse(s.slice(open, i + 1)) };
              } catch { /* args unparseable — fall through */ }
              break;
            }
          }
        }
      }
    }
    return { tool: toolName[1], args: {} };
  }

  // Fall back to the first balanced {...} block in the text.
  const start = s.indexOf('{');
  if (start >= 0) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') inStr = !inStr;
      if (inStr) continue;
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          const got = tryParse(s.slice(start, i + 1));
          if (got) return got;
        }
      }
    }
  }
  return null;
}

/** Providers hand back OpenAI-shaped calls with `arguments` as a JSON string.
 *  Normalise to { id, name, args } and drop anything unparseable rather than
 *  letting a malformed blob reach runTool(). */
function parseToolCalls(raw) {
  if (!Array.isArray(raw) || !raw.length) return [];
  const out = [];
  for (const c of raw) {
    const name = c?.function?.name;
    if (!name) continue;
    let args = {};
    try {
      const a = c.function.arguments;
      args = typeof a === 'string' ? (a.trim() ? JSON.parse(a) : {}) : (a || {});
    } catch {
      // A model that truncates its JSON should get a usable error back, not a
      // silent no-op, so keep the call and let the tool reject the empty args.
      args = {};
    }
    out.push({ id: c.id || `${name}_${out.length}`, name, args });
  }
  return out;
}

/** Each provider family wants the schema in its own shape. */
function toolsForProvider(providerName) {
  if (providerName === 'anthropic') return anthropicTools();
  if (providerName === 'gemini') return geminiTools();
  return openaiTools();   // openai, groq, openrouter, ollama
}

/** One non-streaming completion, provider-agnostic.
 *  Resolves { text, toolCalls, toolsUnsupported } — the loop needs all three. */
function complete(messages, model, apiKey, contextWindow, tools) {
  return new Promise((resolve, reject) => {
    let out = '';
    const opts = { temperature: 0.2, num_ctx: contextWindow, ...(tools && { tools }) };
    providers.streamChat(
      messages, model, apiKey, opts,
      (t) => { out += t; },
      (res = {}) => resolve({
        text: out.trim(),
        toolCalls: parseToolCalls(res.toolCalls),
        toolsUnsupported: !!res.toolsUnsupported
      }),
      (e) => {
        // Node's fetch hides the real problem in .cause — surface it, otherwise
        // every network issue reads as an unactionable "fetch failed".
        const base = typeof e === 'string' ? e : (e?.message || 'model error');
        const cause = e?.cause?.message || e?.cause?.code;
        reject(new Error(cause ? `${base} (${cause})` : base));
      }
    );
  });
}

/**
 * Run a task to completion.
 * @param {Function} onProgress - streams { step, action, detail, status, icon }
 */
async function runAgent(task, model, options = {}, onProgress = () => {}, _win) {
  // `model` may be replaced by the cost router below.
  if (running) return { success: false, error: 'An agent task is already running.' };
  running = true;
  stopRequested = false;

  const settings = getSettings();
  const maxSteps = Math.min(options.maxSteps || settings.general?.maxAgentSteps || 25, 40);
  const contextWindow = settings.general?.contextWindow || 8192;
  // Route to the cheapest model that can actually do this task. An explicit
  // pick from the user is respected inside router.route().
  const decision = router.route(task, {
    isAgent: true,
    contextChars: (options.pageContent || '').length,
    // whatever the panel's dropdown was set to when the run started
    requestedModel: options.requestedModel || model
  });
  if (decision.model && decision.model !== model) {
    onProgress({ step: 0, action: 'Model', detail: decision.reason, status: 'completed', icon: '' });
    model = decision.model;
  }
  router.record(model, decision.estimatedCost, decision.estimatedSaved);

  const { providerName } = providers.getProviderForModel(model);
  const apiKey = getApiKey(providerName);

  // Ground the model in where the user actually is.
  const ctxBits = [];
  if (options.url) ctxBits.push(`The user is currently viewing: ${options.url}`);
  if (options.pageContent) ctxBits.push(`Visible page text (may be truncated):\n"""\n${clip(options.pageContent, 3000)}\n"""`);
  ctxBits.push(`Today's date: ${new Date().toDateString()}`);

  // "Know about me": the user's saved memories + profile, so the agent can
  // personalise without being told the same things every time.
  try {
    const memory = require('../memory');
    const who = settings.profile?.name ? `The user's name is ${settings.profile.name}.` : '';
    const mem = memory.getMemoryContext ? memory.getMemoryContext(task) : '';
    if (who || mem) ctxBits.push(`ABOUT THE USER\n${who}\n${clip(String(mem || ''), 1200)}`.trim());
  } catch { /* memory unavailable */ }
  const ctx = 'CONTEXT\n' + ctxBits.join('\n');

  // Prior turns first, so pronouns and "do it again" resolve correctly.
  const history = Array.isArray(options.history) ? options.history.filter(
    (m) => m && m.content && (m.role === 'user' || m.role === 'assistant')
  ) : [];

  // Start in native tool-calling mode. Every provider supports it; a local
  // model that turns out not to will say so and we drop back mid-run.
  let nativeTools = toolsForProvider(providerName);

  const messages = [
    { role: 'system', content: SYSTEM_NATIVE(ctx) },
    ...(history.length
      ? [{ role: 'user', content: `CONVERSATION SO FAR (for context — resolve any pronouns against it):\n${
          history.map((m) => `${m.role}: ${m.content}`).join('\n\n')}` }]
      : []),
    { role: 'user', content: `TASK: ${task}` }
  ];

  const trace = [];
  let step = 0;
  let protocolNudges = 0;   // prose replies that ignored the tool protocol
  let verified = false;     // the self-check runs at most once per task

  /**
   * One self-check before the answer is shown.
   * @returns {Promise<string|null>} the answer to show, or null if the model
   *          decided to fix something and issued tool calls instead — in which
   *          case the caller loops again and the run continues.
   */
  async function verifyAnswer(answer) {
    if (verified || !answer || !trace.length || !hasCheckableConstraint(task)) return answer;
    verified = true;

    onProgress({ step, action: 'Checking the answer', detail: 'Verifying it against what you asked', status: 'active', icon: '' });

    messages.push({ role: 'assistant', content: answer });
    messages.push({ role: 'user', content: VERIFY_PROMPT(task) });

    let res;
    try {
      res = await complete(messages, model, apiKey, contextWindow, nativeTools);
    } catch {
      return answer;                       // never lose a good answer to a failed check
    }

    if (res.toolCalls.length) {
      onProgress({ step, action: 'Fixing', detail: 'The check found a gap, correcting it', status: 'active', icon: '' });
      await runToolBatch(res.toolCalls, { step, trace, onProgress, messages, content: res.text });
      return null;
    }

    const revised = extractAnswer(res.text) || answer;
    onProgress({ step, action: 'Checked', detail: 'Answer verified', status: 'completed', icon: '' });
    return revised;
  }

  onProgress({ step: 0, action: 'Thinking', detail: task, status: 'active', icon: '' });

  try {
    while (step < maxSteps) {
      if (stopRequested) {
        onProgress({ step, action: 'Stopped', detail: 'Cancelled by user', status: 'cancelled', icon: '' });
        running = false;
        return { success: false, error: 'cancelled', steps: trace };
      }

      step++;
      const res = await complete(messages, model, apiKey, contextWindow, nativeTools);

      // The model cannot do native tool calls after all. Rebuild the system
      // message with the text protocol and carry on rather than failing.
      if (res.toolsUnsupported && nativeTools) {
        nativeTools = null;
        messages[0] = { role: 'system', content: SYSTEM(toolCatalogue(), ctx) };
        onProgress({ step, action: 'Model', detail: `${model} has no tool calling, using the text protocol instead.`, status: 'completed', icon: '' });
        step--;                      // that round trip produced no work
        continue;
      }

      // ── Native tool calls ──
      if (res.toolCalls.length) {
        await runToolBatch(res.toolCalls, { step, trace, onProgress, messages, content: res.text });
        continue;
      }

      // Native mode: no tool calls and real prose means it is finished.
      if (nativeTools && res.text && !parseDecision(res.text)) {
        const checked = await verifyAnswer(res.text);
        if (checked === null) continue;
        onProgress({ step, action: 'Done', detail: 'Task complete', status: 'completed', icon: '' });
        running = false;
        return { success: true, answer: checked, steps: trace };
      }

      const reply = res.text;
      const decision = parseDecision(reply);

      // Prose instead of the protocol. Only treat it as the finished answer if
      // the agent has ACTUALLY done work — otherwise a preamble like "I'll
      // search for X, then create a doc" gets mistaken for the result and the
      // task stops before it starts. Announcements of intent are never answers.
      if (!decision) {
        // Announcements of the NEXT action are never a finished answer. They
        // appear at the start ("I'll search for…") but also — and this is what
        // kept ending runs one step early — at the END, after a genuine partial
        // result: "…I will now switch to the Google Doc and type this in."
        const text = String(reply || '');
        const opensWithIntent = /^\s*(ok(ay)?[,.]?\s*)?(i'?ll|i will|let me|first,? i|i'?m going to|sure[,.]|here'?s (my|the) plan)/i.test(text);
        const endsWithIntent = /(i'?ll|i will|next,?\s*i|now i)\s+(now\s+)?(switch|open|go|navigate|type|paste|enter|write|add|create|proceed|continue|start|begin|do|use|search|check|visit|click)/i
          .test(text.slice(-260));
        const intent = opensWithIntent || endsWithIntent;
        const didWork = trace.length > 0;
        // A reply that is clearly an attempted tool call is never an answer —
        // showing raw JSON to the user and calling it "complete" is the worst
        // possible outcome.
        const looksLikeToolCall = /"tool"\s*:|"args"\s*:/.test(reply || '');

        if (didWork && !intent && !looksLikeToolCall && reply && reply.length > 40) {
          onProgress({ step, action: 'Done', detail: 'Task complete', status: 'completed', icon: '' });
          running = false;
          return { success: true, answer: reply, steps: trace };
        }

        protocolNudges++;
        if (protocolNudges > 4) throw new Error('the model kept replying in prose instead of calling tools');

        messages.push({ role: 'assistant', content: reply || '' });
        messages.push({
          role: 'user',
          content: intent || !didWork
            ? 'Do not describe what you are going to do — DO it now. You have not finished the task. Reply with ONLY the JSON tool call: {"thought","tool","args"}.'
            : 'Reply with ONLY the JSON object from the protocol — {"thought","tool","args"} or {"thought","answer"}.'
        });
        continue;
      }

      if (decision.answer) {
        const answer = extractAnswer(decision.answer);
        const checked = await verifyAnswer(answer);
        if (checked === null) continue;          // verification issued tool calls
        onProgress({ step, action: 'Done', detail: 'Task complete', status: 'completed', icon: '' });
        running = false;
        return { success: true, answer: checked, steps: trace };
      }

      // ── Tool call ──
      const name = decision.tool;
      const args = decision.args || {};
      const meta = toolMeta(name, args);
      onProgress({
        step, action: meta.label, detail: decision.thought || '', status: 'active',
        icon: meta.icon, url: args.url || args.href || ''
      });

      let resultText;
      let ok = true;
      try {
        const result = await runTool(name, args);
        resultText = typeof result === 'string' ? result : JSON.stringify(result);
        resultText = clip(resultText, 7000);
      } catch (err) {
        ok = false;
        resultText = `ERROR: ${err.message}`;
      }

      trace.push({ step, tool: name, args, ok, result: clip(resultText, 500) });
      onProgress({
        step,
        action: meta.label,
        detail: ok ? summarize(name, resultText) : resultText,
        status: ok ? 'completed' : 'error',
        icon: ok ? meta.icon : '⚠️',
        // The panel builds its source strip from these, so a step that touched
        // a real page reports it even when the summary line doesn't mention it.
        url: ok ? (args.url || args.href || '') : ''
      });

      messages.push({ role: 'assistant', content: JSON.stringify(decision) });
      messages.push({ role: 'user', content: `TOOL RESULT (${name}):\n${resultText}` });
    }

    // Out of steps — ask for the best answer from what it has.
    onProgress({ step, action: 'Wrapping up', detail: 'Step limit reached', status: 'active', icon: '' });
    messages.push({
      role: 'user',
      content: 'Step limit reached. Reply now with ONLY {"thought","answer"} summarising your best answer from what you have gathered, and note anything you could not verify.'
    });
    const final = (await complete(messages, model, apiKey, contextWindow)).text;
    running = false;
    onProgress({ step, action: 'Done', detail: 'Task complete', status: 'completed', icon: '' });
    return { success: true, answer: extractAnswer(final), steps: trace };

  } catch (err) {
    running = false;
    onProgress({ step, action: 'Error', detail: err.message, status: 'error', icon: '' });
    return { success: false, error: err.message, steps: trace };
  }
}

/**
 * Does this task carry a constraint that can actually be checked after the fact?
 *
 * Verification costs an extra model round trip, so it is not worth paying on
 * "what is this page about". It IS worth paying whenever the user asked for a
 * specific count, an ordering, or a place to put the result — the three things
 * the agent has historically got quietly wrong.
 */
function hasCheckableConstraint(task) {
  const t = String(task || '').toLowerCase();
  return /\b(top|first|last)\s+\d+|\b\d+\s+(companies|items|results|rows|stocks|articles|examples|points|ways|reasons)\b/.test(t)
      || /\b(sort|sorted|rank|ranked|ascending|descending|order by|in order)\b/.test(t)
      || /\b(table|list of|spreadsheet|csv)\b/.test(t)
      || /\b(write|save|add|put|paste|append)\b.*\b(doc|document|note|sheet|file|page)\b/.test(t);
}

const VERIFY_PROMPT = (task) => `Before this answer is shown to the user, check it against what they actually asked.

THEIR REQUEST: ${task}

Check every constraint:
  1. Category — is this exactly the thing they asked for, not a near neighbour?
  2. Count — if they named a number, do you have exactly that many? Count them.
  3. Order — if they asked for an ordering, is it actually in that order?
  4. Destination — if they asked you to write it somewhere, did you really write it there?

If every check passes, reply with the SAME answer again, unchanged.
If a check fails and you can fix it, call the tools you need to fix it.
If a check fails and you cannot fix it, reply with the answer plus a short, plain
note saying exactly which constraint you missed. Never claim success for
something you did not do.`;

/**
 * Execute one batch of native tool calls and append the results to `messages`.
 *
 * A batch runs concurrently only when every call in it is main-process work.
 * Browser tools share a single webview, so mixing them into a parallel batch
 * would interleave clicks and navigations on the same page.
 */
async function runToolBatch(calls, { step, trace, onProgress, messages, content }) {
  const { TOOLS } = require('./tools');
  const concurrent = calls.length > 1 && calls.every((c) => TOOLS[c.name]?.parallel);

  for (const c of calls) {
    const meta = toolMeta(c.name, c.args);
    onProgress({
      step, action: meta.label, detail: content || '', status: 'active',
      icon: meta.icon, url: c.args.url || c.args.href || ''
    });
  }

  const exec = async (c) => {
    try {
      const result = await runTool(c.name, c.args);
      const text = typeof result === 'string' ? result : JSON.stringify(result);
      return { call: c, ok: true, text: clip(text, 7000) };
    } catch (err) {
      return { call: c, ok: false, text: `ERROR: ${err.message}` };
    }
  };

  let results;
  if (concurrent) {
    results = await Promise.all(calls.map(exec));
  } else {
    results = [];
    for (const c of calls) results.push(await exec(c));
  }

  // One assistant turn holding every call, then one tool message per result —
  // the shape all six providers expect.
  messages.push({
    role: 'assistant',
    content: content || '',
    toolCalls: calls.map((c) => ({ id: c.id, name: c.name, args: c.args }))
  });

  for (const r of results) {
    const meta = toolMeta(r.call.name, r.call.args);
    trace.push({ step, tool: r.call.name, args: r.call.args, ok: r.ok, result: clip(r.text, 500) });
    onProgress({
      step,
      action: meta.label,
      detail: r.ok ? summarize(r.call.name, r.text) : r.text,
      status: r.ok ? 'completed' : 'error',
      icon: r.ok ? meta.icon : '',
      url: r.ok ? (r.call.args.url || r.call.args.href || '') : ''
    });
    messages.push({
      role: 'tool',
      toolCallId: r.call.id,
      name: r.call.name,
      content: r.text
    });
  }
}

/**
 * Pull the answer out of a final reply, even when the JSON is malformed.
 *
 * Models routinely emit `{"thought":"...","answer":"..."}` with a raw newline or
 * an unescaped quote inside one of the strings, which makes JSON.parse fail. The
 * old code fell back to showing the ENTIRE raw object to the user, protocol
 * braces and \n escapes included. Anything is better than that: if the object
 * won't parse, read the "answer" string out by hand.
 */
function extractAnswer(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';

  const parsed = parseDecision(text);
  if (parsed?.answer) return String(parsed.answer).trim();

  // Hand-scan for "answer": "..." honouring backslash escapes.
  const key = /"answer"\s*:\s*"/.exec(text);
  if (key) {
    const from = key.index + key[0].length;
    let out = '';
    for (let i = from; i < text.length; i++) {
      const c = text[i];
      if (c === '\\') {
        const n = text[i + 1];
        out += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '' : n;
        i++;
        continue;
      }
      if (c === '"') break;              // unescaped quote ends the value
      out += c;
    }
    if (out.trim()) return out.trim();
  }

  // No answer field at all: it's prose. Strip a stray protocol wrapper if the
  // model wrapped plain text in braces, otherwise hand it back as-is.
  if (text.startsWith('{') && !/"answer"/.test(text)) {
    const thought = /"thought"\s*:\s*"([\s\S]*?)"\s*[,}]/.exec(text);
    if (thought) return thought[1].replace(/\\n/g, '\n').trim();
  }
  return text;
}

/** Short, human-readable note about what a tool returned. */
function summarize(name, resultText) {
  try {
    const o = JSON.parse(resultText);
    if (Array.isArray(o.results)) return `${o.results.length} results`;
    if (Array.isArray(o.articles)) return `${o.articles.length} articles`;
    if (Array.isArray(o.links)) return `${o.links.length} links`;
    if (Array.isArray(o.tabs)) return `${o.tabs.length} tabs`;
    if (o.price != null) return `${o.symbol}: ${o.price} (${o.changePct >= 0 ? '+' : ''}${o.changePct}%)`;
    if (typeof o.text === 'string') return `${o.text.length.toLocaleString()} chars read`;
    if (o.saved) return 'Saved';
  } catch { /* not JSON */ }
  return clip(resultText, 120);
}

function stopAgent() {
  stopRequested = true;
}

module.exports = { runAgent, stopAgent };
