# Rhea

面向小学生的 AI 学习、练习与复习助手。当前仓库采用 TypeScript monorepo，包含 Expo
移动端、NestJS/Fastify API、独立异步 Worker、PostgreSQL 迁移、Redis 队列与兼容 S3 的
本地对象存储。

## 本地要求

- Node.js 24.15 或更高版本
- pnpm 11.19
- Docker Compose（用于 PostgreSQL、Redis 与 MinIO）

## 首次启动

1. 复制 `.env.example` 为 `.env`，将其中的值加载到当前终端。
2. 安装依赖：`pnpm install --frozen-lockfile`。
3. 启动依赖：`pnpm infra:up`。
4. 初始化数据库：`pnpm migrate`。该命令可安全重复运行。
5. 分别启动 API 与领域 Worker：`pnpm dev:api`、`pnpm dev:worker:domain`。
6. 启动移动端：`pnpm dev:mobile`。

本地家庭试用流程使用 `.env.example` 中的 `IDENTITY_PROVIDER_MODE=development` 与
`EXPO_PUBLIC_DEVELOPMENT_IDENTITY_ASSERTION`。非开发环境没有已配置身份提供方时会拒绝
监护人登录，不会把开发身份回退带入生产。

AI 与安全 Worker 分别使用 `pnpm dev:worker:ai` 和 `pnpm dev:worker:safety` 启动。API
默认监听 `http://127.0.0.1:3000`，移动端通过 `EXPO_PUBLIC_API_BASE_URL` 访问真实的
`GET /v1/today-route` 接口。

## 验证

- `pnpm test`：单元、接口与可用环境下的集成测试
- `pnpm typecheck`：全仓类型检查
- `pnpm lint`：静态检查
- `pnpm build`：构建所有应用和包
- `pnpm check`：依次执行格式、静态检查、类型检查、测试和构建

健康检查区分进程存活与依赖就绪：`GET /health/live` 不访问依赖，
`GET /health/ready` 检查 PostgreSQL、Redis 和对象存储。
