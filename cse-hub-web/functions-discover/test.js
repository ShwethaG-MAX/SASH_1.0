'use strict';
/* Offline tests:  npm test
   NOT covered (needs network / a Firebase project): the live DEV.to / Hacker News / NewsData responses and real Firestore. */
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const { makeDb, FieldValue, Timestamp } = require('./test/fakeFirestore');

const fake = makeDb();
const fsFn = () => fake; fsFn.FieldValue = FieldValue; fsFn.Timestamp = Timestamp;
Object.defineProperty(admin, 'firestore', { value: fsFn, configurable: true });
process.env.GCLOUD_PROJECT = 'demo';

const N = require('./lib/normalize'), D = require('./lib/domains');
const devto = require('./lib/sources/devto'), hn = require('./lib/sources/hn'), nd = require('./lib/sources/newsdata'), H = require('./lib/sources/http');
const R = require('./lib/refresh'), C = require('./lib/comments');

let pass = 0, fail = 0; const queue = [];
const test = (name, fn) => queue.push([name, fn]);
const asUser = (uid, extra) => ({ auth: { uid, token: extra || {} } });
const expectErr = async (p, code) => { try { await p; } catch (e) { if (code) assert.strictEqual(e.code, code, 'expected ' + code + ' got ' + e.code + ' / ' + e.message); return e; } assert.fail('expected an error' + (code ? ' ' + code : '')); };

