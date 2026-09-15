import { expect, test } from '@playwright/test';

async function mockClient(page, savedProfile = null, initialStatus = { installed: true, running: false }) {
  await page.addInitScript(({ saved, initial }) => {
    const calls = [];
    let profile = saved;
    let status = { ...initial };
    window.__ONBOARDING_CALLS__ = calls;
    window.__TAURI__ = {
      event: { listen: async () => () => {}, emit: async () => {} },
      core: { invoke: async (command, args = {}) => {
        calls.push({ command, args });
        switch (command) {
          case 'load_profile':
            if (profile === 'LOAD_ERROR') throw new Error('配置文件无法解析');
            return profile;
            case 'client_status':
              if (status.error) throw new Error(status.error);
              return { ...status, frpcVersion: '0.71.0', pid: status.running ? 1234 : null, binaryPath: 'frpc', configPath: 'frpc.toml', logPath: 'frpc.log' };
          case 'client_logs': return 'fixture log';
          case 'remote_host_status': return { enabled: false, state: 'stopped', message: '未开启远程控制' };
          case 'remote_platform': return { platform: 'macos', label: 'macOS', username: 'tester' };
          case 'save_profile':
            if (status.saveErrorOnce) { delete status.saveErrorOnce; throw new Error('本机配置暂不可写'); }
            profile = args.profile; return null;
          case 'start_client': profile = args.profile; status = { installed: true, running: true }; return { ...status, frpcVersion: '0.71.0', pid: 1234, binaryPath: 'frpc', configPath: 'frpc.toml', logPath: 'frpc.log' };
          case 'stop_client': status = { installed: true, running: false }; return { ...status, frpcVersion: '0.71.0', pid: null, binaryPath: 'frpc', configPath: 'frpc.toml', logPath: 'frpc.log' };
          case 'enroll_device':
            if (!args.deviceId || 'deviceID' in args) throw new Error('deviceId argument required');
            if (args.pairingCode === 'BAD-BAD-BAD-BAD-BAD') throw new Error('配对码已过期');
            return { deviceID: args.deviceId, serverAddr: args.serverAddr, managerPort: args.managerPort, serverPort: 7001, controlPorts: [7001], token: 'fixture-paired-token-123456', deviceCredential: 'fixture-device-credential-123456', protocol: 'tcp' };
          default: return null;
        }
      } },
    };
  }, { saved: savedProfile, initial: initialStatus });
}

test('integration: 配对保存后仍待启动，失败可修正且身份变化要求重新配对', async ({ page }) => {
  await mockClient(page);
  await page.goto('/');
  await expect(page.locator('#onboarding')).toBeVisible();
  await page.locator('#deviceID').fill('new-device');
  await page.locator('#serverAddr').fill('   ');
  await page.locator('#onboarding-next').click();
  await expect(page.locator('#onboarding-error')).toContainText('有效');
  await expect(page.locator('#serverAddr')).toBeFocused();
  await page.locator('#serverAddr').fill('example.com');
  await page.locator('#onboarding-next').click();
  await expect(page.locator('#pairingCode')).toBeFocused();
  await page.locator('#pairingCode').fill('BAD-BAD-BAD-BAD-BAD');
  await page.locator('#enroll-device').click();
  await expect(page.locator('#pairing-feedback')).toContainText('配对码已过期');
  await page.locator('#pairingCode').fill('ABCDE-FGHIJ-KLMNO-PQRST');
  await page.locator('#enroll-device').click();
  await expect(page.locator('#pairing-feedback')).toContainText('设备配对成功');
  await expect(page.locator('#pairingCode')).toHaveValue('');
  await expect(page.locator('#onboarding')).toContainText('待启动');
  const calls = await page.evaluate(() => window.__ONBOARDING_CALLS__);
  expect(calls.some(({ command }) => command === 'save_profile')).toBe(true);
  expect(calls.some(({ command }) => command === 'start_client')).toBe(false);
  await page.locator('#deviceID').fill('changed-device');
  await expect(page.locator('#pairing-feedback')).toContainText('重新使用配对码');
  await expect(page.locator('#onboarding-start')).toBeDisabled();
});

