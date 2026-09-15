# 管理界面

先读根 [AGENTS.md](../AGENTS.md) 和 [server/AGENTS.md](../server/AGENTS.md) 的 API 边界。本目录是 Next.js 管理页，`app/page.tsx` 消费 Go 管理 API，`app/globals.css` 定义界面样式；`next.config.ts` 使用静态导出。`vite.config.ts` 是另一构建/预览入口，改构建时分别验证对应命令。

- `/api/*` 请求字段和失败语义以 `server/internal/manager/server.go` 及其测试为准。新请求同时检查认证、CSRF、状态刷新和用户可见的失败反馈；不要用 UI 推测服务端支持的协议。
- Token、管理密码和连接凭据只在必要的交互中显示或复制。不得写进 URL、客户端持久化、静态导出文件、日志或截图。保存配置、重启和轮换凭据应保留明确的用户确认与结果反馈。
- 读取状态要区分加载、未登录、空数据、部分失败和服务失败；不能把失败当作零客户端或操作成功。
- UI 对齐以用户给出的设计、截图或明确验收目标为依据，检查关键断点、操作可达性和可见反馈。浏览器夹具只能证明界面行为，不能证明 VPS 上真实 API 可用。

验证入口：`npm test`、`npm run lint`、`npm run build:static`；如果更改 `vite.config.ts` 或 Sites 预览入口，再运行相应 `npm run build`。不要把站点部署配置或静态页面修改当作后端 API 已发布。
