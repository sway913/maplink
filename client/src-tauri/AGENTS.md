# Rust 命令、OS 能力与 frpc sidecar

先读根 [AGENTS.md](../../AGENTS.md)、[client/AGENTS.md](../AGENTS.md) 和 [ui/AGENTS.md](../ui/AGENTS.md)。`src/lib.rs` 注册 Tauri 命令并管理配置、frpc 与 SSH 会话；`remote_control.rs` 处理远控及中转协议，`ssh_setup.rs` 处理平台 SSH 准备，`updates.rs` 处理安装包更新。`capabilities/main-events.json` 和 `tauri*.conf.json` 决定窗口权限与打包行为。

- 新命令必须核查 WebView 调用者、`generate_handler!` 注册、参数校验、错误映射及最小必要 ACL。用户传入的地址、端口、路径和 SSH 参数要在使用 OS/网络能力之前校验；不能交给 Shell 解释。
- `frpc` 沿用现有受控二进制解析策略及固定启停/状态动作，不能接受用户随意指定的执行路径。配置渲染、写入、进程生命周期和日志读取要有边界；官方二进制及许可证的打包证据与代码测试分开记录。
- 配对、设备身份、HMAC、远控会话、帧、输入和剪贴板协议改动，要同时追踪实际部署的服务端、主窗口、远控窗口及测试夹具。本仓库 Go 服务未注册配对和远控剪贴板端点，不能把它误当这些接口的提供者。旧协议不支持时明确报错，不能静默降级。
- Windows 与 macOS 的路径、权限、后台进程、OpenSSH、屏幕录制/辅助功能和更新安装分别检查。SSH 私钥只保存在本机；远控只有用户显式开启才可接受会话。
- 修改 CSP、`capabilities/`、窗口标识或事件权限后，必须用对应平台的打包 smoke 核验真实安装态；开发态和浏览器 mock 不能证明 ACL 可用。

先运行聚焦 `cargo test --locked <test-name>`；完成后从本目录运行 `cargo fmt --check` 和 `cargo test --locked`。原生或发布相关修改还应运行受影响平台的构建/包验收，并报告未验平台。