test('e2e: 首次引导确认映射后才能启动并进入映射优先的概览', async ({ page }) => {
  await mockClient(page);
  await page.goto('/');
  await expect(page.locator('#onboarding-start')).toBeDisabled();
  await page.locator('#deviceID').fill('new-device');
  await page.locator('#serverAddr').fill('example.com');
  await page.locator('#onboarding-next').click();
  await page.locator('#pairingCode').fill('ABCDE-FGHIJ-KLMNO-PQRST');
  await page.locator('#enroll-device').click();
  await expect(page.locator('#onboarding-start')).toBeDisabled();
  await expect(page.locator('[data-field="name"]')).toBeFocused();
  await page.locator('#mapping-confirm').check();
  await page.locator('[data-field="remotePort"]').fill('30023');
  await expect(page.locator('#onboarding-start')).toBeDisabled();
  await page.locator('[data-field="remotePort"]').fill('');
  await page.locator('#mapping-confirm').check();
  await expect(page.locator('#onboarding-start')).toBeDisabled();
  await page.locator('[data-field="remotePort"]').fill('30023');
  await page.locator('#mapping-confirm').check();
  await page.locator('#onboarding-start').click();
  await expect(page.locator('#overview')).toBeVisible();
  await expect(page.locator('#overview-status')).toContainText('frpc 运行中');
  await expect(page.locator('#overview-status')).not.toContainText('服务器已连接');
  await expect(page.locator('#proxy-list')).toBeVisible();
  const commands = await page.evaluate(() => window.__ONBOARDING_CALLS__.map(({ command }) => command));
  expect(commands.indexOf('enroll_device')).toBeLessThan(commands.indexOf('start_client'));
  await page.locator('#stop-client').click();
  await expect(page.locator('#overview-status')).toContainText('已停止');
});

test('e2e: 已有旧 Token 配置直接进概览，编辑会标记未应用', async ({ page }) => {
  await mockClient(page, { deviceID: 'legacy', serverAddr: 'example.com', serverPort: 7000, managerPort: 7400, token: 'fixture-legacy-token-123456', deviceCredential: '', protocol: 'tcp', sshUser: '', remoteControlEnabled: false, remoteQuality: '1080p60', remoteClipboardEnabled: false, proxies: [{ name: 'web', type: 'tcp', localIP: '127.0.0.1', localPort: 8080, remotePort: 30080 }] }, { installed: true, running: true });
  await page.goto('/');
  await expect(page.locator('#overview')).toBeVisible();
  await expect(page.locator('#onboarding')).toBeHidden();
  await expect(page.locator('#overview')).toContainText('legacy');
  await expect(page.locator('#overview')).not.toContainText('fixture-legacy-token');
  await page.locator('[data-field="remotePort"]').fill('30081');
  await expect(page.locator('#unsaved-note')).toContainText('未应用');
  await expect(page.locator('#start-client')).toBeDisabled();
  await page.locator('#save-proxies').click();
  await expect(page.locator('#action-feedback')).toContainText('已保存');
  await expect(page.locator('#unsaved-note')).toContainText('未应用');
  await page.locator('#stop-client').click();
  await expect(page.locator('#unsaved-note')).toContainText('尚未应用');
  await page.locator('#start-client').click();
  await expect(page.locator('#unsaved-note')).toBeHidden();
});

test('e2e: 窄窗口中引导可用键盘完成，反馈可被读到', async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 720 });
  await mockClient(page);
  await page.goto('/');
  await expect(page.locator('#onboarding')).toBeVisible();
  await expect(page.locator('#pairing-feedback')).toHaveAttribute('aria-live', 'polite');
  await page.locator('#deviceID').focus();
  await expect(page.locator('#deviceID')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('#serverAddr')).toBeFocused();
  const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(horizontalOverflow).toBe(false);
});

test('integration: 已配对设备更改身份后不能以失效凭据启动', async ({ page }) => {
  await mockClient(page, { deviceID: 'paired', serverAddr: 'example.com', serverPort: 7000, managerPort: 7400, token: 'fixture-paired-token-123456', deviceCredential: 'fixture-credential-123456', protocol: 'tcp', sshUser: '', remoteControlEnabled: false, remoteQuality: '1080p60', remoteClipboardEnabled: false, proxies: [{ name: 'web', type: 'tcp', localIP: '127.0.0.1', localPort: 8080, remotePort: 30080 }] });
  await page.goto('/');
  await page.locator('#open-settings').click();
  await page.locator('#deviceID').fill('paired-changed');
  await expect(page.locator('#pairing-feedback')).toContainText('重新使用配对码');
  await expect(page.locator('#start-client')).toBeDisabled();
  const before = await page.evaluate(() => window.__ONBOARDING_CALLS__.filter(({ command }) => command === 'save_profile').length);
  await page.locator('#profile-footer button[type="submit"]').click();
  await expect(page.locator('#action-feedback')).toContainText('重新使用配对码');
  const after = await page.evaluate(() => window.__ONBOARDING_CALLS__.filter(({ command }) => command === 'save_profile').length);
  expect(after).toBe(before);
});

