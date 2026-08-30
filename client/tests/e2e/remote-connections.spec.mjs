import { expect, test } from '@playwright/test';

const profile = {
  deviceID: 'local-e2e',
  serverAddr: '127.0.0.1',
  serverPort: 7000,
  managerPort: 7400,
  token: 'e2e-token-0123456789',
  protocol: 'tcp',
  sshUser: 'tester',
  remoteControlEnabled: true,
  proxies: [{ name: 'ssh-e2e', type: 'tcp', localIP: '127.0.0.1', localPort: 22, remotePort: 30022 }],
};

async function installTauriMock(page, remoteDevices, sshInitiallyReady = true) {
  await page.addInitScript(({ savedProfile, devices, sshReady }) => {
    const calls = [];
    let openSSHReady = sshReady;
    window.__MAPLINK_E2E_CALLS__ = calls;
    window.__TAURI__ = {
      event: { listen: async () => () => {} },
      core: {
        invoke: async (command, arguments_) => {
          calls.push({ command, arguments_ });
          switch (command) {
            case 'load_profile': return savedProfile;
            case 'remote_platform': return { platform: 'windows', label: 'Windows', username: 'tester' };
            case 'ssh_readiness': return openSSHReady
              ? { platform: 'windows', clientInstalled: true, serverInstalled: true, serverRunning: true, keyAvailable: true, identityPath: 'maplink_ed25519', message: 'OpenSSH 与 MapLink 专用免密密钥已就绪。' }
              : { platform: 'windows', clientInstalled: false, serverInstalled: false, serverRunning: false, keyAvailable: false, identityPath: '', message: '未完整安装 Windows OpenSSH，点击安装后即可使用。' };
            case 'install_openssh':
              openSSHReady = true;
              return { platform: 'windows', clientInstalled: true, serverInstalled: true, serverRunning: true, keyAvailable: true, identityPath: 'maplink_ed25519', message: 'OpenSSH 与 MapLink 专用免密密钥已就绪。' };
            case 'client_status': return { running: true, installed: true, frpcVersion: '0.71.0', pid: 6000, binaryPath: 'frpc.exe', configPath: 'frpc.toml', logPath: 'frpc.log' };
            case 'client_logs': return 'e2e client ready';
            case 'remote_host_status':
            case 'start_remote_host': return { enabled: true, state: 'ready', message: '本机可被其他设备发现' };
            case 'online_ssh_devices': return [{ id: 'ssh-e5', clientID: 'e5', name: 'e5主机', platform: 'windows', remotePort: 30023, sshUser: 'tester' }];
            case 'remote_control_devices': return devices;
            case 'start_remote_control': return { id: 'session-e5', targetDeviceID: 'e5', controllerDeviceID: 'local-e2e', state: 'active', error: '', sshAuthorized: true, screenX: 0, screenY: 0, screenWidth: 1920, screenHeight: 1080, frameSequence: 0 };
            case 'remote_control_frame': return new Promise(() => {});
            case 'stop_remote_control':
            case 'save_profile': return null;
            default: return null;
          }
        },
      },
    };
  }, { savedProfile: profile, devices: remoteDevices, sshReady: sshInitiallyReady });
}

test('二级 Tab 可在 SSH 与远程控制之间切换并建立远程会话', async ({ page }) => {
  await installTauriMock(page, [
    { deviceID: 'local-e2e', name: '当前设备', platform: 'windows', permission: 'ready' },
    { deviceID: 'e5', name: 'e5主机', platform: 'windows', permission: 'ready' },
  ]);
  await page.goto('/');
  await page.getByRole('tab', { name: '远程连接' }).click();

  await expect(page.locator('#remote-ssh-panel')).toBeVisible();
  await expect(page.locator('#remote-desktop-panel')).toBeHidden();
  await expect(page.locator('#remote-device')).toContainText('e5主机');

  await page.getByRole('tab', { name: '远程控制', exact: true }).click();
  await expect(page.locator('#remote-ssh-panel')).toBeHidden();
  await expect(page.locator('#remote-desktop-panel')).toBeVisible();
  await expect(page.locator('#desktop-device')).toHaveValue('e5');
  await expect(page.locator('#desktop-device')).toContainText('e5主机');

  await page.locator('#connect-remote-desktop').click();
  await expect(page.locator('#desktop-session-status')).toHaveText('已连接 e5主机 · SSH 免密已配置');
  const commands = await page.evaluate(() => window.__MAPLINK_E2E_CALLS__.map((item) => item.command));
  expect(commands).toContain('remote_control_devices');
  expect(commands).toContain('start_remote_control');
});

test('进入 SSH 页面自动检测 OpenSSH，缺失时可一键安装并复检', async ({ page }) => {
  await installTauriMock(page, [], false);
  await page.goto('/');
  await page.getByRole('tab', { name: '远程连接' }).click();

  await expect(page.locator('#ssh-readiness-title')).toHaveText('本机 SSH 需要配置');
  await expect(page.locator('#install-openssh')).toBeVisible();
  await page.locator('#install-openssh').click();
  await expect(page.locator('#ssh-readiness-title')).toHaveText('本机 SSH 已开袋即食');
  const commands = await page.evaluate(() => window.__MAPLINK_E2E_CALLS__.map((item) => item.command));
  expect(commands).toContain('ssh_readiness');
  expect(commands).toContain('install_openssh');
});

test('没有其他远程设备时下拉框和长提示同时显示空状态', async ({ page }) => {
  await installTauriMock(page, [
    { deviceID: 'local-e2e', name: '当前设备', platform: 'windows', permission: 'ready' },
  ]);
  await page.goto('/');
  await page.getByRole('tab', { name: '远程连接' }).click();
  await page.getByRole('tab', { name: '远程控制', exact: true }).click();

  await expect(page.locator('#desktop-device')).toContainText('暂无在线');
  await expect(page.locator('#desktop-device-feedback')).toHaveText('远程设备列表已刷新，当前没有其他可远控设备。');
});
