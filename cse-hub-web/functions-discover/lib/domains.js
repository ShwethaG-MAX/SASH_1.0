'use strict';
/**
 * Discover — domain catalogue. ONE place that says which interests exist and which source feeds each.
 * To add a domain: add an entry here (and the same id/label/icon in the website's DV_DOMAINS list, and in firestore.rules' allowed list).
 *   devto : DEV.to tags fetched for this domain (each tag = 1 request per refresh)
 *   kw    : Hacker News stories are matched to the domain by these keywords (regex source, case-insensitive)
 *   nd    : NewsData.io query for this domain (1 credit per request on the free plan); omit = not fetched from NewsData
 */
const DOMAINS = [
  /* ---- Technology ---- */
  { id: 'ai', label: 'Artificial Intelligence', group: 'Technology',
    devto: ['ai', 'llm'], kw: ['AI', 'artificial intelligence', 'LLMs?', 'GPT-?\\d*', 'ChatGPT', 'OpenAI', 'Anthropic', 'Claude', 'Gemini', 'Copilot', 'generative'],
    nd: { category: 'technology', q: 'artificial intelligence OR "generative AI" OR OpenAI' } },
  { id: 'ml', label: 'Machine Learning', group: 'Technology',
    devto: ['machinelearning', 'deeplearning'], kw: ['machine learning', 'deep learning', 'neural net(work)?s?', 'PyTorch', 'TensorFlow', 'transformers?', 'diffusion model', 'reinforcement learning', 'fine-?tun\\w*', 'embeddings?'] },
  { id: 'datascience', label: 'Data Science', group: 'Technology',
    devto: ['datascience', 'dataengineering'], kw: ['data science', 'data analysis', 'pandas', 'datasets?', 'data engineering', 'analytics', 'DuckDB', 'SQL', 'databases?', 'Postgres'] },
  { id: 'programming', label: 'Programming', group: 'Technology',
    devto: ['programming', 'python'], kw: ['programming', 'compilers?', 'Rust', 'Python', 'TypeScript', 'Golang', 'C\\+\\+', 'Haskell', 'Zig', 'Lisp', 'Kotlin', 'language design', 'type system'] },
  { id: 'softeng', label: 'Software Engineering', group: 'Technology',
    devto: ['softwareengineering', 'architecture'], kw: ['software engineering', 'architecture', 'refactor\\w*', 'unit tests?', 'testing', 'DevOps', 'microservices?', 'code review', 'technical debt', 'open source', 'monorepo'] },
  { id: 'webdev', label: 'Web Development', group: 'Technology',
    devto: ['webdev', 'javascript', 'react'], kw: ['web dev\\w*', 'JavaScript', 'CSS', 'HTML', 'React', 'Vue', 'Svelte', 'Next\\.js', 'browsers?', 'WebAssembly', 'WASM', 'front-?end', 'Node\\.js'] },
  { id: 'appdev', label: 'App Development', group: 'Technology',
    devto: ['android', 'flutter', 'mobile'], kw: ['Android', 'iOS', 'Swift', 'Kotlin', 'Flutter', 'React Native', 'mobile apps?', 'App Store', 'Jetpack'] },
  { id: 'cybersecurity', label: 'Cybersecurity', group: 'Technology',
    devto: ['security', 'cybersecurity'], kw: ['security', 'vulnerabilit\\w*', 'exploit\\w*', 'malware', 'ransomware', 'data breach', 'CVE-\\d+', 'zero-?day', 'phishing', 'encryption', 'cryptograph\\w*', 'infosec', 'hack(ed|ers?|ing)?'],
    nd: { category: 'technology', q: 'cybersecurity OR ransomware OR "data breach" OR malware' } },
  { id: 'cs', label: 'Computer Science', group: 'Technology',
    devto: ['computerscience', 'algorithms'], kw: ['algorithms?', 'data structures?', 'computer science', 'complexity theory', 'P vs NP', 'Turing', 'formal verification', 'operating systems?', 'kernel', 'distributed systems?', 'CPUs?', 'GPUs?', 'RISC-V'] },
  { id: 'cloud', label: 'Cloud Computing', group: 'Technology',
    devto: ['cloud', 'aws', 'kubernetes'], kw: ['AWS', 'Azure', 'GCP', 'Google Cloud', 'Kubernetes', 'Docker', 'serverless', 'cloud', 'Cloudflare', 'Terraform', 'data centers?'] },
  /* ---- Science ---- */
  { id: 'space', label: 'Space & Astronomy', group: 'Science',
    devto: [], kw: ['NASA', 'SpaceX', 'astronom\\w*', 'telescopes?', 'Mars', 'lunar', 'rockets?', 'satellites?', 'exoplanets?', 'galax\\w*', 'asteroids?', 'JWST', 'ESA', 'ISRO', 'orbit\\w*'],
    nd: { category: 'science', q: 'astronomy OR NASA OR telescope OR "space exploration" OR ISRO' } },
  { id: 'physics', label: 'Physics', group: 'Science',
    devto: ['physics'], kw: ['physics', 'quantum', 'particles?', 'CERN', 'relativity', 'superconduct\\w*', 'photons?', 'neutrinos?', 'fusion'],
    nd: { category: 'science', q: 'physics OR "quantum computing" OR CERN OR superconductor' } },
  { id: 'math', label: 'Mathematics', group: 'Science',
    devto: ['math'], kw: ['mathematic\\w*', 'theorems?', 'prime numbers?', 'topology', 'algebra', 'calculus', 'conjecture', 'geometry', 'combinatorics', 'proofs?'],
    nd: { category: 'science', q: 'mathematics OR mathematician OR theorem OR "prime numbers"' } },
  { id: 'biotech', label: 'Biotechnology', group: 'Science',
    devto: [], kw: ['biotech\\w*', 'CRISPR', 'genom\\w*', 'DNA', 'proteins?', 'vaccines?', 'gene therapy', 'mRNA', 'bioengineering', 'neuroscience'],
    nd: { category: 'science', q: 'biotechnology OR CRISPR OR genome OR "gene therapy"' } },
  { id: 'discoveries', label: 'Scientific Discoveries', group: 'Science',
    devto: [], kw: ['scientists', 'researchers', 'discover\\w*', 'breakthrough', 'new species', 'fossils?', 'archaeolog\\w*'],
    nd: { category: 'science', q: 'scientists discover OR breakthrough OR "new study" OR researchers found' } },
  { id: 'envscience', label: 'Environmental Science', group: 'Science',
    devto: [], kw: ['climate', 'environment\\w*', 'carbon', 'emissions', 'renewables?', 'solar', 'wind power', 'biodiversity', 'ecolog\\w*', 'pollution', 'sustainab\\w*', 'batter(y|ies)'],
    nd: { category: 'environment', q: 'climate OR sustainability OR "renewable energy" OR biodiversity' } },
  /* ---- General ---- */
  { id: 'business', label: 'Business & Startups', group: 'General',
    devto: ['startup', 'entrepreneurship'], kw: ['startups?', 'Y Combinator', 'YC', 'founders?', 'funding', 'venture', 'acquisition', 'IPO', 'revenue', 'SaaS', 'bootstrapp\\w*'],
    nd: { category: 'business', q: 'startup OR entrepreneur OR funding round OR acquisition' } },
  { id: 'finance', label: 'Finance & Economics', group: 'General',
    devto: [], kw: ['finance', 'econom\\w*', 'inflation', 'stocks?', 'markets?', 'banks?', 'crypto\\w*', 'bitcoin', 'interest rates?', 'recession', 'GDP'],
    nd: { category: 'business', q: 'economy OR inflation OR "interest rates" OR "stock market" OR GDP' } },
  { id: 'worldnews', label: 'World News', group: 'General',
    devto: [], kw: ['election', 'parliament', 'sanctions?', 'protests?', 'supreme court', 'regulation', 'legislation'],
    nd: { category: 'world' } },
  { id: 'innovation', label: 'Innovation', group: 'General',
    devto: [], kw: ['innovation', 'invent\\w*', 'prototype', 'robots?', 'robotics', '3D print\\w*', 'drones?', 'energy storage'],
    nd: { category: 'technology', q: 'innovation OR invention OR prototype OR robotics OR "new technology"' } },
  { id: 'education', label: 'Education', group: 'General',
    devto: ['education', 'learning'], kw: ['education', 'universit(y|ies)', 'schools?', 'students?', 'teaching', 'curriculum', 'MOOCs?', 'tuition', 'college'],
    nd: { category: 'education' } },
  { id: 'psychology', label: 'Psychology', group: 'General',
    devto: ['psychology'], kw: ['psycholog\\w*', 'cognitive', 'behaviou?r', 'cognition', 'attention span', 'memory', 'sleep', 'brain', 'dopamine'],
    nd: { q: 'psychology OR "cognitive science" OR neuroscience OR behavioural science' } },
  { id: 'productivity', label: 'Productivity', group: 'General',
    devto: ['productivity'], kw: ['productivity', 'focus', 'habits?', 'note-?taking', 'time management', 'workflow', 'Obsidian', 'deep work', 'burnout'] },
  { id: 'engineering', label: 'Engineering', group: 'General',
    devto: ['engineering', 'hardware'], kw: ['engineering', 'mechanical', 'civil engineering', 'electrical', 'hardware', 'circuits?', 'PCB', 'embedded', 'FPGA', 'infrastructure', 'manufactur\\w*'],
    nd: { category: 'technology', q: 'engineering OR infrastructure OR semiconductor OR "electric vehicle"' } },
];

