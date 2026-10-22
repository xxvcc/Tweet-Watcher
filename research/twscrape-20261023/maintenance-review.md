# twscrape 维护、发布与可重复安装审查

核验日期：2026-10-23，时区 Asia/Shanghai。源码快照：`63f61a518e576ea5c132f1156c03dda0520d76c1`，本地目录 `/tmp/twscrape-research-20261023`。本报告只读检查源码、Git 历史和公开 GitHub/PyPI 信息，没有运行 X 请求、读取生产账号或修改生产程序。离线测试由主审执行，本审查员已核对其日志。

## 判断

twscrape 是仍有实际维护的候选：最近在修复 X 接口变化、错误处理和丢项，提供测试、依赖锁文件与发布流水线。但是当前恰处于正式版与下一版之间，**不能把 main 中的修复当成 `pip install twscrape` 已获得的能力，也不能把它的模型输出直接当作完整页面证明**。用于现有严格去重和持久发送队列之前，仍需要独立采集适配器及失败语义验证。

## 正式发布与 main 必须区分

| 项目 | 已核验事实 |
|---|---|
| GitHub 最新正式 Release | `/releases/latest` 实际跳转至 `v0.20.1`；页面标注 Latest，并显示此后 main 多 20 个提交 |
| GitHub Release 发布时间 | 页面 `datetime` 为 UTC `2026-08-25T16:21:25Z`；北京时间 **2026-08-26 00:21:25** |
| PyPI 最新版本 | `0.20.1`，wheel 与 sdist 均未被 yanked |
| 正式版 tag 对应提交 | `5271cbdc5da1095b765a2a7ec750b4ac686d581f` |
| PyPI wheel 上传时间 | UTC `2026-08-25T16:21:19.810009Z`；北京时间 **2026-08-26 00:21:19.810009** |
| PyPI sdist 上传时间 | UTC `2026-08-25T16:21:21.008705Z`；北京时间 **2026-08-26 00:21:21.008705** |
| 审查的 main 提交时间 | 原始 Git 时间 `2026-10-22T00:19:14+03:00`；北京时间 **2026-10-22 05:19:14** |
| main 包版本字段 | `pyproject.toml` 及 `uv.lock` 中仍为 `0.20.1` |
| main 更新日志 | 顶部已经写 `v0.21.0 – 2026-10-21`，但没有对应的正式 tag/Release/PyPI 发布可供确认；应称为下一版准备内容 |

20 个提交涉及 5 个 Git 作者身份，其中 Fla 10 个、vladkens 7 个，其余三名作者各 1 个。能说明近期有多个贡献者参与，不能据此承诺维护 SLA。

原始来源：

- https://github.com/vladkens/twscrape/releases/latest
- https://github.com/vladkens/twscrape/releases/tag/v0.20.1
- https://pypi.org/pypi/twscrape/json
- https://github.com/vladkens/twscrape/compare/v0.20.1...63f61a518e576ea5c132f1156c03dda0520d76c1
- https://github.com/vladkens/twscrape/blob/63f61a518e576ea5c132f1156c03dda0520d76c1/changelog.md

## v0.20.1 到审查快照的重要变化

| 变化 | 本项目意义及边界 |
|---|---|
| #347/#354：请求失败、无数据的 API 错误、用户解析失败抛出异常；DeadlineExceeded 有界重试 | 解决一部分失败被解释成空结果的问题，属于行为不兼容变化。不能扩大成所有接口都已严格失败关闭 |
| #332：跨页去重 | 减少相邻页面重复产生条目；不替代本项目跨轮/跨重启去重及持久队列 |
| #338：仅嵌套的引用推文不再被误当顶层条目，真实独立 entry 仍保留；明确识别 Cloudflare challenge 页面 | 避免引用内容串入被监控账号的时间线；挑战检测会报错，不保证能完成请求 |
| #344/#345/#352/#353：作者资料不完整时保留推文、避免完整用户被部分资料覆盖 | 减少丢项；返回的 user 可能是占位资料，不能当完整账户信息保存 |
| #339：根据 X 报错补缺少的 GraphQL features 并重试 | 降低某些 feature flag 变化导致的停用；属于兼容补救，不是 X API 稳定性保证 |
| #323/#333/#335：文章和更多卡片类型 | 更丰富的正文/卡片处理，须由适配器明确映射到现有消息格式 |
| #334：reactivate 命令 | 能再次激活已有会话账户，不等于重新登录或保证 Cookie 有效 |
| #358/#359/#362：更新 GQL 操作 ID/样本和维护脚本 | 表明维护者在跟进上游变化；维护脚本可能访问 X，不应在生产部署时自动执行 |
| #360：更换发布流水线 | 从 release commit 触发共享发布 action，不能据此认定新版本已经发布 |

总体 diff 为 66 个文件、108466 行增加/106921 行删除，但绝大多数是录制的 JSON 样本更新，不能把这个数字当业务代码改动量或测试质量证据。

## 依赖、许可与平台

项目为 MIT 许可，`pyproject.toml` 标为 Beta。运行要求 Python >= 3.10，SQLite >= 3.24（程序在 `twscrape/db.py` 校验）。本体 wheel 为 `py3-none-any`，但可选 curl 后端有平台相关的原生依赖。

