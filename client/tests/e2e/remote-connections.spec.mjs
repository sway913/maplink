import { expect, test } from '@playwright/test';

const profile = {
  deviceID: 'local-e2e',
  serverAddr: '127.0.0.1',
  serverPort: 7000,
  managerPort: 7400,
  token: 'e2e-token-0123456789',
  deviceCredential: '',
  protocol: 'tcp',
  sshUser: 'tester',
  remoteControlEnabled: true,
  proxies: [{ name: 'ssh-e2e', type: 'tcp', localIP: '127.0.0.1', localPort: 22, remotePort: 30022 }],
};

async function installTauriMock(page, remoteDevices, sshInitiallyReady = true, sshInstallDelay = 0) {
  await page.addInitScript(({ savedProfile, devices, sshReady, installDelay }) => {
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
              if (installDelay) await new Promise((resolve) => setTimeout(resolve, installDelay));
              openSSHReady = true;
              return { platform: 'windows', clientInstalled: true, serverInstalled: true, serverRunning: true, keyAvailable: true, identityPath: 'maplink_ed25519', message: 'OpenSSH 与 MapLink 专用免密密钥已就绪。' };
            case 'client_status': return { running: true, installed: true, frpcVersion: '0.71.0', pid: 6000, binaryPath: 'frpc.exe', configPath: 'frpc.toml', logPath: 'frpc.log' };
            case 'client_logs': return 'e2e client ready';
            case 'enroll_device':
              if (!arguments_.deviceId || 'deviceID' in arguments_) throw new Error('enroll_device requires deviceId');
              return {
                deviceID: arguments_.deviceId,
                deviceCredential: 'device-credential-e2e-0123456789abcdef',
                serverAddr: arguments_.serverAddr,
                serverPort: 7001,
                managerPort: arguments_.managerPort,
                controlPorts: [7000, 7001],
                token: 'paired-token-e2e-0123456789',
                protocol: 'tcp',
              };
            case 'remote_host_status':
            case 'start_remote_host': return { enabled: true, state: 'ready', message: '本机可被其他设备发现' };
            case 'remote_control_devices': return devices;
            case 'start_remote_control':
              if (!arguments_.targetDeviceId || 'targetDeviceID' in arguments_) throw new Error('start_remote_control requires targetDeviceId');
              return { id: 'session-e5', targetDeviceID: arguments_.targetDeviceId, controllerDeviceID: 'local-e2e', state: 'active', error: '', sshAuthorized: true, screenX: 0, screenY: 0, screenWidth: 1920, screenHeight: 1080, frameSequence: 0 };
            case 'remote_control_frame': return new Promise(() => {});
            case 'stop_remote_control':
            case 'save_profile': return null;
            default: return null;
          }
        },
      },
    };
  }, { savedProfile: profile, devices: remoteDevices, sshReady: sshInitiallyReady, installDelay: sshInstallDelay });
}

test('一次性配对会自动保存独立设备凭据和可选接入端口', async ({ page }) => {
  await installTauriMock(page, []);
  await page.goto('/');
  await page.locator('#deviceID').fill('paired-e2e');
  await page.locator('#pairingCode').fill('ABCDE-FGHIJ-KLMNO-PQRST');
  await page.locator('#enroll-device').click();

  await expect(page.locator('#pairing-feedback')).toContainText('设备配对成功');
  await expect(page.locator('#serverPort')).toHaveValue('7001');
  await expect(page.locator('#serverPort option')).toHaveCount(2);
  await expect(page.locator('#token')).toHaveValue('paired-token-e2e-0123456789');
  await expect(page.locator('#deviceCredential')).toHaveValue('device-credential-e2e-0123456789abcdef');
  const calls = await page.evaluate(() => window.__MAPLINK_E2E_CALLS__);
  expect(calls.some((item) => item.command === 'enroll_device')).toBe(true);
  expect(calls.some((item) => item.command === 'save_profile' && item.arguments_.profile.deviceCredential.startsWith('device-credential-'))).toBe(true);
});

