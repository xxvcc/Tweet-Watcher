"""Offline synthetic proof cases against unmodified twscrape; no credentials/network."""
import os, sys, socket, json, asyncio, copy, tempfile
os.environ['TWS_TELEMETRY']='0'
os.environ['TWS_LOG_LEVEL']='CRITICAL'
sys.dont_write_bytecode=True
sys.path.insert(0, sys.argv[1])
def deny(*args, **kwargs):
    raise AssertionError('NETWORK FORBIDDEN by offline harness')
socket.create_connection=deny
socket.socket.connect=deny
socket.socket.connect_ex=deny
import twscrape.api as api_mod
import twscrape.models as models
from twscrape.logger import set_log_level
set_log_level('CRITICAL')
DUMPS=[]
models._write_dump=lambda kind,e,x,obj:DUMPS.append({'kind':kind,'type':type(e).__name__,'id':x.get('id_str')})

class Rep:
    def __init__(self,obj): self.obj=obj
    def json(self): return self.obj
class Queue:
    pages=[]; fetched=0
    def __init__(self,*args,**kwargs): pass
    async def __aenter__(self):return self
    async def __aexit__(self,*args):pass
    async def get(self,*args,**kwargs):
        if not self.pages:return None
        Queue.fetched+=1
        p=self.pages.pop(0)
        if isinstance(p,Exception):raise p
        return Rep(copy.deepcopy(p))
api_mod.QueueClient=Queue
api=object.__new__(api_mod.API)
api.pool=None;api.debug=False;api.proxy=None

def tweet(i, **kw):
    result={'__typename':'Tweet','rest_id':str(i),'legacy':None,
        'user_id_str':'42','created_at':'Wed Oct 21 10:00:00 +0000 2026',
        'full_text':'synthetic tweet '+str(i),'core':{'user_results':{'result':{
          '__typename':'User','rest_id':'42','legacy':None,
          'core':{'screen_name':'synthetic','name':'Synthetic',
                  'created_at':'Wed Oct 21 10:00:00 +0000 2020'}}}}}
    result.update(kw);return result

def entry(t, prefix='tweet-'):
    return {'entryId':prefix+str(t['rest_id']),'content':{'itemContent':{
      'itemType':'TimelineTweet','tweet_results':{'result':t}}}}

def cursor(c):
    return {'entryId':'cursor-bottom-'+c,'content':{'cursorType':'Bottom','value':c}}

def page(tweets=(),cur=None, entries=None,instructions=None):
    es=entries if entries is not None else [entry(t)for t in tweets]
    if cur is not None:es=[*es,cursor(cur)]
    ins=instructions if instructions is not None else [{'type':'TimelineAddEntries','entries':es}]
    return {'data':{'user':{'result':{'timeline_v2':{'timeline':{'instructions':ins}}}}}}

def parse(p):
    before=len(DUMPS)
    try:
        got=list(models.parse_tweets(copy.deepcopy(p)))
        return {'ids':[x.id_str for x in got], 'dumps':DUMPS[before:]},got
    except Exception as e:return {'raised':type(e).__name__,'dumps':DUMPS[before:]},[]

async def raw(pages,limit=-1):
    Queue.pages=copy.deepcopy(pages);Queue.fetched=0
    got=[];err=None
    try:
      async for rep in api.user_tweets_raw(42,limit=limit):got.append(rep.json())
    except Exception as e:err=type(e).__name__
    return {'fetched':Queue.fetched,'yielded_pages':len(got),'parsed_ids_per_page':[parse(p)[0].get('ids')for p in got],'raised':err}
async def high(pages,limit=-1):
    Queue.pages=copy.deepcopy(pages);Queue.fetched=0
    got=[];err=None
    try:
      async for item in api.user_tweets(42,limit=limit):got.append(item)
    except Exception as e:err=type(e).__name__
    return {'fetched':Queue.fetched,'ids':[x.id_str for x in got],'texts':[x.rawContent for x in got],'raised':err}

