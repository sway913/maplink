const invoke = window.__TAURI__.core.invoke;
const listen = window.__TAURI__.event.listen;
const list = document.querySelector('#proxy-list');
const template = document.querySelector('#proxy-template');
const feedback = document.querySelector('#feedback');
const runtimeStatus = document.querySelector('#runtime-status');
const startButton = document.querySelector('#start-client');
const stopButton = document.querySelector('#stop-client');
const remoteFeedback = document.querySelector('#remote-feedback');
const remoteHostFeedback = document.querySelector('#remote-host-feedback');
const remoteAddress = document.querySelector('#remote-address');
const remoteDevice = document.querySelector('#remote-device');
const connectRemoteShellButton = document.querySelector('#test-remote-session');
const disconnectRemoteShellButton = document.querySelector('#disconnect-remote-shell');
const remoteTerminalStatus = document.querySelector('#remote-terminal-status');
const remoteTerminalIndicator = document.querySelector('#remote-terminal-indicator');
const terminal = new window.Terminal({
  cursorBlink: true,
  cursorStyle: 'block',
  fontFamily: '"Cascadia Mono", Consolas, "SFMono-Regular", monospace',
  fontSize: 14,
  lineHeight: 1.18,
  scrollback: 5000,
  theme: {
    background: '#0c0c0c',
    foreground: '#cccccc',
    cursor: '#f2f2f2',
    selectionBackground: '#264f78',
  },
});
const terminalFitAddon = new window.FitAddon.FitAddon();
terminal.loadAddon(terminalFitAddon);
terminal.open(document.querySelector('#remote-terminal'));
terminal.writeln('\x1b[90mMapLink SSH 终端尚未连接，请使用上方“连接终端”。\x1b[0m');
let activeShellGeneration = null;
let displayedShellGeneration = null;
let shellConnecting = false;
let pendingShellOutput = [];
let pendingShellClosed = new Set();
let terminalInputBuffer = '';
let terminalInputTimer;
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
  if (name === 'remote') {
    refreshOnlineDevices(true);
    window.setTimeout(() => {
      terminalFitAddon.fit();
      terminal.focus();
    }, 80);
  }
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

function setRemoteShellState(state, message) {
  remoteTerminalStatus.textContent = message;
  remoteTerminalIndicator.className = state;
  connectRemoteShellButton.disabled = state === 'connecting';
  connectRemoteShellButton.textContent = state === 'connected' ? '重新连接' : state === 'connecting' ? '连接中…' : '连接终端';
  disconnectRemoteShellButton.disabled = state !== 'connected';
}

function writeTerminalPayload(payload) {
  terminal.write(new Uint8Array(payload.bytes));
}

const terminalEventsReady = Promise.all([
  listen('remote-shell-output', ({ payload }) => {
    if (shellConnecting && displayedShellGeneration === null) {
      pendingShellOutput.push(payload);
      return;
    }
    if (payload.generation === displayedShellGeneration) writeTerminalPayload(payload);
  }),
  listen('remote-shell-closed', ({ payload }) => {
    if (shellConnecting && activeShellGeneration === null) {
      pendingShellClosed.add(payload.generation);
      return;
    }
    if (payload.generation !== activeShellGeneration) return;
    activeShellGeneration = null;
    shellConnecting = false;
    setRemoteShellState('disconnected', 'SSH 已断开');
    setRemoteFeedback('SSH 终端会话已结束。');
    terminal.write('\r\n\x1b[90m[SSH 会话已结束]\x1b[0m\r\n');
  }),
]);

function flushTerminalInput() {
  window.clearTimeout(terminalInputTimer);
  terminalInputTimer = undefined;
  const input = terminalInputBuffer;
  terminalInputBuffer = '';
  const generation = activeShellGeneration;
  if (!input || generation === null) return;
  invoke('write_remote_shell', { generation, input }).catch((error) => {
    if (generation !== displayedShellGeneration) return;
    terminal.write(`\r\n\x1b[31m[MapLink: ${error}]\x1b[0m\r\n`);
  });
}

