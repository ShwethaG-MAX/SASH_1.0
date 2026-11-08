import sys,json; sys.path.insert(0,'.')
from harness import *
srv=Srv()
srv.accts['boss@x.com']={'pw':'adminpass1','uid':'UADMIN'}
srv.accts['stud@x.com']={'pw':'studpass12','uid':'USTUD'}
srv.accts['rep@cr.cse-hub.app']={'pw':'crpass1234','uid':'UCR'}
srv.docs['crAccounts/UCR']={'section':'C'}
INIT="localStorage.setItem('csec_academic',JSON.stringify({year:'2',branch:'CSE',sem:'3',cycle:''}));localStorage.setItem('csec_onboarding_completed','true');window.__claims={UADMIN:{owner:true}}"
def ok(n,c): print(('PASS ' if c else 'FAIL ')+n)
with sync_playwright() as p:
    b=p.chromium.launch()
    def fresh():
        c,d,e=newctx(b,srv); d.add_init_script(INIT); d.goto('https://cse.test/'); d.wait_for_timeout(2500); return d,e
    d,e=fresh()
    d.click('#lgAdmin'); d.wait_for_timeout(300); d.fill('#olEmail','boss@x.com'); d.fill('#olPass','adminpass1'); d.click('#olSubmit'); d.wait_for_timeout(2500)
    ok('admin login works',d.evaluate("cseRole.role")=='admin')
    ok('admin has no student sync',not d.evaluate("cseAcct.sync.state.active"))
    ok('account card hidden for admin',d.evaluate("document.getElementById('accountCard').classList.contains('hidden')"))
    d.evaluate("document.getElementById('ownerDashOverlay').classList.remove('show')"); d.evaluate("document.getElementById('logoutBtn').click()"); d.wait_for_timeout(300); d.click('#cseDlgB button:first-child'); d.wait_for_timeout(3000)
    ok('admin logout -> gate',d.evaluate("cseGateOpen()") and d.evaluate("firebase.auth().currentUser.isAnonymous"))
    # student account tries Admin Login -> rejected, signed out
    d,e=fresh()
    d.click('#lgAdmin'); d.wait_for_timeout(300); d.fill('#olEmail','stud@x.com'); d.fill('#olPass','studpass12'); d.click('#olSubmit'); d.wait_for_timeout(2500)
    ok('student rejected by Admin Login',d.evaluate("cseRole.role")=='student' and 'access' in d.inner_text('#olErr').lower())
    # CR login
    d,e=fresh()
    d.click('#lgCR'); d.fill('#lgUser','rep'); d.fill('#lgPass','crpass1234'); d.click('#lgSubmit'); d.wait_for_timeout(2500)
    ok('CR login works',d.evaluate("cseRole.role")=='cr' and not d.evaluate("cseGateOpen()"))
    # CR restored on reload (not treated as student)
    d.reload(); d.wait_for_timeout(2500)
    ok('CR session survives reload',d.evaluate("cseRole.role")=='cr')
    # student email account session survives reload and is NOT signed out
    d,e=fresh()
    d.click('#lgEmail'); d.fill('#lgEmEmail','stud@x.com'); d.fill('#lgEmPass','studpass12'); d.click('#lgEmSubmit'); d.wait_for_timeout(2500)
    d.fill('#pflgStudentFormName','Stu'); d.select_option('#pflgStudentFormSec','B'); d.select_option('#pflgStudentFormBatch','2'); d.click('#pflgStudentFormSave'); d.wait_for_timeout(1500)
    d.reload(); d.wait_for_timeout(3000)
    ok('email student survives reload',d.evaluate("!firebase.auth().currentUser.isAnonymous") and not d.evaluate("cseGateOpen()") and d.evaluate("currentUser.name")=='Stu')
    # offline start: server unreachable for profile -> keeps local, no onboarding
    # revoked CR-domain account is not a student
    ok('CR namespace not a student account',d.evaluate("cseAcct.isStudentAccount({isAnonymous:false,email:'x@cr.cse-hub.app',providerData:[{providerId:'password'}]})")==False)
    # registration with reserved domain blocked
    d.evaluate("cseAcct.logout")
    print('errors',e)
    b.close()
