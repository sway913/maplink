import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('客户端把连接配置、远程连接和关于放在顶部 Tab', async () => {
  const [html, script, styles, tauriConfig, packageConfig, cargo] = await Promise.all([
    read('../ui/index.html'),
    read('../ui/app.js'),
    read('../ui/styles.css'),
    read('../src-tauri/tauri.conf.json').then(JSON.parse),
    read('../package.json').then(JSON.parse),
    read('../src-tauri/Cargo.toml'),
  ]);
  const versionPattern = tauriConfig.version.replaceAll('.', '\\.');

  assert.match(html, /class="top-tabs"/);
  assert.match(html, /data-tab="config"[^>]*>连接配置/);
  assert.match(html, /data-tab="remote"[^>]*>远程连接/);
  assert.match(html, /data-tab="about"[^>]*>关于/);
  assert.match(html, /id="about-page"/);
  assert.match(html, /映链/);
  assert.match(html, /MapLink/);
  assert.match(html, new RegExp(`版本\\s*${versionPattern}`));
  assert.match(html, /Powered by frp/);
  assert.match(html, /github\.com\/fatedier\/frp/);
  assert.match(html, /Apache License 2\.0/);
  assert.match(html, /maplink-icon\.png/);
  assert.doesNotMatch(html, /class="brand">F</);
  assert.doesNotMatch(html, /82\.158\.91\.82/);
  assert.match(html, /id="serverAddr"\s+value=""/);
  assert.match(script, /function switchTab/);
  assert.doesNotMatch(script, /showModal\(\)/);
  assert.doesNotMatch(html, /<dialog/);
  assert.match(styles, /\.top-tabs/);
  assert.match(styles, /\.about-page/);
  assert.equal(packageConfig.version, tauriConfig.version);
  assert.equal(packageConfig.dependencies['@xterm/xterm'], '5.5.0');
  assert.equal(packageConfig.dependencies['@xterm/addon-fit'], '0.10.0');
  assert.match(tauriConfig.app.security.csp, /style-src 'self' 'unsafe-inline'/);
  assert.match(cargo, new RegExp(`version = "${versionPattern}"`));
});