terminal.onData((input) => {
  if (activeShellGeneration === null) return;
  terminalInputBuffer += input;
  if (terminalInputTimer === undefined) terminalInputTimer = window.setTimeout(flushTerminalInput, 0);
});

window.addEventListener('resize', () => terminalFitAddon.fit());

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

function remoteShellRequest() {
  const host = document.querySelector('#serverAddr').value.trim();
  const username = document.querySelector('#remote-user').value.trim();
  const port = Number(document.querySelector('#remote-target-port').value);
  const platform = document.querySelector('#remote-os').value;
  if (!host) throw new Error('请先在“连接配置”填写服务器地址');
  if (host.length > 253 || !/^[A-Za-z0-9[\]][A-Za-z0-9.:[\]-]*$/.test(host)) throw new Error('服务器地址格式无效');
  if (!/^[A-Za-z0-9._\\-]{1,64}$/.test(username)) throw new Error('SSH 用户名格式无效');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('公网 SSH 端口无效');
  if (!['windows', 'macos'].includes(platform)) throw new Error('对方系统类型无效');
  return { host, username, port, platform };
}

function sshCommand() {
  const request = remoteShellRequest();
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
  } else {
    steps.innerHTML = '<li>对方机器需已开启 macOS“远程登录”。</li><li>双方各自在 MapLink 添加本机 SSH 映射并启动 frpc。</li><li>在这里填写对方端口，即可直接检测和执行命令。</li>';
  }
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

async function disconnectRemoteShell(showMessage = true) {
  const generation = activeShellGeneration;
  activeShellGeneration = null;
  shellConnecting = false;
  terminalInputBuffer = '';
  window.clearTimeout(terminalInputTimer);
  terminalInputTimer = undefined;
  if (generation !== null) await invoke('stop_remote_shell', { generation });
  setRemoteShellState('disconnected', 'SSH 未连接');
  if (showMessage) terminal.write('\r\n\x1b[90m[SSH 会话已断开]\x1b[0m\r\n');
}

async function connectRemoteShell() {
  const request = remoteShellRequest();
  await terminalEventsReady;
  if (activeShellGeneration !== null) await disconnectRemoteShell(false);
  shellConnecting = true;
  displayedShellGeneration = null;
  pendingShellOutput = [];
  pendingShellClosed = new Set();
  terminal.reset();
  terminal.clear();
  terminalFitAddon.fit();
  setRemoteShellState('connecting', 'SSH 连接中…');
  setRemoteFeedback('正在建立交互式 SSH 终端…');
  try {
    const generation = await invoke('start_remote_shell', { request });
    activeShellGeneration = generation;
    displayedShellGeneration = generation;
    shellConnecting = false;
    for (const payload of pendingShellOutput) {
      if (payload.generation === generation) writeTerminalPayload(payload);
    }
    pendingShellOutput = [];
    if (pendingShellClosed.has(generation)) {
      activeShellGeneration = null;
      pendingShellClosed.clear();
      setRemoteShellState('disconnected', 'SSH 已断开');
      setRemoteFeedback('SSH 终端会话已结束。');
      terminal.write('\r\n\x1b[90m[SSH 会话已结束]\x1b[0m\r\n');
      return;
    }
    pendingShellClosed.clear();
    setRemoteShellState('connected', 'SSH 已连接');
    setRemoteFeedback('✓ 已进入远端交互式终端。', 'success');
    terminal.focus();
  } catch (error) {
    shellConnecting = false;
    activeShellGeneration = null;
    setRemoteShellState('disconnected', 'SSH 连接失败');
    setRemoteFeedback(`连接失败：${error}`, 'error');
    terminal.writeln(`\x1b[31m[MapLink: ${error}]\x1b[0m`);
  }
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
  try { await connectRemoteShell(); } catch (error) { setRemoteFeedback(`连接失败：${error}`, 'error'); }
});
disconnectRemoteShellButton.addEventListener('click', () => {
  disconnectRemoteShell().catch((error) => setRemoteFeedback(`断开失败：${error}`, 'error'));
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
refreshTimer = window.setInterval(refreshRuntime, 2500);
window.addEventListener('beforeunload', () => {
  window.clearInterval(refreshTimer);
  window.clearTimeout(terminalInputTimer);
});
