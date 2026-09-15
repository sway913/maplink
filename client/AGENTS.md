# Tauri 客户端协作入口

先读根 [AGENTS.md](../AGENTS.md)。`ui/` 是 WebView 页面，`src-tauri/` 是 Rust 命令和 OS 能力；改跨层功能时还要读 [ui/AGENTS.md](ui/AGENTS.md) 与 [src-tauri/AGENTS.md](src-tauri/AGENTS.md)。`tests/` 有 Node 契约测试、Playwright 浏览器 E2E 和 Windows/macOS 安装包 smoke。

- 新用户行为先追踪 WebView 的 `invoke`/事件、Rust 注册点与返回类型、实际部署的服务端 API、测试模拟和安装态能力。参数名必须符合 Tauri 的 JS/Rust 映射；事件要核查两端监听/释放与 `capabilities/` ACL。配对及远控剪贴板端点未在本仓库 Go 服务中注册，相关协议必须核对独立服务端。
- 保留官方 `frpc` 受控 sidecar 的固定启停/状态语义；不允许可变执行路径或通过 Shell 拼接命令。配置、日志、凭据与 SSH 私钥要保持本机边界。
- 远控及 SSH 的安全行为同时覆盖 Windows x64、macOS Apple Silicon；权限请求应只在合适的用户操作中触发，并给出可恢复的提示。
- 改版本/发布时同步核对 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`、界面版本文本、Windows/macOS 配置、资源和脚本。内置 `frpc` 的版本与许可证必须可核验；不要只靠开发态运行判断发行包可用。

聚焦验证可运行 `npm test`、`npm run test:e2e`、`cargo test --locked`。Playwright 用模拟 Tauri API；Rust 测试和双平台安装包 smoke 才能补足原生命令、资源、ACL 和真实权限证据。明确写出实际验证的层次与平台。