const DOMAIN_IDS = DOMAINS.map((d) => d.id);
const BY_ID = Object.fromEntries(DOMAINS.map((d) => [d.id, d]));
const isDomain = (id) => Object.prototype.hasOwnProperty.call(BY_ID, id);

/* DEV.to tag -> domain ids (built from the catalogue, so a tag we fetch also classifies articles that merely carry it) */
const TAG_TO_DOMAINS = {};
DOMAINS.forEach((d) => d.devto.forEach((t) => { (TAG_TO_DOMAINS[t] = TAG_TO_DOMAINS[t] || []).push(d.id); }));
/* extra DEV.to tags that classify (but are not fetched on their own) */
[['generativeai', 'ai'], ['chatgpt', 'ai'], ['mlops', 'ml'], ['analytics', 'datascience'], ['java', 'programming'], ['rust', 'programming'], ['go', 'programming'],
 ['cpp', 'programming'], ['testing', 'softeng'], ['devops', 'cloud'], ['cleancode', 'softeng'], ['frontend', 'webdev'], ['css', 'webdev'], ['typescript', 'webdev'],
 ['node', 'webdev'], ['ios', 'appdev'], ['reactnative', 'appdev'], ['swift', 'appdev'], ['kotlin', 'appdev'], ['infosec', 'cybersecurity'], ['hacking', 'cybersecurity'],
 ['datastructures', 'cs'], ['azure', 'cloud'], ['docker', 'cloud'], ['serverless', 'cloud'], ['mathematics', 'math'], ['iot', 'engineering'], ['robotics', 'engineering'],
 ['embedded', 'engineering'], ['saas', 'business'], ['teaching', 'education'], ['neuroscience', 'psychology']
].forEach(([t, d]) => { (TAG_TO_DOMAINS[t] = TAG_TO_DOMAINS[t] || []); if (!TAG_TO_DOMAINS[t].includes(d)) TAG_TO_DOMAINS[t].push(d); });

