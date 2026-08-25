const invoke = window.__TAURI__.core.invoke;
const list = document.querySelector('#proxy-list');
const template = document.querySelector('#proxy-template');
const feedback = document.querySelector('#feedback');
const runtimeStatus = document.querySelector('#runtime-status');
const startButton = document.querySelector('#start-client');
const stopButton = document.querySelector('#stop-client');
const remoteFeedback = document.querySelector('#remote-feedback');
const remoteHostFeedback = document.querySelector('#remote-host-feedback');
const remoteAddress = document.querySelector('#remote-address');
const remoteOutput = document.querySelector('#remote-output');
const remoteResultState = document.querySelector('#remote-result-state');
const remoteResultCode = document.querySelector('#remote-result-code');
const remoteDevice = document.querySelector('#remote-device');
const remoteCommand = document.querySelector('#remote-command');
const remoteCommandHistory = document.querySelector('#remote-command-history');
const commandHistory = new window.MapLinkCommandHistory.CommandHistory(window.localStorage);
let refreshTimer;
let runtimeRunning = false;
let lastDeviceRefresh = 0;
let deviceRefreshPromise;
let onlineDevices = new Map();

function switchTab(name, focus = false) {
  for (const button of document.querySelectorAll('[data-tab]')) {
    const active = button.dataset.tab === name;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
    if (active && focus) button.focus();
  }
  for (const panel of document.querySelectorAll('[data-tab-panel]')) {
    const active = panel.dataset.tabPanel === name;
    panel.hidden = !active;
    panel.classList.toggle('active', active);
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (name === 'remote') refreshOnlineDevices(true);
}

for (const button of document.querySelectorAll('[data-tab]')) {
  button.addEventListener('click', () => switchTab(button.dataset.tab));
  button.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    const buttons = [...document.querySelectorAll('[data-tab]')];
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    const index = (buttons.indexOf(button) + direction + buttons.length) % buttons.length;
    switchTab(buttons[index].dataset.tab, true);
  });
}

function addProxy(value = {}) {
  const row = template.content.firstElementChild.cloneNode(true);
  for (const input of row.querySelectorAll('[data-field]')) {
    if (value[input.dataset.field] !== undefined) input.value = value[input.dataset.field];
  }
  row.querySelector('[data-remove]').addEventListener('click', () => row.remove());
  list.append(row);
  return row;
}

function profile() {
  return {
    deviceID: document.querySelector('#deviceID').value.trim(),
    serverAddr: document.querySelector('#serverAddr').value.trim(),
    serverPort: Number(document.querySelector('#serverPort').value),
    managerPort: Number(document.querySelector('#managerPort').value),
    token: document.querySelector('#token').value,
    protocol: document.querySelector('#protocol').value,
    sshUser: document.querySelector('#sshUser').value.trim(),
    proxies: [...list.querySelectorAll('.proxy-row')].map((row) => Object.fromEntries(
      [...row.querySelectorAll('[data-field]')].map((input) => [input.dataset.field, input.type === 'number' ? Number(input.value) : input.value.trim()]),
    )),
  };
}

async function showResult(action, success = '✓ 操作完成') {
  try {
    feedback.textContent = '正在处理…';
    await action();
    feedback.textContent = success;
  } catch (error) {
    feedback.textContent = `错误：${error}`;
  }
}

function setRemoteFeedback(message, type = '') {
  remoteFeedback.textContent = message;
  remoteFeedback.classList.toggle('success', type === 'success');
  remoteFeedback.classList.toggle('error', type === 'error');
}

function setRemoteHostFeedback(message, type = '') {
  remoteHostFeedback.textContent = message;
  remoteHostFeedback.classList.toggle('success', type === 'success');
  remoteHostFeedback.classList.toggle('error', type === 'error');
}

