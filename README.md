# 映链 MapLink

独立的端口映射管理项目：MapLink Server 运行官方原版 `frps`，自研控制面仅负责配置校验、失败回滚、凭据、端口和监控；MapLink Client 使用 Tauri WebView，并把官方 `frpc` 作为受控 sidecar。

## 目录

- `server/`：Go 管理 API、认证、配置渲染及 systemd 控制。
- `web/`：可静态部署的服务端管理界面。
- `client/`：Tauri 2 桌面客户端，支持 Windows x64 与 macOS Apple Silicon，负责服务器中转远程桌面、多设备 TCP/UDP 配置、交互式 SSH 远程终端以及原版 `frpc` 的受控启停、状态和日志。完整发布包内置官方 `frpc` 0.71.0。

## 客户端快速使用

客户端发行版在本项目的 [Releases](https://github.com/sway913/maplink/releases) 下载。Windows 推荐使用 `.exe` 安装包，也可以下载便携 ZIP；Apple Silicon Mac 下载 `.dmg`，打开后将 MapLink 拖入“应用程序”。

MapLink 需要连接自己部署的服务端。独立服务端项目地址：[sway913/maplink-server](https://github.com/sway913/maplink-server)，安装包与部署说明见 [MapLink Server Releases](https://github.com/sway913/maplink-server/releases)。

### 连接服务端

1. 打开客户端“连接配置”。
2. 为每台电脑填写不同的“设备标识”，例如 `office-pc`、`home-mac`。
3. 填写服务器域名或 IP（不要带 `http://`）、FRP 接入端口、管理端口和 Token。默认接入端口从 `7000` 开始，管理端口为 `7400`。
4. 不确定传输协议时保持 `TCP`，然后点击“保存并启动”。状态显示原版 frpc 已运行即连接成功。

Token 从自己的 MapLink Server 管理台取得，相当于客户端接入密码，不要截图、公开或提交到源码。

### SSH 终端

1. 两台电脑都进入“远程连接 → SSH 连接”。Windows 缺少 OpenSSH 时点击“安装并启用 OpenSSH”；macOS 按提示开启“远程登录”。
2. 在每台被连接的电脑填写本机 SSH 用户名和唯一的公网端口，点击“添加本机 SSH 映射”，再保存并启动 frpc。例如 A 使用 `30022`、B 使用 `30023`。
3. 在控制端手动填写对方系统、SSH 用户名和公网端口，点击“连接终端”。连接后直接在下方终端输入命令，目录切换、ANSI 颜色和方向键历史会保留在同一会话中。

MapLink 使用独立 Ed25519 密钥完成免密连接，私钥只保存在创建它的设备。

### 远程桌面

1. 两台电脑使用相同的服务器、管理端口和 Token，并使用不同设备标识。
2. 被控端进入“远程连接 → 远程控制”，勾选“允许其他 MapLink 设备控制本机”。
3. Windows 接受管理员权限提示；macOS 首次使用时授予“屏幕录制”和“辅助功能”权限。
4. 控制端刷新在线设备，选择目标后点击“远程连接”。服务端只在内存中中转画面和输入，不录屏、不落盘。

### 更新与常见问题

- 在“关于”页点击“检查更新”，客户端会下载 GitHub 最新发行版、校验 SHA-256 并启动安装程序。
- SSH 出现 `Connection timed out`：确认双方 frpc 正在运行、公网端口填写正确且服务器防火墙已放行。
- SSH 出现 `Permission denied`：核对对方用户名，并确认被控端 OpenSSH 已启动、MapLink 公钥已授权。
- 远程设备列表为空：确认两端连接信息一致、设备标识不同，并在被控端开启允许远程控制。
- 远程桌面有画面但不能操作：Windows 重新以管理员身份启动；macOS 检查“屏幕录制”和“辅助功能”权限。

## 服务端安全边界

- FRP 原生仪表盘只监听 `127.0.0.1`，由管理 API 代理允许的只读资源。
- 管理页面使用 HTTPS、HttpOnly/SameSite 会话、CSRF Token 和登录限速。
- 管理员可在“安全设置”中校验当前密码并修改登录密码；新密码以 PBKDF2-SHA256 加盐哈希持久化，修改后注销全部管理会话。
- 配置保存先执行 `frps verify`；重启失败自动恢复旧配置。
- 客户端接入端口段由独立 nftables 表在内核中透明重定向到原版 `frps.bindPort`；入口失败同样参与配置回滚。
- 多台客户端通过独立 `clientID` / `user` 区分，可分别选择接入端口并配置多条 TCP/UDP 代理。
- 服务操作限定为 start/stop/restart，日志接口限定读取 `frps.service`，没有任意 Shell API。
- 远程控制使用用户显式配置的 SSH 映射和系统 OpenSSH 客户端；服务端只转发 TCP，不提供后台命令执行 API，也不保存 SSH 密码或私钥。远控建立时服务端仅在内存中转发 MapLink 专用公钥，私钥永不离开创建它的设备。
- 当前客户端的 SSH 连接信息由用户手动填写，不再自动查询在线 SSH 设备；远程桌面设备列表只返回在线设备元数据，不返回 Token、管理凭据或命令历史。
- 远程桌面请求使用带随机数、时间戳和正文摘要的 HMAC；被控端需显式开启，服务端仅在内存保留最新画面和有上限的输入队列，失活后自动删除。

## 本地验证

```powershell
cd server
go test ./...
go vet ./...

cd ../web
npm run lint
npm run build:static
npm run build

cd ../client/src-tauri
cargo fmt --check
cargo test
cargo build

cd ..
node --check ui/app.js
```

## 自动构建与发布

- 推送到 `main`：自动执行服务端、Web、客户端测试，并在 Windows 与 Apple Silicon macOS 构建机上并行生成 NSIS、便携 ZIP、DMG、APP ZIP 和 SHA-256 校验文件。
- 提交 Pull Request：自动执行同一套代码检查，但不生成或发布安装包。
- 发布新版本：同步修改客户端版本号并推送到 `main`；当对应 Release 尚不存在时，Actions 会等待云端 E2E 和两个平台构建成功，再自动创建 `v<版本号>` 标签、生成发布说明并上传全部安装包。
- 推送已有的 `v*` 标签也会触发同一套发布流程；标签与应用版本不一致时会拒绝发布。
