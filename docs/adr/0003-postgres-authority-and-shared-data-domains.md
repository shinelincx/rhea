---
status: accepted
date: 2026-09-09
---

# 使用 PostgreSQL 权威源与同库数据域

PostgreSQL 是学习事实、处理任务和 outbox 的唯一权威源。Rhea 使用同一个数据库中的 `learning`、`safety`、`metrics` schema，以最小数据库角色、强制 RLS、固定 `search_path`、信封加密和访问审计形成逻辑与权限隔离，而不声称物理隔离。普通应用角色不能访问 `safety`，指标角色不能修改学习事实；同一数据库实例失陷仍可能影响三域是被接受的剩余风险。

领域事实和 outbox 在一个事务内提交，BullMQ/Tair 采用至少一次投递。Redis 中的任务、缓存和匹配池必须能从 PostgreSQL 重建，消费者通过幂等键、租约和条件状态转换保证重复投递至多改变一次领域状态；Rhea 不采用完整事件溯源，也不承诺 exactly-once。
