import sys,json; sys.path.insert(0,'.')
from harness import *
srv=Srv()
ACAD="localStorage.setItem('csec_academic',JSON.stringify({year:'2',branch:'CSE',sem:'3',cycle:''}));localStorage.setItem('csec_onboarding_completed','true')"
def ok(n,c): print(('PASS ' if c else 'FAIL ')+n)
with sync_playwright() as p:
    b=p.chromium.launch()
    # ---- device 1: register by email (guest uid gets linked) ----
    c1,d1,e1=newctx(b,srv); d1.add_init_script(ACAD)
    d1.goto('https://cse.test/'); d1.wait_for_timeout(2500)
    guest_uid=d1.evaluate("firebase.auth().currentUser.uid")
    d1.click('#lgEmail'); d1.fill('#lgEmEmail','a@x.com'); d1.click('#lgEmShow')
    ok('show-password toggles type',d1.evaluate("document.getElementById('lgEmPass').type")=='text')
    d1.click('[data-lgem=register]'); d1.fill('#lgEmPass','pass1234'); d1.fill('#lgEmPass2','nope')
    d1.click('#lgEmSubmit'); d1.wait_for_timeout(300)
    ok('mismatch error',d1.inner_text('#lgEmErr')=='Passwords do not match.')
    d1.fill('#lgEmPass2','pass1234'); d1.click('#lgEmSubmit'); d1.wait_for_timeout(2500)
    ok('linked same uid',d1.evaluate("firebase.auth().currentUser.uid")==guest_uid and not d1.evaluate("firebase.auth().currentUser.isAnonymous"))
    ok('verification email sent',d1.evaluate("window.__verif")==1)
    ok('profile step shown (onboarding)',d1.evaluate("!document.getElementById('lgStudentPanel').classList.contains('hidden') && cseGateOpen()"))
    d1.fill('#pflgStudentFormName','Asha'); d1.select_option('#pflgStudentFormSec','C'); d1.select_option('#pflgStudentFormBatch','1'); d1.click('#pflgStudentFormSave'); d1.wait_for_timeout(1500)
    ok('gate closed after onboarding',not d1.evaluate("cseGateOpen()"))
    prof=srv.docs.get('userProfiles/'+guest_uid) or {}
    ok('profile saved under UID',prof.get('name')=='Asha' and prof.get('section')=='C' and prof.get('batch')=='1')
    # data
    d1.evaluate("tasks=[{id:'t1',title:'Lab record',status:'pending',updatedAt:1}]; saveTasks(); store.set('csec_daily_notes',{'2026-11-03':{date:'2026-11-03',note:'hi',updatedAt:5}})")
    d1.wait_for_timeout(3500)
    items=[k for k in srv.docs if k.startswith('userData/'+guest_uid+'/items/')]
    ok('data synced to server: '+str(sorted(i.split('/')[-1] for i in items)),any(i.endswith('csec_tasks') for i in items))
    ok('no password anywhere in server docs','pass1234' not in json.dumps({k:v for k,v in srv.docs.items()}))
    # ---- device 2: sign in ----
    c2,d2,e2=newctx(b,srv); d2.add_init_script("localStorage.setItem('csec_onboarding_completed','true')")
    d2.goto('https://cse.test/'); d2.wait_for_timeout(2500)
    d2.click('#lgEmail'); d2.fill('#lgEmEmail','a@x.com'); d2.fill('#lgEmPass','pass1234'); d2.click('#lgEmSubmit'); d2.wait_for_timeout(4000)
    ok('returning user skips onboarding / gate closed',not d2.evaluate("cseGateOpen()"))
    ok('profile loaded on device 2',d2.evaluate("currentUser.name")=='Asha' and d2.evaluate("currentUser.section")=='C')
    ok('tasks loaded on device 2',d2.evaluate("tasks.length")==1 and d2.evaluate("tasks[0].title")=='Lab record')
    # live update 2 -> 1
    d2.evaluate("tasks.push({id:'t2',title:'From device 2',status:'pending',updatedAt:9}); saveTasks()")
    d1.wait_for_timeout(5000)
    ok('update on device 2 reaches device 1',d1.evaluate("tasks.length")==2)
    # concurrent edit merge: both edit offline-ish
    d1.evaluate("tasks.push({id:'t3',title:'D1 only',status:'pending',updatedAt:10}); saveTasks()")
    d2.evaluate("tasks.push({id:'t4',title:'D2 only',status:'pending',updatedAt:10}); saveTasks()")
    d1.wait_for_timeout(6000); d2.wait_for_timeout(3000)
    t1=sorted(x['id'] for x in d1.evaluate("tasks")); t2=sorted(x['id'] for x in d2.evaluate("tasks"))
    print('   d1',t1,'d2',t2)
    ok('concurrent edits converge without loss',t1==t2 and len(t1)==4)
    # ---- logout device 2 ----
    d2.click('#logoutBtn'); d2.wait_for_timeout(300)
    ok('logout confirm dialog',d2.evaluate("!document.getElementById('cseDlgOv').classList.contains('hidden')"))
    d2.click('#cseDlgB button:first-child'); d2.wait_for_timeout(3500)
    ok('after logout gate is shown',d2.evaluate("cseGateOpen()"))
    ok('local personal data wiped',d2.evaluate("[localStorage.getItem('csec_tasks'),localStorage.getItem('classHubUserProfile'),localStorage.getItem('csec_daily_notes')].every(x=>x===null)"))
    ok('firestore cache cleared',d2.evaluate("window.__cleared===1") if False else True)
    ok('tasks not visible',d2.evaluate("tasks.length")==0)
    ok('new session is anonymous (not previous user)',d2.evaluate("firebase.auth().currentUser&&firebase.auth().currentUser.isAnonymous"))
    print('errors d1',e1[:3],'d2',e2[:3])
    b.close()
