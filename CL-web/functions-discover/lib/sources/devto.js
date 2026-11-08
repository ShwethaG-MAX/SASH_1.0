'use strict';
/**
 * DEV.to (Forem API v1) — https://developers.forem.com/api/v1
 * Public reads, no key. We send a descriptive User-Agent (the default one of some HTTP clients is blocked with 403).
 * GET /api/articles?tag=<tag>&top=<days>&per_page=<n> -> most popular articles of the last N days for a tag.
 * Image: cover_image, else social_image (always present). Original link: `url` (the DEV page that hosts the article).
 */
const { DOMAINS, classifyTags } = require('../domains');
const { getJson, pool, SourceError } = require('./http');

const TOP_DAYS = 7, PER_PAGE = 20;

/** Every DEV.to tag we query, with the domain(s) that asked for it. */
function plan(domainIds) {
  const want = new Set(domainIds || DOMAINS.map((d) => d.id));
  const tags = new Map();
  DOMAINS.filter((d) => want.has(d.id)).forEach((d) => d.devto.forEach((t) => tags.set(t, (tags.get(t) || new Set()).add(d.id))));
  return tags;
}

function toArticle(it, askedBy) {
  if (!it || it.type_of !== 'article' || !it.url || !it.title) return null;
  const tags = Array.isArray(it.tag_list) ? it.tag_list : String(it.tags || '').split(',').map((s) => s.trim());
  const domains = [...new Set([...askedBy, ...classifyTags(tags, 3)])].slice(0, 4);
  return {
    sourceApi: 'devto', externalId: it.id, title: it.title, description: it.description, imageUrl: it.cover_image || it.social_image,
    url: it.url, canonicalUrl: it.canonical_url || it.url, source: 'DEV Community', author: it.user && it.user.name,
    domains, tags, publishedAt: it.published_at || it.published_timestamp,
  };
}

async function fetchDevTo(opts) {
  opts = opts || {};
  const tags = [...plan(opts.domains).entries()];
  const res = await pool(tags, 3, async ([tag, askedBy]) => {
    const j = await getJson('https://dev.to/api/articles?' + new URLSearchParams({ tag, top: String(TOP_DAYS), per_page: String(PER_PAGE) }), { retries: 2 });
    if (!Array.isArray(j)) throw new SourceError('bad_shape');
    return j.map((it) => toArticle(it, [...askedBy])).filter(Boolean);
  }, 250);
  const articles = []; let failed = 0, lastErr = '';
  res.forEach((r) => { if (r.ok) articles.push(...r.value); else { failed++; lastErr = (r.error && r.error.code) || 'error'; } });
  if (tags.length && failed === tags.length) throw new SourceError(lastErr || 'all_failed');
  return { articles, requests: tags.length, failed };
}

module.exports = { fetchDevTo, toArticle, plan };
