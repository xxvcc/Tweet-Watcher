import json
import sys
out=json.load(open(sys.argv[1]));head=sys.argv[2]=='head'
def ids(k):return out[k].get('ids')
checks={
'control_valid_page': ids('control_valid_page')==['100','101'],
'one_bad_tweet_skipped': ids('one_bad_tweet_skipped')==['100','102'] and len(out['one_bad_tweet_skipped']['dumps'])==1,
'tweet_without_legacy_key_silently_ignored': out['tweet_without_legacy_key_silently_ignored']=={'ids':[],'dumps':[]},
'missing_text_accepted': out['missing_text_accepted']['texts']==[''],
'author_profile_absent': ids('author_profile_absent')==(['106'] if head else []),
'pin_only_direct_parse':ids('pin_only_direct_parse')==['110'],
'pin_only_raw':out['pin_only_raw']['yielded_pages']==0 and out['pin_only_raw']['raised'] is None,
'module_prefix_only_direct_parse':ids('module_prefix_only_direct_parse')==['111'],
'module_prefix_only_raw':out['module_prefix_only_raw']['yielded_pages']==0,
'profile_module_raw':out['profile_module_raw']['parsed_ids_per_page']==[['111']],
'visibility_wrapper':ids('visibility_wrapper')==['112'],
'repeat_cursor_new_content_lost':out['repeat_cursor_new_content_lost']=={'fetched':2,'yielded_pages':1,'parsed_ids_per_page':[['120']],'raised':None},
 'three_empty_pages_drop_future_content':out['three_empty_pages_drop_future_content']['fetched']==3 and out['three_empty_pages_drop_future_content']['yielded_pages']==0,
'cursor_cycle_A_B_A_unchecked':out['cursor_cycle_A_B_A_unchecked']['yielded_pages']==4,
'later_instruction_direct_parse':ids('later_instruction_direct_parse')==['140'],
'later_instruction_raw':out['later_instruction_raw']['yielded_pages']==0,
'raw_limit_one_whole_page':out['raw_limit_one_whole_page']['parsed_ids_per_page']==[['100','101']],
'parsed_limit_one_splits_page':ids('parsed_limit_one_splits_page')==(['100'] if head else ['100','101']),
'same_id_edit_with_changed_content':out['same_id_edit_with_changed_content']['texts']==(['before'] if head else ['before','after']),
 'three_duplicate_parsed_pages_end_early':ids('three_duplicate_parsed_pages_end_early')==(['151'] if head else ['151','151','151','151','152']),
'quote_embedded_only':ids('quote_embedded_only')==(['160']if head else ['160','161']),
'quote_also_standalone':ids('quote_also_standalone')==['160','161'],
'malformed_quote_drops_parent':ids('malformed_quote_drops_parent')==[] and len(out['malformed_quote_drops_parent']['dumps'])==(1 if head else 2),
'retweet_embedded_only':ids('retweet_embedded_only')==['170'],
'retweet_original_also_standalone_dropped':ids('retweet_original_also_standalone_dropped')==['170'],
'long_note_and_hashtags':out['long_note_and_hashtags']['texts']==['long note #note'] and out['long_note_and_hashtags']['hashtags']==[[]],
'edit_metadata':out['edit_metadata']['editControl']==[{'edit_tweet_ids':['189','190'],'initial_tweet_id':'189'}],
'exception_after_first_page':out['exception_after_first_page']['yielded_pages']==1 and out['exception_after_first_page']['raised']=='RuntimeError',
}
if set(out)!=set(checks):raise AssertionError('Scenario accounting mismatch')
for name,passed in checks.items():
 if not passed:raise AssertionError(name)
print(json.dumps({'version':sys.argv[2],'scenarios':len(out),'assertions':len(checks),'passed':sum(checks.values())}))