test('二级 Tab 可在 SSH 与远程控制之间切换并建立远程会话', async ({ page }) => {
  await installTauriMock(page, [
    { deviceID: 'local-e2e', name: '当前设备', platform: 'windows', permission: 'ready' },
    { deviceID: 'e5', name: 'e5主机', platform: 'windows', permission: 'ready' },
  ]);
  await page.goto('/');
  await expect(page.locator('#serverAddr')).toHaveValue(profile.serverAddr);
  await page.getByRole('tab', { name: '远程连接' }).click();

  await expect(page.locator('#remote-ssh-panel')).toBeVisible();
  await expect(page.locator('#remote-desktop-panel')).toBeHidden();
  await expect(page.locator('#remote-user')).toBeVisible();
  await page.locator('#remote-user').fill('manual-user');
  await page.locator('#remote-target-port').fill('30023');
  await expect(page.locator('#remote-address')).toContainText('ssh -p 30023 manual-user@127.0.0.1');
  let commands = await page.evaluate(() => window.__MAPLINK_E2E_CALLS__.map((item) => item.command));
  expect(commands).not.toContain('online_ssh_devices');

  await page.getByRole('tab', { name: '远程控制', exact: true }).click();
  await expect(page.locator('#remote-ssh-panel')).toBeHidden();
  await expect(page.locator('#remote-desktop-panel')).toBeVisible();
  await expect(page.locator('#desktop-device')).toHaveValue('e5');
  await expect(page.locator('#desktop-device')).toContainText('e5主机');

  await page.locator('#connect-remote-desktop').click();
  await expect(page.locator('#desktop-session-status')).toHaveText('已连接 e5主机 · SSH 免密已配置');
  commands = await page.evaluate(() => window.__MAPLINK_E2E_CALLS__.map((item) => item.command));
  expect(commands).toContain('remote_control_devices');
  expect(commands).toContain('start_remote_control');
  const startCall = await page.evaluate(() => window.__MAPLINK_E2E_CALLS__.find((item) => item.command === 'start_remote_control'));
  expect(startCall.arguments_.targetDeviceId).toBe('e5');
  expect(startCall.arguments_).not.toHaveProperty('targetDeviceID');
});

test('进入远程控制只自动刷新一次，手动刷新仍可用', async ({ page }) => {
  await installTauriMock(page, [
    { deviceID: 'local-e2e', name: '当前设备', platform: 'windows', permission: 'ready' },
    { deviceID: 'e5', name: 'e5主机', platform: 'windows', permission: 'ready' },
  ]);
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => window.__MAPLINK_E2E_CALLS__.filter((item) => item.command === 'start_remote_host').length)).toBe(1);
  expect(await page.evaluate(() => window.__MAPLINK_E2E_CALLS__.filter((item) => item.command === 'remote_control_devices').length)).toBe(0);

  await page.getByRole('tab', { name: '远程连接' }).click();
  await page.getByRole('tab', { name: '远程控制', exact: true }).click();
  await expect(page.locator('#desktop-device')).toHaveValue('e5');
  await expect.poll(() => page.evaluate(() => window.__MAPLINK_E2E_CALLS__.filter((item) => item.command === 'remote_control_devices').length)).toBe(1);

  await page.waitForTimeout(5500);
  expect(await page.evaluate(() => window.__MAPLINK_E2E_CALLS__.filter((item) => item.command === 'remote_control_devices').length)).toBe(1);

  await page.locator('#refresh-desktop-devices').click();
  await expect.poll(() => page.evaluate(() => window.__MAPLINK_E2E_CALLS__.filter((item) => item.command === 'remote_control_devices').length)).toBe(2);
});

test('进入 SSH 页面自动检测 OpenSSH，缺失时可一键安装并复检', async ({ page }) => {
  await installTauriMock(page, [], false, 1200);
  await page.goto('/');
  await page.getByRole('tab', { name: '远程连接' }).click();

  await expect(page.locator('#ssh-readiness-title')).toHaveText('本机 SSH 需要配置');
  await expect(page.locator('#install-openssh')).toBeVisible();
  await page.locator('#install-openssh').click();
  await expect(page.locator('#ssh-readiness-message')).toContainText('Windows 正在下载并安装 OpenSSH Server');
  await expect(page.locator('#ssh-readiness-message')).toContainText('已用时');
  await expect(page.locator('#install-openssh')).toBeDisabled();
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
