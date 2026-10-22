# twscrape 数据完整性、分页与解析审查

审查日期：2026-10-23（Asia/Shanghai）。目标：判断能否用于 `/www/tweet-watcher` 的持续账号监控，不修改生产程序。

- HEAD：`63f61a518e576ea5c132f1156c03dda0520d76c1`，源码 `/tmp/twscrape-research-20261023`。
- 发布基线：`v0.20.1` = `5271cbdc5da1095b765a2a7ec750b4ac686d581f`，只读导出 `/tmp/twscrape-repro-v0201`。
- HEAD changelog 已写 v0.21.0，但当前项目版本文件与已核验公开发布仍为 0.20.1；不能把 HEAD 当已发布新版本。
- 下面的行号全部指 HEAD，除非另标 tag。来源可用固定链接 `https://github.com/vladkens/twscrape/blob/63f61a518e576ea5c132f1156c03dda0520d76c1/twscrape/<file>#L<line>` 复核。

## 结论

适合继续评估其维护活跃的传输层、GraphQL operation 更新和账号管理；**不能直接把 `user_tweets()` 或公开分页版 `user_tweets_raw()` 接入现有检查点逻辑后宣称不漏推**。

高层解析会丢弃无法解析的单条记录，部分关系展开会让外层推文一起丢失；高层分页会按去重数量截断整页、将连续重复页当作正常结束。更关键的是，`*_raw()` 也经过 `_gql_items()` 的页面筛选：它可能在把响应交给调用方之前就吞掉有内容的页面。它保留的是「被库接受的原始响应」，并非「每个网络响应都交给调用方」。

可行方案是保留我们的队列/完整页/覆盖判定设计，编写一个逐页适配器：在 `QueueClient` 的单请求层或受控调用 `_gql_item(OP_UserTweets, variables)` 后，先保存并检查整个响应，再由适配器决定游标、结束原因、覆盖状态。`_gql_item` 是私有接口，必须锁定版本/commit，不能不加兼容测试跟随 main。公开分页 raw 可以用于试验或严格拒绝所有歧义结果的临时接入，但不足以提供可信的终止凭证，尤其无法区分真正无推文与库已吞掉 pin-only 页。

## 离线证据

没有使用用户 X 凭据，没有连接 X，没有发送 Telegram，没有写生产数据。所有运行在 `unshare --net` 网络命名空间内；脚本还禁止 socket connect、关闭遥测。API 的 QueueClient 被替换成内存响应队列；使用完全合成的推文、ID、用户名。错误 dump 函数替换为内存错误分类，避免把响应写进公共 `/tmp/twscrape`。

- 复现脚本：`probes/pagination.py`
- 断言脚本：`probes/assert-pagination.py`
- HEAD 结果：`evidence/pagination-main.json`
- tag 结果：`evidence/pagination-v0.20.1.json`
- HEAD：28 个场景，28 个复现断言通过。
- v0.20.1：同样28个场景，28个对应版本断言通过。
- 这是56次「确认预期行为/问题」的断言，不是56个缺陷，也不是修复验证；没有实测线上请求成功率。

复现命令：

```sh
unshare --net /tmp/twscrape-research-venv-20261023/bin/python probes/pagination.py /tmp/twscrape-research-20261023 > evidence/pagination-main.json
unshare --net /tmp/twscrape-research-venv-20261023/bin/python probes/assert-pagination.py evidence/pagination-main.json head
unshare --net /tmp/twscrape-research-venv-20261023/bin/python probes/pagination.py /tmp/twscrape-repro-v0201 > evidence/pagination-v0.20.1.json
unshare --net /tmp/twscrape-research-venv-20261023/bin/python probes/assert-pagination.py evidence/pagination-v0.20.1.json tag
```

探针输出中的 `fetched` 表示从内存队列消费的预设响应/异常数量，不包含队列耗尽后的 `get` 调用，不应当作真实 HTTP 请求总数。pin-only、module-only 等单页场景确证响应没有交给调用方；若没有真实终止条件，后续终止来自假队列返回 None，不能据此声称该页自身导致自然结束。命令路径相对于本报告目录；另见 [复现说明](REPRODUCE.md)。

## 会影响持续监控的主要行为

