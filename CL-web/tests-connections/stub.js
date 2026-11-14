(function(){
var UID = window.__UID, rpc = window.__rpc;
function rev(v){ if(v && typeof v === 'object'){ if(v.__ts != null){ var ms = v.__ts; return {toMillis:function(){return ms;}, toDate:function(){return new Date(ms);}}; } for(var k in v) v[k] = rev(v[k]); } return v; }
function snapDoc(r){ return {id:r.id, ref:{path:r.path, id:r.id}, exists:true, metadata:{hasPendingWrites:false}, data:function(){ return rev(JSON.parse(JSON.stringify(r.data))); }}; }
function Q(path, f, o, l){ this.path = path; this.f = f || []; this.o = o; this.l = l; }
Q.prototype.where = function(a, b, c){ return new Q(this.path, this.f.concat([[a, b, c]]), this.o, this.l); };
Q.prototype.orderBy = function(a, d){ return new Q(this.path, this.f, [a, d || 'asc'], this.l); };
Q.prototype.limit = function(n){ return new Q(this.path, this.f, this.o, n); };
Q.prototype.get = function(){ var s = this; return rpc('query', [s.path, s.f, s.o, s.l]).then(function(rows){ var docs = rows.map(snapDoc); return {docs:docs, empty:!docs.length, size:docs.length, forEach:function(fn){ docs.forEach(fn); }}; }); };
Q.prototype.onSnapshot = function(ok, err){ var s = this, prev = {}, dead = false, first = true;
  (function tick(){ if(dead) return; s.get().then(function(snap){ var ch = []; snap.docs.forEach(function(d){ var j = JSON.stringify(d.data()); if(prev[d.id] == null) ch.push({type:'added', doc:d}); else if(prev[d.id] !== j) ch.push({type:'modified', doc:d}); prev[d.id] = j; });
      var ids = {}; snap.docs.forEach(function(d){ ids[d.id] = 1; }); Object.keys(prev).forEach(function(k){ if(!ids[k]){ delete prev[k]; ch.push({type:'removed', doc:{id:k, data:function(){return {};}, metadata:{}}}); } });
      if(first || ch.length){ first = false; snap.docChanges = function(){ return ch; }; try{ ok(snap); }catch(e){ console.error(e); } } }).catch(function(e){ err && err(e); }); setTimeout(tick, 250); })();
  return function(){ dead = true; }; };
function Col(path){ Q.call(this, path); }
Col.prototype = Object.create(Q.prototype);
Col.prototype.doc = function(id){ return new Doc(this.path + '/' + id); };
Col.prototype.add = function(d){ return rpc('add', [this.path, d]); };
function Doc(path){ this.path = path; this.id = path.split('/').pop(); }
Doc.prototype.collection = function(n){ return new Col(this.path + '/' + n); };
Doc.prototype.get = function(){ var p = this.path, id = this.id; return rpc('get', [p]).then(function(r){ return {id:id, exists:!!r, data:function(){ return r ? rev(JSON.parse(JSON.stringify(r))) : undefined; }}; }); };
Doc.prototype.set = function(d, o){ return rpc('set', [this.path, d, o || null, UID]); };
Doc.prototype.update = function(d){ return rpc('update', [this.path, d]); };
Doc.prototype.onSnapshot = function(ok){ var d = this, dead = false, prev = null; (function t(){ if(dead) return; d.get().then(function(r){ var j = JSON.stringify(r.exists && r.data()); if(j !== prev){ prev = j; ok(r); } }); setTimeout(t, 400); })(); return function(){ dead = true; }; };
Doc.prototype.delete = function(){ return rpc('delete', [this.path]); };
var fs = { collection:function(p){ return new Col(p); }, doc:function(p){ return new Doc(p); }, settings:function(){}, enablePersistence:function(){ return Promise.reject({code:'unimplemented'}); },
  batch:function(){ var ops = []; var b = { update:function(r, d){ ops.push(['update', r.path, d]); return b; }, set:function(r, d){ ops.push(['set', r.path, d]); return b; }, delete:function(r){ ops.push(['delete', r.path]); return b; }, commit:function(){ return rpc('batch', [ops]); } }; return b; },
  runTransaction:function(fn){ return Promise.reject({code:'unimplemented'}); } };
var user = {uid:UID, isAnonymous:false, email:UID + '@test.local', displayName:UID, providerData:[{providerId:'password'}], getIdToken:function(){ return Promise.resolve('tok'); }, getIdTokenResult:function(){ return Promise.resolve({claims:{}, token:'tok', signInProvider:'password'}); }, reload:function(){ return Promise.resolve(); } };
var ready = false; setTimeout(function(){ ready = true; }, 1800);
var auth = { get currentUser(){ return ready ? user : null; }, setPersistence:function(){ return Promise.resolve(); }, onAuthStateChanged:function(cb){ setTimeout(function(){ cb(user); }, 2000); return function(){}; }, onIdTokenChanged:function(cb){ setTimeout(function(){ cb(user); }, 2000); return function(){}; }, signInAnonymously:function(){ return Promise.resolve({user:user}); }, signOut:function(){ return Promise.resolve(); } };
var fb = { apps:[], initializeApp:function(){ this.apps.push({}); return {}; },
  app:function(){ return { functions:function(){ return { httpsCallable:function(name){ return function(d){ return rpc('call', [name, d, UID]).then(function(r){ if(r && r.__err){ var e = new Error(r.message); e.code = 'functions/' + r.code; throw e; } return {data:r}; }); }; } }; } }; },
  auth:function(){ return auth; }, firestore:function(){ return fs; }, functions:true, storage:function(){ return {}; } };
fb.auth.Auth = {Persistence:{LOCAL:'local', SESSION:'session', NONE:'none'}};
fb.auth.GoogleAuthProvider = function(){}; fb.auth.EmailAuthProvider = {};
fb.firestore.FieldValue = { serverTimestamp:function(){ return {__op:'ts'}; }, arrayUnion:function(){ return {__op:'au', v:[].slice.call(arguments)}; }, arrayRemove:function(){ return {__op:'ar', v:[].slice.call(arguments)}; }, delete:function(){ return {__op:'del'}; }, increment:function(n){ return {__op:'inc', n:n}; } };
fb.firestore.Timestamp = { now:function(){ return rev({__ts:Date.now()}); }, fromMillis:function(m){ return rev({__ts:m}); } };
window.firebase = fb;
})();
