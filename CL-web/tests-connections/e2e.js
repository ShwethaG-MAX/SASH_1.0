const { chromium } = require('playwright'); const fs = require('fs'); const path = require('path');
const root = require('path').resolve(__dirname, '..'); const core = require(root + '/functions-connections/lib/core');
const { makeDb, FieldValue } = require(root + '/functions-connections/test/fakeFirestore');
const db = makeDb(), ctx = { db, FV: FieldValue };
const html = fs.readFileSync(process.argv[2] || root + '/public/index.html', 'utf8'); const stub = fs.readFileSync(__dirname + '/stub.js', 'utf8');
const ser = (v) => JSON.parse(JSON.stringify(v, (k, x) => (x && x.ms !== undefined && x.toMillis ? { __ts: x.ms } : x)));
async function rpc(m, a) {
  if (m === 'get') { const s = await db.doc(a[0]).get(); return s.exists ? ser(s.data()) : null; }
  if (m === 'query') { let q = db.collection(a[0]); a[1].forEach(([f, o, v]) => { q = q.where(f, o, v); }); if (a[2]) q = q.orderBy(a[2][0], a[2][1]); if (a[3]) q = q.limit(a[3]); const s = await q.get(); return s.docs.map((d) => ({ id: d.id, path: d.ref.path, data: ser(d.data()) })); }
  if (m === 'set') { await db.doc(a[0]).set(a[1], a[2] || undefined); return; }
  if (m === 'update') { await db.doc(a[0]).update(a[1]); return; }
  if (m === 'delete') { await db.doc(a[0]).delete(); return; }
  if (m === 'add') { await db.collection(a[0]).add(a[1]); return; }
  if (m === 'batch') { for (const [t, p, d] of a[0]) await (t === 'update' ? db.doc(p).update(d) : t === 'set' ? db.doc(p).set(d) : db.doc(p).delete()); return; }
  if (m === 'call') { const map = { connSend: 'sendRequest', connRespond: 'respond', connCancel: 'cancelRequest', connRemove: 'removeConnection', connMutuals: 'mutuals', connSuggest: 'suggestions' };
    try { const rr = ser(await core[map[a[0]]](ctx, { uid: a[2], token: { firebase: { sign_in_provider: 'password' } } }, a[1])); if (process.env.DBG && /Suggest|Mutuals/.test(a[0])) console.log('CALL', a[2], a[0], JSON.stringify(rr).slice(0, 200)); return rr; } catch (e) { return { __err: 1, code: e.code || 'internal', message: e.message }; } }
}
(async () => {
  const br = await chromium.launch(); const out = []; const ok = (n, c) => { out.push((c ? 'PASS ' : 'FAIL ') + n); if (!c) process.exitCode = 1; };
  async function open(uid, name) {
    const ctxb = await br.newContext({ viewport: { width: 420, height: 900 } }), pg = await ctxb.newPage(); pg.errs = [];
    pg.on('console', (m) => { if (process.env.DBG && /Connect|Connections|publish|Firebase\]|Auth/.test(m.text())) console.log(uid, m.text().slice(0,160)); }); pg.on('pageerror', (e) => pg.errs.push(String(e).slice(0, 160)));
    await pg.exposeFunction('__rpc', rpc); await pg.addInitScript('window.__UID=' + JSON.stringify(uid) + ';' + stub);
    await pg.route('**/*', (r) => { const u = r.request().url();
      if (u === 'file:///app.html' || u.endsWith('/app.html')) return r.fulfill({ contentType: 'text/html', body: html });
      if (/gstatic\.com\/firebasejs\/.*firebase-app-compat/.test(u)) return r.fulfill({ contentType: 'text/javascript', body: '/*stub*/' });
      if (/gstatic\.com\/firebasejs/.test(u)) return r.fulfill({ contentType: 'text/javascript', body: '/*stub*/' });
      if (u.startsWith('http://app.test/')) return r.fulfill({ contentType: 'text/html', body: html });
      return r.abort(); });
    await pg.goto('http://app.test/'); await pg.waitForTimeout(4500);
    await pg.evaluate((n) => { currentUser.name = n; currentUser.year = '2'; currentUser.branch = 'CSE'; }, name);
    return pg;
  }
  const C = 'uidChitra01'; await db.doc('publicProfiles/' + C).set({ name: 'Chitra', year: '2', branch: 'ISE' });
  { const au = (u) => ({ uid: u, token: { firebase: { sign_in_provider: 'password' } } }); await db.doc('publicProfiles/uidBhuvan01').set({ name: 'Bhuvan', year: '2', branch: 'CSE' }); await core.sendRequest(ctx, au(C), { to: 'uidBhuvan01' }); await core.respond(ctx, au('uidBhuvan01'), { from: C, accept: true }); }
  const A = await open('uidAsha0001', 'Asha'), B = await open('uidBhuvan01', 'Bhuvan');
  const go = async (pg, sub) => { await pg.evaluate((s) => { document.getElementById('secBtnConnect').click(); }, sub); await pg.waitForTimeout(300); await pg.evaluate(() => document.querySelector('[data-cn="teams"]').click()); await pg.waitForTimeout(200); await pg.evaluate((s) => document.querySelector('[data-cntsub="' + s + '"]').click(), sub); await pg.waitForTimeout(1500); };
  await A.waitForTimeout(4000);
  await go(A, 'people'); await go(B, 'people');
  const txt = (pg, sel) => pg.evaluate((s) => (document.querySelector(s) || {}).innerText || '', sel);
  if (process.env.DBG) console.log('GRID', await txt(A,'#cnPgrid'), '|', await txt(A,'#cnPempty'), JSON.stringify(Object.keys(db._store ? Object.fromEntries(db._store) : {})));
  ok('A sees B in Find people (real publicProfiles)', /Bhuvan/.test(await txt(A, '#cnPgrid')));
  
  await A.evaluate(() => { const b = [...document.querySelectorAll('#cnPgrid .cn-urow')].find((r) => /Bhuvan/.test(r.innerText)).querySelector('button[data-k]'); b.click(); }); await A.waitForTimeout(1500);
  ok('A button flips to Request sent', /Request sent/.test(await txt(A, '#cnPgrid')));
  await B.waitForTimeout(800);
  ok('B nav badge shows 1 (real-time)', (await txt(B, '#cnNavN')).trim() === '1');
  ok('B sub-tab badge shows 1', (await txt(B, '#cnConN')).trim() === '1');
  ok('B got a live toast', /Asha sent you a connection request/.test(await B.evaluate(() => [...document.querySelectorAll('.cn-toast')].map((x) => x.innerText).join('|'))));
  await B.evaluate(() => document.querySelector('[data-cntsub="connections"]').click()); await B.waitForTimeout(800);
  ok('B Received tab lists Asha', /Asha/.test(await txt(B, '#cnConBody')));
  await A.evaluate(() => document.querySelector('[data-cntsub="connections"]').click()); await A.evaluate(() => document.querySelector('[data-ccon="sent"]').click()); await A.waitForTimeout(500);
  ok('A Sent tab lists Bhuvan with Cancel', /Bhuvan/.test(await txt(A, '#cnConBody')) && /Cancel request/.test(await txt(A, '#cnConBody')));
  await A.evaluate(() => document.querySelector('[data-ccan]').click()); await A.waitForTimeout(1200); await B.waitForTimeout(600);
  ok('Cancel empties A Sent and B Received', /No sent requests/.test(await txt(A, '#cnConBody')) && /No received requests/.test(await txt(B, '#cnConBody')));
  await A.evaluate(() => document.querySelector('[data-cntsub="people"]').click()); await A.waitForTimeout(500);
  await A.evaluate(() => [...document.querySelectorAll('#cnPgrid .cn-urow')].find((r) => /Bhuvan/.test(r.innerText)).querySelector('button[data-k]').click()); await A.waitForTimeout(1500);
  await B.evaluate(() => document.querySelector('[data-crej]').click()); await B.waitForTimeout(1500);
  await A.evaluate(() => document.querySelector('[data-cntsub="connections"]').click()); await A.evaluate(() => document.querySelector('[data-ccon="sent"]').click()); await A.waitForTimeout(500);
  ok('Reject shows A "Not accepted" + Send again', /Not accepted/.test(await txt(A, '#cnConBody')) && /Send again/.test(await txt(A, '#cnConBody')));
  await A.evaluate(() => document.querySelector('[data-cagain]').click()); await A.waitForTimeout(1500);
  await B.evaluate(() => document.querySelector('[data-cacc]').click()); await B.waitForTimeout(1500);
  await B.evaluate(() => document.querySelector('[data-ccon="mine"]').click()); await A.evaluate(() => document.querySelector('[data-ccon="mine"]').click()); await A.waitForTimeout(800);
  ok('Accept: B My Connections has Asha', /Asha/.test(await txt(B, '#cnConBody')));
  ok('Accept: A My Connections has Bhuvan', /Bhuvan/.test(await txt(A, '#cnConBody')));
  ok('A got accepted toast/activity', /accepted your request/.test(await txt(A, '#cnConAct')));
  ok('Badges cleared on B after handling', (await txt(B, '#cnConN')).trim() === '');
  await A.waitForTimeout(500); await A.evaluate(() => document.querySelector('[data-cntsub="people"]').click()); await A.waitForTimeout(3500);
  if (process.env.DBG) console.log('SUG', JSON.stringify(await A.evaluate(() => ({ sug: document.getElementById('cnPsug').innerText, mu: JSON.stringify(window.__mu||null), grid: document.getElementById('cnPgrid').innerText.slice(0,200) }))));
  ok('Suggestion: A sees People you may know -> Chitra with 1 mutual', /People you may know/.test(await txt(A, '#cnPsug')) && /Chitra/.test(await txt(A, '#cnPsug')) && /1 mutual connection/.test(await txt(A, '#cnPsug')));
  ok('Mutual shown on Chitra card in list', /1 mutual/.test(await A.evaluate(() => ([...document.querySelectorAll('#cnPgrid .cn-urow')].find((r) => /Chitra/.test(r.innerText)) || {}).innerText || '')));
  ok('Peer profile: no demo text, real Connect', await (async () => { await A.evaluate(() => [...document.querySelectorAll('#cnPgrid .cn-urow')].find((r) => /Chitra/.test(r.innerText)).querySelector('[data-vp]').click()); await A.waitForTimeout(700); const t = await A.evaluate(() => (document.getElementById('pfBody') || {}).innerText || ''); return /Chitra/.test(t) && !/not sent anywhere/.test(t) && (await txt(A, '#pfConn')).trim() === 'Connect'; })());
  await A.evaluate(() => document.getElementById('pfConn').click()); await A.waitForTimeout(1500);
  ok('Peer profile Connect sends real request', /Request sent/.test(await txt(A, '#pfConn')) && !!(await db.doc('connectionRequests/uidAsha0001_' + C).get()).exists);
  await A.evaluate(() => { const c = document.querySelector('#profileOverlay .cl-ovbar button, .cl-ovbar button'); if (c) c.click(); }); await A.waitForTimeout(400);
  await A.evaluate(() => document.querySelector('[data-cntsub="people"]').click()); await A.waitForTimeout(600);
  ok('Find people shows Connected for Bhuvan', /Connected/.test(await txt(A, '#cnPgrid')));
  await A.evaluate(() => document.querySelector('[data-cntsub="connections"]').click()); await A.evaluate(() => document.querySelector('[data-ccon="mine"]').click());
  await A.evaluate(() => document.querySelector('[data-crm]').click()); await A.evaluate(() => document.querySelector('[data-crmok]').click()); await A.waitForTimeout(1500);
  ok('Remove clears both sides', /No connections yet/.test(await txt(A, '#cnConBody')));
  await B.waitForTimeout(800); ok('B also cleared (Asha gone, Chitra stays)', !/Asha/.test(await txt(B, '#cnConBody')) && /Chitra/.test(await txt(B, '#cnConBody')));
  ok('no page errors A', !A.errs.length); ok('no page errors B', !B.errs.length); if (A.errs.length || B.errs.length) out.push(JSON.stringify(A.errs.concat(B.errs)));
  await A.evaluate(() => document.querySelector('[data-cntsub="connections"]').click()); await B.evaluate(() => document.querySelector('[data-cntsub="connections"]').click());
  await A.evaluate(() => document.querySelector('[data-ccon="received"]').click());
  const cl = () => [...document.querySelectorAll('body *')].forEach((el) => { const c = getComputedStyle(el); if (c.position === 'fixed' && el.offsetWidth > innerWidth * 0.9 && el.offsetHeight > innerHeight * 0.5 && !el.contains(document.getElementById('sectionConnect'))) el.style.display = 'none'; });
  await A.evaluate(cl); await A.waitForTimeout(400); await A.screenshot({ path: __dirname + '/screenshot.png' }); console.log(out.join('\n')); await br.close();
})().catch((e) => { console.error('HARNESS ERR', e); process.exit(2); });
