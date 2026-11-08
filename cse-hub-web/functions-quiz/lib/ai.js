'use strict';
/**
 * Question generation. The provider is configuration (quizSettings/config.generationProvider), so it can be swapped
 * without touching the app. The API key is a Firebase secret (QUIZ_AI_API_KEY) and never leaves the server.
 */
const { db, FV, HttpsError, GROUPS, QUESTIONS_PER_QUIZ, DIFFICULTIES, cleanQuestion, qHash, norm, logGeneration } = require('./core');

const PROVIDERS = {
  anthropic: { defaultModel: 'claude-sonnet-5-5' },
  openai:    { defaultModel: 'gpt-4o-mini' },
  groq:      { defaultModel: 'llama-3.3-70b-versatile' },   // Groq's OpenAI-compatible API; model IDs differ from OpenAI's
  gemini:    { defaultModel: 'gemini-2.0-flash' },
};

// Providers can echo a (partially masked) copy of the key in error text; never let that reach logs or the admin UI.
const scrub = (m) => String(m || '').replace(/\b(gsk_|sk-|AIza)[A-Za-z0-9_*.\-]*/g, '[redacted-key]');

async function callModel({ provider, model, apiKey, system, user, maxTokens = 3000 }) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`Unknown provider "${provider}"`);
  if (!apiKey) throw new Error('AI API key secret (QUIZ_AI_API_KEY) is not configured');
  const m = model || p.defaultModel;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 90000);
  try {
    let res, data;
    if (provider === 'anthropic') {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal: ctl.signal,
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: m, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
      });
      data = await res.json();
      if (!res.ok) throw new Error(`Anthropic ${res.status}: ${scrub(data.error && data.error.message) || 'request failed'}`);
      return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    }
    if (provider === 'openai' || provider === 'groq') {
      const base = provider === 'groq' ? 'https://api.groq.com/openai/v1' : 'https://api.openai.com/v1';
      const label = provider === 'groq' ? 'Groq' : 'OpenAI';
      res = await fetch(`${base}/chat/completions`, {
        method: 'POST', signal: ctl.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: m, max_tokens: maxTokens, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      });
      data = await res.json();
      if (!res.ok) throw new Error(`${label} ${res.status}: ${scrub(data.error && data.error.message) || 'request failed'}`);
      return data.choices[0].message.content;
    }
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent`, {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig: { maxOutputTokens: maxTokens, responseMimeType: 'application/json' } }),
    });
    data = await res.json();
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${scrub(data.error && data.error.message) || 'request failed'}`);
    return ((data.candidates || [])[0].content.parts || []).map((x) => x.text || '').join('');
  } finally { clearTimeout(timer); }
}

function parseJson(text) {
  const s = String(text || '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a === -1 || b <= a) throw new Error('Model did not return JSON');
  return JSON.parse(s.slice(a, b + 1));
}

/* ---------- prompt design ---------- */
const CATEGORIES = {
  FY_ALL: [
    'Engineering mathematics (calculus, limits and series, matrices and eigenvalues, differential equations, probability)',
    'Physics (mechanics, waves, optics, thermodynamics, modern physics; numerical or concept-application questions)',
    'Engineering chemistry (electrochemistry, thermodynamics, polymers, water and fuels, materials)',
    'Basic electrical and electronics (circuit laws, AC basics, diodes and transistors, measurements)',
    'Engineering mechanics and materials (forces, equilibrium, friction, stress-strain, units and dimensions)',
    'Programming fundamentals (C or Python: tricky output prediction, operators, loops, arrays, recursion)',
    'Logical reasoning and quantitative aptitude (puzzles, series, probability, time-speed-work, data sufficiency)',
  ],
  SY_CSE_GROUP: [
    'Data structures and algorithms (complexity analysis, tracing recursion, trees, graphs, heaps, hashing, dynamic programming)',
    'Code output prediction and debugging (C/C++/Java/Python: pointers, references, scope, integer overflow, recursion, edge cases, language gotchas)',
    'Operating systems (scheduling, synchronization and deadlock, memory management, paging, file systems)',
    'Databases (SQL query results, joins, normalization, indexing, transactions and isolation)',
    'Computer networks and web (TCP/IP, subnetting, routing, HTTP, DNS, REST, security basics)',
    'Object-oriented design and software engineering (OOP concepts, design patterns, Git, testing, cloud and containers)',
    'Discrete mathematics, digital logic and computer organisation (combinatorics, graph theory, Boolean algebra, number representation, caches)',
    'AI/ML fundamentals (supervised learning, overfitting, evaluation metrics, gradient descent, basic probability for ML)',
  ],
};
const LEVEL = {
  FY_ALL: 'first-year engineering students from many branches (CSE, ECE, mechanical, civil, etc.); engineering mathematics, science and topics common to the first-year syllabus; no branch-specific prerequisites; challenging: mostly medium-to-hard, with at least one hard question that needs multi-step reasoning',
  SY_CSE_GROUP: 'second-year students of CSE, CSE (AI & ML) and ISE; strongly tech and coding focused, at syllabus level and beyond; difficult: mostly hard, at most one medium; questions should need careful tracing, analysis or applying a concept, not recall',
};
function seeded(seedStr) {
  let h = 2166136261;
  for (const c of seedStr) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 1e6) / 1e6; };
}
function pickCategories(groupId, date, n) {
  const rnd = seeded(`${date}|${groupId}`), pool = CATEGORIES[groupId].slice();
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  const out = []; for (let i = 0; i < n; i++) out.push(pool[i % pool.length]); return out;
}