test('e2e: 旧服务器 Token 可完成引导而不会请求配对', async ({ page }) => {
  await mockClient(page);
  await page.goto('/');
  await page.locator('#serverAddr').fill('example.com');
  await page.locator('#onboarding-next').click();
  await page.locator('#use-legacy').click();
  await page.locator('#token').fill('fixture-legacy-token-123456');
  await page.locator('#legacy-next').click();
  await expect(page.locator('#onboarding-start')).toBeDisabled();
  await page.locator('#mapping-confirm').check();
  await page.locator('#onboarding-start').click();
  await expect(page.locator('#overview')).toBeVisible();
  const commands = await page.evaluate(() => window.__ONBOARDING_CALLS__.map(({ command }) => command));
  expect(commands).not.toContain('enroll_device');
  expect(commands).toContain('start_client');
});

test('integration: 配对后重新打开仍要求确认映射，直到成功启动', async ({ page }) => {
  await mockClient(page);
  await page.goto('/');
  await page.locator('#serverAddr').fill('example.com');
  await page.locator('#onboarding-next').click();
  await page.locator('#pairingCode').fill('ABCDE-FGHIJ-KLMNO-PQRST');
  await page.locator('#enroll-device').click();
  const saved = await page.evaluate(() => window.__ONBOARDING_CALLS__.findLast(({ command }) => command === 'save_profile').args.profile);
  await mockClient(page, saved);
  await page.reload();
  await expect(page.locator('#onboarding')).toBeVisible();
  await expect(page.locator('#onboarding-start')).toBeDisabled();
  await page.locator('#mapping-confirm').check();
  await page.locator('#onboarding-start').click();
  await page.reload();
  await expect(page.locator('#overview')).toBeVisible();
});

test('e2e: 状态读取失败与内置程序缺失都有明确恢复入口', async ({ page }) => {
  const saved = { deviceID: 'existing', serverAddr: 'example.com', serverPort: 7000, managerPort: 7400, token: 'fixture-legacy-token-123456', deviceCredential: '', protocol: 'tcp', sshUser: '', remoteControlEnabled: false, remoteQuality: '1080p60', remoteClipboardEnabled: false, proxies: [{ name: 'web', type: 'tcp', localIP: '127.0.0.1', localPort: 8080, remotePort: 30080 }] };
  await mockClient(page, saved, { installed: true, running: false, error: '状态暂不可读' });
  await page.goto('/');
  await expect(page.locator('#overview-status')).toContainText('状态读取失败');
  await expect(page.locator('#retry-runtime')).toBeVisible();
  await expect(page.locator('#start-client')).toBeDisabled();
  await mockClient(page, saved, { installed: false, running: false });
  await page.reload();
  await expect(page.locator('#overview-status')).toContainText('内置 frpc 缺失');
  await expect(page.locator('#start-client')).toBeDisabled();
  await mockClient(page, null, { installed: false, running: false });
  await page.reload();
  await expect(page.locator('#onboarding')).toBeVisible();
  await expect(page.locator('#runtime-warning')).toContainText('重新安装完整包');
});

test('e2e: 配置读取失败不会误入首次引导', async ({ page }) => {
  await mockClient(page, 'LOAD_ERROR');
  await page.goto('/');
  await expect(page.locator('#config-loading-title')).toContainText('本机配置读取失败');
  await expect(page.locator('#retry-profile')).toBeVisible();
  await expect(page.locator('#onboarding')).toBeHidden();
  await expect(page.locator('#overview')).toBeHidden();
});

test('integration: 服务端配对成功但本机保存失败时仍可修正并启动', async ({ page }) => {
  await mockClient(page, null, { installed: true, running: false, saveErrorOnce: true });
  await page.goto('/');
  await page.locator('#serverAddr').fill('example.com');
  await page.locator('#onboarding-next').click();
  await page.locator('#pairingCode').fill('ABCDE-FGHIJ-KLMNO-PQRST');
  await page.locator('#enroll-device').click();
  await expect(page.locator('#pairing-feedback')).toContainText('配对成功');
  await expect(page.locator('#pairing-feedback')).toContainText('未保存');
  await expect(page.locator('#onboarding')).toBeVisible();
  await page.locator('#mapping-confirm').check();
  await page.locator('#onboarding-start').click();
  await expect(page.locator('#overview')).toBeVisible();
});
