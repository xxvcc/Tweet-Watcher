# twscrape 认证、账号池与安全审查

审查日期：2026-10-23（Asia/Shanghai）。源码：`/tmp/twscrape-research-20261023`，提交 `63f61a518e576ea5c132f1156c03dda0520d76c1`。本报告只覆盖该提交，不能把结论直接视为 PyPI 0.20.1 发布包的行为。未接触生产 Cookie、密码、数据库，未调用 X，也未改变生产文件。

## 结论

适合作为候选传输层，但不建议把 CLI 的默认行为直接接到生产监控。必须补齐凭据作用域、文件权限、失败终止与完整页契约，并明确关闭遥测。优先 Cookie 导入，保留当前 Node 侧持久队列与严格页面解析；无需引入 X 密码、邮箱密码、TOTP 种子。

## 认证机制：实际代码

- `AccountsPool.add_account_cookies` 只要求 `auth_token` 和 `ct0` 非空，即将账号标为 active。用户名只是本地标签，不校验标签与 Cookie 所属 X 账号是否一致；active/logged_in 不证明 Cookie 仍有效。来源：`accounts_pool.py:127-142`、`account.py:18-19,40-46`。
- Cookie 导入支持 Cookie header、JSON、浏览器扩展列表、base64；列表转映射时丢弃 domain/path/secure 等属性。来源：`utils.py:393-422`。
- CLI 可通过隐藏输入或 stdin 导入 Cookie，无需将其写进命令参数。来源：`cli.py:88-97,198-200`。若把 Cookie 当位置参数传入，仍会出现在命令历史/进程参数，接入应禁止这条用法。
- Cookie 模式把密码、邮箱、邮箱密码置为 `_`；更新已有账号时保留原密码、代理、统计和锁。因此从历史密码账号改用 Cookie，并不自动清除旧敏感字段。来源：`accounts_pool.py:132-141`。
- 密码模式走 X 网页 onboarding endpoint，而非官方开发者 OAuth；包括用户名、密码、TOTP、邮箱确认等步骤。`mfa_code` 实际是供 `pyotp.TOTP` 使用的长期种子。来源：`login.py:14,107-139,159-199,251-279`。
- 密码自动登录可连 IMAP 取确认码；无需该功能时，不应保存邮箱密码或启用它。不能保证未知新 challenge/验证码自动通过；代码只识别列出的 subtasks，未知任务没有完整处理。来源：`login.py:213-248`。

## 确认问题 / 接入前必须控制的行为

### 1. 主客户端 Cookie 未限定域名和 HTTPS；HTTPX 跨域跳转可带出认证 Cookie（条件性高影响）

`account.py:73-85` 将整个 cookies dict 传给 HTTP client。`http.py:162-168` 开启 `follow_redirects=True` 并直接使用该 dict。离线 HTTPX 实证：Cookie 的 domain 为空、secure=False；模拟 `https://x.com/...` 返回 302 到 `https://outside.example/...`，第二个请求仍带 auth_token 和 x-csrf-token。

这不等于已发现真实数据泄漏：正常 API URL 固定指向 X，实际利用还需要接口返回跨域跳转、调用方误用客户端，或其他能影响跳转目的地的条件。风险边界仍应在采集器内收紧。

建议：Cookie 显式绑定 `.x.com`、Secure；仅允许 HTTPS 且受信任 host 的请求/重定向，跨站跳转失败退出；敏感 header 同样限定作用域。curl 后端已补充真实 loopback 验证：其重定向不带 auth_token，但会带 CSRF header；直接向新 host 请求仍带两者，详见文末。`xclid.py:26-30` 的独立签名页面客户端已经做了 `.x.com` Cookie 域绑定，但还没设 Secure，不能代替修复主客户端。

### 2. SQLite 明文保存凭据，默认权限由外部 umask 决定

表含 password、email_password、cookies、headers、proxy 和 mfa_code：`db.py:70-95`；序列化无加密：`account.py:59-66`；创建/打开没有 chmod/umask：`db.py:124-139`。

离线实证：umask 022 下新 `accounts.db` 为 0644，二进制文件中可找到合成 Cookie 明文。Cookie 必须可恢复使用，不能用密码哈希替代；可通过专用用户、0700 数据目录、UMask=0077、0600 DB/备份和限制可读目录规避跨用户暴露。直接落在默认工作目录且目录可遍历则不合适。

### 3. debug dump 会把响应 Set-Cookie 写到共享临时目录

`queue_client.py:179-203,267-268` 将完整响应头、请求 URL、响应正文写 `/tmp/twscrape-{分钟}/...`，未过滤 Set-Cookie、未设权限、没有保留数量/大小限制。请求头行被注释，不能据此认为没有凭据落盘：响应 Set-Cookie 同样可能含凭据。

离线实证：umask 022 时目录 0755、文件 0644，合成 Set-Cookie 和正文均原样保留。生产禁止 debug；若确需诊断，使用私有临时目录、脱敏和容量限制。文件名包含本地 account label，接入也应固定/校验标签，避免把任意字符串送进路径。