const SYSTEM = 'You write multiple-choice quiz questions for engineering students. You are meticulous: every question is factually correct, unambiguous, self-contained and has exactly one defensible correct answer. You reply with a single JSON object and nothing else.';

async function recentTexts(groupId, limit = 40) {
  const snap = await db.collection('quizQuestionHashes').where('groupId', '==', groupId).orderBy('createdAt', 'desc').limit(limit).get();
  return snap.docs.map((d) => d.data().text).filter(Boolean);
}

/* ============================================================================================
 * Second Year (SY_CSE_GROUP) technical generator — owner-configurable difficulty, domains, formats.
 * Settings live in quizSettings/config.secondYearGen. First Year never reads them.
 * ============================================================================================ */
const SY_GROUP = 'SY_CSE_GROUP';
const GEN_CATALOG = [
  { id: 'lang', label: 'Programming Languages', topics: ['C Programming', 'C++', 'Java', 'Python', 'JavaScript', 'TypeScript', 'SQL', 'Kotlin', 'Go', 'Rust', 'Object-Oriented Programming', 'Functional Programming'] },
  { id: 'dsa', label: 'Data Structures and Algorithms', topics: ['Arrays and Strings', 'Linked Lists', 'Stacks and Queues', 'Trees and Binary Trees', 'Binary Search Trees', 'Graphs', 'Hashing', 'Recursion and Backtracking', 'Sorting and Searching', 'Dynamic Programming', 'Greedy Algorithms', 'Time and Space Complexity', 'Competitive Programming', 'Problem Solving'] },
  { id: 'web', label: 'Web Development', topics: ['HTML and CSS', 'JavaScript DOM', 'React', 'Node.js', 'Express.js', 'REST APIs', 'Authentication', 'Frontend Development', 'Backend Development', 'Full-Stack Development', 'Responsive Web Design'] },
  { id: 'db', label: 'Database Technologies', topics: ['DBMS', 'SQL Queries', 'Joins and Subqueries', 'Normalization', 'Transactions', 'Indexing', 'MongoDB', 'Firebase', 'PostgreSQL', 'Database Design'] },
  { id: 'cs', label: 'Computer Science Fundamentals', topics: ['Operating Systems', 'Computer Networks', 'Computer Architecture', 'Software Engineering', 'Object-Oriented Design', 'Compiler Design', 'Theory of Computation', 'Discrete Mathematics', 'Digital Logic', 'Information Security'] },
  { id: 'ai', label: 'Artificial Intelligence and Machine Learning', topics: ['AI Fundamentals', 'Machine Learning', 'Supervised and Unsupervised Learning', 'Neural Networks', 'Deep Learning', 'Natural Language Processing', 'Computer Vision', 'Generative AI', 'Prompt Engineering', 'Data Science', 'Python for Machine Learning'] },
  { id: 'modern', label: 'Modern Technologies', topics: ['Cloud Computing', 'Firebase', 'Google Cloud', 'AWS Fundamentals', 'Docker', 'Git and GitHub', 'CI/CD', 'DevOps', 'Cybersecurity Fundamentals', 'Blockchain', 'Internet of Things', 'Distributed Systems', 'System Design'] },
  { id: 'practical', label: 'Practical Engineering and Development', topics: ['Debugging', 'Code Optimization', 'Software Testing', 'Real-world Programming Scenarios', 'Identifying Logical Errors', 'Predicting Program Output', 'Writing Efficient Algorithms', 'API Integration', 'Building Small Applications', 'Technical Case Studies'] },
];
const ALL_TOPICS = new Set(GEN_CATALOG.flatMap((c) => c.topics));
const GEN_DIFFICULTIES = {
  beginner: { label: 'Beginner', hint: 'Basic concepts, definitions, syntax and straightforward problems.', brief: 'Single-concept recall or a one-step problem: basic definitions, syntax, reading a very short snippet (about 3-6 lines, no tricks).' },
  easy:     { label: 'Easy', hint: 'Fundamental coding problems and basic applications.', brief: 'Fundamental coding problems: tracing a short program with a loop or condition, applying one standard concept in a basic application.' },
  medium:   { label: 'Medium', hint: 'Intermediate programming, logical reasoning and application-based problems.', brief: 'Intermediate programming and logical reasoning: programs combining loops, lists/arrays and functions, or applying a concept to a practical situation; needs 2-3 reasoning steps.' },
  hard:     { label: 'Hard', hint: 'Complex algorithms, debugging, data structures and multi-step problems.', brief: 'Complex multi-step reasoning: nested data structures, function interactions, edge cases, subtle bugs, non-trivial algorithms; a careful student needs several minutes.' },
  advanced: { label: 'Advanced', hint: 'Optimization, system design, advanced algorithms and deeper technical understanding.', brief: 'Challenging technical problems: analysing a non-trivial algorithm and comparing time/space complexity, optimization trade-offs, concurrency or design decisions, deeper internals.' },
  expert:   { label: 'Expert', hint: 'Competition-level or industry-oriented technical challenges.', brief: 'Competition-level or industry-grade: sophisticated algorithmic or system-design reasoning in several stages, tricky invariants and corner cases that most second-year students would miss.' },
};
const GEN_FORMATS = [
  { id: 'output',     label: 'Predict the output of a code snippet', practical: true },
  { id: 'error',      label: 'Identify the logical error in a program', practical: true },
  { id: 'algo',       label: 'Choose the correct algorithm', practical: true },
  { id: 'complexity', label: 'Find the time complexity', practical: true },
  { id: 'debug',      label: 'Debug a given code snippet', practical: true },
  { id: 'complete',   label: 'Complete missing code', practical: true },
  { id: 'sql',        label: 'Identify the correct SQL query', practical: true },
  { id: 'scenario',   label: 'Analyze a programming scenario', practical: false },
  { id: 'bestsol',    label: 'Select the best technical solution', practical: false },
  { id: 'realworld',  label: 'Solve a real-world engineering problem', practical: false },
];
const FORMAT_BY_ID = Object.fromEntries(GEN_FORMATS.map((f) => [f.id, f]));
const DIST_MODES = { single: 'All questions at the selected difficulty', mixed: 'Mixed difficulty (Easy, Medium, Hard)', custom: 'Custom distribution' };
const DEFAULT_GEN = { difficulty: 'medium', difficultyNotes: '', domainMode: 'all', categories: [], topics: [], customTopic: '', formats: [], distribution: 'single', customDistribution: ['easy', 'medium', 'hard'] };
const GEN_CATALOG_PUBLIC = {
  difficulties: Object.entries(GEN_DIFFICULTIES).map(([id, d]) => ({ id, label: d.label, hint: d.hint })),
  distributions: Object.entries(DIST_MODES).map(([id, label]) => ({ id, label })),
  formats: GEN_FORMATS.map((f) => ({ id: f.id, label: f.label })),
  categories: GEN_CATALOG,
};

