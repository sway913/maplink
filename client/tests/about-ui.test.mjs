import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('客户端提供 MapLink 关于窗口和完整的开源归属信息', async () => {
  const [html, script, styles, tauriConfig, packageConfig, cargo] = await Promise.all([
    read('../ui/index.html'),
    read('../ui/app.js'),
    read('../ui/styles.css'),
    read('../src-tauri/tauri.conf.json').then(JSON.parse),
    read('../package.json').then(JSON.parse),
    read('../src-tauri/Cargo.toml'),
  ]);
  const versionPattern = tauriConfig.version.replaceAll('.', '\\.');

  assert.match(html, /id="about-button"/);
  assert.match(html, /<dialog[^>]+id="about-dialog"/);
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
  assert.match(script, /showModal\(\)/);
  assert.match(script, /about-dialog/);
  assert.match(styles, /\.about-dialog/);
  assert.equal(packageConfig.version, tauriConfig.version);
  assert.match(cargo, new RegExp(`version = "${versionPattern}"`));
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
