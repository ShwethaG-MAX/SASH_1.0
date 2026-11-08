'use strict';
/**
 * NewsData.io — https://newsdata.io/documentation  (endpoint /api/1/latest)
 * Free plan facts (verified against newsdata.io docs/pricing, Nov 2026): 200 credits/day, 1 credit = 1 request = up to 10 articles,
 * 30 credits per 15 min, news delayed ~12 h, no full text, query (q) max 100 chars.
 * We store ONLY metadata the API returns (title, short description, publisher, date, link, image URL). The image is hot-linked from the
 * publisher (never copied or re-hosted) and every card links back to the original article.
 * If the daily budget or the API's own limit is hit we STOP — we never switch to another paid service.
 */
const { DOMAINS } = require('../domains');
const { getJson, pool, SourceError } = require('./http');
const { cleanText } = require('../normalize');

const DAILY_BUDGET = 150;            // our own ceiling, under the 200/day plan limit (leaves room for manual testing)

function plan(domainIds) {
  const want = new Set(domainIds || DOMAINS.map((d) => d.id));
  return DOMAINS.filter((d) => d.nd && want.has(d.id));
}

function toArticle(it, domainId) {
  if (!it || !it.title || !it.link) return null;
  const pub = String(it.pubDate || '').trim();
  const publishedAt = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(pub) ? new Date(pub.replace(' ', 'T') + 'Z') : new Date(pub);   // pubDate is UTC
  const creator = Array.isArray(it.creator) ? it.creator[0] : it.creator;
  return {
    sourceApi: 'newsdata', externalId: it.article_id, title: it.title, description: it.description, imageUrl: it.image_url,
    url: it.link, canonicalUrl: it.link, source: cleanText(it.source_name || it.source_id, 80), author: typeof creator === 'string' ? creator : '',
    domains: [domainId], tags: Array.isArray(it.category) ? it.category.filter((c) => typeof c === 'string') : [], publishedAt,
  };
}

/**
 * @param {{apiKey:string, creditsLeft:number, domains?:string[]}} o
 * @returns {{articles, requests, failed, stoppedBy?:string}}
 */
async function fetchNewsData(o) {
  const key = String(o.apiKey || '').trim();
  if (!key || /^(none|disabled|off)$/i.test(key)) throw new SourceError('no_key');
  const queries = plan(o.domains).slice(0, Math.max(0, Math.min(o.creditsLeft == null ? DAILY_BUDGET : o.creditsLeft, DAILY_BUDGET)));
  if (!queries.length) throw new SourceError('budget');
  let stop = ''; const articles = []; let used = 0, failed = 0;
  const res = await pool(queries, 1, async (d) => {                          // one at a time: stays far below 30 credits / 15 min
    if (stop) return [];
    const p = { apikey: key, language: 'en', size: '10' };
    if (d.nd.category) p.category = d.nd.category;
    if (d.nd.q) p.q = d.nd.q.slice(0, 100);
    let j;
    try { j = await getJson('https://newsdata.io/api/1/latest?' + new URLSearchParams(p), { retries: 1, noRetryOn429: true }); used++; }
    catch (e) { if (e.code === 'rate_limited' || e.code === 'auth') stop = e.code; throw e; }
    if (!j || j.status !== 'success' || !Array.isArray(j.results)) {
      const code = j && j.results && j.results.code ? String(j.results.code) : 'bad_shape';
      if (/RateLimit|ApiLimit|Quota/i.test(code)) stop = 'rate_limited'; else if (/Unauthor|ApiKey/i.test(code)) stop = 'auth';
      throw new SourceError(stop || code.slice(0, 40));
    }
    return j.results.map((it) => toArticle(it, d.id)).filter(Boolean);
  }, 400);
  res.forEach((r) => { if (r.ok) articles.push(...r.value); else failed++; });
  if (failed === queries.length) { const e = new SourceError(stop || (res.find((r) => !r.ok).error.code) || 'all_failed'); e.creditsUsed = used; throw e; }
  return { articles, requests: used, failed, stoppedBy: stop || undefined, creditsUsed: used };
}

module.exports = { fetchNewsData, toArticle, plan, DAILY_BUDGET };