async def main():
  out={}
  valid=page([tweet(100),tweet(101)])
  out['control_valid_page']=parse(valid)[0]
  out['one_bad_tweet_skipped']=parse(page([tweet(100),tweet(101,created_at='bad-date'),tweet(102)]))[0]
  nolegacy=tweet(104);nolegacy.pop('legacy')
  out['tweet_without_legacy_key_silently_ignored']=parse(page([nolegacy]))[0]
  missing=tweet(105);missing.pop('full_text')
  pr,got=parse(page([missing]));out['missing_text_accepted']={**pr,'texts':[x.rawContent for x in got]}
  nop=tweet(106);nop.pop('core')
  pr,got=parse(page([nop]));out['author_profile_absent']={**pr,'author_names':[x.user.username for x in got]}
  pin=page(instructions=[{'type':'TimelinePinEntry','entry':entry(tweet(110))},{'type':'TimelineAddEntries','entries':[cursor('P')]}])
  out['pin_only_direct_parse']=parse(pin)[0]
  out['pin_only_raw']=await raw([pin])
  module={'entryId':'module-conversation-1','content':{'items':[{'entryId':'module-conversation-1-tweet-111','item':entry(tweet(111))['content']}]}}
  out['module_prefix_only_direct_parse']=parse(page(entries=[module]))[0]
  out['module_prefix_only_raw']=await raw([page(entries=[module])])
  module2=copy.deepcopy(module);module2['entryId']='profile-conversation-1'
  out['profile_module_raw']=await raw([page(entries=[module2])])
  vis={'__typename':'TweetWithVisibilityResults','tweet':tweet(112)}
  out['visibility_wrapper']=parse(page(entries=[{'entryId':'tweet-112','content':{'itemContent':{'tweet_results':{'result':vis}}}}]))[0]
  out['repeat_cursor_new_content_lost']=await raw([page([tweet(120)],'C'),page([tweet(121)],'C')])
  out['three_empty_pages_drop_future_content']=await raw([page(cur=x)for x in ['A','B','C']]+[page([tweet(122)])])
  out['cursor_cycle_A_B_A_unchecked']=await raw([page([tweet(130)],'A'),page([tweet(131)],'B'),page([tweet(132)],'A'),page([tweet(133)])])
  multi=page(instructions=[{'type':'TimelineAddEntries','entries':[]},{'type':'TimelineAddEntries','entries':[entry(tweet(140))]}])
  out['later_instruction_direct_parse']=parse(multi)[0]
  out['later_instruction_raw']=await raw([multi])
  out['raw_limit_one_whole_page']=await raw([valid],limit=1)
  out['parsed_limit_one_splits_page']=await high([valid],limit=1)
  out['same_id_edit_with_changed_content']=await high([page([tweet(150,full_text='before')],'E1'),page([tweet(150,full_text='after')])])
  out['three_duplicate_parsed_pages_end_early']=await high([page([tweet(151)],'D1'),page([tweet(151)],'D2'),page([tweet(151)],'D3'),page([tweet(151)],'D4'),page([tweet(152)])])
  quote=tweet(160,is_quote_status=True,quoted_status_id_str='161',quoted_status_result={'result':tweet(161)})
  out['quote_embedded_only']=parse(page([quote]))[0]
  out['quote_also_standalone']=parse(page([quote,tweet(161)]))[0]
  brokenquote=tweet(162,is_quote_status=True,quoted_status_id_str='163',quoted_status_result={'result':tweet(163,created_at='bad-date')})
  out['malformed_quote_drops_parent']=parse(page([brokenquote]))[0]
  rt=tweet(170,retweeted_status_id_str='171',retweeted_status_result={'result':tweet(171)})
  out['retweet_embedded_only']=parse(page([rt]))[0]
  out['retweet_original_also_standalone_dropped']=parse(page([rt,tweet(171)]))[0]
  note=tweet(180,note_tweet={'note_tweet_results':{'result':{'text':'long note #note','entity_set':{'hashtags':[{'text':'note'}],'urls':[]}}}})
  pr,got=parse(page([note]));out['long_note_and_hashtags']={**pr,'texts':[x.rawContent for x in got],'hashtags':[x.hashtags for x in got]}
  ed=tweet(190,edit_control={'edit_control_initial':{'edit_tweet_ids':['189','190']},'initial_tweet_id':'189'})
  pr,got=parse(page([ed]));out['edit_metadata']={**pr,'editControl':[x.editControl for x in got]}
  out['exception_after_first_page']=await raw([page([tweet(200)],'next'),RuntimeError('synthetic failure')])
  print(json.dumps(out,ensure_ascii=False,indent=2))

asyncio.run(main())
