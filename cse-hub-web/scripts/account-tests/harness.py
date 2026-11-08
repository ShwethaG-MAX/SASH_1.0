import json,re,sys,threading
from playwright.sync_api import sync_playwright
HTML=open('public/index.html',encoding='utf-8').read()
FAKE=open('/home/claude/t/fakefb.js').read()
class Srv:
    def __init__(s): s.docs={}; s.accts={}; s.g={}; s.ver={}
    def call(s,op,a):
        if op=='get': return s.docs.get(a['path'])
        if op=='set':
            d=s.docs.get(a['path']) if a.get('merge') else None
            n=dict(d or {}); n.update(a['data']); s.docs[a['path']]=n; s.ver[a['path']]=s.ver.get(a['path'],0)+1; return None
        if op=='list':
            pre=a['path']+'/'; return [{'path':k,'data':v} for k,v in s.docs.items() if k.startswith(pre) and '/' not in k[len(pre):]]
        if op=='ver': return s.ver.get(a['path'],0)
        if op=='txcommit':
            for pth,v in a['reads'].items():
                if s.ver.get(pth,0)!=v: return False
            for w in a['writes']: s.call('set',w)
            return True
        if op=='acct': return s.accts.get(a['email'])
        if op=='addacct': s.accts[a['email']]={'pw':a['pw'],'uid':a['uid']}; return None
        if op=='gacct': return s.g.get(a['gid'])
        if op=='addg': s.g[a['gid']]=a['uid']; return None
def newctx(browser,srv,url='https://cse.test/'):
    ctx=browser.new_context(viewport={'width':1280,'height':900})
    def route(r):
        u=r.request.url
        if u.startswith('https://cse.test/'): r.fulfill(body=HTML,content_type='text/html')
        elif 'gstatic.com/firebasejs' in u: r.fulfill(body=FAKE if 'firebase-app-compat' in u else '/*noop*/',content_type='application/javascript')
        else: r.abort()
    ctx.route('**/*',route)
    pg=ctx.new_page(); errs=[]
    pg.on('pageerror',lambda e: errs.append(str(e)))
    pg.expose_function('__srv',lambda op,a: srv.call(op,a))
    return ctx,pg,errs
