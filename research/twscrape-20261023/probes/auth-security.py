import asyncio, json, os, shutil, stat, tempfile
from pathlib import Path
os.environ['TWS_TELEMETRY']='0'
os.environ['DO_NOT_TRACK']='1'
os.environ['TWS_HTTP_BACKEND']='httpx'
from unittest.mock import patch
import httpx
from twscrape.accounts_pool import AccountsPool
from twscrape.http import Response
from twscrape import queue_client, telemetry, models
from twscrape.imap import _wait_email_code
from twscrape.logger import logger
logger.remove()

async def main():
    out={}
    root=Path(tempfile.mkdtemp(prefix='twscrape-auth-security-'))
    old_umask=os.umask(0o022)
    try:
        pool=AccountsPool(str(root/'accounts.db'),raise_when_no_account=True,wait_timeout=0)
        await pool.add_account_cookies('offline_probe','auth_token=FAKE_AUTH_SENTINEL; ct0=FAKE_CSRF_SENTINEL')
        acc=await pool.get('offline_probe')
        out['sqlite']={'mode':oct(stat.S_IMODE((root/'accounts.db').stat().st_mode)), 'cleartext_auth_present':b'FAKE_AUTH_SENTINEL' in (root/'accounts.db').read_bytes(), 'cookie_only_has_password_placeholder':acc.password=='_' and acc.email_password=='_'}
        cl=acc.make_client()
        out['cookie_jar']=[{'name':c.name,'domain':c.domain,'secure':c.secure} for c in cl._client.cookies.jar]
        requests=[]
        def handler(req):
            requests.append(req)
            if len(requests)==1:
                return httpx.Response(302, headers={'location':'https://outside.example/probe'})
            return httpx.Response(200,json={'ok':True})
        await cl._client._transport.aclose()
        cl._client._transport=httpx.MockTransport(handler)
        cl._client._mounts={}
        await cl.get('https://x.com/i/api/graphql/probe')
        target=requests[-1]
        out['simulated_cross_origin_redirect']={'requests':len(requests),'target_host':target.url.host,'auth_cookie_forwarded':'FAKE_AUTH_SENTINEL' in target.headers.get('cookie',''),'csrf_header_forwarded':'FAKE_CSRF_SENTINEL' in target.headers.get('x-csrf-token','')}
        await cl.aclose()
        dump_root=Path('/tmp')/('twscrape-'+root.name)
        rep=Response(httpx.Response(200,headers={'set-cookie':'auth_token=FAKE_NEW_SESSION; Path=/'},json={'data':'FAKE_PRIVATE_RESPONSE'},request=httpx.Request('GET','https://x.com/i/api/graphql/probe')))
        setattr(rep,'__username','offline_probe')
        with patch.object(queue_client,'TMP_TS',root.name):
            queue_client.dump_rep(rep)
        dump=next(dump_root.iterdir())
        out['debug_dump']={'directory_mode':oct(stat.S_IMODE(dump_root.stat().st_mode)),'file_mode':oct(stat.S_IMODE(dump.stat().st_mode)),'set_cookie_preserved':'FAKE_NEW_SESSION' in dump.read_text(),'response_preserved':'FAKE_PRIVATE_RESPONSE' in dump.read_text()}
        shutil.rmtree(dump_root)
        invalid=root/'invalid_accounts.txt'
        invalid.write_text('offline_probe:FAKE_PASSWORD_SENTINEL:email@example.test\n')
        try:
            await pool.load_from_file(str(invalid),'username:password:email:email_password')
        except ValueError as e:
            out['invalid_accounts_exception']={'password_in_exception':'FAKE_PASSWORD_SENTINEL' in str(e)}
        logs=[]
        sink=logger.add(lambda msg: logs.append(str(msg)),format='{message}')
        class FakeImap:
            def fetch(self,*args):
                return 'OK',[(b'1',b'Date: Fri, 23 Oct 2026 00:00:00 +0000\r\nFrom: info@x.com\r\nSubject: Your Twitter confirmation code is FAKE_OTP_SENTINEL\r\n\r\n')]
        code=_wait_email_code(FakeImap(),1,None)
        logger.remove(sink)
        out['imap_info_log']={'code_returned':bool(code),'otp_in_log':any('fake_otp_sentinel' in x for x in logs)}
        telemetry.reset()
        with patch.dict(os.environ,{'TWS_TELEMETRY':'1','DO_NOT_TRACK':'0'}), patch.object(telemetry,'_distinct_id',lambda:'synthetic-machine'):
            telemetry.capture('gql_request',{'operation':'UserTweets','http_method':'GET','http_backend':'httpx','source':'lib','$current_url':'lib://twscrape/gql/UserTweets'})
            events=telemetry.snapshot()
            out['telemetry']={'event':events[0]['event'],'property_keys':sorted(events[0]['properties']),'destination':telemetry.POSTHOG_BATCH_URL}
        telemetry.reset()
    finally:
        os.umask(old_umask)
        shutil.rmtree(root)
    print(json.dumps(out,indent=2))
asyncio.run(main())
