'use strict';
/* Deterministic (no AI) question extraction + categorisation from plain paper text.
   Recognised: numbered questions ("1.", "1)", "Q1.", "Q.1"), options "A." "A)" "(A)" "a)" on their own lines or inline,
   per-question "Answer: B" / "Ans - C" / "Correct answer: (D)", "Explanation: ...", a trailing "Answer Key" table,
   "[2 marks]" / "(2M)" marks, and headings "Unit 1 ...", "Module 2 ...", "Chapter 3 ...", "Section A ...", "Subject: ...", "Course: ...".
   CODE: lines of a question stem that look like source code keep their own line breaks and indentation and are wrapped in a ``` fence
   (the website renders fenced text as a monospace code block). Prose lines are still re-flowed into one paragraph. */
const LETTERS = 'ABCDEF';
const MAX_QUESTIONS = 300;

const RE_Q = /^\s*(?:Q(?:uestion)?\.?\s*)?(\d{1,3})\s*[.):\]]\s*(.+)$/i;
const RE_OPT = /^\s*\(?([A-Fa-f])(?:\s*\)\s*|\s*\.(?:\s+|$))(.*)$/;   // "A) x" "(A) x" "A. x" — but NOT code such as "a.push(1)"
const RE_ANS = /^\s*(?:correct\s+)?(?:ans(?:wer)?|key)\s*[:\-–]\s*\(?\s*([A-Fa-f])\s*\)?\b/i;
const RE_EXP = /^\s*(?:explanation|solution|reason)\s*[:\-–]\s*(.*)$/i;
const RE_KEYHDR = /^\s*(?:answer\s*key|answers|key\s+to\s+questions|solutions?\s+key)\s*:?\s*$/i;
const RE_SUBJ = /^\s*(?:subject|course|paper)\s*(?:name)?\s*[:\-–]\s*(.+)$/i;
const RE_UNIT = /^\s*((?:unit|module|chapter|section|part)\s*[-:–]?\s*(?:[0-9]{1,2}|[ivxIVX]{1,5}|[A-Za-z])\b.*)$/i;
const RE_MARKS = /[\[(]\s*(\d{1,2}(?:\.\d)?)\s*(?:marks?|m)\s*[\])]/i;

function clean(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }


