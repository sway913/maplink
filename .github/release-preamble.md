映链 MapLink 桌面客户端：

- 多设备 TCP/UDP 端口映射，可选 TCP、KCP、QUIC 传输。
- 内置官方 frpc，支持配置保存、启停、状态和日志查看。
- Windows 与 macOS 均支持双向 SSH 远程控制：每台设备既能开放本机入口，也能在 MapLink 内控制另一台设备。
- 在线设备可直接选择并自动填写平台、SSH 用户名和公网端口。
- SSH 命令历史保存在本机；Windows 客户端、frpc 和 SSH 均不弹出终端窗口。
- 自动复用已有 SSH 映射，提供连接检测、命令执行、退出码与输出查看。
- 支持 Windows x64 和 macOS Apple Silicon；服务端可统一查看客户端与代理。
- 提供 NSIS、便携 ZIP、DMG、APP ZIP 与 SHA-256 校验文件。

macOS 包采用临时签名，尚未使用 Apple 开发者证书公证；首次打开时请在系统设置中确认。
