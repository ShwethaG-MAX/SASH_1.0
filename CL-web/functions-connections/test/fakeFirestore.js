'use strict';
/* Minimal in-memory Firestore for tests: docs, subcollections, set/create/update(dotted paths)/delete, getAll, batch, transactions,
   equality queries, FieldValue sentinels. Enough to exercise the REAL refresh/comment code without a network or emulator. */
let seq = 0;
const SERVER_TS = { __op: 'ts' };
class Ts { constructor(ms) { this.ms = ms; } toMillis() { return this.ms; } toDate() { return new Date(this.ms); } }
const FieldValue = { serverTimestamp: () => ({ __op: 'ts' }), increment: (n) => ({ __op: 'inc', n }), arrayUnion: (...v) => ({ __op: 'au', v }), arrayRemove: (...v) => ({ __op: 'ar', v }), delete: () => ({ __op: 'del' }) };
const Timestamp = { fromMillis: (ms) => new Ts(ms), fromDate: (d) => new Ts(d.getTime()), now: () => new Ts(Date.now()) };
const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o, (k, v) => (v instanceof Ts ? { __ts: v.ms } : v)), (k, v) => (v && v.__ts !== undefined ? new Ts(v.__ts) : v)));

function resolve(cur, val) {
  if (val && typeof val === 'object' && val.__op) {
    if (val.__op === 'ts') return new Ts(Date.now());
    if (val.__op === 'inc') return (typeof cur === 'number' ? cur : 0) + val.n;
    if (val.__op === 'del') return undefined;
    if (val.__op === 'au') { const a = Array.isArray(cur) ? cur.slice() : []; val.v.forEach((x) => { if (!a.includes(x)) a.push(x); }); return a; }
    if (val.__op === 'ar') return (Array.isArray(cur) ? cur : []).filter((x) => !val.v.includes(x));
  }
  return val;
}
function setPath(obj, path, val) {
  const parts = path.split('.'); let o = obj;
  for (let i = 0; i < parts.length - 1; i++) { if (typeof o[parts[i]] !== 'object' || o[parts[i]] === null || o[parts[i]] instanceof Ts) o[parts[i]] = {}; o = o[parts[i]]; }
  const last = parts[parts.length - 1], r = resolve(o[last], val);
  if (r === undefined) delete o[last]; else o[last] = r;
}
const deepResolve = (data) => { const out = {}; Object.keys(data).forEach((k) => { const v = data[k]; if (v === undefined) return; if (v && typeof v === 'object' && !v.__op && !(v instanceof Ts) && !Array.isArray(v)) out[k] = deepResolve(v); else { const r = resolve(undefined, v); if (r !== undefined) out[k] = r; } }); return out; };

class Snap { constructor(ref, data) { this.ref = ref; this.id = ref.id; this._d = data; this.exists = data !== undefined; } data() { return this.exists ? clone(this._d) : undefined; } }