| 行为 | 实证与影响 | 位置 / 版本 |
|---|---|---|
| 单条解析失败时继续后面的记录 | 合成页100、坏时间戳101、102，返回100和102，外层无异常。若据102等推进水位，101永久漏掉 | `models.py:1271-1313`；tag `models.py:833-863`同样存在 |
| 引用推文坏了会连带丢父推 | 162引用163，163的时间戳坏：162也没有返回。递归 `Tweet.parse` 没有隔离嵌套异常 | `models.py:494-499`、1309；两个版本均存在 |
| public raw 吞掉 pin-only 页 | 直接 `parse_tweets` 能读到 TimelinePinEntry.entry 中110；但同一页只有置顶+游标时，`user_tweets_raw`消费1个预设响应、yield0页；后续空队列返回None使探针结束 | `api.py:210-222`、252-269；`get_by_path`只找 entries，没把单独 entry 纳入页面有效性；两个版本相同 |
| raw 吞掉特定 module-only 页 | `module-conversation-*`下真实111，直接解析能读到；raw按`module-`前缀过滤后整页不yield。`profile-conversation-*`对照能正常yield | `api.py:210-222`；两个版本同样。构造场景用于证明机制，不声称已观察到线上此prefix承载推文 |
| raw 只检查递归找到的第一个 entries | 合成响应先一条空TimelineAddEntries、后另一条含140：直接解析读到140，raw返回0页 | `utils.py:70-84`、`api.py:212`；两个版本相同 |
| 重复游标时丢掉当前响应 | 第一页120，第二页121但Bottom游标相同：请求两页，只yield第一页，121不交给调用方，无异常 | `api.py:182-202`、256-258；tag `api.py:145-162,213-215`相同 |
| 连续3空页后正常结束 | A/B/C三个只有游标的页，后面是122：只请求前三页，返回0页，无“未完成”标志 | `api.py:261-269`；两个版本相同 |
| 游标A→B→A不识别循环 | `seen.clear()`只记上一页；合成A/B/A/终止页全部请求。无限变化的页面或循环可能持续抓取，需要外部页数/时长/游标集合上限 | `api.py:199-202`；两个版本相同 |
| HEAD按limit截断已经拿到的整页 | 两条完整记录100/101，`user_tweets(limit=1)`只返回100；`raw(limit=1)`把包含100/101的整页返回 | `api.py:110-137`、587-592。tag高层limit并未严格截断，返回两条 |
| HEAD三页无新解析ID后停下 | 151出现在连续四页（各有不同游标），第五页152：HEAD请求四页后正常结束，152丢；tag继续第五页 | `api.py:133-137`，HEAD新增 |
| HEAD同ID内容更新被屏蔽 | 同ID150的before/after分两页：HEAD仅返回before；tag两版均返回。真实编辑有新ID的情况不会被此ID去重直接吞掉，但必须处理编辑关联 | `api.py:117-125`，`models.py:1306-1308` |
| RT原文即使是独立entry也被过滤 | 页含170转发171，同时独立entry171：仅返回170。quoted tweet在HEAD有独立entry例外，retweeted tweet没有 | `utils.py:327-332`、`models.py:1290-1291`，两个版本同样 |
| 缺文字被默认为空，形态变化可被当作无数据 | 缺full_text且没有note时仍产出空正文105；Tweet若完全不带legacy键会直接消失且无dump | `utils.py:250`、311-316，两个版本同样。media-only合法空文要和结构缺失区别处理 |

这些终止策略多数是通用爬虫避免无限迭代的合理取舍，问题在于它们不能自动成为我们“已覆盖上次水位”的证据。对于持续增量发送，`return`与正常自然终止必须区分。

## 支持能力与保真边界

### 置顶、模块、visibility

`get_typed_object()`递归整份响应收集所有 `__typename`（utils.py:120-136），所以**只要响应被raw分页层交出来**，TimelinePinEntry.entry、常见profile-conversation模块中的Tweet能够被发现。`TweetWithVisibilityResults` 在 utils.py:314-316 也有显式处理；合成112成功解析。

但解析后的Tweet模型没有“本条来自置顶指令/模块/推荐内容”的上下文。User.pinnedIds只代表用户资料中的置顶ID，不等于本次entry的位置来源，更不是按时间排序的依据。递归搜集也不是对每条时间线指令逐一验证：未知/新结构可能无声忽略。水位判断必须看原始instruction、entryId、sortIndex及明确的条目类型，不能对解包后的ID简单取最大/最小就认为已覆盖。

### 引用、转发、回复

- retweetedTweet/quotedTweet 是递归Tweet对象；`RT_ID_PATH` / `QT_ID_PATH`兼容legacy id、result.rest_id、visibility result.tweet.rest_id（utils.py:292-303）。
- HEAD修复引用内容误作为独立时间线结果：只有嵌套引用161时返回160；同页确有独立entry161时保留160/161。tag在仅嵌套场景也输出160/161。这是对我们监控有价值的实际改进。
- 转发原始内容仍被统一排除为顶层对象，缺少“同时存在独立entry”的例外；按账号时间线通常不常见，但按列表/混合流就要注意。
- `inReplyToTweetIdStr`、`inReplyToScreenName`、`conversationIdStr`等字段保留（models.py:502-515）。`tweet_replies`只筛直接回复，`tweet_thread`按conversationId筛整线程（api.py:414-419、478-484），两者语义不同。
- user_tweets和user_tweets_and_replies是不同GraphQL操作；采集某账号的回复必须明确选后者或另定策略，不能从方法名泛化为“所有活动”。

### 作者缺失

HEAD在拿不到完整作者资料但有user_id_str时保留推文，生成placeholder user，username可能为空，created设1970，统计置0（models.py:1116-1154）。合成106在HEAD返回，在tag因为KeyError被跳过。新版还支持从转发“RT @...”/user_mentions或引用permalink推断引用作者名。

这是避免漏推的改进，但placeholder是未知信息，不得用0覆盖数据库中已知统计，或用空username误判成别的作者。自己的监控账号可用已确认的ID→用户名映射补全；引用对象可以只保留ID与“资料不全”标志，不能伪造完整资料。