test('SSH 页面自动配置 Windows 与 macOS OpenSSH，并且私钥只保留本机', async () => {
  const [html, script, rust, sshSetup, remoteControl, server, xterm, xtermLicense, tauriConfig, eventCapability] = await Promise.all([
    read('../ui/index.html'),
    read('../ui/app.js'),
    read('../src-tauri/src/lib.rs'),
    read('../src-tauri/src/ssh_setup.rs'),
    read('../src-tauri/src/remote_control.rs'),
    read('../../server/internal/manager/remote.go'),
    read('../ui/vendor/xterm/xterm.js'),
    read('../ui/vendor/xterm/XTERM-LICENSE'),
    read('../src-tauri/tauri.conf.json').then(JSON.parse),
    read('../src-tauri/capabilities/main-events.json').then(JSON.parse),
  ]);

  for (const pattern of [
    /id="remote-page"/,
    /id="remote-ssh-tab"/,
    /data-remote-mode="ssh"[^>]*>SSH 连接/,
    /id="remote-ssh-panel"/,
    /id="ssh-readiness"/,
    /id="install-openssh"/,
    /id="refresh-ssh-readiness"/,
    /Windows OpenSSH Server/,
    /macOS 远程登录/,
    /开放本机控制入口/,
    /连接另一台设备/,
    /id="remote-host-public-port"/,
    /id="remote-host-feedback"/,
    /id="remote-target-port"/,
    /id="add-remote-mapping"/,
    /id="test-remote-session"/,
    /id="disconnect-remote-shell"/,
    /id="remote-terminal"/,
    /vendor\/xterm\/xterm\.css/,
    /vendor\/xterm\/xterm\.js/,
  ]) assert.match(html, pattern);

  assert.match(script, /ssh -p/);
  assert.match(script, /服务器地址格式无效/);
  assert.match(script, /SSH 用户名格式无效/);
  assert.doesNotMatch(html, /RDP \/ VNC/);
  assert.doesNotMatch(html, /id="remote-command"/);
  assert.doesNotMatch(html, /id="remote-command-history"/);
  assert.doesNotMatch(html, /id="remote-output"/);
  assert.doesNotMatch(html, /id="remote-device"/);
  assert.doesNotMatch(html, /id="refresh-remote-devices"/);
  assert.doesNotMatch(script, /online_ssh_devices/);
  assert.match(script, /ssh_readiness/);
  assert.match(script, /install_openssh/);
  assert.match(script, /checkSSHReadiness/);
  assert.match(script, /可能连带下载约 200 MB 系统组件/);
  assert.match(script, /sshInstallProgressTimer/);
  assert.match(script, /new window\.Terminal/);
  assert.match(script, /start_remote_shell/);
  assert.match(script, /write_remote_shell/);
  assert.match(script, /terminal\.onData/);
  assert.match(script, /localIP: '127\.0\.0\.1'/);
  assert.match(script, /localPort/);
  assert.match(script, /remotePort/);
  assert.match(script, /syncRemoteHostMapping/);
  assert.match(html, /value="30022"/);
  assert.match(html, /value="30023"/);
  assert.doesNotMatch(html, /value="2302[23]"/);
  assert.match(rust, /async fn run_remote_command/);
  assert.match(rust, /fn start_remote_shell/);
  assert.match(rust, /fn write_remote_shell/);
  assert.match(rust, /"-tt"\.into\(\)/);
  assert.match(rust, /powershell\.exe -NoExit/);
  assert.match(rust, /BatchMode=yes/);
  assert.match(rust, /ConnectTimeout=8/);
  assert.match(rust, /REMOTE_COMMAND_TIMEOUT/);
  assert.match(rust, /REMOTE_OUTPUT_LIMIT/);
  assert.match(rust, /remote_platform/);
  assert.match(rust, /hide_windows_console\(&mut command\)/);
  assert.match(rust, /online_ssh_devices/);
  assert.match(rust, /ssh_readiness/);
  assert.match(rust, /install_openssh/);
  assert.match(sshSetup, /maplink_ed25519/);
  assert.match(sshSetup, /OpenSSH\.Client/);
  assert.match(sshSetup, /OpenSSH\.Server/);
  assert.match(sshSetup, /Get-WindowsCapability/);
  assert.match(sshSetup, /State -ne 'Installed'/);
  assert.match(sshSetup, /systemsetup -setremotelogin on/);
  assert.match(sshSetup, /authorized_keys/);
  assert.match(sshSetup, /administrators_authorized_keys/);
  assert.match(sshSetup, /IdentitiesOnly=yes/);
  assert.doesNotMatch(remoteControl, /private.?key/i);
  assert.match(remoteControl, /controllerSSHPublicKey/);
  assert.match(remoteControl, /sshAuthorized/);
  assert.match(server, /SSHPublicKey/);
  assert.match(server, /validSSHPublicKey/);
  assert.deepEqual(tauriConfig.app.security.capabilities, ['main-events']);
  assert.deepEqual(eventCapability.windows, ['main']);
  assert.deepEqual(eventCapability.permissions.sort(), [
    'core:event:allow-listen',
    'core:event:allow-unlisten',
  ]);
  assert.ok(xterm.length > 200_000);
  assert.match(xtermLicense, /MIT License|Permission is hereby granted/);
});

test('v0.6.1 通过二级 Tab 提供可靠的服务器中转远程桌面列表', async () => {
  const [html, script, rust, server, buildScript] = await Promise.all([
    read('../ui/index.html'),
    read('../ui/app.js'),
    read('../src-tauri/src/remote_control.rs'),
    read('../../server/internal/manager/remote.go'),
    read('../src-tauri/build.rs'),
  ]);

  for (const pattern of [
    /id="remote-control-enabled"/,
    /id="remote-desktop-tab"/,
    /data-remote-mode="desktop"[^>]*>远程控制/,
    /id="remote-desktop-panel"/,
    /id="desktop-device"/,
    /id="connect-remote-desktop"/,
    /id="disconnect-remote-desktop"/,
    /id="remote-screen"/,
    /SERVER RELAY/,
  ]) assert.match(html, pattern);
  assert.match(script, /function switchRemoteMode/);
  for (const command of [
    'start_remote_host',
    'remote_control_devices',
    'start_remote_control',
    'remote_control_frame',
    'send_remote_control_input',
    'stop_remote_control',
  ]) assert.match(script, new RegExp(command));
  assert.match(rust, /capture_image/);
  assert.match(rust, /JpegEncoder/);
  assert.match(rust, /move_mouse/);
  assert.match(rust, /danger_accept_invalid_certs/);
  assert.match(rust, /ACCEPT_ENCODING, "identity"/);
  assert.match(rust, /已重试 3 次/);
  assert.match(script, /option\(available\.length \? `选择在线设备（\$\{available\.length\}）` : '暂无在线'\)/);
  assert.match(script, /远程设备列表已刷新，当前没有其他可远控设备/);
  assert.match(script, /设备读取失败/);
  assert.match(script, /需要系统授权/);
  assert.match(script, /refreshRemoteControlDevices\(\)/);
  assert.doesNotMatch(script, /device\.permission === 'ready'\);/);
  assert.match(server, /remoteFrameLimit/);
  assert.match(server, /remoteSignature/);
  assert.match(server, /remoteSessionTTL/);
  assert.match(buildScript, /requireAdministrator/);
  assert.doesNotMatch(server, /WriteFile|os\.WriteFile/);
});