| 直接依赖 | 声明下限 | 当前 main 的 uv.lock 版本 |
|---|---:|---:|
| aiosqlite | 0.17.0 | 0.22.1 |
| fake-useragent | 1.4.0 | 2.2.0 |
| httpx | 0.26.0 | 0.28.1 |
| loguru | 0.7.0 | 0.7.3 |
| pyotp | 2.9.0 | 2.10.0 |
| beautifulsoup4 | 4.13.0 | 4.15.0 |
| py-machineid | 1.0.0 | 1.0.0 |
| curl-cffi（可选 curl extra；开发测试也使用） | 0.7.0 | 0.16.3 |

当前默认仍是 httpx。**安装 `twscrape[curl]` 本身不会在此快照自动切换后端**，必须显式配置 `TWS_HTTP_BACKEND=curl`。自动优先 curl 的 PR #363 尚未合并。

运行代码未发现 Node 子进程需求；Docker 测试镜像安装 Node 并不等于产品运行必须依赖 Node。发布要求与 CI 主要验证 Linux/Ubuntu；不能由 Python 跨平台分类推断所有 Windows/macOS 与 curl 原生 wheel 组合均已测试。

`py-machineid` 用于项目已有遥测机制。`TWS_TELEMETRY=0` 或 `DO_NOT_TRACK=1` 是源码中的禁用开关；接入本项目宜显式关闭。具体遥测字段应由安全审查另行解释。

main 的锁文件固定了完整依赖版本及分发文件哈希，并把 certifi 升到 `2026.10.19`；源码注释称旧版本有已知漏洞。这里没有独立核实该注释所指公告。主审另对研究环境29个已安装包查询了OSV，未返回匹配公告（`evidence/dependency-osv.json`）；这不覆盖全部捆绑原生组件，也不构成依赖无漏洞的证明。

原始来源：

- https://github.com/vladkens/twscrape/blob/63f61a518e576ea5c132f1156c03dda0520d76c1/LICENSE
- https://github.com/vladkens/twscrape/blob/63f61a518e576ea5c132f1156c03dda0520d76c1/pyproject.toml
- https://github.com/vladkens/twscrape/blob/63f61a518e576ea5c132f1156c03dda0520d76c1/uv.lock
- https://github.com/vladkens/twscrape/blob/63f61a518e576ea5c132f1156c03dda0520d76c1/twscrape/http.py
- https://github.com/vladkens/twscrape/blob/63f61a518e576ea5c132f1156c03dda0520d76c1/twscrape/db.py

## CI 和测试能证明什么

当前流水线在 Ubuntu 上配置 Python 3.10、3.11、3.12、3.13、3.14、3.15；**3.15 允许失败**。步骤包括 `uv sync --frozen`、`make check`（ruff 格式、lint、ty 类型检查）、`make test`（pytest 与覆盖率）。另有构建与发布作业，发布依赖测试及构建作业。

测试使用录制页面、HTTP 替身和临时 SQLite。源码 `agents.md` 明确测试不应访问网络；`make update` 会更新 GQL 和采集样本，会用 X 账户，不能把它当普通测试运行。离线通过验证的是已有样本和异常路径，不验证当前账户可用、X 当前接口、风控策略或线上完整性。

主审已在临时 Python **3.13.5** 环境，以 `unshare --net` 隔离网络并降为 `nobody` 身份，对上述 main SHA 执行完整 pytest：**276 passed in 4.97s，行覆盖率 82%**。其中模型 94%、HTTP 99%、请求队列 92%，但登录 24%、IMAP 32%、x-client-transaction-id 43%，不能把总体通过数理解成全部真实认证链已验证。日志 `evidence/upstream-tests.log`，安装版本清单 `evidence/research-requirements.txt`，检出源码仍 clean。

这次测试环境是临时 pip 解析的依赖版本，**没有严格复现上游 uv.lock**；例如 coverage 为 7.17.0、soupsieve 为 3.0.4，与锁文件部分版本不同。这是该已记录环境上的通过证据，不能宣称所有上游 CI 环境或所有依赖组合通过。

公开 Actions API 一度可读，看到下列 PR 分支工作流成功：

- `39690243867`，head `9f7ebfc357d4e747d33f592638a97447ac7dd0c5`，event=`pull_request`、conclusion=`success`。
- `39688423263`，head `9f02f97c7a288336a49c4dc41c53df271d4b493b`，event=`pull_request`、conclusion=`success`。

