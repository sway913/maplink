# 映链 MapLink Client（WebView 客户端）

这是 MapLink 的 Windows WebView 客户端，界面使用 Tauri 2 承载，底层调用固定版本的官方 `frpc` sidecar。

当前阶段按部署要求：

- 已实现服务信息、Token、传输协议和多条 TCP/UDP 代理的编辑界面；
- 已实现配置校验、保存及原版 `frpc.toml` 生成；
- 完整发布包内置官方 `frpc.exe` 0.71.0，并保留官方许可证；
- 安装包内置 WebView2 离线安装程序，无网络环境也能完成运行环境安装；
- sidecar 只允许固定的 start/stop/status 命令，不向 WebView 暴露 Shell。

开发环境需要 Node.js、Rust 与 Tauri 2 CLI。`resources/frpc.exe` 来源于官方 `frp_0.71.0_windows_amd64.zip`，下载包 SHA-256 为 `9e5062e3e5cf07e67144a3a4acf175ef6a2486f3605dd6cf288bae34ab39819f`。

运行 `scripts/build-complete.ps1` 会生成完整 NSIS 安装包和便携 ZIP；便携版把 `frpc.exe` 放在应用旁边，安装版从 Tauri 资源目录加载内置程序。