test('关于页可从 GitHub 校验并启动最新版安装程序', async () => {
  const [html, script, rust] = await Promise.all([
    read('../ui/index.html'),
    read('../ui/app.js'),
    read('../src-tauri/src/updates.rs'),
  ]);

  assert.match(html, /id="check-update"/);
  assert.match(html, /id="update-status"/);
  assert.match(html, /SHA-256/);
  assert.match(script, /check_for_update/);
  assert.match(script, /download_and_install_update/);
  assert.match(rust, /api\.github\.com\/repos\/sway913\/maplink\/releases\/latest/);
  assert.match(rust, /RELEASE_DOWNLOAD_PREFIX/);
  assert.match(rust, /verify_download/);
  assert.match(rust, /launch_installer/);
  assert.match(rust, /Sha256::digest/);
});

test('桌面窗口使用 MapLink 用户可见名称', async () => {
  const config = JSON.parse(await read('../src-tauri/tauri.conf.json'));

  assert.equal(config.productName, 'MapLink Client');
  assert.equal(config.app.windows[0].title, '映链 MapLink');
});

test('Windows 与 macOS 使用独立原版 frpc 和原生 WebView 打包配置', async () => {
  const [windowsConfig, macosConfig, readme] = await Promise.all([
    read('../src-tauri/tauri.windows.conf.json').then(JSON.parse),
    read('../src-tauri/tauri.macos.conf.json').then(JSON.parse),
    read('../README.md'),
  ]);

  assert.deepEqual(windowsConfig.bundle.targets, ['nsis']);
  assert.equal(windowsConfig.bundle.resources['resources/frpc.exe'], 'frpc.exe');
  assert.equal(windowsConfig.bundle.windows.webviewInstallMode.type, 'downloadBootstrapper');
  assert.deepEqual(macosConfig.bundle.targets, ['app', 'dmg']);
  assert.equal(macosConfig.bundle.resources['resources/frpc'], 'frpc');
  assert.equal(macosConfig.bundle.macOS.minimumSystemVersion, '11.0');
  assert.match(readme, /WKWebView/);
});

test('完整包和程序文件使用 MapLink 名称', async () => {
  const [buildScript, macBuildScript, smokeTest, macSmokeTest, packageGuide, cargo] = await Promise.all([
    read('../scripts/build-complete.ps1'),
    read('../scripts/build-macos.sh'),
    read('./package-smoke.ps1'),
    read('./package-smoke-macos.sh'),
    read('../COMPLETE-PACKAGE.txt'),
    read('../src-tauri/Cargo.toml'),
  ]);

  for (const content of [buildScript, macBuildScript, smokeTest, macSmokeTest, packageGuide]) {
    assert.match(content, /MapLink/);
    assert.doesNotMatch(content, /FRP-Desktop/);
  }
  assert.match(cargo, /name = "maplink-client"/);
  assert.match(buildScript, /200MB/);
  assert.match(smokeTest, /200MB/);
  assert.match(macBuildScript, /200 \* 1024 \* 1024/);
  assert.match(macSmokeTest, /200 \* 1024 \* 1024/);
});

test('云端 E2E 覆盖远程协议、二级 Tab 和浏览器连接流程', async () => {
  const [workflow, config, spec] = await Promise.all([
    read('../../.github/workflows/release.yml'),
    read('../playwright.config.mjs'),
    read('./e2e/remote-connections.spec.mjs'),
  ]);
  assert.match(workflow, /cloud-e2e:/);
  assert.match(workflow, /TestRemoteRelayAuthenticatesAndMovesFramesAndInputWithoutPersistence/);
  assert.match(workflow, /playwright install --with-deps chromium/);
  assert.match(workflow, /npm run test:e2e/);
  assert.match(config, /127\.0\.0\.1:4173/);
  assert.match(spec, /start_remote_control/);
  assert.match(spec, /暂无在线/);
});
