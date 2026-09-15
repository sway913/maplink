# WebView 页面与事件边界

先读根 [AGENTS.md](../../AGENTS.md)、[client/AGENTS.md](../AGENTS.md) 和 [src-tauri/AGENTS.md](../src-tauri/AGENTS.md)。`app.js`/`index.html` 是主窗口；`remote-viewer.js`/`remote-viewer.html` 是独立远控窗口。UI 通过 Tauri `invoke` 与事件使用 Rust 能力，不在页面中执行特权操作。

- 新命令或字段先确认 Rust `#[tauri::command]`、`generate_handler!`、请求/响应结构和服务端协议。保留参数命名及失败路径；不能让界面夹具成为接口真源。
- `listen`/`emit` 变更要列出主窗口与远控窗口的生产者、订阅者、取消订阅、生命周期及 `main-events` ACL；不要放宽为任意 OS 权限。
- 远控画面、输入和剪贴板改动要保持会话身份、最新帧语义、队列上限、文本大小和失败时释放会话。不能用失败的轮询结果继续显示“已连接”。
- 不在 DOM、浏览器存储、URL、截图或控制台中新增凭据/私钥暴露。加载、权限未就绪、空设备列表、断线和恢复必须分别提示。
- `ui/vendor/xterm/` 是第三方文件与许可证；不要直接编辑压缩库来修业务逻辑。

验证受影响的 `client/tests/*.test.mjs` 和 `client/tests/e2e/*.spec.mjs`，并运行 `node --check` 检查改动的 JS。浏览器 E2E 的 Tauri mock 不覆盖 Rust、系统权限和真实安装包。
