import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('客户端把连接配置、远程控制和关于放在顶部 Tab', async () => {
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
  assert.match(html, /data-tab="remote"[^>]*>远程控制/);
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

test('远程控制页面通过标准 SSH 映射支持 Windows 与 macOS 命令行', async () => {
  const [html, script, rust, xterm, xtermLicense] = await Promise.all([
    read('../ui/index.html'),
    read('../ui/app.js'),
    read('../src-tauri/src/lib.rs'),
    read('../ui/vendor/xterm/xterm.js'),
    read('../ui/vendor/xterm/XTERM-LICENSE'),
  ]);

  for (const pattern of [
    /id="remote-page"/,
    /Windows OpenSSH Server/,
    /macOS 远程登录/,
    /开放本机控制入口/,
    /连接另一台设备/,
    /id="remote-host-public-port"/,
    /id="remote-host-feedback"/,
    /id="remote-target-port"/,
    /id="remote-device"/,
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
  assert.match(script, /online_ssh_devices/);
  assert.match(script, /在线设备列表已刷新/);
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
  assert.ok(xterm.length > 200_000);
  assert.match(xtermLicense, /MIT License|Permission is hereby granted/);
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
  assert.equal(windowsConfig.bundle.windows.webviewInstallMode.type, 'offlineInstaller');
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
});