/* keyword matchers for Hacker News (and for any source with no tag information) */
const MATCHERS = DOMAINS.filter((d) => d.kw.length).map((d) => ({ id: d.id, re: new RegExp('(?<![A-Za-z0-9])(?:' + d.kw.join('|') + ')(?![A-Za-z0-9])', 'gi') }));

/** Ordered domain ids whose keywords occur in `text` (most matches first). Never returns more than `max`. */
function classifyText(text, max) {
  const t = String(text || '');
  const hits = [];
  for (const m of MATCHERS) {
    m.re.lastIndex = 0;
    const n = (t.match(m.re) || []).length;
    if (n) hits.push({ id: m.id, n });
  }
  hits.sort((a, b) => b.n - a.n);
  return hits.slice(0, max || 3).map((h) => h.id);
}
/** Domain ids for a DEV.to tag list. */
function classifyTags(tags, max) {
  const seen = new Map();
  (tags || []).forEach((t) => (TAG_TO_DOMAINS[String(t).toLowerCase()] || []).forEach((d) => seen.set(d, (seen.get(d) || 0) + 1)));
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, max || 3).map((e) => e[0]);
}

module.exports = { DOMAINS, DOMAIN_IDS, BY_ID, isDomain, TAG_TO_DOMAINS, classifyText, classifyTags };
