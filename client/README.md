# 映链 MapLink Client（WebView 客户端）

这是 MapLink 的 Windows / macOS 桌面客户端，界面使用 Tauri 2 承载：Windows 使用 WebView2，macOS 使用系统 WKWebView，底层调用固定版本的官方 `frpc` sidecar。

当前阶段按部署要求：

- 已实现服务信息、Token、传输协议和多条 TCP/UDP 代理的编辑界面；
- 已实现配置校验、保存及原版 `frpc.toml` 生成；
- Windows x64 发布包内置官方 `frpc.exe` 0.71.0 与 WebView2 离线安装程序；
- macOS Apple Silicon 发布包内置官方 `frpc` 0.71.0，直接使用系统 WKWebView；
- v0.5.0 在“远程控制”页顶部加入服务器中转远程桌面，可从在线设备列表直接建立会话并实时发送画面、鼠标、键盘和滚轮事件；
- v0.5.1 修复开启远控主机后、无会话时权限探测也会释放鼠标右键的问题，并补全服务端远控能力标识；
- v0.5.2 在“关于”页加入 GitHub 发行版检查、SHA-256 校验、自动启动安装程序，并让远控列表定时刷新且明确区分空列表、权限未就绪与读取失败；
- 被控端必须显式开启“允许其他 MapLink 设备控制本机”；服务端仅在内存中保留最新一帧和有上限的输入队列，超时自动回收，不录屏、不落盘；
- Windows 客户端通过应用清单要求管理员权限，以便控制提升权限的窗口；macOS 首次使用会请求“屏幕录制”和“辅助功能”系统权限；
- 两个平台都提供“远程控制”页面，可把 B 机器的 SSH 服务通过 frpc 映射给 A 机器，并生成可供终端或 Codex 使用的标准 SSH 命令；
- frpc 在线后，远程控制页会从服务端发现已开放 SSH 的在线设备，选择设备即可自动填写其平台、SSH 用户名和公网端口；
- 远程控制页内置持久的交互式 SSH 终端：Windows 直接进入 PowerShell，macOS 进入默认登录 Shell，原生支持提示符、ANSI 输出、方向键历史、持续工作目录和交互程序；
- Windows 客户端及其启动的 frpc、OpenSSH 进程均以后台模式运行，不弹出终端窗口；
- 两个平台都保留官方许可证；
- frpc sidecar 只允许固定的 start/stop/status 命令；交互式终端由系统 OpenSSH 客户端直接建立，不经过本地 Shell 拼接。

## 服务器中转远程桌面

1. 在两台设备填写同一 MapLink 服务器地址、管理端口和 Token，并分别使用不同的设备标识。
2. 在被控设备勾选“允许其他 MapLink 设备控制本机”。Windows 接受 UAC 管理员提示；macOS 在系统设置中允许 MapLink 的“屏幕录制”和“辅助功能”。
3. 控制端在第二个 Tab 顶部的“远程桌面”区域选择在线设备并点击“远程连接”，随后直接在画面中使用鼠标、键盘和滚轮。
4. 画面和输入经管理服务 HMAC 认证后中转，不要求额外公网端口；一台设备同一时间只允许一个活动控制会话。

## 交互式远程终端（SSH）

1. 在需要互相控制的每台机器启用 SSH。macOS 在“系统设置 → 通用 → 共享”中开启“远程登录”；Windows 安装并启动 OpenSSH Server。
2. 为双方的最小权限账号配置 SSH 公钥登录。MapLink 不保存 SSH 密码或私钥。
3. A、B 两台机器都在 MapLink“远程控制 → 开放本机控制入口”添加自己的 SSH 映射，通常把 `127.0.0.1:22` 映射到服务端允许范围内的不同端口，例如 A 使用 `30022`、B 使用 `30023`，然后分别保存配置并启动 frpc。页面会自动识别并复用已有的 SSH 映射。
4. A 要控制 B，直接在“连接另一台设备”选择在线的 B；B 要控制 A，同样选择在线的 A。旧配置未包含设备元数据时仍可手动填写用户名和公网端口。
5. 点击“连接终端”后直接在下方终端操作。Windows 会进入持续的 PowerShell 会话，macOS 会进入远端账号的默认登录 Shell。

终端直接呈现远端 Shell 的提示符、ANSI 颜色和输出，键盘输入、方向键历史、工作目录变化及交互程序都保留在同一 SSH 会话中，无需再打开外部终端。除首次启用系统 SSH/远程登录及配置系统账号密钥外，双向映射、设备选择、连接和日常远程控制都在 MapLink 内完成。所有权限均由被控机器的 SSH 账号、密钥和系统授权决定。

开发环境需要 Node.js、Rust 与 Tauri 2 CLI。`resources/frpc.exe` 来源于官方 `frp_0.71.0_windows_amd64.zip`，下载包 SHA-256 为 `9e5062e3e5cf07e67144a3a4acf175ef6a2486f3605dd6cf288bae34ab39819f`；`resources/frpc` 来源于官方 `frp_0.71.0_darwin_arm64.tar.gz`，下载包 SHA-256 为 `45be02b186860d375ed49a8941ae9569628a54bf14e67fc36b29c98c99dabcc6`。

Windows 运行 `scripts/build-complete.ps1` 生成 NSIS 安装包和便携 ZIP；Apple Silicon Mac 运行 `scripts/build-macos.sh` 生成 DMG 和 APP ZIP。推送新版本到 `main` 后，GitHub Actions 会自动完成两个平台的打包与 Release 发布。
