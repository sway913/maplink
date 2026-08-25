# 映链 MapLink Client（WebView 客户端）

这是 MapLink 的 Windows / macOS 桌面客户端，界面使用 Tauri 2 承载：Windows 使用 WebView2，macOS 使用系统 WKWebView，底层调用固定版本的官方 `frpc` sidecar。

当前阶段按部署要求：

- 已实现服务信息、Token、传输协议和多条 TCP/UDP 代理的编辑界面；
- 已实现配置校验、保存及原版 `frpc.toml` 生成；
- Windows x64 发布包内置官方 `frpc.exe` 0.71.0 与 WebView2 离线安装程序；
- macOS Apple Silicon 发布包内置官方 `frpc` 0.71.0，直接使用系统 WKWebView；
- 两个平台都提供“远程控制”页面，可把 B 机器的 SSH 服务通过 frpc 映射给 A 机器，并生成可供终端或 Codex 使用的标准 SSH 命令；
- 两个平台都保留官方许可证；
- frpc sidecar 只允许固定的 start/stop/status 命令；远程命令由系统 OpenSSH 客户端直接执行，不经过本地 Shell 拼接。

## 远程命令控制（SSH）

1. 在需要互相控制的每台机器启用 SSH。macOS 在“系统设置 → 通用 → 共享”中开启“远程登录”；Windows 安装并启动 OpenSSH Server。
2. 为双方的最小权限账号配置 SSH 公钥登录。MapLink 不保存 SSH 密码或私钥。
3. A、B 两台机器都在 MapLink“远程控制 → 开放本机控制入口”添加自己的 SSH 映射，通常把 `127.0.0.1:22` 映射到服务端允许范围内的不同端口，例如 A 使用 `30022`、B 使用 `30023`，然后分别保存配置并启动 frpc。页面会自动识别并复用已有的 SSH 映射。
4. A 要控制 B，就在“连接另一台设备”填写 B 的 SSH 用户名和 `30023`；B 要控制 A，则填写 A 的用户名和 `30022`。
5. 页面生成的 `ssh -p <对方公网端口> <对方用户>@<服务端地址>` 可直接交给 Codex，也可以在 MapLink 页面执行远程命令。

页面内置连接检测和远程命令面板，无需再打开外部终端；默认 30 秒超时，最多保留 256 KB 输出。除首次启用系统 SSH/远程登录及配置系统账号密钥外，双向映射、连接检测与日常远程控制都在 MapLink 内完成。所有权限均由被控机器的 SSH 账号、密钥和系统授权决定。

开发环境需要 Node.js、Rust 与 Tauri 2 CLI。`resources/frpc.exe` 来源于官方 `frp_0.71.0_windows_amd64.zip`，下载包 SHA-256 为 `9e5062e3e5cf07e67144a3a4acf175ef6a2486f3605dd6cf288bae34ab39819f`；`resources/frpc` 来源于官方 `frp_0.71.0_darwin_arm64.tar.gz`，下载包 SHA-256 为 `45be02b186860d375ed49a8941ae9569628a54bf14e67fc36b29c98c99dabcc6`。

Windows 运行 `scripts/build-complete.ps1` 生成 NSIS 安装包和便携 ZIP；Apple Silicon Mac 运行 `scripts/build-macos.sh` 生成 DMG 和 APP ZIP。推送新版本到 `main` 后，GitHub Actions 会自动完成两个平台的打包与 Release 发布。
