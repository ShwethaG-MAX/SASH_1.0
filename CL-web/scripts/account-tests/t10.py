import sys,json; sys.path.insert(0,'.')
from harness import *
srv=Srv()
srv.accts['a@x.com']={'pw':'passA1234','uid':'UA'}; srv.accts['b@x.com']={'pw':'passB1234','uid':'UB'}
P=lambda n,s:json.dumps({'name':n,'section':s,'batch':'1','year':'2','branch':'CSE','sem':'3','cycle':''})
srv.docs['userProfiles/UA']=json.loads(P('Alice','C')); srv.docs['userProfiles/UB']=json.loads(P('Bob','C'))
srv.docs['userData/UA/items/csec_tasks']={'k':'csec_tasks','v':json.dumps([{'id':'a1','title':'ALICE SECRET'}]),'t':5,'dev':'x'}
INIT="localStorage.setItem('csec_academic',JSON.stringify({year:'2',branch:'CSE',sem:'3',cycle:''}));localStorage.setItem('csec_onboarding_completed','true')"
def ok(n,c): print(('PASS ' if c else 'FAIL ')+n)
with sync_playwright() as p:
    b=p.chromium.launch(); c,d,e=newctx(b,srv); d.add_init_script(INIT); d.goto('https://cse.test/'); d.wait_for_timeout(2500)
    d.click('#lgEmail'); d.fill('#lgEmEmail','a@x.com'); d.fill('#lgEmPass','passA1234'); d.click('#lgEmSubmit'); d.wait_for_timeout(3500)
    ok('Alice loaded',d.evaluate("currentUser.name")=='Alice' and d.evaluate("tasks.length")==1)
    # account switch WITHOUT logout (token swap) -> Alice's data must not reach Bob
    d.evaluate("firebase.auth().signInWithEmailAndPassword('b@x.com','passB1234')"); d.wait_for_timeout(5000)
    ok('Bob signed in as Bob',d.evaluate("currentUser.name")=='Bob')
    ok('Alice data not visible to Bob',d.evaluate("tasks.length")==0 and 'ALICE' not in (d.evaluate("localStorage.getItem('csec_tasks')") or ''))
    ok('no Alice data written under Bob',not any('ALICE' in json.dumps(v) for k,v in srv.docs.items() if k.startswith('userData/UB')))
    # rules not deployed -> clear status, app keeps working
    d.evaluate("window.__denyUserData=true; tasks.push({id:'b1',title:'bob'}); saveTasks()"); d.wait_for_timeout(3500)
    d.evaluate("setMode('settings')"); d.wait_for_timeout(300)
    print('  status:',d.inner_text('#acSync')[:110])
    ok('rules-missing status shown',('not available' in d.inner_text('#acSync')))
    ok('local data still saved',d.evaluate("tasks.length")==1)
    print('errors',e); b.close()
