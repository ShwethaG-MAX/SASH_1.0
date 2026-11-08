// TEST-ONLY in-memory Firebase compat stub (no network in sandbox). Server state lives in the Python harness via __srv().
(function(){
const srv=(op,a)=>window.__srv(op,a);
const listeners=[];
class Err extends Error{constructor(code){super(code);this.code=code;}}
const TS={__ts:true};
const FV={serverTimestamp:()=>TS};
function clean(d){return JSON.parse(JSON.stringify(d,(k,v)=>v&&v.__ts?{__ts:Date.now()}:v));}
function wrapDoc(path,d){return {id:path.split('/').pop(),exists:!!d,metadata:{fromCache:false,hasPendingWrites:false},data:()=>d?JSON.parse(JSON.stringify(d)):undefined,ref:{path}};}
function docRef(path){return {path,id:path.split('/').pop(),
  collection:c=>colRef(path+'/'+c),
  get:async o=>wrapDoc(path,await srv('get',{path})),
  set:async(d,o)=>{await check('write',path,d);await srv('set',{path,data:clean(d),merge:!!(o&&o.merge)});},
  update:async d=>srv('set',{path,data:clean(d),merge:true}),
  onSnapshot:(f)=>{return poll(()=>srv('get',{path}).then(d=>[wrapDoc(path,d)]),f,true);}};}
async function check(kind,path,d){const u=window.__auth.cur; if(window.__denyUserData && path.startsWith('userData/')) throw new Err('permission-denied');}
function colRef(path){const q={path,
  doc:id=>docRef(path+'/'+id),
  get:async o=>{const l=await srv('list',{path});const docs=l.map(x=>wrapDoc(x.path,x.data));return {docs,forEach:f=>docs.forEach(f),size:docs.length};},
  add:async d=>{const id='a'+Math.random().toString(36).slice(2);await srv('set',{path:path+'/'+id,data:clean(d)});return docRef(path+'/'+id);},
  orderBy:()=>q,limit:()=>q,where:()=>q,
  onSnapshot:(f,e)=>poll(()=>srv('list',{path}).then(l=>l.map(x=>wrapDoc(x.path,x.data))),f,false)};return q;}
function poll(fetch,f,single){let last={},stop=false;const run=async()=>{if(stop)return;try{const docs=await fetch();const changes=[];docs.forEach(d=>{const s=JSON.stringify(d.data());if(last[d.ref.path]!==s){changes.push({type:last[d.ref.path]?'modified':'added',doc:d});last[d.ref.path]=s;}});
  if(single)f(docs[0]);else f({docs,forEach:x=>docs.forEach(x),docChanges:()=>changes});}catch(e){}if(!stop)setTimeout(run,250);};run();return()=>{stop=true;};}
const db={collection:c=>colRef(c),settings(){},enablePersistence:()=>Promise.resolve(),enableNetwork:()=>Promise.resolve(),disableNetwork:()=>Promise.resolve(),
  terminate:()=>{window.__terminated=1;return Promise.resolve();},clearPersistence:()=>{window.__cleared=1;return Promise.resolve();},
  batch:()=>{const ops=[];return {set:(r,d,o)=>ops.push(()=>r.set(d,o)),update:(r,d)=>ops.push(()=>r.update(d)),commit:async()=>{for(const o of ops)await o();}}},
  runTransaction:async fn=>{for(let i=0;i<5;i++){const reads={},writes=[];const tx={get:async r=>{reads[r.path]=await srv('ver',{path:r.path});return r.get();},set:(r,d)=>{writes.push({path:r.path,data:clean(d)});}};const res=await fn(tx);if(window.__denyUserData&&writes.some(w=>w.path.startsWith('userData/')))throw new Err('permission-denied');if(await srv('txcommit',{reads,writes}))return res;}throw new Err('aborted');}};
// ---- auth ----
const A=window.__auth={cur:null,subs:[],n:0};
function mkUser(o){const u=Object.assign({uid:'u'+(++A.n)+Math.random().toString(36).slice(2,6),isAnonymous:false,emailVerified:false,providerData:[],email:null,displayName:null},o);
 u.getIdToken=()=>Promise.resolve('t');u.getIdTokenResult=()=>Promise.resolve({claims:(window.__claims&&window.__claims[u.uid])||{}});
 u.sendEmailVerification=()=>{window.__verif=(window.__verif||0)+1;return Promise.resolve();};
 u.delete=()=>Promise.resolve();
 u.linkWithCredential=async c=>{ if(c.providerId==='password'){const ex=await srv('acct',{email:c.email});if(ex)throw new Err('auth/email-already-in-use');await srv('addacct',{email:c.email,pw:c.pw,uid:u.uid});u.isAnonymous=false;u.email=c.email;u.providerData=[{providerId:'password'}];}
   else{const ex=await srv('gacct',{gid:c.gid});if(ex&&ex!==u.uid){const e=new Err('auth/credential-already-in-use');e.credential=c;throw e;}await srv('addg',{gid:c.gid,uid:u.uid});u.isAnonymous=false;u.email=c.gemail;u.providerData=[{providerId:'google.com'}];}
   save();return {user:u};};
 u.linkWithPopup=async p=>{if(window.__popupErr){const e=new Err(window.__popupErr);e.email='nina@x.com';throw e;}return u.linkWithCredential(await pickGoogle());};
 return u;}
function save(){localStorage.setItem('fake_auth',JSON.stringify(A.cur?{uid:A.cur.uid,isAnonymous:A.cur.isAnonymous,email:A.cur.email,providerData:A.cur.providerData,emailVerified:A.cur.emailVerified,displayName:A.cur.displayName}:null));}
function set(u){console.log('[STUB] set '+(u?u.uid+(u.isAnonymous?' anon':''):'null')+' '+new Error().stack.split('\n').slice(2,4).join('|').slice(0,200));A.cur=u;save();A.subs.forEach(f=>setTimeout(()=>f(u),0));}
async function pickGoogle(){const g=window.__googlePick||{gid:'g1',gemail:'g@x.com',name:'Gina G'};return {providerId:'google.com',gid:g.gid,gemail:g.gemail,name:g.name};}
const auth={get currentUser(){return A.cur;},
 onAuthStateChanged(f){A.subs.push(f);setTimeout(()=>{const r=JSON.parse(localStorage.getItem('fake_auth')||'null');if(r&&!A.cur){A.cur=mkUser(r);}f(A.cur);},10);return()=>{};},
 setPersistence:()=>Promise.resolve(),
 signInAnonymously:async()=>{if(A.cur&&A.cur.isAnonymous)return {user:A.cur};const u=mkUser({isAnonymous:true});set(u);return {user:u};},
 createUserWithEmailAndPassword:async(email,pw)=>{if(await srv('acct',{email}))throw new Err('auth/email-already-in-use');const u=mkUser({email,providerData:[{providerId:'password'}]});await srv('addacct',{email,pw,uid:u.uid});set(u);return {user:u};},
 signInWithEmailAndPassword:async(email,pw)=>{const a=await srv('acct',{email});if(!a||a.pw!==pw)throw new Err('auth/invalid-credential');set(mkUser({uid:a.uid,email,providerData:[{providerId:'password'}]}));return {user:A.cur};},
 signInWithPopup:async()=>{if(window.__popupErr)throw new Err(window.__popupErr);const c=await pickGoogle();let uid=await srv('gacct',{gid:c.gid});if(!uid){uid='ug'+Math.random().toString(36).slice(2,8);await srv('addg',{gid:c.gid,uid});}set(mkUser({uid,email:c.gemail,displayName:c.name,emailVerified:true,providerData:[{providerId:'google.com'}]}));return {user:A.cur};},
 signInWithCredential:async c=>{const uid=await srv('gacct',{gid:c.gid});set(mkUser({uid,email:c.gemail,emailVerified:true,providerData:[{providerId:'google.com'}]}));return {user:A.cur};},
 sendPasswordResetEmail:async e=>{window.__reset=e;},
 signOut:async()=>{if(window.__signOutFail)throw new Err('auth/network-request-failed');set(null);},
 getRedirectResult:()=>Promise.resolve({user:null})};
auth.constructor={Persistence:{LOCAL:'local'}};
const fb={apps:[],initializeApp(){fb.apps.push({});},auth:Object.assign(()=>auth,{Auth:{Persistence:{LOCAL:'local'}},
  GoogleAuthProvider:function(){this.setCustomParameters=()=>{};},EmailAuthProvider:{credential:(email,pw)=>({providerId:'password',email,pw})}}),
 firestore:Object.assign(()=>db,{FieldValue:FV,Timestamp:{now:()=>({toMillis:()=>Date.now()}),fromMillis:m=>({toMillis:()=>m}),fromDate:d=>({toMillis:()=>+d})}}),analytics:()=>({logEvent(){}})};
window.firebase=fb;
})();
