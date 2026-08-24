import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('客户端提供 MapLink 关于窗口和完整的开源归属信息', async () => {
  const [html, script, styles] = await Promise.all([
    read('../ui/index.html'),
    read('../ui/app.js'),
    read('../ui/styles.css'),
  ]);

  assert.match(html, /id="about-button"/);
  assert.match(html, /<dialog[^>]+id="about-dialog"/);
  assert.match(html, /映链/);
  assert.match(html, /MapLink/);
  assert.match(html, /版本\s*0\.1\.0/);
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
});

test('桌面窗口使用 MapLink 用户可见名称', async () => {
  const config = JSON.parse(await read('../src-tauri/tauri.conf.json'));

  assert.equal(config.productName, 'MapLink Client');
  assert.equal(config.app.windows[0].title, '映链 MapLink');
});

test('完整包和程序文件使用 MapLink 名称', async () => {
  const [buildScript, smokeTest, packageGuide, cargo] = await Promise.all([
    read('../scripts/build-complete.ps1'),
    read('./package-smoke.ps1'),
    read('../COMPLETE-PACKAGE.txt'),
    read('../src-tauri/Cargo.toml'),
  ]);

  for (const content of [buildScript, smokeTest, packageGuide]) {
    assert.match(content, /MapLink/);
    assert.doesNotMatch(content, /FRP-Desktop/);
  }
  assert.match(cargo, /name = "maplink-client"/);
});
