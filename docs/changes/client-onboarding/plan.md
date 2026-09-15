# 客户端引导与控制台：实施计划

- 作者：Codex；依据：已接受 intent/spec 与用户 2026-09-15 的计划；决定者：用户；决定日期：2026-09-15；状态：accepted。
- 提供者/消费者：沿用 Rust `load_profile`、`enroll_device`、`save_profile`、`start_client`、`stop_client`、`client_status`；WebView 主窗口为消费者，Playwright Tauri 夹具为测试消费者。独立服务端配对提供者为 `unknown`，不改线协议。
- 顺序：先写 UI 状态单元、页面命令集成、浏览器完整流程的目标测试并记录三层 Red；再改 `client/ui/index.html`、`app.js`、`styles.css`；目标 Green 后整理；最后运行客户端 Node/Playwright、JS 语法与 Rust 检查。
- 门禁：新测试通过现有 `npm test`、`npm run test:e2e` 进入 PR CI；检查窄窗口、键盘焦点和凭据不显示。发布安装包 smoke 保持现有门禁。夹具绿色与真实官方 frpc/外部服务端验收分开记录。
- 最大风险：将进程运行误表述为在线，或配对后示例 SSH 映射被隐式启动。备选为新增在线探测或自动 SSH 启动，均已被用户排除。回滚为撤销本任务的 UI/测试改动并恢复原配置页；用户已有配置文件和协议保持不变。