/* ---------- code detection / formatting ---------- */
const CODE_START = /^\s*(?:#\s*(?:include|define|ifdef|ifndef|endif)\b|import\s+[\w.*]+|from\s+[\w.]+\s+import\b|def\s+\w+\s*\(|class\s+\w+|public\s|private\s|protected\s|static\s|void\s+\w+|(?:int|float|double|char|long|short|bool|boolean|String|var|let|const|auto)\s+[\w*]+(?:\[[^\]]*\])*\s*(?:[=;(,]|$)|(?:for|while|if|switch)\s*\(|else\b|elif\b|try\s*:|except\b|finally\b|return\b|break\s*;|continue\s*;|printf\s*\(|scanf\s*\(|print\s*\(|console\.log|System\.out|cout\s*<<|cin\s*>>|[{}]\s*;?\s*$|\/\/|\/\*|\*\/|@\w+)/;
const CODE_TOKEN = /==|!=|<=|>=|\+=|-=|\*=|\/=|%=|\+\+|--|->|=>|&&|\|\||<<|>>|::/;
function looksCode(raw, prevWasCode) {
  const t = String(raw || '').trim();
  if (!t) return false;
  const indent = raw.length - raw.trimStart().length;
  if (CODE_START.test(raw)) return true;
  if (/[;{}]\s*$/.test(t)) return true;
  if (CODE_TOKEN.test(t) && !/\b(?:is|are|the|which|what|and then)\b.*[.?]$/i.test(t)) return true;
  if (/^[A-Za-z_]\w*(?:\.\w+)*\([^()]*\)\s*;?$/.test(t)) return true;                  // foo(a, b)   obj.method(x)
  if (/^[A-Za-z_]\w*(?:\[[^\]]*\])*(?:\.\w+)*\s*=[^=]/.test(t) && t.split(/\s+/).length <= 10) return true;   // x = 5   a[i] = b
  if (prevWasCode && indent >= 2) return true;                                         // body line of a block that is already code
  return false;
}
/* C/Java/JS style code that arrived with no indentation at all (typical for PDFs): rebuild it from the braces. */
function reindentBraces(lines) {
  let depth = 0;
  return lines.map((l) => {
    const t = l.trim(); if (!t) return '';
    const lead = (t.match(/^\}+/) || [''])[0].length;
    const d = Math.max(0, depth - lead);
    const stripped = t.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '');
    depth = Math.max(0, depth + (stripped.match(/\{/g) || []).length - (stripped.match(/\}/g) || []).length);
    return '    '.repeat(d) + t;
  });
}
/* lines -> fenced code block with the common left margin removed and original relative indentation kept */
function fenceBlock(lines) {
  let L = lines.map((l) => l.replace(/\s+$/, ''));
  while (L.length && !L[0].trim()) L.shift();
  while (L.length && !L[L.length - 1].trim()) L.pop();
  if (!L.length) return { text: '', flatPython: false };
  const ind = (l) => l.length - l.trimStart().length;
  const margin = Math.min(...L.filter((l) => l.trim()).map(ind));
  L = L.map((l) => l.slice(Math.min(margin, ind(l))));
  const flat = L.every((l) => !l.trim() || ind(l) === 0);
  const hasBrace = L.some((l) => /[{}]/.test(l));
  let flatPython = false;
  if (flat && L.length >= 2) {
    if (hasBrace) L = reindentBraces(L);
    else if (L.some((l) => /:\s*$/.test(l))) flatPython = true;     // Python-like block whose indentation is gone: cannot be rebuilt safely
  }
  return { text: '```\n' + L.join('\n') + '\n```', flatPython };
}
/* cap at n characters without leaving a fence open */
function capText(t, n) {
  if (t.length <= n) return t;
  let cut = t.slice(0, n);
  if ((cut.match(/```/g) || []).length % 2) cut = cut.slice(0, n - 5) + '\n```';
  return cut;
}
function stemSegsAdd(cur, raw) {
  const last = cur.segs[cur.segs.length - 1];
  if (looksCode(raw, last && last.code)) {
    if (last && last.code) last.lines.push(raw); else cur.segs.push({ code: true, lines: [raw] });
  } else if (last && !last.code) last.text = clean(last.text + ' ' + raw);
  else cur.segs.push({ code: false, text: clean(raw) });
}
function stemText(cur) {
  const parts = []; let flatPython = false;
  cur.segs.forEach((sg) => {
    if (sg.code) { const f = fenceBlock(sg.lines); if (f.text) parts.push(f.text); flatPython = flatPython || f.flatPython; }
    else if (sg.text) parts.push(sg.text);
  });
  return { text: parts.join('\n'), flatPython };
}

/* Split "A) foo B) bar C) baz" on one line into options. Returns null if it doesn't look like inline options. */
function splitInlineOptions(line) {
  const re = /(?:^|\s)\(?([A-Fa-f])[.)]\s+/g;
  const hits = []; let m;
  while ((m = re.exec(line))) hits.push({ letter: m[1].toUpperCase(), at: m.index, end: re.lastIndex });
  if (hits.length < 2 || hits[0].letter !== 'A') return null;
  for (let i = 0; i < hits.length; i++) if (hits[i].letter !== LETTERS[i]) return null;
  const stem = line.slice(0, hits[0].at);
  const opts = hits.map((h, i) => clean(line.slice(h.end, i + 1 < hits.length ? hits[i + 1].at : undefined)));
  return { stem: clean(stem), opts };
}

function parseAnswerKeySection(lines) {
  const map = {};
  const re = /(\d{1,3})\s*[-.):–]?\s*\(?([A-Fa-f])\)?(?=[\s,;|]|$)/g;
  for (const ln of lines) { let m; while ((m = re.exec(ln))) map[Number(m[1])] = m[2].toUpperCase(); }
  return map;
}

function parseQuestions(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n').map((l) => l.replace(/ /g, ' ').trimEnd());
  let subject = '', unit = '', topic = '';
  const out = []; let cur = null, lastOpt = null, lastNum = 0, keyLines = null;
  const flush = () => { if (cur) { out.push(cur); cur = null; lastOpt = null; } };
  const catg = () => ({ subject: subject || 'Uncategorised', unit, topic: topic || 'Uncategorised' });

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {   // a blank line inside a code block is kept (it is trimmed again if the block ends there)
      if (cur && !cur.options.length) { const last = cur.segs[cur.segs.length - 1]; if (last && last.code) last.lines.push(''); }
      continue;
    }
    if (keyLines) { keyLines.push(line); continue; }
    if (RE_KEYHDR.test(line)) { flush(); keyLines = []; continue; }
    let m;
    if ((m = RE_SUBJ.exec(line)) && !cur) { subject = clean(m[1]).slice(0, 120); continue; }
    if ((m = RE_UNIT.exec(line)) && !RE_Q.test(line)) {
      flush(); unit = clean(m[1]).slice(0, 120);
      const rest = unit.replace(/^(?:unit|module|chapter|section|part)\s*[-:–]?\s*(?:[0-9]{1,2}|[ivxIVX]{1,5}|[A-Za-z])\b\s*[-:–.]?\s*/i, '');
      topic = rest ? rest.slice(0, 120) : '';
      continue;
    }
    if (cur && (m = RE_ANS.exec(line))) { cur.answer = m[1].toUpperCase(); continue; }
    if (cur && (m = RE_EXP.exec(line))) { cur.explanation = clean(m[1]).slice(0, 1000); cur.inExp = true; continue; }
    const qm = RE_Q.exec(line);
    if (qm) {
      const n = Number(qm[1]);
      if ((n === lastNum + 1 || (n > lastNum && n <= lastNum + 5) || (lastNum === 0 && n <= 3))) {
        flush();
        lastNum = n;
        const body = qm[2];
        const inl = splitInlineOptions(body);
        cur = { num: n, segs: [{ code: false, text: inl ? inl.stem : clean(body) }], options: inl ? inl.opts : [], answer: '', explanation: '', ...catg() };
        const mk = RE_MARKS.exec(body); if (mk) cur.marks = Number(mk[1]);
        continue;
      }
    }
    if (!cur) continue;
    const om = RE_OPT.exec(line);
    if (om) {
      const idx = LETTERS.indexOf(om[1].toUpperCase());
      if (idx === cur.options.length) { cur.options.push(clean(om[2])); lastOpt = idx; cur.inExp = false; continue; }
    }
    const inl2 = !cur.options.length ? splitInlineOptions(line) : null;
    if (inl2) { if (inl2.stem) stemSegsAdd(cur, inl2.stem); cur.options = inl2.opts; continue; }
    if (cur.inExp) cur.explanation = clean(cur.explanation + ' ' + line).slice(0, 1000);
    else if (lastOpt !== null && cur.options.length) cur.options[lastOpt] = clean(cur.options[lastOpt] + ' ' + line);
    else stemSegsAdd(cur, raw);
  }
  flush();
  const keyMap = keyLines ? parseAnswerKeySection(keyLines) : {};
  let flatPythonSeen = false;
  const questions = out.slice(0, MAX_QUESTIONS).map((q, i) => {
    const st = stemText(q); q.text = st.text; if (st.flatPython) flatPythonSeen = true;
    const ans = q.answer || keyMap[q.num] || '';
    const optsOk = q.options.length >= 2 && q.options.length <= 6 && q.options.every(Boolean);
    const ansOk = !!ans && LETTERS.slice(0, q.options.length).includes(ans);
    const marks = q.marks > 0 ? q.marks : 1;
    return {
      order: i + 1, text: capText(q.text.replace(RE_MARKS, '').replace(/[ \t]+\n/g, '\n').trim(), 2000), options: q.options.slice(0, 6).map((o) => o.slice(0, 500)),
      marks, subject: q.subject, unit: q.unit, topic: q.topic, answer: ansOk ? ans : '', explanation: q.explanation || '',
      confidence: optsOk && ansOk ? 0.8 : optsOk ? 0.6 : 0.3, needsReview: !(optsOk && ansOk),
    };
  }).filter((q) => q.text);
  return { questions, hadKeySection: !!keyLines, truncated: out.length > MAX_QUESTIONS, flatPython: flatPythonSeen };
}

module.exports = { parseQuestions, splitInlineOptions, parseAnswerKeySection, looksCode, fenceBlock, reindentBraces, capText, MAX_QUESTIONS, LETTERS };