它们是 PR 分支，**不是本次 main SHA 的成功证明**。随后 GitHub API 返回 403，未使用登录凭据或绕过限制；改读公开网页后，另确认 main 的 [run 39677817606](https://github.com/vladkens/twscrape/actions/runs/39677817606) 对应完整 SHA `63f61a518e576ea5c132f1156c03dda0520d76c1`，由 push 触发，显示 **Status Success**、6 个矩阵测试作业完成、整体用时 34 秒；创建时间 UTC `2026-10-21T21:19:17Z`，北京时间 **2026-10-22 05:19:17**。页面要求登录才可看日志，本次未登录，因此没有逐 job 日志和上游测试数量证据，尤其不能将允许失败的 Python 3.15 视为强制通过。

流水线部分 action 使用固定 SHA，部分使用 `@v1`、`@v7`、`@release/v1` 等可变标签；CI 配置能提供质量流程证据，但不构成整个构建链已达到不可变或已审计的结论。

来源：

- https://github.com/vladkens/twscrape/blob/63f61a518e576ea5c132f1156c03dda0520d76c1/.github/workflows/main.yml
- https://github.com/vladkens/twscrape/actions/runs/39690243867
- https://github.com/vladkens/twscrape/actions/runs/39688423263
- https://github.com/vladkens/twscrape/actions/runs/39677817606
- https://github.com/vladkens/twscrape/blob/63f61a518e576ea5c132f1156c03dda0520d76c1/tests/conftest.py

## 当前开放问题与未合并 PR

公开列表在核验时显示 11 个开放 issue、3 个开放 PR。问题报告不是普遍线上复现证明；下面保留具体接口和来源限定。

| 来源 | 状态与实际含义 |
|---|---|
| [#351](https://github.com/vladkens/twscrape/issues/351) | 开放。用户报告 SearchTimeline/Advanced Search 限流后不切账号，返回空或中断；报告明确说 UserTweets 轮换正常，不能泛化为所有账号拉取都坏 |
| [#348](https://github.com/vladkens/twscrape/issues/348) | 开放。tweet_details/user_about/community_info 的单对象解析失败仍可能返回 None。还明确指出分页解析器会跳过坏项，调用者拿不到“页内丢项”标识 |
| [#349](https://github.com/vladkens/twscrape/issues/349) | 开放。用户不存在与暂停/不可用原因未暴露到普通用户模型；user_tweets 对暂停/受限账号可空迭代，需要 raw lookup 判断原因 |
| [#337](https://github.com/vladkens/twscrape/issues/337) | 开放。0.20.1 的 user_by_id 在 httpx 被 Cloudflare 拦；报告者称 user_by_login 和采推文仍正常，维护者随后复现并建议 curl 后端 |
| [PR #364](https://github.com/vladkens/twscrape/pull/364) | 未合并，作者 vladkens。拟修复无标准限流头/HTML 429 的轮换、暂停账号处理、单对象 ParseError。页面仍有待解决的自动代码审查意见；不能将 proposed behavior 写成 main 已有能力 |
| [PR #363](https://github.com/vladkens/twscrape/pull/363) | 未合并，作者 vladkens。拟在安装 curl-cffi 时默认优先使用它；当前仍须显式设置环境变量 |
| [PR #361](https://github.com/vladkens/twscrape/pull/361) | 未合并。拟补 retweetedTweetId/quotedTweetId 及字符串字段，并继续讨论 isRetweet。作者和维护者都讨论了原始推文不可用时的关系丢失，现有模型不能保证保存该身份 |

特别相关的原始说明：#348 指出分页解析器“the caller gets no signal that something was skipped”。这正是本项目之前修复过的风险类型，不能用 twscrape 自带分页/模型直接替代当前完整页校验。

## 如何可重复固定版本

1. **固定正式版时**，固定 `twscrape==0.20.1` 并记录 wheel 的 SHA256，而不只写 `pip install twscrape`：

   `bfad943020361fc882b09ac49685e11d65b88743723de419b3d7873fe09d56e3`

   sdist SHA256 为：

   `09b3b768e701fb71a6f785dba9744f60c96d03308c76abfa66cbf2cdb360eb63`

   两个值是本次 PyPI JSON 的实际分发哈希；哈希能固定内容，不能独立证明代码安全。

2. **研究 main 修复时**，固定完整提交 `63f61a518e576ea5c132f1156c03dda0520d76c1`，保留对应源码和 `uv.lock`，不要跟随浮动 main。由于该源码仍自称 0.20.1，发布记录还必须存 Git SHA/构建产物哈希，单看 `pip show` 或版本号无法区分正式 wheel 与开发快照。

3. **完整固定依赖树**。`pip install twscrape==0.20.1` 仍会按 `>=` 重新解算依赖，不能重建同一个环境。接入项目应使用自己的受审查锁文件和全部 wheel 哈希，或固定源码附带锁文件并使用冻结模式；同时明确 Python 补丁版本、uv/pip 版本、平台、curl extra 与后端开关。

4. **固定构建输入**。源码构建声明 `hatchling>=1.9.1`，仅冻结运行依赖仍未固定构建隔离环境。优先保存已验证 wheel；需要自行构建时固定构建后端及其依赖，记录最终产物哈希。生产安装时使用预备好的 wheel 集，避免临时选择新的源码包构建。

5. **升级先验证再改锁**。用固定录制页验证目标账号识别、关系字段、完整页、异常/空结果区别、有界分页与等待；再由主审决定是否进行授权的只读真实采集。账号池只是会话/限流调度，不提供本项目的持久消息交付语义。

本审查员没有安装 twscrape 或执行任何生产切换；主审的隔离研究环境安装及离线测试已在上文明确列出。