### 4. 高层解析失败默认也会 dump 数据，与 debug 无关

`models.py:1250-1265` 在解析失败时，将错误对象和整份扁平化响应写 `/tmp/twscrape`，有随机文件名但没有文件权限、大小、数量、保留期控制。正文可能含受登录可见性限制的数据；持续模式变更会放大磁盘占用。严格 raw parser 可绕过此路径，不能仅靠 `debug=False` 防住。

### 5. 密码/邮箱登录路线有确定的日志泄漏

- 账号文件字段不完整时，`accounts_pool.py:80` 将原始整行写入 ValueError；离线探针证实合成密码进入异常字符串。
- `imap.py:65-72` 在 INFO 级别打印邮件 Subject，再从同一个 Subject 提取确认码；离线探针证实确认码进入日志。
- `accounts_pool.py:194` 在 HTTP 登录失败时日志完整响应正文；`login.py:220` 的 assertion 也嵌入完整响应文本，远端可能返回敏感登录流程数据。

只使用 Cookie 导入可避开这些登录路径；若未来启用密码登录，需要统一脱敏异常/日志，禁止保存邮箱凭据到普通数据文件。

## 遥测：不能只写“匿名统计”

`telemetry.py:31-45,61-75,93-120` 与 `queue_client.py:385-396`：默认启用采集，事件为 `gql_request`，字段包括 operation、HTTP method/backend、lib/cli、合成 `$current_url`（非真实查询 URL）、应用版本、平台、Python 主次版本、会话 UUID、`machineid.hashed_id('twscrape')[:16]` 派生的持久设备标识。flush 时另加 timestamp/count。目的地：`https://app.posthog.com/batch/`。

在该内置调用处没有发现上传账号名、Cookie、代理、查询文本、实际请求 URL 或响应正文。机器派生标识意味着可跨会话关联，不能描述成无标识统计；接收端通常还会看到网络源 IP，服务端如何处理 IP 未在本地代码中证明。

准确区分：QueueClient 采集到内存；CLI `_run` 在 finally 调用 flush（`cli.py:144-148`）。当前 API 库调用本身没有发现自动 flush，除非调用方主动触发。flush 使用独立 `httpx.AsyncClient()`，并不使用 `TWS_PROXY`/账号代理参数。可用 `TWS_TELEMETRY=0` 或 `DO_NOT_TRACK=1` 关闭；接入建议同时设定并验证无遥测出站。

离线探针仅替换设备 ID 为合成标识后查看字段名，未发送事件也未读取真实机器标识。

## 账号池、锁、限流、异常

- SQLite 内存 asyncio.Lock 串行同进程 DB 操作，跨进程遇 database is locked 最多尝试 10 次，每次间隔 0.5–1 秒，SQLite 自身也有等待；不是分布式服务。来源：`db.py:21-43`。
- 每个 account/operation 的锁，首次取用暂锁 15 分钟；SQLite >=3.35 使用单条 UPDATE RETURNING 避免正常竞争取到同一账号。不同 operation 可同时占用同一账号。来源：`accounts_pool.py:263-324`。
- 没有持续续租或 owner token；超过 15 分钟的长任务可能与新取用者交叠，后退出的旧任务会无条件 unlock。同样，硬杀进程会留下锁直到超时。短任务+单采集进程+总超时较容易控制；不能当作可靠分布式租约。
- 默认如果 active 账号都锁住会一直等；如果没有 active 账号则可返回 None，调用方可能误以为正常空结果。必须 `raise_when_no_account=True` 并设 wait_timeout/外层总时限，保持旧 checkpoint。来源：`accounts_pool.py:326-365`、`api.py:142-165,248-250`。
- 限流使用响应头 remaining/reset，锁住该账号的对应 operation 后换号；账号封禁/失效由错误码 32/326、部分 88/403 启发式判断并标为 inactive。无法把所有这些状态精确区分为“永久封禁”。来源：`queue_client.py:286-332`。
- network/load-shed 有少量指数退避；失败预算每个成功请求重置，换号和持续等待导致总体无严格总预算。来源：`queue_client.py:82-93,343-354,366-460`。
- Cloudflare/HTML 错误、签名解析失败明确抛异常；默认 HTTPX，curl 需要显式安装和选择，不自动切换。curl 是不同 TLS/浏览器指纹传输实现，不保证消除验证码/账号风险。来源：`queue_client.py:270-279,422-447`、`http.py:194-246,250-268`。
- GraphQL 有 data 时允许部分 errors 通过：`queue_client.py:338-341`。原始响应仍需由我方严格校验，不能把 `*_raw` 当作完整性保证。
- SQL 的 username 增删已参数化；queue 名仍插值（`accounts_pool.py:263-324,367-374`），正常内部来源是固定 operation。接入不得让外部用户任意构造 queue/op；本次未证明公网可达 SQL 注入。

## 外部请求与依赖

