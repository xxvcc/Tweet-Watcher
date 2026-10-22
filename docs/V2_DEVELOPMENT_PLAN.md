# 第二代开发入口与第一代维护

2026-10-23，已按用户确认的方案建立第二代独立公开仓库和开发目录。完整开发方案、实施状态与后续讨论记录转到第二代仓库维护：

- [第二代仓库：Tweet-Watcher-v2](https://github.com/xxvcc/Tweet-Watcher-v2)
- [开发方案](https://github.com/xxvcc/Tweet-Watcher-v2/blob/main/docs/V2_DEVELOPMENT_PLAN.md)
- [开发进度](https://github.com/xxvcc/Tweet-Watcher-v2/blob/main/docs/DEVELOPMENT.md)
- [新会话接续说明](https://github.com/xxvcc/Tweet-Watcher-v2/blob/main/docs/SESSION_HANDOFF.md)

第二代从本仓库已发布的 v3.5.0（`baf0c2da0927d4448b6f4525676652b49975c1fb`）派生，保留 Git 历史、许可证及已有安全修复。它目前是开发骨架，twscrape 尚未接入；本仓库继续维护第一代 Bird 实现。

当前服务器的目录职责：

| 用途 | 目录 | 仓库 |
|---|---|---|
| 第一代生产服务 | `/www/tweet-watcher` | `xxvcc/Tweet-Watcher` |
| 第一代开发副本 | `/www/tweet-watcher-v1-dev` | `xxvcc/Tweet-Watcher` |
| 第二代开发副本 | `/www/tweet-watcher-v2` | `xxvcc/Tweet-Watcher-v2` |

第一代后续改动在开发副本完成测试和发布，再部署到生产目录。两代分别管理服务、运行数据、凭据和发送权；公共安全修复按实际影响移植，不共享可写工作树或生产数据。

需要在 VS Code 浏览新版时，可保留原窗口中的对话，在新窗口连接同一服务器并打开 `/www/tweet-watcher-v2`。新对话先阅读第二代的 `AGENTS.md` 和接续说明；打开新目录不等于已经迁移原对话的工作目录。