function makeDb() {
  const store = new Map(); const writes = [];
  const log = (op, path) => writes.push(op + ' ' + path);
  const doApply = (op) => {
    const { type, path, data } = op, cur = store.get(path);
    if (type === 'create') { if (cur !== undefined) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; } store.set(path, deepResolve(clone(data) || {})); }
    else if (type === 'set') store.set(path, deepResolve(data));
    else if (type === 'update') { if (cur === undefined) { const e = new Error('NOT_FOUND'); e.code = 5; throw e; } const n = clone(cur); Object.keys(data).forEach((k) => setPath(n, k, data[k])); store.set(path, n); }
    else if (type === 'delete') store.delete(path);
    log(type, path);
  };
  class DocRef {
    constructor(path) { this.path = path; this.id = path.split('/').pop(); }
    collection(n) { return new ColRef(this.path + '/' + n); }
    async get() { return new Snap(this, clone(store.get(this.path))); }
    async set(d, o) { if (o && o.merge) { const n = clone(store.get(this.path)) || {}; Object.keys(d).forEach((k) => setPath(n, k, d[k])); store.set(this.path, n); log('merge', this.path); } else doApply({ type: 'set', path: this.path, data: d }); }
    async create(d) { doApply({ type: 'create', path: this.path, data: d }); }
    async update(d) { doApply({ type: 'update', path: this.path, data: d }); }
    async delete() { doApply({ type: 'delete', path: this.path }); }
  }
  const val = (v) => (v instanceof Ts ? v.ms : v);
  const OPS = { 'array-contains': (a, b) => Array.isArray(a) && a.includes(b), '==': (a, b) => a === b, '>=': (a, b) => a >= b, '<=': (a, b) => a <= b, '<': (a, b) => a < b, '>': (a, b) => a > b };
  class Query {
    constructor(path, filters, lim, ord) { this.path = path; this.filters = filters || []; this.lim = lim; this.ord = ord; }
    where(f, op, v) { if (!OPS[op]) throw new Error('fake: unsupported op ' + op); return new Query(this.path, this.filters.concat([[f, op, v]]), this.lim, this.ord); }
    orderBy(f, dir) { return new Query(this.path, this.filters, this.lim, [f, dir || 'asc']); }
    limit(n) { return new Query(this.path, this.filters, n, this.ord); }
    async get() {
      let docs = []; const depth = this.path.split('/').length + 1;
      for (const [p, d] of store) if (p.startsWith(this.path + '/') && p.split('/').length === depth && this.filters.every(([f, op, v]) => OPS[op](val(d[f]), val(v)))) docs.push(new Snap(new DocRef(p), clone(d)));
      if (this.ord) { const [f, dir] = this.ord; docs.sort((a, b) => (val(a._d[f]) > val(b._d[f]) ? 1 : -1) * (dir === 'desc' ? -1 : 1)); }
      const out = this.lim ? docs.slice(0, this.lim) : docs; return { docs: out, size: out.length, empty: !out.length, forEach: (f) => out.forEach(f) };
    }
  }
  class ColRef extends Query {
    constructor(path) { super(path); }
    async add(d) { const r = this.doc(); await r.set(d); return r; }
    doc(id) { id = id || (('A' + (++seq).toString(36).padStart(5, '0') + Math.random().toString(36).slice(2)).replace(/[^A-Za-z0-9]/g, 'x') + 'x'.repeat(20)).slice(0, 20); return new DocRef(this.path + '/' + id); }
  }
  const db = {
    _store: store, _writes: writes,
    doc: (p) => new DocRef(p), collection: (p) => new ColRef(p),
    getAll: async (...refs) => refs.map((r) => new Snap(r, clone(store.get(r.path)))),
    batch: () => { const ops = []; const b = { set: (r, d) => (ops.push({ type: 'set', path: r.path, data: d }), b), create: (r, d) => (ops.push({ type: 'create', path: r.path, data: d }), b), update: (r, d) => (ops.push({ type: 'update', path: r.path, data: d }), b), delete: (r) => (ops.push({ type: 'delete', path: r.path }), b), commit: async () => { ops.forEach(doApply); } }; return b; },
    runTransaction: async (fn) => {
      const ops = []; const t = {
        get: async (r) => new Snap(r, clone(store.get(r.path))), getAll: async (...refs) => refs.map((r) => new Snap(r, clone(store.get(r.path)))),
        set: (r, d, o) => ops.push({ type: o && o.merge ? 'merge' : 'set', path: r.path, data: d }), create: (r, d) => ops.push({ type: 'create', path: r.path, data: d }),
        update: (r, d) => ops.push({ type: 'update', path: r.path, data: d }), delete: (r) => ops.push({ type: 'delete', path: r.path }),
      };
      const res = await fn(t); const snapshot = new Map([...store].map(([k, v]) => [k, clone(v)]));
      try { ops.forEach((op) => { if (op.type === 'merge') { const n = clone(store.get(op.path)) || {}; Object.keys(op.data).forEach((k) => setPath(n, k, op.data[k])); store.set(op.path, n); } else doApply(op); }); } catch (e) { store.clear(); snapshot.forEach((v, k) => store.set(k, v)); throw e; }
      return res;
    },
  };
  return db;
}
module.exports = { makeDb, FieldValue, Timestamp, Ts };
