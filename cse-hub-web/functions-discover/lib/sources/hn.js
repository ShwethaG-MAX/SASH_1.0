'use strict';
/**
 * Hacker News (official Firebase API) — https://github.com/HackerNews/API   (free, no key, no published rate limit)
 *   /v0/topstories.json, /v0/beststories.json -> story ids;  /v0/item/<id>.json -> {id,type,by,time,title,url,score,descendants}
 * HN has no description or cover image: we show the HN score/comment count and fall back to the app's generated art.
 * Stories are only kept if their title matches a domain keyword (see domains.js) — HN is mostly off-topic for any one interest.
 */
const { classifyText } = require('../domains');
const { getJson, pool, SourceError } = require('./http');
const { hostOf, safeUrl } = require('../normalize');

const BASE = 'https://hacker-news.firebaseio.com/v0/';
const TOP_N = 120, BEST_N = 80, MIN_SCORE = 30;

function toArticle(it) {
  if (!it || it.type !== 'story' || it.dead || it.deleted || !it.title || !it.url || !safeUrl(it.url)) return null;
  if (!(it.score >= MIN_SCORE)) return null;
  if (/^(ask|show|tell) hn:/i.test(it.title) && !it.url) return null;
  const domains = classifyText(it.title, 3);
  if (!domains.length) return null;
  const pts = it.score | 0, com = it.descendants | 0;
  return {
    sourceApi: 'hn', externalId: it.id, title: it.title, source: hostOf(it.url) || 'Hacker News', author: it.by,
    description: 'Trending on Hacker News \u00B7 ' + pts + ' points \u00B7 ' + com + ' comment' + (com === 1 ? '' : 's') + ' there.',
    imageUrl: '', url: it.url, canonicalUrl: it.url, domains, tags: ['hacker-news'],
    publishedAt: new Date((it.time | 0) * 1000), discussionUrl: 'https://news.ycombinator.com/item?id=' + it.id,
  };
}

async function fetchHN() {
  const [top, best] = await Promise.allSettled([getJson(BASE + 'topstories.json', { retries: 2 }), getJson(BASE + 'beststories.json', { retries: 1 })]);
  if (top.status === 'rejected' && best.status === 'rejected') throw top.reason;
  const ids = [...new Set([...(top.status === 'fulfilled' ? top.value.slice(0, TOP_N) : []), ...(best.status === 'fulfilled' ? best.value.slice(0, BEST_N) : [])])];
  if (!ids.length) throw new SourceError('empty');
  const res = await pool(ids, 12, (id) => getJson(BASE + 'item/' + id + '.json', { retries: 1, timeoutMs: 8000 }));
  const articles = []; let failed = 0;
  res.forEach((r) => { if (!r.ok) failed++; else { const a = toArticle(r.value); if (a) articles.push(a); } });
  if (failed === ids.length) throw new SourceError('all_failed');
  return { articles, requests: ids.length + 2, failed };
}

module.exports = { fetchHN, toArticle };
