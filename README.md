# 🐦 Tweet Watcher

极简 Node.js 推特监控 → Telegram 推送工具。基于 [bird](https://github.com/steipete/bird) CLI，纯 Node.js 实现，带 Web 管理面板，网页与后台 worker 同进程运行，开箱即用。核心仅需一个 `server.js` 加 `lib/` 下的几个小模块，使用 JSON 文件管理配置，运行依赖仅 `express` + `bcryptjs`。

> 💡 版本 `3.3.0`：第三轮逐行审计后的修复版 —— 修好了「局部保存配置会清空账号列表」「置顶推文每 200 条被重推一次」「Nginx 只设 `X-Real-IP` 导致登录限流退化为全局单桶」等 20 处问题，详见 [CHANGELOG](CHANGELOG.md)。功能面延续 3.2.0：**监控台式面板**（账号状态卡片 + 顶部指标 + 实时活动流，配置收进设置抽屉）、深浅双主题、bird 路径自动检测；单 Node 进程同时承载面板与后台监控 worker，用 SSE 实时推送状态与日志、用 systemd 常驻，无前端框架、无构建步骤。
>
> ⚠️ **从 3.2.x 升级请务必同步更新 Nginx 配置**：把 `proxy_set_header X-Real-IP $remote_addr;` 换成 `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`，否则登录限流形同虚设（见[生产部署](#6-生产部署systemd--nginx)）。

## ✨ 功能

- 📡 监控多个 Twitter/X 账号的新推文
- 📲 新推文实时推送到 Telegram（区分原创 / 转推）
- ⚙️ 网页面板与后台 worker 同进程，worker 随服务自动启动，无需 Cron、无需独立守护进程
- 🖥️ **监控台式面板**：打开即见每账号状态卡片（状态灯 / 上次检查·推送 / 最近推文 / 推送量走势 / 下次检查倒计时）+ 顶部指标（账号数·今日推送·运行时长·下次检查）+ 实时活动流；配置收进右上角 ⚙ 设置抽屉
- 🌗 深色 / 浅色 / 跟随系统 主题一键切换（记忆选择）
- 🔍 bird CLI 路径自动检测（面板一键查找并填入）
- 🔒 密码保护 + 安全加固（bcrypt、无状态签名会话、CSRF、登录限流、防敏感字段回显、data 目录隔离）
- 🧠 智能去重（ID 集合，首次运行不推送旧推文）
- ♻️ 每账号独立设置拉取条数和检查频率，保存后下一轮自动热加载，无需重启
- 🔁 推送失败自动重试（最多 3 次；间隔取 2 秒与 Telegram `retry_after` 的较大值，上限 60 秒，超限转为全局退避）
- ✂️ 超长推文自动截断（>4000 字符），避免 Telegram API 报错
- 📋 Web 端实时查看运行日志（SSE 推送，内存环形缓冲 500 条，同时打到 journald）
- 🚀 纯 Node，无前端框架、无构建步骤

## 📌 项目定位

`Tweet-Watcher` 面向以下场景：

- 想以极低依赖部署一个 Twitter/X → Telegram 监控工具
- 希望直接在服务器上用 Node.js + bird CLI 跑通，不引入复杂框架
- 需要一个简单可视化的 Web 面板管理 Cookie、Bot Token、监控账号和监控开关
- 接受当前项目以单机部署、轻量运维为主，而不是大规模分布式设计

如果你想要的是一个超轻量、可直接用 systemd 常驻 + Nginx 反代的监控工具，这个仓库就是为这种用途准备的。

## 📁 文件结构

```text
├── server.js               # 单 Node 进程：Web 面板 + 后台监控 worker
├── package.json            # 依赖与启动脚本
├── lib/
│   ├── config.js           # config.json / secrets.json 读写与字段校验
│   ├── auth.js             # bcrypt 密码、HMAC 签名会话、CSRF 令牌
│   ├── state.js            # 运行时状态 + 日志环形缓冲 + 事件总线（SSE 源）
│   ├── store.js            # 原子 JSON 读写（临时文件 + rename）
│   ├── bird.js             # 调用 bird CLI 拉取推文并解析
│   ├── telegram.js         # 消息格式化 + Telegram Bot API 发送
│   └── worker.js           # 调度：按账号间隔拉取、去重、重试推送
├── public/                 # 纯静态前端（无构建、无框架）
│   ├── index.html          # 面板页面
│   ├── app.js              # 前端逻辑
│   └── style.css           # 样式
├── README.md               # 项目说明
├── LICENSE                 # 开源许可证
└── data/                   # 运行时数据（自动创建，位于站点根之外，永不经 Web 暴露）
    ├── config.json         # 普通配置（账号、tg_chat_id、bird_path、paused）
    ├── secrets.json        # 敏感凭据（auth_token / ct0 / tg_bot_token，明文）
    ├── password.json       # 访问密码（bcrypt 哈希）
    ├── session_secret.json # 会话 HMAC 密钥 + epoch
    └── sent_ids.json       # 已推送推文 ID（去重用）
```

## 📋 前置要求

| 依赖 | 说明 |
|------|------|
| Node.js ≥ 20 | 运行环境（实测 v24.18.0）；使用内置 `fetch`、`execFile` 等，无需额外扩展 |
| npm 依赖 | 仅 `express` + `bcryptjs`，`npm install` 自动安装 |
| bird CLI | `npm install -g @steipete/bird`，用于拉取推文 |
| Telegram Bot | Bot Token + Chat ID |
| Twitter Cookie | `auth_token` + `ct0` |

> 💡 无需 PHP，也不依赖 `pcntl` / `posix` / `proc_open` 之类的能力。监控 worker 在 Node 进程内直接作为定时循环运行，不 fork 独立守护进程。
>
> ⚠️ bird CLI 是外部命令，由 Node 通过 `execFile` 调用（带 30 秒超时）。请确保运行服务的用户对 `bird_path` 指向的可执行文件有执行权限。

## 🚀 安装

### 1. 安装 bird CLI

```bash
npm install -g @steipete/bird
```

验证安装：

```bash
bird --version

# 查看安装路径（也可在面板设置里点「🔍 自动检测」自动填入）
which bird
```

> 💡 面板设置页的 bird CLI 路径支持 **🔍 自动检测**：会在常见位置（与运行 node 同目录、`which bird`、`/usr/local/bin`、`/usr/bin`）自动找到 bird 并填入，无需手动 `which`；找不到时会提示安装或手动填写。默认路径为 `/www/server/nodejs/v24.18.0/bin/bird`。

### 2. 拉取代码并安装依赖

```bash
git clone https://github.com/xxvcc/Tweet-Watcher.git
cd Tweet-Watcher
npm install
```

### 3. 启动服务

```bash
node server.js
# 或
npm start
```

默认监听 `127.0.0.1:8787`，可用环境变量覆盖：

```bash
HOST=0.0.0.0 PORT=9000 node server.js
```

服务启动后，网页面板与后台监控 worker 会在同一个进程内一起运行，日志同时打到终端（stdout）。

### 4. 首次设置密码

浏览器访问面板地址（本机为 `http://127.0.0.1:8787`），首次访问会提示设置访问密码（至少 8 位）。

### 5. Web 页面配置

登录后进入**监控台**（默认视图）：账号状态卡片、顶部指标、右侧实时活动流一目了然。点右上角 **⚙ 设置** 打开配置抽屉，填写：

1. **监控账号列表**：每个账号可单独设置拉取条数和检查频率
2. **Twitter 认证**：`auth_token` 和 `ct0`（已保存时显示一行圆点，留空即保持不变；点 👁 可明文核对）
3. **Telegram 推送**：Bot Token 和 Chat ID
4. **bird CLI 路径**：可点 **🔍 自动检测** 自动填入
5. 点击 💾 **保存配置**（几秒内热加载生效，无需重启）
6. 点击各个 🧪 **测试** 按钮验证连接是否正常

> 右上角 **🌙** 可在 深色 / 浅色 / 跟随系统 间切换主题；**⏸ 暂停 / ▶ 恢复** 可随时停/启监控。

保存后 worker 会在下一轮 tick（几秒内）自动读取新配置，**无需重启**。

### 6. 生产部署（systemd + Nginx）

**systemd 常驻** —— 新建 `/etc/systemd/system/tweet-watcher.service`：

```ini
[Unit]
Description=Tweet Watcher
After=network.target

[Service]
Type=simple
User=www
WorkingDirectory=/www/tweet-watcher
ExecStart=/usr/bin/node server.js
Environment=HOST=127.0.0.1
Environment=PORT=8787
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

启用并查看日志：

```bash
systemctl daemon-reload
systemctl enable --now tweet-watcher
journalctl -u tweet-watcher -f
```

**Nginx 反代 + HTTPS** —— 面板只监听回环，由 Nginx 对外提供 HTTPS：

```nginx
server {
    listen 443 ssl;
    server_name 你的域名;

    ssl_certificate     /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;

        # 必须：登录限流按 req.ip 分桶，而 Express 的 trust proxy 只读 X-Forwarded-For。
        # $proxy_add_x_forwarded_for 会把真实连接 IP 追加到客户端自带的 XFF 之后，
        # 服务端取最右侧非可信地址，因此客户端无法伪造。
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE 实时日志：关闭缓冲，保持长连接
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }
}
```

> ⚠️ **不要漏掉 `X-Forwarded-For`。** 服务端只信任回环代理（`trust proxy = loopback`）且只读 `X-Forwarded-For`；若 Nginx 没有注入它（例如只设了 `X-Real-IP`），所有客户端的 `req.ip` 都会塌缩成 `127.0.0.1`，登录限流退化为**全局单桶** —— 任何人连错 5 次密码就会把所有人一起锁在门外。
>
> ⚠️ 面板端口只监听回环，请务必只从本机 Nginx 反代，不要直接对公网开放。

> 💡 无需 `.htaccess`、也无需把 `data/` 放到 Web 根下再做防护：Node 只静态伺服 `public/` 目录，`data/` 本就在站点根之外，永不经 Web 暴露。

## ⚙️ 配置说明

所有配置**均通过 Web 页面统一管理，无需手动编辑文件、也没有 `.env`**。数据持久化到 `data/` 目录下的几个 JSON 文件：

| 文件 | 内容 |
|------|------|
| `config.json` | 账号列表、`tg_chat_id`、`bird_path`、`paused`（暂停开关） |
| `secrets.json` | `auth_token`、`ct0`、`tg_bot_token`（明文存储，目录权限保护） |
| `password.json` | 访问密码的 bcrypt 哈希 |
| `session_secret.json` | 会话 HMAC 密钥与 epoch |
| `sent_ids.json` | 每账号已推送 ID（去重表） |

首次运行无需任何配置文件即可启动，`config.js` 内置默认值（当然需要在 Web 页面填写 Token 才能正常工作）。

### 配置项一览

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `bird_path` | bird CLI 可执行文件路径 | `/www/server/nodejs/v24.18.0/bin/bird` |
| `auth_token` | Twitter Cookie 认证令牌 | - |
| `ct0` | Twitter Cookie CSRF Token | - |
| `tg_bot_token` | Telegram Bot Token | - |
| `tg_chat_id` | Telegram Chat ID | - |
| `accounts` | 监控的 Twitter 账号列表（对象数组） | `[]` |

每个账号对象支持以下字段：

| 字段 | 说明 | 默认值 |
|------|------|--------|
| `username` | Twitter 用户名（不含 @，需匹配 `^[A-Za-z0-9_]{1,15}$`） | （必填） |
| `fetch_count` | 每次拉取推文条数（1–50） | `10` |
| `check_interval` | 检查频率（秒，30–3600） | `300` |

> 💡 修改任何配置后点击「保存配置」即可生效，worker 会在下一轮 tick（每 5 秒一轮）自动读取新值，**无需重启**。已保存的密文字段（`auth_token` / `ct0` / `tg_bot_token`）在页面上不回显，**留空即保持不变**。

### 获取 Twitter Cookie

1. 浏览器登录 [x.com](https://x.com)
2. 按 `F12` 打开开发者工具
3. 切换到 **Application**（应用程序）标签页
4. 左侧找到 **Cookies** → `https://x.com`
5. 复制 `auth_token` 和 `ct0` 的值

> ⚠️ Cookie 会过期。如果推送停止工作，请重新获取 Cookie 并在 Web 页面更新。

### 获取 Telegram Bot Token

1. 在 Telegram 搜索 [@BotFather](https://t.me/BotFather)
2. 发送 `/newbot`，按提示创建
3. 获得格式如 `123456789:ABCdefGHIjklMNOpqrsTUVwxyz` 的 Token

### 获取 Telegram Chat ID

1. 在 Telegram 搜索 [@userinfobot](https://t.me/userinfobot)
2. 发送任意消息，获得你的 Chat ID

> 💡 推送到群组：把 Bot 拉入群组，使用群组 Chat ID（以 `-` 开头）。

## 🔒 安全特性

- 首次访问 Web 页面时需设置密码（至少 8 位）
- 密码以 **bcrypt**（cost 12）哈希存储在 `data/password.json`；兼容旧 `$2y$` 前缀（自动改写为 `$2b$`）
- 密码使用**异步 bcrypt**（不阻塞事件循环），错误时固定延迟 1 秒响应（防暴力破解）
- **登录限流**（按 `req.ip`，即 `trust proxy=loopback` 下 Nginx 经 `X-Forwarded-For` 传入的真实客户端 IP，客户端无法伪造）：累计失败 5 次锁 5 分钟、10 次锁 30 分钟、20 次锁 60 分钟。锁定期满只放行下一次尝试而**不清零计数**，因此升级档位真正可达；计数在**登录成功**或**1 小时无新失败**时清除。限流表有界（惰性回收 + 硬上限，防内存耗尽）
- **首次设置令牌**：无密码时服务端启动会在日志打印一次性 `setup_token`，`/api/setup` 必须携带它才能设密，杜绝公网面板的无认证首次抢注（TOFU）。若 `password.json` 损坏，`hasPassword` 判定为 fail-closed（视为已设置），不会重开无认证设置
- **会话**：HMAC-SHA256 签名的无状态 Cookie（有效期 7 天），内含 epoch —— 登出或改密会 `bump` epoch，使所有已签发会话**立即失效**；畸形 Cookie/会话一律返回 401（不再有 500 堆栈泄露）
- **CSRF 双提交令牌**：所有改动型接口校验，`timingSafeEqual` 常量时间比较；`/api/logout` 仅在持有效会话+CSRF 时才全局吊销，未认证请求无法借此制造登出 DoS
- **安全响应头**：CSP（脚本与样式均严格同源，无 `unsafe-inline`；含 `form-action 'none'`）、`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy`，并关闭 `X-Powered-By`；所有 `/api/*` 响应带 `Cache-Control: no-store`
- 凭据（`auth_token` / `ct0` / `tg_bot_token`）在日志输出中自动 redact，替换为 `***`
- `data/` 目录权限 `0700`、文件写入 `0600`，位于站点根之外且永不被静态伺服（Node 只 `express.static` 伺服 `public/`）
- 文件写入使用原子替换（临时文件 + `fsync` + `rename` + 目录 `fsync`），防止崩溃/断电导致半写损坏；读取时区分「文件不存在」与「存在但损坏」，损坏不静默当作「未设置」
- `bird_path` 只接受绝对路径、限定字符集、无 `..`、且文件名必须为 `bird`——防止已认证用户将其改指向 `/bin/sh` 等宿主二进制。注意该校验拦不住一个**名为 `bird` 的符号链接**指向别处（利用它需要已认证 + 对宿主有写权限）
- 子进程调用 bird 带 30 秒超时保护，防止挂起

> ⚠️ **已知残留风险：Twitter 凭据经命令行参数传给 bird。** bird 0.8.0 只接受 `--auth-token` / `--ct0` 参数或从浏览器提取 cookie，不支持环境变量、stdin 或凭据文件，因此本项目无法规避。在 Linux 上，`/proc/<pid>/cmdline` 默认对同机其它用户可读，这意味着**同一台机器上的其他用户可以读到你的 X 会话 Cookie**。缓解：以独占用户运行本服务；在多租户主机上以 `hidepid=2` 挂载 `/proc`（`mount -o remount,hidepid=2 /proc`）。
- 忘记密码时，需**停服 → 删除 `password.json` → 重启**，重启后从服务端日志读取新的一次性 `setup_token` 再走首次设置：

```bash
systemctl stop tweet-watcher
rm /www/tweet-watcher/data/password.json
systemctl start tweet-watcher
journalctl -u tweet-watcher -n 20 | grep 首次设置令牌   # 取出 setup_token
```

重启后下次访问面板会回到「首次设置密码」流程，需在页面填入日志中的令牌。

## 📬 Telegram 推送格式

**原创推文：**
```text
🐦 新推文 @elonmusk

发布时间：2026/2/26 10:00:00
X链接：https://x.com/elonmusk/status/1234567890
内容：
推文内容在这里...
```

**转推：**
```text
🔁 转推 @elonmusk

发布时间：2026/2/26 10:05:00
X链接：https://x.com/elonmusk/status/1234567890
内容：
转推内容在这里...
```

> 💡 时间由推文原始时间戳解析后转为北京时间（`Asia/Shanghai`），以 `zh-CN`、24 小时制显示；无法解析时原样保留。整条消息超过 4000 字符会自动截断并追加「…（内容已截断）」。

## 🧠 去重机制

| 策略 | 说明 |
|------|------|
| ID 集合 | 每个账号维护已推送的推文 ID 列表，持久化到 `sent_ids.json` |
| 首次静默 | 账号首次运行只记录当前推文 ID，不推送旧推文 |
| 集合上限 | 每个账号最多保留 200 条 ID |
| 置顶推保护 | 淘汰时优先保留"仍出现在本次拉取窗口内"的 ID —— 否则长期置顶的推文会被挤出去重表并每满 200 条重推一次 |
| 孤立清理 | 从配置中删除账号后，worker 自动清理其去重记录、计时与状态 |
| 转推识别 | 转推标记为 🔁，与原创推文（🐦）区分 |
| 按账号落盘 | 每个账号一轮检查推送完毕后统一写盘 `sent_ids.json`（而非每条一次），降低写放大；语义仍是 at-least-once —— 崩溃至多导致"已发未记"，下轮重发 |
| 损坏即重建 | `sent_ids.json` 整体损坏或某账号的值不是数组时，按"首次运行"处理（重建基线、不推送），而不是把整条时间线当新推文全量推出 |

推送失败时最多重试 3 次，间隔取 `2 秒` 与 Telegram `retry_after` 的较大值。若 `retry_after` 超过 60 秒（洪泛限制），worker **不会在 tick 内长睡**（那会拖停整个调度），而是设置一个全局退避窗口，把推文顺延到退避结束后再发。全部失败则记录日志、保留该 ID 未推状态，下轮仍可再试。

## 📋 日志查看

**Web 页面：** 监控台右侧的「实时活动」列即为日志流。日志通过 SSE（`/api/stream`）从服务端实时推送到面板，来源是内存里的环形缓冲（最多保留 500 条）。

**命令行 / 服务器：** 日志同时写到进程 stdout，交给 systemd/journald 留存与轮转：

```bash
# 查看最近日志
journalctl -u tweet-watcher -n 50

# 实时跟踪
journalctl -u tweet-watcher -f
```

> 💡 本项目不再写 `data/cron.log` 文件，也没有 2MB 上限那套自建日志轮转 —— 落盘与轮转交给 journald 处理。

### 供外部脚本使用的接口

面板本身走 SSE，不调用下面两个接口；它们是留给健康检查与日志抓取的（均需携带有效会话 Cookie）：

| 接口 | 用途 |
|------|------|
| `GET /api/status` | 运行状态 + 每账号指标；`healthy` 表示 worker 在 60 秒内有过心跳（长 tick 期间也会持续更新，不会误判） |
| `GET /api/logs` | 取最近 200 条日志（JSON 数组） |

## 🔄 迁移

迁移到新服务器：

1. 拷贝整个项目目录（含 `server.js`、`lib/`、`public/`、`package.json`）
2. 新服务器安装 Node.js ≥ 20 与 bird CLI：`npm install -g @steipete/bird`
3. `npm install` 安装运行依赖
4. （可选）拷贝 `data/` 目录以保留配置、凭据、密码与去重记录；若只想保留去重记录，单独拷贝 `data/sent_ids.json`
5. 配好 systemd / Nginx 后启动服务，访问面板确认状态

> 💡 拷贝 `data/` 后请确认目录权限仍为 `0700`、文件为 `0600`，且属主是运行服务的用户。

## ❓ 常见问题

### Q: 推送突然不工作了？

1. 查看日志：面板「实时日志」或 `journalctl -u tweet-watcher -n 50`
2. 检查面板「监控状态」是否为运行中、是否被「暂停监控」
3. 检查 Twitter Cookie 是否过期：
   ```bash
   bird user-tweets elonmusk --json -n 1 --auth-token YOUR_TOKEN --ct0 YOUR_CT0 --no-color
   ```
4. 重新获取 Cookie，在 Web 页面更新即可（下一轮 tick 自动生效）

### Q: 面板打不开 / 打开空白？

1. 确认服务在运行：`systemctl status tweet-watcher`
2. 确认监听地址端口：默认 `127.0.0.1:8787`，可用 `HOST` / `PORT` 环境变量覆盖
3. 若通过公网访问，确认 Nginx 已正确反代到 `127.0.0.1:8787` 并配好 HTTPS

### Q: 点「测试 Twitter 拉取」报错？

多半是 bird CLI 路径不对、Cookie 失效或未填。可在服务器终端手动排查：

```bash
# 检查安装与路径
bird --version
which bird

# 手动测试拉取（与服务端调用一致）
bird user-tweets elonmusk --json -n 1 --auth-token YOUR_TOKEN --ct0 YOUR_CT0 --no-color
```

> ⚠️ `bird_path` 会经过格式校验：必须是绝对路径、限定字符集、不含 `..`，且**文件名必须为 `bird`**（防止改指向其它宿主二进制）。请填写 bird 可执行文件的真实绝对路径，如 `which bird` 的输出。

### Q: 想用别的方式常驻，而不是 systemd？

监控 worker 在 `node server.js` 进程内随服务自动启动，只要保证这个进程一直活着即可。除了 systemd，也可以用 `pm2`、`supervisor` 等进程管理器守护。注意本项目没有 `start` / `stop` 守护进程子命令，也没有 Cron 单次运行模式 —— 面板上的「暂停 / 恢复监控」控制的是同一个进程里的监控开关，而不是进程本身的启停。

### Q: 想推送到多个 Telegram 账号？

- 创建 Telegram 群组，把 Bot 和所有人拉进去，使用群组 Chat ID（以 `-` 开头）
- 或复制项目到另一个目录、用不同的 `PORT` 再跑一份，配置不同的 Chat ID

### Q: 修改了检查频率 / 账号，需要重启吗？

不需要。保存配置后 worker 会在下一轮 tick（每 5 秒一轮）读取最新的 `config.json`，账号增删、频率与条数调整都会自动生效。

## 🤝 贡献

欢迎提交 Issue、Pull Request 或部署经验反馈。请只依据代码中真实存在的能力提交问题与改进，附上**脱敏后的**日志（凭据在服务端日志中已自动 redact）与环境信息（Node 版本、bird 版本、部署方式）。

## 🧭 支持与反馈

如果你在使用中遇到问题，建议按以下顺序排查：

1. 阅读本 README 对应章节
2. 查看面板「实时日志」或 `journalctl -u tweet-watcher -f`
3. 检查 bird CLI、Twitter Cookie 和 Telegram 配置（用面板的 🧪 测试按钮）
4. 提交 Issue，并附上脱敏后的日志与环境信息

## 📜 License

本项目基于 MIT License 开源，详见 [`LICENSE`](LICENSE)。

## 🙏 致谢

推特数据拉取由 [bird](https://github.com/steipete/bird) CLI 提供支持。