function paintRuntime(status) {
  runtimeRunning = status.running;
  runtimeStatus.classList.toggle('running', status.running);
  runtimeStatus.classList.toggle('missing', !status.installed);
  const frpcLabel = `frpc ${status.frpcVersion || '0.71.0'}`;
  runtimeStatus.textContent = status.running ? `${frpcLabel} 运行中` : status.installed ? `${frpcLabel} 已就绪` : '完整包损坏';
  document.querySelector('#process-state').textContent = status.running ? '正在运行' : status.installed ? '已停止' : '缺少内置原版程序';
  document.querySelector('#process-pid').textContent = status.pid || '—';
  document.querySelector('#binary-path').textContent = status.binaryPath;
  document.querySelector('#config-path').textContent = status.configPath;
  document.querySelector('#log-path').textContent = status.logPath;
  startButton.disabled = status.running || !status.installed;
  stopButton.disabled = !status.running;
}

function option(text, value = '') {
  const item = document.createElement('option');
  item.value = value;
  item.textContent = text;
  return item;
}

function platformLabel(platform) {
  if (platform === 'windows') return 'Windows';
  if (platform === 'macos') return 'macOS';
  return platform || '未知系统';
}

function applySelectedDevice() {
  const selected = onlineDevices.get(remoteDevice.value);
  if (!selected) return;
  document.querySelector('#remote-target-port').value = selected.remotePort;
  if (['windows', 'macos'].includes(selected.platform)) {
    document.querySelector('#remote-os').value = selected.platform;
  }
  if (selected.sshUser) document.querySelector('#remote-user').value = selected.sshUser;
  updateRemoteGuide();
  updateRemoteAddress();
  setRemoteFeedback(`✓ 已选择 ${selected.name}，SSH 公网端口 ${selected.remotePort}。`, 'success');
}

async function refreshOnlineDevices(force = false) {
  if (deviceRefreshPromise) return deviceRefreshPromise;
  if (!force && (!runtimeRunning || Date.now() - lastDeviceRefresh < 10000)) return;
  const currentProfile = profile();
  if (!currentProfile.serverAddr || currentProfile.token.length < 16) {
    remoteDevice.replaceChildren(option('请先填写服务器地址和 Token'));
    return;
  }
  const selectedID = remoteDevice.value;
  remoteDevice.disabled = true;
  if (!selectedID) remoteDevice.replaceChildren(option('正在读取在线设备…'));
  deviceRefreshPromise = invoke('online_ssh_devices', { profile: currentProfile })
    .then((devices) => {
      lastDeviceRefresh = Date.now();
      const ownDeviceID = currentProfile.deviceID;
      const available = devices.filter((device) => device.clientID !== ownDeviceID);
      onlineDevices = new Map(available.map((device) => [device.id, device]));
      remoteDevice.replaceChildren(option(available.length ? `选择在线设备（${available.length}）` : '暂无其他可远控的在线设备'));
      setRemoteFeedback(
        available.length ? `✓ 已读取 ${available.length} 台可远控在线设备。` : '✓ 在线设备列表已刷新，当前没有其他可远控设备。',
        'success',
      );
      for (const device of available) {
        remoteDevice.append(option(`${device.name} · ${platformLabel(device.platform)} · :${device.remotePort}`, device.id));
      }
      if (onlineDevices.has(selectedID)) remoteDevice.value = selectedID;
      else if (available.length === 1) {
        remoteDevice.value = available[0].id;
        applySelectedDevice();
      }
    })
    .catch((error) => {
      remoteDevice.replaceChildren(option('在线设备读取失败，点击刷新重试'));
      if (force) setRemoteFeedback(`设备读取失败：${error}`, 'error');
    })
    .finally(() => {
      remoteDevice.disabled = false;
      deviceRefreshPromise = undefined;
    });
  return deviceRefreshPromise;
}

async function refreshRuntime() {
  try {
    const [status, logs] = await Promise.all([
      invoke('client_status'),
      invoke('client_logs', { lines: 120 }),
    ]);
    paintRuntime(status);
    document.querySelector('#client-logs').textContent = logs || '暂无日志';
    if (status.running) refreshOnlineDevices();
  } catch (error) {
    runtimeStatus.textContent = '状态读取失败';
    runtimeStatus.classList.add('missing');
    feedback.textContent = `错误：${error}`;
  }
}

