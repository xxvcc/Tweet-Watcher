import asyncio
import json
import os
import shutil
import ssl
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

os.environ['TWS_TELEMETRY']='0'
os.environ['DO_NOT_TRACK']='1'
os.environ['TWS_HTTP_BACKEND']='curl'
for key in list(os.environ):
    if key.lower() in {'http_proxy','https_proxy','all_proxy','tws_proxy'}:
        del os.environ[key]
os.environ['NO_PROXY']='*'
from twscrape.account import Account
from twscrape.logger import logger
import curl_cffi
logger.remove()

FAKE_AUTH='offline-only-auth-sentinel'
FAKE_CSRF='offline-only-csrf-sentinel'

async def probe_scheme(scheme, certfile, keyfile):
    observed=[]
    redirect={'url':None}
    class Handler(BaseHTTPRequestHandler):
        protocol_version='HTTP/1.1'
        def log_message(self,*args):
            pass
        def do_GET(self):
            observed.append({'host':self.headers.get('Host','').split(':')[0], 'path':self.path,
                'auth_cookie':FAKE_AUTH in self.headers.get('Cookie',''),
                'csrf_header':FAKE_CSRF in self.headers.get('x-csrf-token','')})
            if self.path=='/start':
                self.send_response(302)
                self.send_header('Location',redirect['url'])
            else:
                self.send_response(200)
                self.send_header('Content-Type','application/json')
            self.send_header('Content-Length','0')
            self.end_headers()
    class QuietServer(ThreadingHTTPServer):
        def handle_error(self,*args):
            pass
    servers=[]
    threads=[]
    for host in ['127.0.0.1','127.0.0.2']:
        srv=QuietServer((host,0),Handler)
        if scheme=='https':
            ctx=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            ctx.load_cert_chain(certfile,keyfile)
            ctx.set_alpn_protocols(['http/1.1'])
            srv.socket=ctx.wrap_socket(srv.socket,server_side=True)
        servers.append(srv)
        th=threading.Thread(target=srv.serve_forever,daemon=True)
        th.start()
        threads.append(th)
    first=f'{scheme}://127.0.0.1:{servers[0].server_port}'
    second=f'{scheme}://127.0.0.2:{servers[1].server_port}'
    redirect['url']=second+'/target'
    acc=Account(username='offline_probe', password='_', email='_', email_password='_', user_agent='@chrome',active=True,cookies={'auth_token':FAKE_AUTH,'ct0':FAKE_CSRF})
    clients=[]
    try:
        cl=acc.make_client()
        clients.append(cl)
        if scheme=='https':
            cl._session.verify=certfile
        jar=[{'name':c.name,'domain_empty':c.domain=='','secure':bool(c.secure)} for c in cl.cookies.jar]
        await cl.get(first+'/start',timeout=5)
        first_request=observed[-2]
        redirected=observed[-1]
        await cl.get(second+'/direct-reused',timeout=5)
        reused_direct=observed[-1]
        fresh=acc.make_client()
        clients.append(fresh)
        tls_rejects_without_trust=None
        if scheme=='https':
            try:
                await fresh.get(second+'/untrusted-control',timeout=5)
                tls_rejects_without_trust=False
            except Exception as error:
                tls_rejects_without_trust='certificate' in str(error).lower()
            fresh._session.verify=certfile
        await fresh.get(second+'/direct-fresh',timeout=5)
        fresh_direct=observed[-1]
        return {'requests_observed':len(observed),'initial_host_received_cookie':first_request['auth_cookie'],'initial_host_received_csrf':first_request['csrf_header'],'cross_host_redirect_received_cookie':redirected['auth_cookie'],'cross_host_redirect_received_csrf':redirected['csrf_header'],'reused_client_direct_other_host_received_cookie':reused_direct['auth_cookie'],'reused_client_direct_other_host_received_csrf':reused_direct['csrf_header'],'fresh_client_direct_arbitrary_host_received_cookie':fresh_direct['auth_cookie'],'fresh_client_direct_arbitrary_host_received_csrf':fresh_direct['csrf_header'],'cookie_jar':jar,'tls_certificate_verified':scheme=='https','tls_rejects_test_cert_without_explicit_trust':tls_rejects_without_trust,'different_loopback_hosts':first_request['host']!=redirected['host']}
    finally:
        for cl in clients:
            await cl.aclose()
        for srv in servers:
            srv.shutdown()
            srv.server_close()
        for th in threads:
            th.join(timeout=2)

async def main():
    root=Path(tempfile.mkdtemp(prefix='twscrape-curl-security-'))
    try:
        cert=root/'cert.pem'
        key=root/'key.pem'
        subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(key),'-out',str(cert),'-days','1','-subj','/CN=offline-twscrape-test','-addext','subjectAltName=IP:127.0.0.1,IP:127.0.0.2','-addext','basicConstraints=critical,CA:TRUE'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        result={'curl_cffi_version':curl_cffi.__version__,'network_scope':'unshare --net; loopback only; no external route; no proxy','http':await probe_scheme('http',str(cert),str(key)),'https':await probe_scheme('https',str(cert),str(key))}
        print(json.dumps(result,indent=2))
    finally:
        shutil.rmtree(root)
asyncio.run(main())
