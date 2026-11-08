'use strict';
const crypto = require('crypto');

/* Query params that only track the click, never change the page — stripped before an URL is used to detect duplicates. */
const TRACKING = /^(utm_[a-z0-9_]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|ref|ref_src|ref_url|source|spm|share|sharedUserId|cmpid|ocid|ncid|_hsenc|_hsmi)$/i;

/** http(s) URL or null. Anything else (javascript:, data:, file: ...) is refused. */
function safeUrl(u, opts) {
  try {
    const x = new URL(String(u || '').trim());
    if (x.protocol !== 'https:' && x.protocol !== 'http:') return null;
    if (!x.hostname || x.hostname.indexOf('.') === -1) return null;
    if (opts && opts.upgrade && x.protocol === 'http:') x.protocol = 'https:';   // images: avoid mixed content
    return x.toString().length <= 1000 ? x.toString() : null;
  } catch (e) { return null; }
}

/** Stable form of an article URL for duplicate detection. */
function canonicalUrl(u) {
  const s = safeUrl(u);
  if (!s) return null;
  const x = new URL(s);
  x.hash = '';
  x.protocol = 'https:';
  x.hostname = x.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '');
  if (x.port === '443' || x.port === '80') x.port = '';
  const keep = [...x.searchParams.entries()].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => a.localeCompare(b));
  x.search = '';
  keep.forEach(([k, v]) => x.searchParams.append(k, v));
  let p = x.pathname.replace(/\/{2,}/g, '/');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  x.pathname = p;
  return x.toString();
}

/** Document id: the same article always maps to the same id, whichever source delivered it. Firestore rules check this shape. */
const articleId = (canon) => 'a_' + crypto.createHash('sha1').update(canon).digest('hex').slice(0, 20);

const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ', '&rsquo;': '\u2019', '&lsquo;': '\u2018', '&ldquo;': '\u201C', '&rdquo;': '\u201D', '&hellip;': '\u2026', '&ndash;': '\u2013', '&mdash;': '\u2014' };
/** Plain text, no markup, bounded length. Placeholders some APIs send for paid-only fields become ''. */
function cleanText(s, max) {
  if (s == null) return '';
  let t = String(s);
  if (/ONLY AVAILABLE IN/i.test(t)) return '';
  t = t.replace(/<[^>]*>/g, ' ').replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m) => {
    if (ENT[m.toLowerCase()]) return ENT[m.toLowerCase()];
    const c = /^&#x/i.test(m) ? parseInt(m.slice(3, -1), 16) : /^&#/.test(m) ? parseInt(m.slice(2, -1), 10) : NaN;
    return Number.isFinite(c) && c > 31 && c < 0x10ffff ? String.fromCodePoint(c) : ' ';
  });
  t = t.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (max && t.length > max) { t = t.slice(0, max - 1); const i = t.lastIndexOf(' '); t = (i > max * 0.6 ? t.slice(0, i) : t) + '\u2026'; }
  return t;
}

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } };
const toDate = (v) => { const d = v instanceof Date ? v : new Date(v); return Number.isFinite(d.getTime()) ? d : null; };
const uniq = (a) => [...new Set((a || []).filter(Boolean))];

/** Last line of defence before anything reaches Firestore: required fields present, sizes bounded, only http(s) links. */
function finalizeArticle(a) {
  const url = safeUrl(a.url);
  const canon = canonicalUrl(a.canonicalUrl || a.url);
  const title = cleanText(a.title, 220);
  const publishedAt = toDate(a.publishedAt);
  if (!url || !canon || title.length < 8 || !publishedAt) return null;
  if (publishedAt.getTime() > Date.now() + 36e5) return null;                     // future-dated junk
  const domains = uniq(a.domains).slice(0, 4);
  if (!domains.length) return null;                                              // nothing to personalise on = not shown
  return {
    id: articleId(canon), title, description: cleanText(a.description, 400), imageUrl: safeUrl(a.imageUrl, { upgrade: true }) || '',
    url, canonicalUrl: canon, source: cleanText(a.source, 80) || hostOf(url), sourceApi: a.sourceApi, externalId: String(a.externalId || '').slice(0, 120),
    author: cleanText(a.author, 80), category: domains[0], domains, tags: uniq((a.tags || []).map((t) => cleanText(t, 30).toLowerCase())).slice(0, 8),
    publishedAt, discussionUrl: safeUrl(a.discussionUrl) || '',
  };
}

module.exports = { safeUrl, canonicalUrl, articleId, cleanText, hostOf, toDate, uniq, finalizeArticle };