function remoteRequest(command = '') {
  const host = document.querySelector('#serverAddr').value.trim();
  const username = document.querySelector('#remote-user').value.trim();
  const port = Number(document.querySelector('#remote-target-port').value);
  if (!host) throw new Error('请先在“连接配置”填写服务器地址');
  if (host.length > 253 || !/^[A-Za-z0-9[\]][A-Za-z0-9.:[\]-]*$/.test(host)) throw new Error('服务器地址格式无效');
  if (!/^[A-Za-z0-9._\\-]{1,64}$/.test(username)) throw new Error('SSH 用户名格式无效');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('公网 SSH 端口无效');
  return { host, username, port, command };
}

function sshCommand() {
  const request = remoteRequest();
  return `ssh -p ${request.port} ${request.username}@${request.host}`;
}

function updateRemoteAddress() {
  try {
    remoteAddress.textContent = sshCommand();
  } catch {
    remoteAddress.textContent = '请填写服务器地址和 SSH 用户名';
  }
}

function syncRemoteHostMapping(proxies) {
  const sshProxy = proxies.find((proxy) => proxy.type === 'tcp'
    && Number(proxy.localPort) === 22
    && ['127.0.0.1', 'localhost'].includes(proxy.localIP));
  if (!sshProxy) return;
  document.querySelector('#remote-host-name').value = sshProxy.name;
  document.querySelector('#remote-host-local-port').value = sshProxy.localPort;
  document.querySelector('#remote-host-public-port').value = sshProxy.remotePort;
  setRemoteHostFeedback(`已复用现有 SSH 映射：${sshProxy.name} → ${sshProxy.remotePort}`, 'success');
}

function updateRemoteGuide() {
  const remoteOS = document.querySelector('#remote-os').value;
  const steps = document.querySelector('#remote-steps');
  if (remoteOS === 'windows') {
    steps.innerHTML = '<li>对方机器需已启动 Windows OpenSSH Server。</li><li>双方各自在 MapLink 添加本机 SSH 映射并启动 frpc。</li><li>在这里填写对方端口，即可直接检测和执行命令。</li>';
    document.querySelector('#remote-command').placeholder = '例如：powershell -NoProfile -Command "Get-ComputerInfo"';
  } else {
    steps.innerHTML = '<li>对方机器需已开启 macOS“远程登录”。</li><li>双方各自在 MapLink 添加本机 SSH 映射并启动 frpc。</li><li>在这里填写对方端口，即可直接检测和执行命令。</li>';
    document.querySelector('#remote-command').placeholder = '例如：uname -a';
  }
}

function refreshCommandHistory() {
  const entries = commandHistory.list();
  remoteCommandHistory.replaceChildren(option(entries.length ? `选择历史命令（${entries.length}）` : '暂无历史命令'));
  entries.forEach((entry, index) => {
    const label = entry.replace(/\s+/g, ' ').slice(0, 120);
    remoteCommandHistory.append(option(label, String(index)));
  });
  remoteCommandHistory.disabled = entries.length === 0;
  document.querySelector('#clear-command-history').disabled = entries.length === 0;
}