/* ============================== normalisation ============================== */
test('canonicalUrl: tracking params, www, slash and #hash do not create a different article', () => {
  const a = N.canonicalUrl('https://www.Example.com/post/1/?utm_source=x&b=2&a=1#top');
  const b = N.canonicalUrl('http://example.com/post/1?a=1&b=2&fbclid=zzz');
  assert.strictEqual(a, b);
  assert.strictEqual(N.articleId(a), N.articleId(b));
  assert.ok(/^a_[0-9a-f]{20}$/.test(N.articleId(a)));
  assert.notStrictEqual(N.articleId(a), N.articleId(N.canonicalUrl('https://example.com/post/2')));
});
test('safeUrl refuses non-http(s) schemes', () => {
  ['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'ftp://x.com/a', 'not a url', ''].forEach((u) => assert.strictEqual(N.safeUrl(u), null, u));
  assert.strictEqual(N.safeUrl('http://img.example.com/a.png', { upgrade: true }), 'https://img.example.com/a.png');
});
test('cleanText strips markup/entities and paid-plan placeholders', () => {
  assert.strictEqual(N.cleanText('<p>Fish &amp; chips&nbsp;<b>now</b></p>'), 'Fish & chips now');
  assert.strictEqual(N.cleanText('ONLY AVAILABLE IN PAID PLANS'), '');
  assert.ok(N.cleanText('word '.repeat(200), 50).length <= 50);
});
test('finalizeArticle rejects incomplete, future-dated and un-categorised items', () => {
  const ok = { title: 'A decent headline here', url: 'https://x.com/a', publishedAt: new Date(), domains: ['ai'], sourceApi: 'devto' };
  assert.ok(N.finalizeArticle(ok));
  assert.strictEqual(N.finalizeArticle(Object.assign({}, ok, { title: 'short' })), null);
  assert.strictEqual(N.finalizeArticle(Object.assign({}, ok, { url: 'javascript:1' })), null);
  assert.strictEqual(N.finalizeArticle(Object.assign({}, ok, { domains: [] })), null);
  assert.strictEqual(N.finalizeArticle(Object.assign({}, ok, { publishedAt: new Date(Date.now() + 864e5) })), null);
});

/* ============================== domains ============================== */
test('domain catalogue: unique ids, <=30 (array-contains-any limit), every id classifiable', () => {
  assert.strictEqual(new Set(D.DOMAIN_IDS).size, D.DOMAIN_IDS.length);
  assert.ok(D.DOMAIN_IDS.length <= 30);
  D.DOMAINS.forEach((d) => assert.ok(d.devto.length || d.kw.length || d.nd, d.id + ' has no feed'));
});
test('classifyText maps typical Hacker News titles to the right domains', () => {
  assert.ok(D.classifyText('Show HN: I trained a tiny LLM on my laptop').includes('ai'));
  assert.ok(D.classifyText('Rust 2.0 compiler speedups land').includes('programming'));
  assert.ok(D.classifyText('Critical zero-day in OpenSSH exploited in the wild').includes('cybersecurity'));
  assert.ok(D.classifyText('JWST finds water vapour around a distant exoplanet').includes('space'));
  assert.deepStrictEqual(D.classifyText('Why my cat sits on the keyboard'), []);
  assert.ok(!D.classifyText('He said nothing').includes('ai'), '"said" must not match AI');
});
test('classifyTags maps DEV.to tags', () => {
  assert.ok(D.classifyTags(['discuss', 'machinelearning', 'python']).includes('ml'));
  assert.ok(D.classifyTags(['aws']).includes('cloud'));
});

/* ============================== source parsers (fixtures copied from the live DEV.to payload shape) ============================== */
const DEV_FIX = { type_of: 'article', id: 4951431, title: '10 problems I face to start a new project!', description: 'I will just go straight into the points (sorry, problems): 1. Idea My mind...', url: 'https://dev.to/csm18/10-problems-i-face-to-start-a-new-project-4eie', canonical_url: 'https://dev.to/csm18/10-problems-i-face-to-start-a-new-project-4eie', cover_image: null, social_image: 'https://media2.dev.to/dynamic/image/width=1200,height=627/https%3A%2F%2Fexample.com%2Fa.png', published_at: '2026-10-31T08:08:45Z', tag_list: ['discuss', 'webdev'], tags: 'discuss, webdev', user: { name: 'csm' } };
test('DEV.to: null cover_image falls back to social_image; domains from tags + asking domain', () => {
  const a = devto.toArticle(DEV_FIX, ['programming']);
  const f = N.finalizeArticle(a);
  assert.ok(f.imageUrl.includes('social') || f.imageUrl.includes('media2.dev.to'));
  assert.ok(f.domains.includes('programming') && f.domains.includes('webdev'));
  assert.strictEqual(f.source, 'DEV Community'); assert.strictEqual(f.author, 'csm');
  assert.strictEqual(f.url, DEV_FIX.url);
});
test('DEV.to: cross-posted article dedupes on its canonical (external) URL', () => {
  const medium = Object.assign({}, DEV_FIX, { canonical_url: 'https://medium.com/@x/post-abc?sharedUserId=x' });
  const a = N.finalizeArticle(devto.toArticle(medium, ['softeng']));
  assert.strictEqual(a.url, DEV_FIX.url, 'reader link stays on DEV');
  assert.strictEqual(a.id, N.articleId(N.canonicalUrl('https://medium.com/@x/post-abc')), 'tracking param ignored in the id');
});
test('Hacker News: keeps relevant external stories, drops Ask HN/low score/off-topic; no image', () => {
  const base = { type: 'story', id: 1, by: 'u', time: 1790000000, title: 'GPT-5 benchmarks are out', url: 'https://example.org/gpt', score: 250, descendants: 90 };
  const a = N.finalizeArticle(hn.toArticle(base));
  assert.ok(a && a.domains.includes('ai') && a.imageUrl === '' && a.discussionUrl.endsWith('item?id=1'));
  assert.ok(/250 points/.test(a.description));
  assert.strictEqual(hn.toArticle(Object.assign({}, base, { score: 5 })), null);
  assert.strictEqual(hn.toArticle(Object.assign({}, base, { url: undefined })), null);
  assert.strictEqual(hn.toArticle(Object.assign({}, base, { title: 'Ask HN: how do you cook rice' })), null);
  assert.strictEqual(hn.toArticle(Object.assign({}, base, { dead: true })), null);
});
test('NewsData: UTC pubDate, placeholders, missing image', () => {
  const a = N.finalizeArticle(nd.toArticle({ article_id: 'abc', title: 'Researchers find a new exoplanet', link: 'https://news.example.com/x?utm_source=a', description: 'ONLY AVAILABLE IN PAID PLANS', image_url: null, source_name: 'Example News', pubDate: '2026-10-31 08:30:00', creator: ['Jane'] }, 'space'));
  assert.strictEqual(a.publishedAt.toISOString(), '2026-10-31T08:30:00.000Z');
  assert.strictEqual(a.description, ''); assert.strictEqual(a.imageUrl, ''); assert.strictEqual(a.source, 'Example News'); assert.strictEqual(a.author, 'Jane');
});

/* ============================== http helper (real local server) ============================== */
test('getJson: retries 429/5xx, stops on 403, honours noRetryOn429, errors never contain the URL', async () => {
  const hits = {}; const srv = http.createServer((req, res) => {
    hits[req.url] = (hits[req.url] || 0) + 1; const n = hits[req.url];
    const send = (c, b) => { res.writeHead(c, { 'content-type': 'application/json', 'retry-after': '0' }); res.end(JSON.stringify(b || {})); };
    if (req.url === '/ok') return send(200, { ok: 1 });
    if (req.url === '/flaky') return n < 3 ? send(503) : send(200, { ok: 2 });
    if (req.url === '/limited') return n < 2 ? send(429) : send(200, { ok: 3 });
    if (req.url.startsWith('/forbidden')) return send(403);
    if (req.url === '/limited-hard') return send(429);
    if (req.url === '/hang') return;
    send(404);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const base = 'http://127.0.0.1:' + srv.address().port;
  try {
    assert.deepStrictEqual(await H.getJson(base + '/ok'), { ok: 1 });
    assert.deepStrictEqual(await H.getJson(base + '/flaky', { retries: 2 }), { ok: 2 }); assert.strictEqual(hits['/flaky'], 3);
    assert.deepStrictEqual(await H.getJson(base + '/limited', { retries: 1 }), { ok: 3 });
    const e = await expectErr(H.getJson(base + '/forbidden?apikey=SECRET123', { retries: 3 }), 'auth'); assert.strictEqual(hits['/forbidden?apikey=SECRET123'], 1); assert.ok(!/SECRET123/.test(e.message + JSON.stringify(e)));
    await expectErr(H.getJson(base + '/limited-hard', { retries: 3, noRetryOn429: true }), 'rate_limited'); assert.strictEqual(hits['/limited-hard'], 1);
    await expectErr(H.getJson(base + '/hang', { retries: 0, timeoutMs: 150 }), 'timeout');
    await expectErr(H.getJson(base + '/nothing', { retries: 2 }), 'http_404'); assert.strictEqual(hits['/nothing'], 1);
  } finally { srv.closeAllConnections && srv.closeAllConnections(); srv.close(); }
});

/* ============================== sources end-to-end against a mocked fetch ============================== */
const realFetch = global.fetch;
const iso = (h) => new Date(Date.now() - h * 3600000).toISOString();
function mockFetch(routes) {
  const calls = [];
  global.fetch = async (url) => {
    const u = String(url); calls.push(u);
    for (const [pat, handler] of routes) if (u.includes(pat)) { const r = await handler(u); return { ok: r.status === undefined || r.status < 400, status: r.status || 200, headers: { get: () => null }, json: async () => r.body }; }
    return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) };
  };
  return calls;
}
const devArticle = (id, tag, extra) => Object.assign({ type_of: 'article', id, title: 'DEV article number ' + id + ' on ' + tag, description: 'desc ' + id, url: 'https://dev.to/u/post-' + id, canonical_url: 'https://dev.to/u/post-' + id, cover_image: 'https://media2.dev.to/c' + id + '.png', social_image: 'https://media2.dev.to/s' + id + '.png', published_at: iso(id % 24 + 1), tag_list: [tag], user: { name: 'U' + id } }, extra || {});
const hnItem = (id, title, extra) => Object.assign({ type: 'story', id, by: 'h', time: Math.floor(Date.now() / 1000) - 3600, title, url: 'https://blog.example/hn-' + id, score: 100, descendants: 10 }, extra || {});
const ndItem = (id, title) => ({ article_id: 'nd' + id, title, link: 'https://news.example/nd-' + id, description: 'short ' + id, image_url: 'https://img.example/nd' + id + '.jpg', source_name: 'Example Wire', pubDate: new Date(Date.now() - 7200000).toISOString().slice(0, 19).replace('T', ' '), category: ['science'] });
const happyRoutes = () => [
  ['dev.to/api/articles', (u) => { const tag = new URL(u).searchParams.get('tag'); return { body: [devArticle(tag.length * 10 + 1, tag), devArticle(tag.length * 10 + 2, tag)] }; }],
  ['topstories', () => ({ body: [1, 2, 3] })], ['beststories', () => ({ body: [3, 4] })],
  ['item/1.json', () => ({ body: hnItem(1, 'New LLM beats GPT-4 on every benchmark') })], ['item/2.json', () => ({ body: hnItem(2, 'My cat photo album') })],
  ['item/3.json', () => ({ body: hnItem(3, 'Linux kernel 7.0 released') })], ['item/4.json', () => ({ body: hnItem(4, 'Show HN: something', { score: 3 }) })],
  ['newsdata.io/api/1/latest', (u) => ({ body: { status: 'success', totalResults: 2, results: [ndItem(new URL(u).searchParams.get('category') + (new URL(u).searchParams.get('q') || '').length, 'Researchers report a breakthrough in ' + (new URL(u).searchParams.get('q') || 'general').slice(0, 20))] } })],
];

test('fetchDevTo: one request per catalogue tag, tolerates a failing tag, fails only if ALL fail', async () => {
  const calls = mockFetch([['tag=ai', () => ({ status: 500 })], ['dev.to/api/articles', (u) => ({ body: [devArticle(7, new URL(u).searchParams.get('tag'))] })]]);
  const r = await devto.fetchDevTo({ retries: 0 });
  assert.strictEqual(calls.filter((c) => c.includes('tag=ai&')).length >= 1, true);
  assert.ok(r.articles.length > 5 && r.failed >= 1);
  mockFetch([['dev.to', () => ({ status: 503 })]]);
  await expectErr(devto.fetchDevTo(), 'server');
});
test('fetchHN: filters, dedupes ids (top+best), keeps only relevant', async () => {
  const calls = mockFetch(happyRoutes());
  const r = await hn.fetchHN();
  assert.deepStrictEqual(r.articles.map((a) => a.externalId).sort(), [1, 3]);
  assert.strictEqual(calls.filter((c) => c.includes('item/3.json')).length, 1, 'story 3 is in both lists but fetched once');
});
test('fetchNewsData: no key -> no_key (and ZERO requests); 429 stops the whole run without spending more credits', async () => {
  const calls = mockFetch(happyRoutes());
  await expectErr(nd.fetchNewsData({ apiKey: 'none', creditsLeft: 100 }), 'no_key'); await expectErr(nd.fetchNewsData({ apiKey: '', creditsLeft: 100 }), 'no_key');
  assert.strictEqual(calls.filter((c) => c.includes('newsdata')).length, 0);
  let n = 0; const calls2 = mockFetch([['newsdata.io', () => (++n <= 2 ? { body: { status: 'success', results: [ndItem(n, 'Researchers report a breakthrough ' + n)] } } : { status: 429, body: {} })]]);
  const r = await nd.fetchNewsData({ apiKey: 'k', creditsLeft: 100 });
  assert.strictEqual(r.stoppedBy, 'rate_limited'); assert.strictEqual(r.articles.length, 2);
  assert.strictEqual(calls2.length, 3, 'stopped right after the first 429');
});
test('fetchNewsData: respects the credit budget and sends the key only as a query param', async () => {
  const calls = mockFetch(happyRoutes());
  await nd.fetchNewsData({ apiKey: 'KEY1', creditsLeft: 3 });
  assert.strictEqual(calls.length, 3); assert.ok(calls.every((c) => c.startsWith('https://newsdata.io/api/1/latest?') && c.includes('apikey=KEY1') && c.includes('language=en')));
});

/* ============================== refresh orchestration on the fake Firestore ============================== */
const META = () => fake.doc('discoverMeta/refresh').get().then((s) => s.data());
const wipe = () => { fake._store.clear(); fake._writes.length = 0; };
const articles = () => [...fake._store.entries()].filter(([p]) => /^discoverArticles\/a_[0-9a-f]{20}$/.test(p));

test('refresh: first run stores normalised articles from all three sources; meta records success', async () => {
  wipe(); mockFetch(happyRoutes());
  const r = await R.runRefresh({ reason: 'manual', apiKey: 'k' });
  assert.strictEqual(r.state, 'done'); assert.ok(r.ok); assert.ok(r.added > 10, 'added ' + r.added);
  assert.ok(r.sources.devto.ok && r.sources.hn.ok && r.sources.newsdata.ok);
  const all = articles().map(([, d]) => d);
  assert.ok(all.every((d) => d.title && d.url && d.publishedAt && d.fetchedAt && d.domains.length && d.commentCount === 0 && !('id' in d)));
  assert.ok(all.some((d) => d.sourceApi === 'hn' && d.imageUrl === '' && d.discussionUrl), 'HN item without image kept');
  assert.ok(all.some((d) => d.sourceApi === 'newsdata' && d.imageUrl.startsWith('https://img.example')));
  const m = await META(); assert.strictEqual(m.status, 'idle'); assert.ok(m.lastSuccessAtMs); assert.ok(m.nextAllowedAtMs > Date.now()); assert.ok(m.sources.newsdata.creditsUsed > 0);
});
test('refresh: manual cool-down blocks a second manual refresh (no API calls); daily ignores it', async () => {
  const calls = mockFetch(happyRoutes());
  const r = await R.runRefresh({ reason: 'manual', apiKey: 'k' });
  assert.strictEqual(r.state, 'cooldown'); assert.ok(r.retryAfterMs > 0); assert.strictEqual(calls.length, 0);
  const d = await R.runRefresh({ reason: 'daily', apiKey: 'k' }); assert.strictEqual(d.state, 'done'); assert.ok(calls.length > 0);
});
test('refresh: re-running adds NOTHING new, never duplicates, and keeps comment counters + saved links intact', async () => {
  wipe(); mockFetch(happyRoutes());
  await R.runRefresh({ reason: 'daily', apiKey: 'k' });
  const before = articles().length; const [id] = articles()[0];
  await fake.doc(id).update({ commentCount: 5, lastCommentAt: new Date() });
  await fake.doc('discoverUsers/u1/saved/' + id.split('/')[1]).set({ savedAt: 1 });
  const r = await R.runRefresh({ reason: 'daily', apiKey: 'k' });
  assert.strictEqual(r.added, 0, 'no duplicates inserted'); assert.ok(r.updated >= before - 1);
  assert.strictEqual(articles().length, before);
  const d = (await fake.doc(id).get()).data(); assert.strictEqual(d.commentCount, 5); assert.ok(d.lastCommentAt);
  assert.ok((await fake.doc('discoverUsers/u1/saved/' + id.split('/')[1]).get()).exists);
});
test('refresh: the same article from two sources is ONE document with merged domains and the image filled in', async () => {
  wipe();
  mockFetch([
    ['dev.to/api/articles', () => ({ body: [] })], ['topstories', () => ({ body: [9] })], ['beststories', () => ({ body: [] })],
    ['item/9.json', () => ({ body: hnItem(9, 'Kubernetes 2.0 and Docker changes', { url: 'https://www.shared.example/story?utm_source=hn' }) })],
    ['newsdata.io', () => ({ body: { status: 'success', results: [Object.assign(ndItem(9, 'Kubernetes 2.0 lands'), { link: 'https://shared.example/story/' })] } })],
  ]);
  await R.runRefresh({ reason: 'daily', apiKey: 'k' });
  const rows = articles(); assert.strictEqual(rows.length, 1, 'one article, not two');
  assert.ok(rows[0][1].imageUrl.includes('img.example'), 'image from the source that had one');
  assert.ok(rows[0][1].domains.includes('cloud'));
});
test('refresh: a failing/keyless source never breaks the others; all-sources-failed does not update lastSuccess', async () => {
  wipe(); mockFetch([['dev.to', () => ({ status: 500 })], ['hacker-news', () => ({ status: 500 })], ['newsdata.io', () => ({ status: 500 })]]);
  const bad = await R.runRefresh({ reason: 'daily', apiKey: '' });
  assert.strictEqual(bad.ok, false); const m = await META(); assert.ok(!m.lastSuccessAtMs); assert.strictEqual(m.status, 'idle', 'lock released after failure');
  wipe(); mockFetch(happyRoutes());
  const r = await R.runRefresh({ reason: 'daily', apiKey: '' });
  assert.ok(r.ok && r.sources.newsdata.skipped === 'no_key' && r.sources.devto.ok);
});
test('refresh: only one refresh can run at a time (second caller is told "running", no API calls)', async () => {
  wipe(); await fake.doc('discoverMeta/refresh').set({ status: 'running', startedAtMs: Date.now() - 1000 });
  const calls = mockFetch(happyRoutes());
  const r = await R.runRefresh({ reason: 'daily', apiKey: 'k' }); assert.strictEqual(r.state, 'running'); assert.strictEqual(calls.length, 0);
  await fake.doc('discoverMeta/refresh').set({ status: 'running', startedAtMs: Date.now() - 9 * 60000 });
  assert.strictEqual((await R.runRefresh({ reason: 'daily', apiKey: 'k' })).state, 'done', 'a stale lock (crashed run) is taken over');
});
test('refresh: NewsData daily budget is enforced across runs', async () => {
  wipe(); const day = new Date().toISOString().slice(0, 10);
  await fake.doc('discoverMeta/refresh').set({ status: 'idle', sources: { newsdata: { creditsDay: day, creditsUsed: 150 } } });
  const calls = mockFetch(happyRoutes());
  const r = await R.runRefresh({ reason: 'daily', apiKey: 'k' });
  assert.strictEqual(r.sources.newsdata.error, 'daily_budget'); assert.strictEqual(calls.filter((c) => c.includes('newsdata')).length, 0);
});

/* ============================== comments ============================== */
const AID = 'a_' + '0123456789abcdef0123';
const seedArticle = async () => { wipe(); await fake.doc('discoverArticles/' + AID).set({ title: 'Seed article for comments', commentCount: 0, domains: ['ai'] }); };
const post = (uid, text, parentId) => C.postComment(Object.assign(asUser(uid), { data: { articleId: AID, text, parentId } }));

test('spamReason: bounds, links, repetition, empty-looking text', () => {
  assert.ok(C.spamReason('a')); assert.ok(C.spamReason('x'.repeat(801))); assert.ok(C.spamReason('!!!!!!!!!!!!!!'));
  assert.ok(C.spamReason('see http://a.com http://b.com http://c.com')); assert.ok(C.spamReason('aaaaaaaaaaaaaaaaaa'));
  assert.ok(C.spamReason('buy buy buy buy buy buy buy buy buy buy')); assert.ok(C.spamReason('a\n'.repeat(20)));
  assert.strictEqual(C.spamReason('Great read, thanks for sharing! \u0928\u092E\u0938\u094D\u0924\u0947'), '');
  assert.strictEqual(C.spamReason('Check https://example.com for more'), '');
});
test('cleanComment strips invisible/bidi characters', () => assert.strictEqual(C.cleanComment('hi\u202Ethere\u200B  \r\n\r\n\r\n\r\nok'), 'hithere\n\nok'));
test('postComment: public doc is anonymous; author link is server-side only; counters update', async () => {
  await seedArticle();
  const r = await post('uidA', 'Really interesting angle on the training costs.');
  const pub = (await fake.doc('discoverArticles/' + AID + '/comments/' + r.id).get()).data();
  assert.deepStrictEqual(Object.keys(pub).sort(), ['createdAt', 'parentId', 'text']);
  assert.ok(!JSON.stringify(pub).includes('uidA'));
  assert.strictEqual((await fake.doc('discoverCommentAuthors/' + r.id).get()).data().uid, 'uidA');
  assert.ok((await fake.doc('discoverUsers/uidA/myComments/' + r.id).get()).exists);
  const a = (await fake.doc('discoverArticles/' + AID).get()).data(); assert.strictEqual(a.commentCount, 1); assert.ok(a.lastCommentAt);
});
test('postComment: replies are one level deep; unknown article / parent rejected; bad ids rejected', async () => {
  await seedArticle(); const top = await post('uidA', 'Top level comment here');
  const rep = await post('uidB', 'A reply to the top comment', top.id); assert.strictEqual(rep.parentId, top.id);
  await expectErr(post('uidC', 'Reply to a reply is not allowed', rep.id), 'failed-precondition');
  await expectErr(post('uidC', 'Reply to nothing at all', 'ZZZZZZZZZZZZZZZZZZZZ'), 'failed-precondition');
  await expectErr(C.postComment(Object.assign(asUser('u'), { data: { articleId: 'a_' + 'f'.repeat(20), text: 'valid text here' } })), 'not-found');
  await expectErr(C.postComment(Object.assign(asUser('u'), { data: { articleId: '../evil', text: 'valid text here' } })), 'invalid-argument');
  await expectErr(C.postComment({ data: { articleId: AID, text: 'no auth at all' } }), 'unauthenticated');
  assert.strictEqual((await fake.doc('discoverArticles/' + AID).get()).data().commentCount, 2);
});
test('postComment: duplicate text and flooding are refused', async () => {
  await seedArticle(); await post('flood', 'First message in the burst');
  await expectErr(post('flood', 'First message in the burst'), 'already-exists');
  for (let i = 2; i <= 4; i++) await post('flood', 'Distinct message number ' + i + ' here');   // attempts 3..5 (the refused duplicate was attempt 2)
  await expectErr(post('flood', 'Sixth attempt inside one minute'), 'resource-exhausted');
  await post('someoneElse', 'First message in the burst');           // another user is unaffected
});
test('deleteComment: only the author (or owner) can delete; deleting a parent removes its replies and fixes counters', async () => {
  await seedArticle(); const top = await post('uidA', 'Parent comment to be deleted'); const rep = await post('uidB', 'Reply that goes with it', top.id);
  await expectErr(C.deleteComment(Object.assign(asUser('uidX'), { data: { articleId: AID, commentId: top.id } })), 'permission-denied');
  const r = await C.deleteComment(Object.assign(asUser('uidA'), { data: { articleId: AID, commentId: top.id } }));
  assert.strictEqual(r.removed, 2);
  assert.ok(!(await fake.doc('discoverArticles/' + AID + '/comments/' + rep.id).get()).exists);
  const a = (await fake.doc('discoverArticles/' + AID).get()).data(); assert.strictEqual(a.commentCount, 0); assert.ok(!('lastCommentAt' in a), 'indicator disappears at zero');
  assert.ok(!(await fake.doc('discoverUsers/uidB/myComments/' + rep.id).get()).exists);
  const t2 = await post('uidA', 'Owner can remove anything'); assert.strictEqual((await C.deleteComment(Object.assign(asUser('mod', { owner: true }), { data: { articleId: AID, commentId: t2.id } }))).removed, 1);
});
test('reportComment: 3 different students auto-hide it (archived, not lost); own/duplicate reports handled; owner can restore', async () => {
  await seedArticle(); const c = await post('author', 'A questionable comment text');
  const rep = (uid, reason) => C.reportComment(Object.assign(asUser(uid), { data: { articleId: AID, commentId: c.id, reason } }));
  await expectErr(rep('author', 'spam'), 'failed-precondition');
  assert.strictEqual((await rep('r1', 'spam')).hidden, false); assert.strictEqual((await rep('r1', 'spam')).already, true);
  assert.strictEqual((await rep('r2', 'abusive')).hidden, false);
  assert.strictEqual((await rep('r3', 'nonsense-reason')).hidden, true);
  assert.ok(!(await fake.doc('discoverArticles/' + AID + '/comments/' + c.id).get()).exists, 'no longer public');
  assert.ok((await fake.doc('discoverHidden/' + c.id).get()).exists, 'archived server-side');
  assert.strictEqual((await fake.doc('discoverArticles/' + AID).get()).data().commentCount, 0);
  await expectErr(C.modList(asUser('student')), 'permission-denied');
  const list = await C.modList(asUser('mod', { owner: true })); assert.strictEqual(list.items.length, 1); assert.strictEqual(list.items[0].hidden, true); assert.strictEqual(list.items[0].count, 3);
  await expectErr(C.modAct(Object.assign(asUser('student'), { data: { articleId: AID, commentId: c.id, action: 'keep' } })), 'permission-denied');
  await C.modAct(Object.assign(asUser('mod', { owner: true }), { data: { articleId: AID, commentId: c.id, action: 'keep' } }));
  assert.ok((await fake.doc('discoverArticles/' + AID + '/comments/' + c.id).get()).exists, 'restored');
  assert.strictEqual((await fake.doc('discoverArticles/' + AID).get()).data().commentCount, 1);
  assert.strictEqual((await C.modList(asUser('mod', { owner: true }))).items.length, 0);
});
test('modAct remove deletes permanently', async () => {
  await seedArticle(); const c = await post('author', 'Comment that will be removed');
  for (const u of ['r1', 'r2']) await C.reportComment(Object.assign(asUser(u), { data: { articleId: AID, commentId: c.id, reason: 'spam' } }));
  await C.modAct(Object.assign(asUser('mod', { owner: true }), { data: { articleId: AID, commentId: c.id, action: 'remove' } }));
  assert.ok(!(await fake.doc('discoverArticles/' + AID + '/comments/' + c.id).get()).exists);
  assert.strictEqual((await fake.doc('discoverArticles/' + AID).get()).data().commentCount, 0);
});

/* ============================== cross-file consistency ============================== */
test('firestore.rules allowed-interest list == domain catalogue', () => {
  const f = path.join(__dirname, '..', 'firestore.rules'); if (!fs.existsSync(f)) return;
  const m = fs.readFileSync(f, 'utf8').match(/function dvInterests\(\)\{\s*return \[([^\]]+)\];/);
  assert.ok(m, 'dvInterests() not found in firestore.rules');
  const ids = m[1].split(',').map((s) => s.trim().replace(/'/g, '')).sort(); assert.deepStrictEqual(ids, [...D.DOMAIN_IDS].sort());
});
test('website DV_DOMAINS list == domain catalogue', () => {
  const f = path.join(__dirname, '..', 'public', 'index.html'); if (!fs.existsSync(f)) return;
  const html = fs.readFileSync(f, 'utf8'); const blk = html.match(/var DV_DOMAINS = \[([\s\S]*?)\n\];/); assert.ok(blk, 'DV_DOMAINS not found');
  const ids = [...blk[1].matchAll(/\bid:'([a-z]+)'/g)].map((x) => x[1]).sort(); assert.deepStrictEqual(ids, [...D.DOMAIN_IDS].sort());
});

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n       ') : e)); }
    global.fetch = realFetch;
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
