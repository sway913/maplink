import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('服务端控制台统一使用 MapLink 品牌和新图标', async () => {
  const [layout, page, styles] = await Promise.all([
    read('../app/layout.tsx'),
    read('../app/page.tsx'),
    read('../app/globals.css'),
  ]);

  assert.match(layout, /映链 MapLink/);
  assert.match(layout, /maplink-icon\.png/);
  assert.match(layout, /og\.png/);
  assert.doesNotMatch(layout, /title:\s*['"]FRP Manager/);
  assert.match(page, /映链 MapLink/);
  assert.match(page, /MAPLINK SERVER CONSOLE/);
  assert.doesNotMatch(page, />FRP Manager</);
  assert.doesNotMatch(page, /brand-mark">F</);
  assert.match(styles, /maplink-icon\.png/);
  await access(new URL('../public/maplink-icon.png', import.meta.url));
  await access(new URL('../public/og.png', import.meta.url));
});
