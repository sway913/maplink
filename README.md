# 映链 MapLink

独立的端口映射管理项目：MapLink Server 运行官方原版 `frps`，自研控制面仅负责配置校验、失败回滚、凭据、端口和监控；MapLink Client 使用 Tauri WebView，并把官方 `frpc` 作为受控 sidecar。

## 目录

- `server/`：Go 管理 API、认证、配置渲染及 systemd 控制。
- `web/`：可静态部署的服务端管理界面。
- `client/`：Tauri 2 桌面客户端，支持 Windows x64 与 macOS Apple Silicon，负责服务器中转远程桌面、多设备 TCP/UDP 配置、交互式 SSH 远程终端以及原版 `frpc` 的受控启停、状态和日志。完整发布包内置官方 `frpc` 0.71.0；普通用户安装、连接、SSH 和远程控制步骤见 [客户端使用教程](client/README.md#普通用户快速上手)。

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
