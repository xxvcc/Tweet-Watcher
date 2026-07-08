# Contributing to Tweet Watcher

感谢你关注 [`Tweet-Watcher`](README.md)。本项目当前规模不大，但欢迎通过 Issue、Pull Request、文档修正与部署经验分享来帮助完善它。

本项目是单进程 `server.js` 同时承担网页面板与后台 worker 的 Node.js 工具（`package.json` version 3.0.0），请在贡献时以现有 Node 实现为准。

## 贡献方式

你可以通过以下方式参与：

- 提交 Bug 报告
- 提交功能建议
- 改进 [`README.md`](README.md) 和相关文档
- 优化 [`server.js`](server.js)、[`lib/*.js`](lib/) 与 [`public/*`](public/) 的稳定性、安全性与兼容性
- 提供不同服务器环境下的部署经验（systemd 常驻 + nginx 反代）

## 提交 Issue 前

在提交问题前，建议先完成以下检查：

1. 阅读 [`README.md`](README.md) 中的安装、运行与常见问题章节
2. 确认 bird CLI（`@steipete/bird`）能单独运行，例如手动执行一次拉取
3. 查看面板中的实时日志（SSE 推送的内存日志），或用 `journalctl -u tweet-watcher -f` 查看 stdout 日志
4. 确认 Twitter Cookie（`auth_token` / `ct0`）、Telegram Bot Token、Chat ID 配置是否正确
5. 确认 Node.js 版本满足要求（>= 20），以及 bird CLI 路径是否正确（默认 `/www/server/nodejs/v24.18.0/bin/bird`）

## Pull Request 指南

提交 PR 时请尽量遵循以下原则：

- 保持改动聚焦，不要把无关重构混在同一个 PR 中
- 修改代码时同步更新相关文档，如 [`README.md`](README.md) 或 [`CHANGELOG.md`](CHANGELOG.md)
- 不要提交本地运行时数据或敏感信息，例如 `data/` 下的运行时文件：
  - [`data/config.json`](data/config.json)
  - [`data/secrets.json`](data/secrets.json)
  - [`data/password.json`](data/password.json)
  - [`data/session_secret.json`](data/session_secret.json)
  - [`data/sent_ids.json`](data/sent_ids.json)
- 提交前至少执行基础语法检查：

```bash
node --check server.js
for f in lib/*.js; do node --check "$f"; done
```

## 代码风格建议

本项目暂未引入完整的自动化代码规范工具，提交时请尽量保持：

- JavaScript 代码风格与现有文件一致（原生 Node，运行依赖仅 `express` + `bcryptjs`，前端为纯静态 `public/`，无构建、无框架）
- 变量命名清晰、含义明确
- 新增逻辑尽量保持函数化，避免把复杂逻辑直接堆在流程代码中
- 安全相关改动优先考虑：
  - 输入校验
  - 凭据最小暴露
  - 文件权限与锁
  - 命令执行边界控制

## 安全问题反馈

如果你发现的是安全漏洞，而不是普通 Bug，建议不要直接公开敏感利用细节。你可以先通过仓库 Issue 提交一个最小化描述，标记为安全相关，后续再决定是否公开完整细节。

## 提交信息建议

建议使用清晰的提交信息，例如：

- `fix: handle bird createdAt field`
- `docs: improve deployment instructions`
- `security: harden session and login rate limiting`
- `chore: add repository community files`

## 文档贡献

文档改进同样非常重要，尤其欢迎以下内容：

- 不同 Linux / systemd / Nginx 环境的部署说明（含 SSE 反代与 `X-Real-IP` 注入）
- bird 返回结构变化下的兼容说明
- 常见错误信息与排查步骤
- 适合中文用户的使用示例与故障处理经验

感谢你的贡献。
