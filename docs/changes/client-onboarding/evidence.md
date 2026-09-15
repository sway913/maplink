# 客户端引导与控制台：验证证据

- 作者：Codex；来源：2026-09-15 本地执行；状态：accepted。命令从对应子目录运行。测试夹具只替代 Tauri 命令，不证明独立服务端、真实桌面权限或服务器在线。

## Red → Green

| 层 | Red 命令与原因 | Green 命令与结果 |
| --- | --- | --- |
| 单元 | `node --test tests/config-view-state.test.mjs`：状态模块尚不存在，`ERR_MODULE_NOT_FOUND`。追加映射有效性目标时，未校验字段导致 `true !== false`。 | 同命令：2/2 通过。 |
| 页面集成 | `npx playwright test --config /tmp/maplink-playwright-chrome.config.mjs client-onboarding.spec.mjs --grep 'integration:'`：`#onboarding` 不存在。追加身份变更目标时，`#start-client` 仍可用；追加保存目标时，失效凭据仍被保存；配对已成功但本机保存失败仍误报“配对失败”；空白服务器地址未在第一步拦截。 | 同配置运行目标：通过；完整浏览器回归含 4 个页面集成场景。 |
| 浏览器 E2E | 同配置 `--grep 'e2e:'`：`#onboarding-start`、`#overview` 不存在。追加映射有效性目标时，空远程端口仍允许启动；程序缺失时没有重新安装的恢复提示。 | 同配置运行目标：通过；完整浏览器回归含新旧流程、窄窗口和失败恢复场景。 |

首次执行 Playwright 标准命令因本机缺少 Chromium 而在浏览器启动前失败；`npx playwright install chromium` 下载超时。随后以已安装的 Google Chrome 和临时配置完成目标 Red/Green。最终回归时另一个独立 `maplink2` 工作区占用默认 `4173` 并提供不同页面；本仓库静态测试服务器新增可选 `MAPLINK_E2E_PORT`，本地临时配置改用 `4174` 后完整回归通过。CI 的 `npm run test:e2e` 在独立 runner 上仍安装并使用 Playwright Chromium，默认端口不变。临时配置不作为仓库产物。

## 回归与真实边界

- `cd client && npm ci && npm test`：锁文件安装完成，11/11 通过；Chrome 配置下完整 Playwright：18/18 通过；`node --check ui/app.js`、`config-view-state.mjs`、`remote-viewer.js`：通过；`git diff --check`：通过。
- `cd client/src-tauri && cargo fmt --check && cargo test --locked`：25/25 通过。首次 Rust 回归有 1 个 SSH 夹具失败：夹具直接使用 macOS 系统临时目录，生产权限函数尝试修改其父目录。改为独立临时子目录后原断言通过，未跳过测试。
- 内置官方 macOS ARM64 `frpc --version`：`0.71.0`；`frpc verify -c <非敏感临时配置>`：语法通过。此检查不证明远端 FRP 已接入。
- `./client/scripts/build-macos.sh` 和 `./client/tests/package-smoke-macos.sh ./dist`：通过；APP/DMG、SHA-256、签名及内置 frpc 已校验，APP 二进制包含 `/config-view-state.mjs`。本机包使用临时签名且未公证，不是可发布包结论。
- Windows x64 安装态与独立 `maplink-server` `/api/client/enroll` 真实版本/连接：`not_evaluated`。补验路径：PR CI 的 Windows job 与目标服务部署环境端到端验收；须记录服务版本与实际结果。