function addRemoteMapping() {
  const name = document.querySelector('#remote-host-name').value.trim();
  const localPort = Number(document.querySelector('#remote-host-local-port').value);
  const publicPort = Number(document.querySelector('#remote-host-public-port').value);
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) throw new Error('映射名称只能包含字母、数字、短横线和下划线');
  for (const [label, value] of [['本机 SSH 端口', localPort], ['公网 SSH 端口', publicPort]]) {
    if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${label}无效`);
  }
  let row = [...list.querySelectorAll('.proxy-row')].find((candidate) => candidate.querySelector('[data-field="name"]').value.trim() === name);
  if (!row) row = addProxy();
  const values = { name, type: 'tcp', localIP: '127.0.0.1', localPort, remotePort: publicPort };
  for (const input of row.querySelectorAll('[data-field]')) input.value = values[input.dataset.field];
  feedback.textContent = '✓ SSH 映射已加入，请保存配置并启动 frpc';
  setRemoteHostFeedback(`本机 SSH 已映射到公网端口 ${publicPort}，请把这个端口告诉另一台设备。`, 'success');
  switchTab('config');
  window.setTimeout(() => row.scrollIntoView({ behavior: 'smooth', block: 'center' }), 180);
}

async function runRemote(command) {
  const request = remoteRequest(command);
  remoteResultState.textContent = '正在连接…';
  remoteResultState.className = '';
  remoteResultCode.textContent = '退出码 —';
  remoteOutput.textContent = '等待远端响应…';
  const result = await invoke('run_remote_command', { request });
  remoteResultState.textContent = result.timedOut ? '执行超时' : result.success ? '执行成功' : '执行失败';
  remoteResultState.className = result.success ? 'success' : 'error';
  remoteResultCode.textContent = `退出码 ${result.exitCode ?? '—'}`;
  const sections = [];
  if (result.stdout) sections.push(result.stdout);
  if (result.stderr) sections.push(`[stderr]\n${result.stderr}`);
  remoteOutput.textContent = sections.join('\n\n') || '命令没有输出。';
  return result;
}

document.querySelector('#add-proxy').addEventListener('click', () => addProxy());
document.querySelector('#profile-form').addEventListener('submit', (event) => {
  event.preventDefault(); showResult(() => invoke('save_profile', { profile: profile() }));
});
document.querySelector('#copy-config').addEventListener('click', () => showResult(async () => {
  const config = await invoke('render_config', { profile: profile() });
  await navigator.clipboard.writeText(config);
}, '✓ 已复制原版 frpc TOML'));
document.querySelector('#refresh-client').addEventListener('click', () => showResult(refreshRuntime, '✓ 状态已刷新'));
startButton.addEventListener('click', () => showResult(async () => {
  const status = await invoke('start_client', { profile: profile() });
  paintRuntime(status);
  await refreshRuntime();
  await refreshOnlineDevices(true);
}, '✓ 原版 frpc 已启动'));
stopButton.addEventListener('click', () => showResult(async () => {
  const status = await invoke('stop_client');
  paintRuntime(status);
  await refreshRuntime();
}, '✓ 原版 frpc 已停止'));

document.querySelector('#serverAddr').addEventListener('input', updateRemoteAddress);
document.querySelector('#managerPort').addEventListener('input', () => { lastDeviceRefresh = 0; });
document.querySelector('#token').addEventListener('input', () => { lastDeviceRefresh = 0; });
document.querySelector('#remote-user').addEventListener('input', updateRemoteAddress);
document.querySelector('#remote-target-port').addEventListener('input', updateRemoteAddress);
document.querySelector('#remote-os').addEventListener('change', updateRemoteGuide);
remoteDevice.addEventListener('change', applySelectedDevice);
document.querySelector('#refresh-remote-devices').addEventListener('click', () => refreshOnlineDevices(true));
document.querySelector('#add-remote-mapping').addEventListener('click', () => {
  try { addRemoteMapping(); } catch (error) { setRemoteHostFeedback(`错误：${error.message || error}`, 'error'); }
});
document.querySelector('#copy-ssh-command').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(sshCommand());
    setRemoteFeedback('✓ SSH 命令已复制，可直接交给 Codex 或终端执行。', 'success');
  } catch (error) {
    setRemoteFeedback(`错误：${error.message || error}`, 'error');
  }
});
document.querySelector('#test-remote-session').addEventListener('click', async () => {
  try {
    const result = await runRemote('echo MAPLINK_REMOTE_OK');
    const verified = result.success && result.stdout.includes('MAPLINK_REMOTE_OK');
    setRemoteFeedback(verified ? '✓ SSH 密钥连接验证通过。' : '连接建立，但验证输出不符合预期。', verified ? 'success' : 'error');
  } catch (error) {
    setRemoteFeedback(`连接失败：${error}`, 'error');
    remoteOutput.textContent = String(error);
  }
});
document.querySelector('#run-remote-command').addEventListener('click', async () => {
  const command = remoteCommand.value.trim();
  if (!command) { setRemoteFeedback('错误：请输入要执行的远程命令', 'error'); return; }
  commandHistory.record(command);
  refreshCommandHistory();
  try {
    const result = await runRemote(command);
    setRemoteFeedback(result.success ? '✓ 远程命令执行完成。' : '远程命令返回非零退出码。', result.success ? 'success' : 'error');
  } catch (error) {
    setRemoteFeedback(`执行失败：${error}`, 'error');
    remoteOutput.textContent = String(error);
  }
});

remoteCommandHistory.addEventListener('change', () => {
  if (remoteCommandHistory.value === '') return;
  const selected = commandHistory.list()[Number(remoteCommandHistory.value)];
  if (selected !== undefined) {
    remoteCommand.value = selected;
    remoteCommand.focus();
    remoteCommand.setSelectionRange(selected.length, selected.length);
  }
  remoteCommandHistory.value = '';
});
document.querySelector('#clear-command-history').addEventListener('click', () => {
  commandHistory.clear();
  refreshCommandHistory();
  setRemoteFeedback('本机命令历史已清空。');
});
remoteCommand.addEventListener('input', () => commandHistory.resetNavigation());
remoteCommand.addEventListener('keydown', (event) => {
  const atStart = remoteCommand.selectionStart === 0 && remoteCommand.selectionEnd === 0;
  const atEnd = remoteCommand.selectionStart === remoteCommand.value.length && remoteCommand.selectionEnd === remoteCommand.value.length;
  if (event.key === 'ArrowUp' && (event.altKey || atStart)) {
    event.preventDefault();
    remoteCommand.value = commandHistory.previous(remoteCommand.value);
    remoteCommand.setSelectionRange(remoteCommand.value.length, remoteCommand.value.length);
  } else if (event.key === 'ArrowDown' && (event.altKey || atEnd)) {
    event.preventDefault();
    remoteCommand.value = commandHistory.next();
    remoteCommand.setSelectionRange(remoteCommand.value.length, remoteCommand.value.length);
  }
});

invoke('load_profile').then((saved) => {
  if (!saved) {
    const proxies = [{ name: 'ssh-home', type: 'tcp', localIP: '127.0.0.1', localPort: 22, remotePort: 30022 }];
    proxies.forEach(addProxy);
    syncRemoteHostMapping(proxies);
    updateRemoteAddress();
    return;
  }
  for (const key of ['deviceID', 'serverAddr', 'serverPort', 'managerPort', 'token', 'protocol']) document.querySelector(`#${key}`).value = saved[key];
  if (saved.sshUser) document.querySelector('#sshUser').value = saved.sshUser;
  saved.proxies.forEach(addProxy);
  syncRemoteHostMapping(saved.proxies);
  updateRemoteAddress();
  refreshOnlineDevices(true);
}).catch(() => { addProxy(); updateRemoteAddress(); });

invoke('remote_platform').then((platform) => {
  document.querySelector('#remote-platform').textContent = `${platform.label} 客户端`;
  document.querySelector('#remote-os').value = platform.platform;
  if (!document.querySelector('#sshUser').value) document.querySelector('#sshUser').value = platform.username || '';
  updateRemoteGuide();
}).catch(() => {
  document.querySelector('#remote-platform').textContent = '桌面客户端';
  updateRemoteGuide();
});

refreshRuntime();
refreshCommandHistory();
refreshTimer = window.setInterval(refreshRuntime, 2500);
window.addEventListener('beforeunload', () => window.clearInterval(refreshTimer));
