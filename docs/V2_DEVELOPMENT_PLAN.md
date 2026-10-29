# v1 停止维护与 v2 迁移

更新：2026-10-29。v1 已停止维护，最终版本 **3.5.0**，后续不再提供功能、Bug 修复、依赖升级或安全更新。本仓库暂不归档，保留历史版本、代码与许可证供查阅。

## 后续项目

[Tweet-Watcher-v2](https://github.com/xxvcc/Tweet-Watcher-v2) 从 v1 的 v3.5.0 派生，保留 Git 历史与 MIT 归属。v2 已接入固定 twscrape，支持持久队列、非中文 AI 翻译及管理面板，已完成维护者实例的生产交接；当前发布仍标记为预发布，实际验收范围以其文档为准。

- [v2 文档索引](https://github.com/xxvcc/Tweet-Watcher-v2/blob/main/docs/README.md)
- [最新版本与发行说明](https://github.com/xxvcc/Tweet-Watcher-v2/releases)
- [架构与后续范围](https://github.com/xxvcc/Tweet-Watcher-v2/blob/main/docs/ARCHITECTURE.md)
- [当前验证摘要](https://github.com/xxvcc/Tweet-Watcher-v2/blob/main/docs/VERIFICATION.md)
- [迁移与回退指南](https://github.com/xxvcc/Tweet-Watcher-v2/blob/main/docs/MIGRATION.md)

## 已有实例

v2 是独立项目，不能通过在 v1 目录直接拉取 v2 代码来替换。先备份私有状态，核对监控目标、采集水位、已确认 ID 和待发消息，再按迁移指南逐项执行。

两代不要共享可写数据目录、依赖、密码或会话密钥，也不要同时向同一目标发送。回退需要合并迁移期间的确认和待发消息，不能直接恢复旧快照。迁移工具生成候选状态，不会自动完成生产交接。

## 反馈范围

新功能、v2 问题和迁移问题请到 v2 仓库；v1 不再承诺修复或支持。安全问题按 [SECURITY.md](../SECURITY.md) 处理，任何报告都不要附上真实凭据或未脱敏运行数据。