- 固定 GraphQL 主目标在 X；签名生成额外请求 `https://x.com/tesla` 页面及 JS assets，提取签名素材，不执行下载的 JS。来源：`xclid.py:265-324,360-373`。主分支的这层兼容代码会随着 X 页面结构变化而变动。
- 页面脚本正则接受任意 HTTPS host 的 x-web/client-web 路径，页面中的 JS 重定向也未限定 host（`xclid.py:33-65`）。正常来源是 X 页面；建议我方做 X/CDN host 白名单和资源大小/总超时限制。没有证明普通推文文本能控制这条路径。
- 密码模式还会连接由邮箱域名推导的 IMAP 服务器；没有该模式就无此依赖。
- 主依赖 `aiosqlite,fake-useragent,httpx,loguru,pyotp,beautifulsoup4,py-machineid`，可选 curl-cffi。pyproject 只设下界，无上界；普通 pip install 不等于使用仓库 uv.lock。应固定 commit，锁住实际解析依赖并保留哈希，不随 pip upgrade 自动漂移。
- 未发现运行时自动拉 GitHub 最新代码、自动 pip install 或执行远程脚本的逻辑。主审另对研究环境29个已安装包查询了OSV，未返回匹配公告（`evidence/dependency-osv.json`）；未完整审计捆绑原生组件，不能推导整个依赖链“无 CVE”。

## 可复现实证

脚本 `probes/auth-security.py`；输出 `evidence/auth-security.json`。运行：

```sh
unshare --net env PYTHONPATH=/tmp/twscrape-research-20261023 TWS_TELEMETRY=0 DO_NOT_TRACK=1 /tmp/twscrape-research-venv-20261023/bin/python probes/auth-security.py
```

用新建临时 DB、假 HTTPX MockTransport、假 IMAP 邮件和假设备 ID；没有 X 网络请求，不使用真实凭据；stdout 只含布尔判定、权限、字段名和非敏感目标。临时凭据 DB/debug dump 已清理。已在隔离网络命名空间运行，退出 0。

该探针验证主分支 HTTPX 后端与本机 umask 行为，不证明真实 Cookie 可用、X 是否会返回跨站跳转、账户风控概率或长期稳定性。curl 的独立真实传输验证见下节。


## 补充：curl 后端真实 HTTP / HTTPS 隔离测试

为避免把 HTTPX 行为误套到 curl，使用当前安装的 `curl-cffi 0.16.3` 和真实 `Account.make_client()`、真实 libcurl 网络传输另测。脚本 `probes/curl-security.py`，输出 `evidence/curl-security.json`。

在 `unshare --net` 独立网络命名空间内只启用 lo，清空代理，分别在 `127.0.0.1`、`127.0.0.2` 启动本地服务器。第一台返回 302 到第二台，用纯合成 Cookie/CSRF。HTTP 与 HTTPS 分两轮，各有 4 个实际 HTTP 请求。HTTPS 使用含两个 loopback IP SAN 的临时自签证书，只配置测试客户端的信任路径，没有关闭证书验证、没有扩展系统 CA；未配置该路径的负控请求因证书验证失败被拒绝。临时证书/私钥测试后删除。

| 验证项目 | HTTP | HTTPS（验证临时证书） |
|---|---|---|
| 初始请求收到 auth_token / CSRF | 两者均有 | 两者均有 |
| 302 跳到另一 host 后收到 auth_token | **没有** | **没有** |
| 302 跳到另一 host 后收到 x-csrf-token | **有** | **有** |
| 复用客户端直接请求另一 host，收到 auth_token / CSRF | 两者均有 | 两者均有 |
| 新客户端首次直接请求任意 host，收到 auth_token / CSRF | 两者均有 | 两者均有 |
| Cookie jar 是否空 domain / Secure=False | 是 | 是 |

因此，不能声称本次 curl 测试证实了“跨域重定向泄漏 auth_token”；**本次证实 curl 在 302 中限制了认证 Cookie，但没有限制 CSRF header，而且没有把 Cookie 限定为 X 站点的初始请求凭据。** HTTP 结果还证明直接请求明文 HTTP 时它会发送这些 Cookie；生产当前固定 HTTPS endpoint，尚未证明正常采集流程会走到明文 HTTP。

本次使用不同 loopback IP 作为不同 host，模拟 X 站→站外的传输条件；没有使用真实 X 域名、DNS、代理或账户，不证明 X 会实际返回这种跳转，也不覆盖所有 libcurl 版本、跨协议降级、子域或代理行为。仍建议 Cookie 明确绑定 `.x.com` + Secure，客户端只许 HTTPS/X host，并拦截站外跳转、限制敏感 header。

复现：

```sh
unshare --net /bin/bash -c 'ip link set lo up; exec env PYTHONPATH=/tmp/twscrape-research-20261023 TWS_TELEMETRY=0 DO_NOT_TRACK=1 /tmp/twscrape-research-venv-20261023/bin/python probes/curl-security.py'
```

已退出 0，stdout 只含版本/范围、布尔结果和非敏感字段，无 Cookie 值；stderr 为空。
