# Go 服务与 FRP 控制面

先读根 [AGENTS.md](../AGENTS.md)。`cmd/frp-manager/` 是启动入口；`internal/manager/server.go` 注册 HTTP API，`apply.go` 负责配置应用及回滚，`remote.go` 维护远控会话，`system.go` 调用受控系统操作；`internal/frp/` 验证并渲染原版 `frps` 配置，`internal/auth/` 管理密码哈希。

- 新增或改动 `/api/*` 前，搜索 `web/app/page.tsx`、`client/src-tauri/src/`、服务端测试和部署调用者。明确请求字段、认证/CSRF、响应、错误及旧客户端兼容行为。
- 管理端点保持已认证会话、CSRF 和登录限速；设备/远控端点保持设备身份、HMAC、时间戳与会话边界。不能把敏感字段放进设备列表、日志或错误。
- `frps` 是数据面。配置只经 `internal/frp` 校验/渲染及官方 `frps verify` 后应用；更改 `Store.Apply` 要覆盖验证失败、写入失败、重启失败、nftables 入口失败和回滚失败。
- systemd、nftables、FRP dashboard 只暴露固定操作和允许的只读资源，不添加任意命令或代理访问。
- 远控会话仅在内存中保留必要状态；改帧、输入、剪贴板或 SSH 公钥传递时核查身份、大小/队列上限、失活清理、并发及不落盘语义，同时追踪两个客户端方向。

局部验证先运行 `go test ./internal/<area>`，完成后运行 `go test ./...` 与 `go vet ./...`。外部 `frps`、systemd 或 nftables 的夹具不等于真实 VPS 验收；部署相关变更需说明真实环境验证状态。此目录的配置和凭据文件应保持受限权限。