### 长文、文章、编辑

- note_tweet正文优先于full_text，合成长文成功读到；但是 hashtags/cashtags/mentionedUsers取legacy entities，note实体的对应信息未合并。合成note里有#note但解析hashtags为空。链接则合并legacy与note URLs，未见统一去重（models.py:479、487-492、1222-1230）。
- HEAD新增Article模型，详情接口带 `ARTICLE_FIELD_TOGGLES` 请求rich content；UserTweets方法自身没有同样明确请求完整article内容（api.py:54-62、370-385、572-585）。时间线预览不应声称已得到整篇文章。
- Article解析错误会warning并返回None，保住父推但丢文章部分（models.py:377-400），因此要单独标“文章未取得/不完整”。
- editControl保留原始编辑ID链并把edit_control_initial摊平（models.py:1210-1219）。库不提供业务级“编辑更新原消息”语义；需我们按编辑ID链关联版本。HEAD最近页去重仅看Tweet.id，不看正文hash。

### ID与JSON

Python int能精确表示X大ID，但 `.json()` 使用JSON number（models.py:33-38），Node默认JSON.parse会损失大整数精度。传输协议应明确使用id_str/conversationIdStr/inReplyToTweetIdStr，引用/作者/编辑链ID全部保持十进制字符串；不要先从JS number再转回字符串。

## 异常、分页与队列交接

- HEAD将多种原来返回None的请求错误改为显式异常，比tag更适合监控；但这不等于所有部分数据都已严格验证。
- `QueueClient.has_data`仅检查HTTP200且data至少一个顶层值非None/{}/[]（queue_client.py:135-143）；errors与非空data并存时某些错误按warning返回（338-341）。因此适配器应显式检查GraphQL errors及其path，默认不能据部分页推进水位。此处是代码审查结论，不计入上述28场景，因为脚本用假的QueueClient隔离分页行为。
- 第N页异常会在已yield前面页面之后抛出。合成第一页200成功、第二页RuntimeError，得到一页后再收到异常。调用方要区分“此前页面已持久化”和“整次覆盖完成”；不要把已收的前页当作已到达旧水位，也不要在异常后丢失已取得的新记录。
- raw的limit按`_gql_entries`数量计数；一个模块中几条Tweet被计为一个entry、置顶独立entry可能完全不计入。high-level HEAD按实际唯一解析记录计数。两者不是同一页大小/记录上限。
- 解析错误dump写入`/tmp/twscrape/...`，包含失败对象与整页规范化数据，普通open未指定0600（models.py:1250-1265）。生产适配应避免直接使用这条dump路径，或者将诊断写入专用0700目录+0600文件并去除敏感正文；不要把private/受限可见内容当作普通公开日志。

## 对照tag的关键变化

- api.py增加 `_parsed_pages`：跨页重复过滤、严格parsed limit、连续三页无新ID退出；tag逐页parse，没有这些逻辑。
- models.py补齐作者placeholder、引用作者推断、文章/卡片、parse_user错误显式抛出；但parse_tweets单条失败continue保留。
- utils.py收集entryId以识别独立引用entry；转发排除策略没有同样例外。
- raw分页核心 `_is_end/_is_stalled/_get_cursor/_gql_entries` 语义没有变化，HEAD上述raw风险同样存在于tag。
- 28个合成场景中6个结果条目在HEAD/tag之间不同：缺作者、parsed limit、同ID更新、连续重复页、纯嵌套引用、坏引用的错误计数。其余22个行为一致。

## 适配建议与验收条件

1. 单请求原始响应接口：获取每个响应完整字节/JSON后才决策，携带请求游标、返回游标、账号ID、抓取时间、HTTP/GraphQL状态；不要依赖库内部return推断终止原因。
2. 严格枚举时间线指令：涵盖PinEntry、AddEntries、模块、visibility、不可用/删除提示；未知内容条目导致“不完整”，不推进检查点。
3. 补齐既有Node解析器的合法缺资料场景。根代理已经离线验证：当前raw_user_tweets成功21条、raw_user_tweets_and_replies成功26条；作者缺资料fixture被现有严格parser拒绝，另一bot reply fixture缺边界也被拒绝。现有严格策略可复用，但不能宣称完全不改就兼容；详见 `evidence/current-adapter-compatibility.json`。
4. 每页完整保存后才更新读取游标；明确区分terminal/reachedSince/pageLimit/stalled/partial/errors。置顶/模块上下文记录不能独自证明时间覆盖。
5. 使用字符串ID；保留转发/引用/回复/编辑关系和原始证据，正文更新有单独检测。
6. 延续持久发送队列。只有在整页验收和覆盖判断通过的事务边界更新监控水位；Telegram发送确认与抓取游标分离。遇坏页仍保留已抓新内容和旧水位。
7. 固定已审查commit，依赖锁定、离线回归、禁遥测，设置单次请求/全部分页超时和数量上限。进入生产前仍需经授权的只读在线对照，核验四账号最新页、旧水位覆盖、长期限流恢复；GitHub活跃与离线通过不等于这些结果。
