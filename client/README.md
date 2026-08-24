# 映链 MapLink Client（WebView 客户端）

这是 MapLink 的 Windows / macOS 桌面客户端，界面使用 Tauri 2 承载：Windows 使用 WebView2，macOS 使用系统 WKWebView，底层调用固定版本的官方 `frpc` sidecar。

当前阶段按部署要求：

- 已实现服务信息、Token、传输协议和多条 TCP/UDP 代理的编辑界面；
- 已实现配置校验、保存及原版 `frpc.toml` 生成；
- Windows x64 发布包内置官方 `frpc.exe` 0.71.0 与 WebView2 离线安装程序；
- macOS Apple Silicon 发布包内置官方 `frpc` 0.71.0，直接使用系统 WKWebView；
- 两个平台都保留官方许可证；
- sidecar 只允许固定的 start/stop/status 命令，不向 WebView 暴露 Shell。

开发环境需要 Node.js、Rust 与 Tauri 2 CLI。`resources/frpc.exe` 来源于官方 `frp_0.71.0_windows_amd64.zip`，下载包 SHA-256 为 `9e5062e3e5cf07e67144a3a4acf175ef6a2486f3605dd6cf288bae34ab39819f`；`resources/frpc` 来源于官方 `frp_0.71.0_darwin_arm64.tar.gz`，下载包 SHA-256 为 `45be02b186860d375ed49a8941ae9569628a54bf14e67fc36b29c98c99dabcc6`。

Windows 运行 `scripts/build-complete.ps1` 生成 NSIS 安装包和便携 ZIP；Apple Silicon Mac 运行 `scripts/build-macos.sh` 生成 DMG 和 APP ZIP。推送新版本到 `main` 后，GitHub Actions 会自动完成两个平台的打包与 Release 发布。
