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
const remoteControlEnabled = document.querySelector('#remote-control-enabled');
const desktopDevice = document.querySelector('#desktop-device');
const connectRemoteDesktopButton = document.querySelector('#connect-remote-desktop');
const disconnectRemoteDesktopButton = document.querySelector('#disconnect-remote-desktop');
const remoteScreen = document.querySelector('#remote-screen');
const remoteScreenImage = document.querySelector('#remote-screen-image');
const remoteScreenPlaceholder = document.querySelector('#remote-screen-placeholder');
const desktopSessionStatus = document.querySelector('#desktop-session-status');
const desktopSessionIndicator = document.querySelector('#desktop-session-indicator');
const desktopFrameMeta = document.querySelector('#desktop-frame-meta');
const desktopHostStatus = document.querySelector('#desktop-host-status');
const desktopDeviceFeedback = document.querySelector('#desktop-device-feedback');
const checkUpdateButton = document.querySelector('#check-update');
const updateStatus = document.querySelector('#update-status');
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
let desktopDevices = new Map();
let desktopRefreshPromise;
let lastDesktopRefresh = 0;
let activeDesktopSession = null;
let desktopGeneration = 0;
let desktopInputQueue = [];
let desktopInputTimer;

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
    refreshRemoteControlDevices(true);
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
    remoteControlEnabled: remoteControlEnabled.checked,
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
      remoteDevice.replaceChildren(option(available.length ? `选择在线设备（${available.length}）` : '暂无在线'));
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
    const [status, logs, hostStatus] = await Promise.all([
      invoke('client_status'),
      invoke('client_logs', { lines: 120 }),
      invoke('remote_host_status'),
    ]);
    paintRuntime(status);
    paintRemoteHostStatus(hostStatus);
    document.querySelector('#client-logs').textContent = logs || '暂无日志';
    if (status.running) refreshOnlineDevices();
    refreshRemoteControlDevices();
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

function setDesktopSessionState(state, message) {
  desktopSessionStatus.textContent = message;
  desktopSessionIndicator.className = state;
  connectRemoteDesktopButton.disabled = state === 'connecting' || state === 'connected';
  disconnectRemoteDesktopButton.disabled = state !== 'connecting' && state !== 'connected';
}

function paintRemoteHostStatus(status) {
  desktopHostStatus.textContent = status.message;
  desktopHostStatus.classList.toggle('ready', ['ready', 'controlled'].includes(status.state));
  desktopHostStatus.classList.toggle('error', ['error', 'permission-required'].includes(status.state));
}

async function syncRemoteHost() {
  const currentProfile = profile();
  if (!currentProfile.serverAddr || currentProfile.token.length < 16) {
    paintRemoteHostStatus({ state: 'disabled', message: '请先在“连接配置”填写服务器地址和 Token。' });
    return;
  }
  const status = await invoke('start_remote_host', {
    profile: currentProfile,
    enabled: remoteControlEnabled.checked,
  });
  paintRemoteHostStatus(status);
}

async function refreshRemoteControlDevices(force = false) {
  if (desktopRefreshPromise) return desktopRefreshPromise;
  if (!force && Date.now() - lastDesktopRefresh < 5000) return;
  const currentProfile = profile();
  if (!currentProfile.serverAddr || currentProfile.token.length < 16) {
    desktopDevice.replaceChildren(option('请先填写服务器地址和 Token'));
    desktopDeviceFeedback.textContent = '请先填写服务器地址和 Token。';
    desktopDeviceFeedback.className = 'desktop-device-feedback';
    return;
  }
  lastDesktopRefresh = Date.now();
  const selectedID = desktopDevice.value;
  desktopDevice.disabled = true;
  if (!selectedID) desktopDevice.replaceChildren(option('正在读取远程设备…'));
  desktopDeviceFeedback.textContent = '正在读取远程设备列表…';
  desktopDeviceFeedback.className = 'desktop-device-feedback';
  desktopRefreshPromise = invoke('remote_control_devices', { profile: currentProfile })
    .then((devices) => {
      const available = devices.filter((device) => device.deviceID !== currentProfile.deviceID);
      desktopDevices = new Map(available.map((device) => [device.deviceID, device]));
      desktopDevice.replaceChildren(option(available.length ? `选择在线设备（${available.length}）` : '暂无在线'));
      for (const device of available) {
        const state = device.permission === 'ready' ? '可远控' : device.permission === 'permission-required' ? '需要系统授权' : '远控暂不可用';
        desktopDevice.append(option(`${device.name} · ${platformLabel(device.platform)} · ${state}`, device.deviceID));
      }
      if (desktopDevices.has(selectedID)) desktopDevice.value = selectedID;
      else if (available.length === 1) desktopDevice.value = available[0].deviceID;
      desktopDeviceFeedback.textContent = available.length
        ? `已读取 ${available.length} 台其他在线设备。`
        : '远程设备列表已刷新，当前没有其他可远控设备。';
      desktopDeviceFeedback.className = 'desktop-device-feedback success';
    })
    .catch((error) => {
      desktopDevice.replaceChildren(option('远程设备列表读取失败'));
      desktopDevices = new Map();
      desktopDeviceFeedback.textContent = `设备读取失败：${error}`;
      desktopDeviceFeedback.className = 'desktop-device-feedback error';
    })
    .finally(() => {
      desktopDevice.disabled = false;
      desktopRefreshPromise = undefined;
    });
  return desktopRefreshPromise;
}