/** Validates owner input (throws HttpsError). Free text is reduced to plain single-line text: it is data for the prompt, never markup or instructions. */
function cleanGenSettings(raw) {
  const bad = (m) => { throw new HttpsError('invalid-argument', m); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad('Invalid generator settings.');
  const text = (v, max, name) => { const t = String(v == null ? '' : v).replace(/[\u0000-\u001f`<>{}]+/g, ' ').replace(/\s+/g, ' ').trim(); if (t.length > max) bad(`${name} must be at most ${max} characters.`); return t; };
  const arr = (v, name, max) => { if (v == null) return []; if (!Array.isArray(v) || v.length > max) bad(`${name} is invalid.`); return v; };
  const out = {};
  out.difficulty = raw.difficulty == null ? DEFAULT_GEN.difficulty : raw.difficulty;
  if (!GEN_DIFFICULTIES[out.difficulty]) bad('Unknown difficulty.');
  out.difficultyNotes = text(raw.difficultyNotes, 300, 'Difficulty instructions');
  out.domainMode = raw.domainMode == null ? 'all' : raw.domainMode;
  if (!['all', 'specific'].includes(out.domainMode)) bad('Unknown domain mode.');
  out.categories = [...new Set(arr(raw.categories, 'Domains', 20))]; if (out.categories.some((c) => !GEN_CATALOG.some((g) => g.id === c))) bad('Unknown domain.');
  out.topics = [...new Set(arr(raw.topics, 'Topics', 80))]; if (out.topics.some((t) => typeof t !== 'string' || !ALL_TOPICS.has(t))) bad('Unknown topic.');
  out.customTopic = text(raw.customTopic, 300, 'Custom topic');
  out.formats = [...new Set(arr(raw.formats, 'Formats', 20))]; if (out.formats.some((f) => !FORMAT_BY_ID[f])) bad('Unknown question format.');
  out.distribution = raw.distribution == null ? 'single' : raw.distribution;
  if (!DIST_MODES[out.distribution]) bad('Unknown difficulty distribution.');
  const cd = raw.customDistribution == null ? DEFAULT_GEN.customDistribution : raw.customDistribution;
  if (!Array.isArray(cd) || cd.length !== QUESTIONS_PER_QUIZ || cd.some((d) => !GEN_DIFFICULTIES[d])) bad(`Custom distribution needs ${QUESTIONS_PER_QUIZ} valid difficulty levels.`);
  out.customDistribution = cd.slice();
  if (out.domainMode === 'specific' && !out.categories.length && !out.topics.length && !out.customTopic) bad('Choose at least one domain or topic, or type a custom topic.');
  return out;
}
/** Never throws: a damaged stored value falls back to defaults so the scheduler can't be blocked by it. */
function resolveGen(stored) {
  try { return cleanGenSettings(Object.assign({}, DEFAULT_GEN, stored || {})); } catch (e) { return Object.assign({}, DEFAULT_GEN); }
}
function summarizeGen(g) {
  return { difficulty: g.difficulty, distribution: g.distribution, customDistribution: g.distribution === 'custom' ? g.customDistribution : null, domainMode: g.domainMode,
    domains: [...g.categories.map((id) => (GEN_CATALOG.find((c) => c.id === id) || {}).label), ...g.topics].slice(0, 20), customTopic: g.customTopic.slice(0, 120), formats: g.formats };
}

/** Per-question plan: difficulty, domain/topic and format. Deterministic per date, spread across the selected scope. */
function planSY({ date, gen, count }) {
  const rnd = seeded(`${date}|${SY_GROUP}|sy`);
  const shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const levels = gen.distribution === 'mixed' ? ['easy', 'medium', 'hard'] : gen.distribution === 'custom' ? gen.customDistribution : [gen.difficulty];
  let items = [];                                                    // {domain, topic}
  if (gen.domainMode === 'all') items = GEN_CATALOG.map((c) => ({ domain: c.label, topic: '' }));
  else {
    gen.categories.forEach((id) => { const c = GEN_CATALOG.find((g) => g.id === id); if (c) items.push({ domain: c.label, topic: '' }); });
    gen.topics.forEach((t) => { const c = GEN_CATALOG.find((g) => g.topics.includes(t)); items.push({ domain: c ? c.label : '', topic: t }); });
  }
  items = shuffle(items);
  const fitsSql = (it) => /database|sql|dbms|postgres|mongo|firebase/i.test(`${it.domain} ${it.topic}`);
  const allowed = (gen.formats.length ? GEN_FORMATS.filter((f) => gen.formats.includes(f.id)) : GEN_FORMATS);
  const used = new Set();
  const plan = [];
  for (let i = 0; i < count; i++) {
    const it = items.length ? items[i % items.length] : { domain: '', topic: '' };
    // at least two of every three questions lean practical (code/analysis) unless the owner narrowed the formats
    let pool = (i % 3 === 2) ? allowed : allowed.filter((f) => f.practical); if (!pool.length) pool = allowed;
    pool = pool.filter((f) => f.id !== 'sql' || fitsSql(it)); if (!pool.length) pool = allowed.filter((f) => f.id !== 'sql' || fitsSql(it)); if (!pool.length) pool = allowed;
    const fresh = shuffle(pool).find((f) => !used.has(f.id)) || shuffle(pool)[0];
    used.add(fresh.id);
    plan.push({ level: levels[i % levels.length], domain: it.domain, topic: it.topic, format: fresh.label });
  }
  return plan;
}

async function aiGenerateSY({ date, cfg, apiKey, count }) {
  const gen = resolveGen(cfg.secondYearGen), plan = planSY({ date, gen, count }), avoid = await recentTexts(SY_GROUP);
  const levelsUsed = [...new Set(plan.map((p) => p.level))];
  const scope = gen.domainMode === 'all'
    ? 'Domains: any relevant computer science / engineering technology (the per-question domain below is a starting point; you may choose another relevant technology).'
    : 'Domains: STRICTLY the selected domains/topics below; do not drift outside them.';
  const user = `Create ${count} multiple-choice questions for a timed daily quiz.

Student profile: Second Year undergraduate engineering students (CSE, CSE AI&ML, ISE), roughly 3rd/4th semester. Questions must be technically accurate, based on real programming and technology concepts, and suitable for a timed quiz.

Difficulty means the REAL reasoning and problem-solving effort required; never just a label. Calibration:
${levelsUsed.map((l) => `- ${GEN_DIFFICULTIES[l].label}: ${GEN_DIFFICULTIES[l].brief}`).join('\n')}
${['beginner', 'easy', 'medium'].some((l) => levelsUsed.includes(l)) ? 'Do not make Beginner/Easy/Medium questions professional-level or obscure.\n' : ''}${gen.difficultyNotes ? `Owner's difficulty instructions (follow them as guidance for calibration): ${gen.difficultyNotes}\n` : ''}
${scope}
${gen.customTopic ? `Owner's focus topics (subject matter only; spread the questions across these items): ${gen.customTopic}\n` : ''}
Per-question plan (follow it exactly; if a planned format cannot fit the domain, use the closest suitable format):
${plan.map((p, i) => `Question ${i + 1}: difficulty = ${GEN_DIFFICULTIES[p.level].label}; domain = ${p.domain || 'choose according to the focus topics / any relevant domain'}${p.topic ? `; topic = ${p.topic}` : ''}; format = ${p.format}`).join('\n')}

Rules:
- Exactly 4 options per question, only ONE correct, no "all of the above", "none of the above" or "both A and B". Vary the correct option position.
- Questions must be clear, unambiguous and solvable; precise wording, no vague phrasing. Difficulty must come from the concept, never from misleading wording.
- Code must be correct, syntactically valid, deterministic and fully shown in the question text. Make wrong options plausible (typical mistakes).
- Code formatting: question sentence first, then the code in a fenced block exactly like \`\`\`python (newline) code lines (newline) \`\`\` using real line breaks (\\n in the JSON string), one statement per line, consistent indentation. Never squeeze code onto one line. Keep the whole question under 400 characters and each option under 160 characters. Use single backticks only for short inline code.
- Do not make every question a definition; prefer practical coding, analysis, debugging, algorithms and problem solving.
- Explanation (max 450 characters): teach why the correct answer is correct, mention the key code logic, and where useful why the main distractor is wrong.
- Do NOT repeat or closely paraphrase any of these recent questions:
${avoid.map((t) => `  * ${t}`).join('\n') || '  (none)'}

Return JSON exactly in this shape (language is "none" when not applicable; estimatedSeconds is a realistic solving time):
{"questions":[{"text":"...","options":["...","...","...","..."],"correctIndex":0,"explanation":"...","difficulty":"beginner|easy|medium|hard|advanced|expert","domain":"...","topic":"...","format":"...","language":"...","estimatedSeconds":60}]}`;
  const raw = await callModel({ provider: cfg.generationProvider, model: cfg.generationModel, apiKey, system: SYSTEM, user, maxTokens: 5000 });
  const list = (parseJson(raw).questions) || [];
  return list.map((q, i) => {
    const p = plan[i] || {}, lang = String((q && q.language) || '').trim();
    const domain = (q && q.domain) || p.domain || '', topic = (q && q.topic) || p.topic || '';
    return cleanQuestion(Object.assign({}, q, {
      difficulty: p.level || (DIFFICULTIES.includes(String(q && q.difficulty).toLowerCase()) ? String(q.difficulty).toLowerCase() : gen.difficulty),   // the plan is authoritative
      domain, topic, format: (q && q.format) || p.format || '', language: /^(none|n\/a|null)?$/i.test(lang) ? '' : lang,
      estSeconds: q && q.estimatedSeconds, category: String(topic || domain || 'General').slice(0, 40),
    }));
  }).filter((c) => c.ok).map((c) => c.q);
}

async function aiGenerate({ date, groupId, cfg, apiKey, count }) {
  if (groupId === SY_GROUP) return aiGenerateSY({ date, cfg, apiKey, count });
  const cats = pickCategories(groupId, date, count);
  const avoid = await recentTexts(groupId);
  const user = `Create ${count} multiple-choice questions for ${LEVEL[groupId]}.

Question ${cats.map((c, i) => `${i + 1} category: ${c}`).join('\n')}

Rules:
- Exactly 4 options per question, only ONE correct. No "all of the above", "none of the above" or "both A and B" options.
- Correct option position must vary; do not always use the same index.
- Make the questions genuinely challenging: require multi-step reasoning, careful tracing or applying a concept to a new situation; make wrong options plausible (typical mistakes). Difficulty must come from the concept, never from vague or misleading wording: the question must stay precise, unambiguous and have exactly one defensible answer.
- No opinion questions, no questions that depend on a specific textbook, edition or recent news.
- Keep each question under 400 characters and each option under 160 characters.
- Code-output questions must be fully deterministic and shown in the question text.
- Formatting of code: write the question sentence first, then the code in a fenced block exactly like \`\`\`c (newline) code lines (newline) \`\`\` using real line breaks (\n in the JSON string), one statement per line and 4-space indentation for nested blocks. Never squeeze code onto one line. Keep code to at most 10 short lines so the whole question stays under 400 characters. Use single backticks only for short inline code such as \`i++\` inside sentences or options.
- Each question needs a 1–3 sentence explanation that justifies the correct answer.
- Do NOT repeat or closely paraphrase any of these recent questions:
${avoid.map((t) => `  * ${t}`).join('\n') || '  (none)'}

Return JSON exactly in this shape:
{"questions":[{"text":"...","options":["...","...","...","..."],"correctIndex":0,"explanation":"...","difficulty":"easy|medium|hard","category":"short category name"}]}`;
  const raw = await callModel({ provider: cfg.generationProvider, model: cfg.generationModel, apiKey, system: SYSTEM, user, maxTokens: 4000 });
  const list = (parseJson(raw).questions) || [];
  return list.map((q) => cleanQuestion(q)).filter((c) => c.ok).map((c) => c.q);
}

/** Independent second pass: a fresh call solves each question WITHOUT seeing the key; mismatch or ambiguity ⇒ reject. */
async function aiVerify({ questions, cfg, apiKey }) {
  const user = `Solve each question independently. For each, pick the single best option and say whether the question is ambiguous, has more than one defensible answer, or has no correct option.
${questions.map((q, i) => `\n#${i}: ${q.text}\n${q.options.map((o, k) => `  ${k}) ${o}`).join('\n')}`).join('\n')}

Return JSON only: {"results":[{"id":0,"chosenIndex":0,"ambiguous":false}]}`;
  const raw = await callModel({ provider: cfg.generationProvider, model: cfg.generationModel, apiKey, system: 'You are a careful expert examiner. Reply with JSON only.', user, maxTokens: 1500 });
  const res = parseJson(raw).results || [];
  return questions.map((q, i) => { const r = res.find((x) => x.id === i); return !!(r && !r.ambiguous && r.chosenIndex === q.correctIndex); });
}

async function isDuplicate(q) { return (await db.doc(`quizQuestionHashes/${qHash(q.text)}`).get()).exists || (await db.doc(`quizQuestionPool/${qHash(q.text)}`).get()).exists; }

/** Draw approved, unused questions from the backup pool (different categories first). */
async function drawFromPool(groupId, n) {
  const snap = await db.collection('quizQuestionPool').where('groupId', '==', groupId).where('used', '==', false).limit(40).get();
  const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const chosen = [], seen = new Set();
  for (const r of rows.sort(() => Math.random() - 0.5)) { if (chosen.length >= n) break; if (!seen.has(r.category)) { chosen.push(r); seen.add(r.category); } }
  for (const r of rows) { if (chosen.length >= n) break; if (!chosen.includes(r)) chosen.push(r); }
  return chosen.length >= n ? chosen.slice(0, n) : null;
}

/**
 * Returns {questions, source, provider, model, poolIds}. Throws if no valid quiz can be produced — callers must NOT publish then.
 */
async function generateQuiz({ date, groupId, cfg, apiKey, trigger }) {
  const need = QUESTIONS_PER_QUIZ, total = need + Math.max(0, cfg.poolBuffer || 0);
  const provider = cfg.generationProvider, model = cfg.generationModel || (PROVIDERS[provider] || {}).defaultModel || '';
  const settings = groupId === SY_GROUP ? summarizeGen(resolveGen(cfg.secondYearGen)) : null;
  let lastErr = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      let cands = await aiGenerate({ date, groupId, cfg, apiKey, count: total });
      const uniq = []; const seen = new Set();
      for (const q of cands) { const h = qHash(q.text); if (seen.has(h) || await isDuplicate(q)) continue; seen.add(h); uniq.push(q); }
      cands = uniq;
      if (cands.length < need) throw new Error(`Only ${cands.length} valid, non-duplicate questions came back (need ${need})`);
      if (cfg.requireVerification) { const ok = await aiVerify({ questions: cands, cfg, apiKey }); cands = cands.filter((_, i) => ok[i]); }
      if (cands.length < need) throw new Error(`Only ${cands.length} questions passed verification (need ${need})`);
      const chosen = cands.slice(0, need), spare = cands.slice(need);
      for (const q of spare) await db.doc(`quizQuestionPool/${qHash(q.text)}`).set({ groupId, ...q, used: false, source: 'ai', provider, model, createdAt: FV.serverTimestamp() });
      return { questions: chosen, source: 'ai', provider, model, poolIds: [], settings };
    } catch (e) { lastErr = String((e && e.message) || e); console.warn(`[quiz] AI attempt ${attempt} failed (${groupId} ${date}): ${lastErr}`); }
  }
  // fallback: previously approved, unused questions
  const pool = await drawFromPool(groupId, need);
  if (pool) {
    await logGeneration({ date, groupId, status: 'fallback', source: 'pool', provider, model, trigger, error: `AI failed: ${lastErr}` });
    return { questions: pool.map((r) => ({ text: r.text, options: r.options, correctIndex: r.correctIndex, explanation: r.explanation, difficulty: r.difficulty, category: r.category })), source: 'pool', provider, model, poolIds: pool.map((r) => r.id), settings };
  }
  throw new HttpsError('unavailable', `Question generation failed and the backup pool is empty. Last error: ${lastErr}`);
}

module.exports = { generateQuiz, PROVIDERS, CATEGORIES, GEN_CATALOG_PUBLIC, cleanGenSettings, resolveGen };
