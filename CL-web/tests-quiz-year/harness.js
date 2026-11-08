'use strict';
// In-memory stand-ins for firebase-admin / firebase-functions so the REAL index.js + lib/core.js run unmodified.
const Module = require('module');
const path = require('path');
const store = new Map();                       // path -> data
const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
const SERVER_TS = { __fv: 'ts' };
const mkSnap = (p) => { const d = store.get(p); return { id: p.split('/').pop(), exists: d !== undefined, data: () => clone(d), ref: mkDoc(p) }; };
const applyFV = (obj) => { const o = {}; for (const [k, v] of Object.entries(obj)) o[k] = (v && v.__fv) ? Date.now() : v; return o; };
function mkDoc(p) {
  return {
    path: p,
    get: async () => mkSnap(p),
    set: async (data, opts) => { const d = applyFV(data); store.set(p, opts && opts.merge ? Object.assign({}, store.get(p) || {}, d) : d); },
    create: async (data) => { if (store.has(p)) { const e = new Error('exists'); e.code = 'already-exists'; throw e; } store.set(p, applyFV(data)); },
    update: async (data) => { store.set(p, Object.assign({}, store.get(p) || {}, applyFV(data))); },
    delete: async () => { store.delete(p); },
  };
}
function mkQuery(col, filters = [], lim = null) {
  const q = {
    where: (f, op, v) => mkQuery(col, filters.concat([[f, op, v]]), lim),
    limit: (n) => mkQuery(col, filters, n),
    orderBy: () => q,
    get: async () => {
      let docs = [...store.keys()].filter((k) => k.startsWith(col + '/') && !k.slice(col.length + 1).includes('/'))
        .filter((k) => filters.every(([f, , v]) => store.get(k)[f] === v)).map((k) => mkSnap(k));
      if (lim) docs = docs.slice(0, lim);
      return { docs, empty: docs.length === 0, size: docs.length };
    },
    count: () => ({ get: async () => ({ data: () => ({ count: [...store.keys()].filter((k) => k.startsWith(col + '/')).length }) }) }),
  };
  return q;
}
const fakeDb = {
  doc: mkDoc,
  collection: (c) => Object.assign(mkQuery(c), { doc: (id) => mkDoc(`${c}/${id || 'auto' + Math.random()}`) }),
  runTransaction: async (fn) => {
    const t = { get: async (x) => (x.path ? mkSnap(x.path) : x.get()), set: (r, d, o) => r.set(d, o), create: (r, d) => r.create(d), update: (r, d) => r.update(d), delete: (r) => r.delete() };
    // writes are applied immediately (single-threaded test); good enough for these flows
    const pending = [];
    const wrap = (fnName) => (...a) => { const p = t['_' + fnName](...a); pending.push(p); return p; };
    ['set', 'create', 'update', 'delete'].forEach((n) => { t['_' + n] = t[n]; t[n] = wrap(n); });
    const r = await fn(t); await Promise.all(pending); return r;
  },
  batch: () => { const ops = []; return { set: (r, d, o) => ops.push(() => r.set(d, o)), update: (r, d) => ops.push(() => r.update(d)), delete: (r) => ops.push(() => r.delete()), commit: async () => { for (const o of ops) await o(); } }; },
};
const fsFn = () => fakeDb;
fsFn.FieldValue = { serverTimestamp: () => SERVER_TS, increment: (n) => n, delete: () => undefined };
fsFn.Timestamp = { fromMillis: (m) => m, now: () => Date.now() };
const admin = { apps: [1], initializeApp() {}, firestore: fsFn };
class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
const handlers = {};
const fns = {
  'firebase-admin': admin,
  'firebase-functions/v2': { setGlobalOptions() {} },
  'firebase-functions/v2/https': { onCall: (opts, h) => h, HttpsError },
  'firebase-functions/v2/scheduler': { onSchedule: (o, h) => h },
  'firebase-functions/params': { defineSecret: () => ({ value: () => '' }) },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return fns[req] || origLoad.call(this, req, ...rest); };
const root = process.env.FN_ROOT || path.resolve(__dirname, '../functions-quiz');
const fnsExports = require(path.join(root, 'index.js'));
const C = require(path.join(root, 'lib/core.js'));
module.exports = { store, fn: fnsExports, C, HttpsError };