function delay(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function connectRemoteDesktop() {
  const targetDeviceID = desktopDevice.value;
  if (!desktopDevices.has(targetDeviceID)) throw new Error('请选择一台可远控的在线设备');
  const target = desktopDevices.get(targetDeviceID);
  if (target.permission === 'permission-required') throw new Error('对方设备在线，但尚未授予屏幕录制或辅助控制权限');
  if (target.permission !== 'ready') throw new Error('对方设备在线，但远程控制当前不可用');
  if (activeDesktopSession) await disconnectRemoteDesktop(false);
  const generation = ++desktopGeneration;
  setDesktopSessionState('connecting', '正在等待对方设备响应…');
  desktopFrameMeta.textContent = '正在通过 MapLink 服务器建立会话';
  const currentProfile = profile();
  let session = await invoke('start_remote_control', { profile: currentProfile, targetDeviceID });
  activeDesktopSession = session.id;
  const deadline = Date.now() + 30000;
  while (session.state === 'pending' && Date.now() < deadline && generation === desktopGeneration) {
    await delay(400);
    session = await invoke('remote_control_session', { profile: currentProfile, sessionId: session.id });
  }
  if (generation !== desktopGeneration) return;
  if (session.state !== 'active') throw new Error(session.error || '对方设备响应超时');
  setDesktopSessionState('connected', `已连接 ${desktopDevices.get(targetDeviceID).name}`);
  remoteScreen.focus();
  remoteScreenPlaceholder.hidden = true;
  remoteScreenImage.hidden = false;
  readRemoteFrames(currentProfile, session.id, generation, session.frameSequence);
}

async function readRemoteFrames(currentProfile, sessionID, generation, after = 0) {
  while (generation === desktopGeneration && activeDesktopSession === sessionID) {
    try {
      const frame = await invoke('remote_control_frame', {
        profile: currentProfile,
        sessionId: sessionID,
        after,
      });
      if (!frame) continue;
      after = frame.sequence;
      remoteScreenImage.src = frame.dataUrl;
      desktopFrameMeta.textContent = `${frame.width} × ${frame.height} · 帧 ${frame.sequence} · 服务器实时中转`;
    } catch (error) {
      if (generation !== desktopGeneration) return;
      await disconnectRemoteDesktop(false);
      setDesktopSessionState('disconnected', '远程桌面已断开');
      desktopHostStatus.textContent = `远程画面中断：${error}`;
      desktopHostStatus.classList.add('error');
      return;
    }
  }
}

async function disconnectRemoteDesktop(notifyServer = true) {
  const sessionID = activeDesktopSession;
  activeDesktopSession = null;
  desktopGeneration += 1;
  desktopInputQueue = [];
  window.clearTimeout(desktopInputTimer);
  desktopInputTimer = undefined;
  remoteScreenImage.hidden = true;
  remoteScreenImage.removeAttribute('src');
  remoteScreenPlaceholder.hidden = false;
  desktopFrameMeta.textContent = '服务器加密认证中转 · 不录屏、不落盘';
  setDesktopSessionState('disconnected', '远程桌面未连接');
  if (notifyServer && sessionID) {
    await invoke('stop_remote_control', { profile: profile(), sessionId: sessionID });
  }
}

function normalizedRemotePoint(event) {
  const bounds = remoteScreenImage.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return null;
  return {
    x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
    y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
  };
}

function queueRemoteInput(event) {
  if (!activeDesktopSession) return;
  if (event.type === 'move' && desktopInputQueue.at(-1)?.type === 'move') desktopInputQueue[desktopInputQueue.length - 1] = event;
  else desktopInputQueue.push(event);
  if (desktopInputQueue.length > 64) desktopInputQueue.splice(0, desktopInputQueue.length - 64);
  if (desktopInputTimer === undefined) desktopInputTimer = window.setTimeout(flushRemoteInput, 16);
}

function flushRemoteInput() {
  desktopInputTimer = undefined;
  const sessionID = activeDesktopSession;
  const events = desktopInputQueue.splice(0, 64);
  if (!sessionID || !events.length) return;
  invoke('send_remote_control_input', { profile: profile(), sessionId: sessionID, events })
    .catch((error) => {
      desktopHostStatus.textContent = `发送远程输入失败：${error}`;
      desktopHostStatus.classList.add('error');
    });
  if (desktopInputQueue.length) desktopInputTimer = window.setTimeout(flushRemoteInput, 16);
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
  event.preventDefault(); showResult(async () => {
    await invoke('save_profile', { profile: profile() });
    await syncRemoteHost();
  });
});
document.querySelector('#copy-config').addEventListener('click', () => showResult(async () => {
  const config = await invoke('render_config', { profile: profile() });
  await navigator.clipboard.writeText(config);
}, '✓ 已复制原版 frpc TOML'));
document.querySelector('#refresh-client').addEventListener('click', () => showResult(refreshRuntime, '✓ 状态已刷新'));
startButton.addEventListener('click', () => showResult(async () => {
  const status = await invoke('start_client', { profile: profile() });
  paintRuntime(status);
  await syncRemoteHost();
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

document.querySelector('#refresh-desktop-devices').addEventListener('click', () => refreshRemoteControlDevices(true));
checkUpdateButton.addEventListener('click', async () => {
  checkUpdateButton.disabled = true;
  updateStatus.className = '';
  updateStatus.textContent = '正在连接 GitHub 检查最新发行版…';
  try {
    const update = await invoke('check_for_update');
    if (!update.available) {
      updateStatus.textContent = `当前已是最新版本 ${update.currentVersion}。`;
      updateStatus.className = 'success';
      return;
    }
    updateStatus.textContent = `发现 v${update.latestVersion}，正在下载并校验安装包…`;
    const result = await invoke('download_and_install_update');
    updateStatus.textContent = result.message;
    updateStatus.className = 'success';
  } catch (error) {
    updateStatus.textContent = `检查或安装更新失败：${error}`;
    updateStatus.className = 'error';
  } finally {
    checkUpdateButton.disabled = false;
  }
});
connectRemoteDesktopButton.addEventListener('click', async () => {
  try {
    await connectRemoteDesktop();
  } catch (error) {
    if (activeDesktopSession) await disconnectRemoteDesktop().catch(() => {});
    setDesktopSessionState('disconnected', '远程桌面连接失败');
    desktopHostStatus.textContent = `连接失败：${error}`;
    desktopHostStatus.classList.add('error');
  }
});
disconnectRemoteDesktopButton.addEventListener('click', () => {
  disconnectRemoteDesktop().catch((error) => {
    desktopHostStatus.textContent = `断开失败：${error}`;
    desktopHostStatus.classList.add('error');
  });
});
remoteControlEnabled.addEventListener('change', async () => {
  try {
    await invoke('save_profile', { profile: profile() });
    await syncRemoteHost();
    await refreshRemoteControlDevices(true);
  } catch (error) {
    desktopHostStatus.textContent = `远程控制主机设置失败：${error}`;
    desktopHostStatus.classList.add('error');
  }
});

remoteScreen.addEventListener('contextmenu', (event) => event.preventDefault());
remoteScreen.addEventListener('pointermove', (event) => {
  const point = normalizedRemotePoint(event);
  if (point) queueRemoteInput({ type: 'move', ...point });
});
remoteScreen.addEventListener('pointerdown', (event) => {
  if (!activeDesktopSession) return;
  event.preventDefault();
  remoteScreen.focus();
  remoteScreen.setPointerCapture?.(event.pointerId);
  const point = normalizedRemotePoint(event);
  if (point) queueRemoteInput({ type: 'move', ...point });
  queueRemoteInput({ type: 'button', button: event.button, down: true, ...(point || {}) });
});
remoteScreen.addEventListener('pointerup', (event) => {
  if (!activeDesktopSession) return;
  event.preventDefault();
  const point = normalizedRemotePoint(event);
  queueRemoteInput({ type: 'button', button: event.button, down: false, ...(point || {}) });
  remoteScreen.releasePointerCapture?.(event.pointerId);
});
remoteScreen.addEventListener('wheel', (event) => {
  if (!activeDesktopSession) return;
  event.preventDefault();
  queueRemoteInput({ type: 'wheel', deltaX: Math.round(event.deltaX), deltaY: Math.round(event.deltaY) });
}, { passive: false });
for (const eventName of ['keydown', 'keyup']) {
  remoteScreen.addEventListener(eventName, (event) => {
    if (!activeDesktopSession || event.isComposing) return;
    event.preventDefault();
    queueRemoteInput({ type: 'key', key: event.key, code: event.code, down: eventName === 'keydown' });
  });
}

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
  remoteControlEnabled.checked = Boolean(saved.remoteControlEnabled);
  saved.proxies.forEach(addProxy);
  syncRemoteHostMapping(saved.proxies);
  updateRemoteAddress();
  refreshOnlineDevices(true);
  syncRemoteHost().then(() => refreshRemoteControlDevices(true)).catch((error) => {
    desktopHostStatus.textContent = `远程控制主机启动失败：${error}`;
    desktopHostStatus.classList.add('error');
  });
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
  window.clearTimeout(desktopInputTimer);
});
