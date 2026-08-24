const invoke = window.__TAURI__.core.invoke;
const list = document.querySelector('#proxy-list');
const template = document.querySelector('#proxy-template');
const feedback = document.querySelector('#feedback');
const runtimeStatus = document.querySelector('#runtime-status');
const startButton = document.querySelector('#start-client');
const stopButton = document.querySelector('#stop-client');
const aboutDialog = document.querySelector('#about-dialog');
let refreshTimer;

function addProxy(value = {}) {
  const row = template.content.firstElementChild.cloneNode(true);
  for (const input of row.querySelectorAll('[data-field]')) {
    if (value[input.dataset.field] !== undefined) input.value = value[input.dataset.field];
  }
  row.querySelector('[data-remove]').addEventListener('click', () => row.remove());
  list.append(row);
}

function profile() {
  return {
    deviceID: document.querySelector('#deviceID').value.trim(),
    serverAddr: document.querySelector('#serverAddr').value.trim(),
    serverPort: Number(document.querySelector('#serverPort').value),
    token: document.querySelector('#token').value,
    protocol: document.querySelector('#protocol').value,
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

function paintRuntime(status) {
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

async function refreshRuntime() {
  try {
    const [status, logs] = await Promise.all([
      invoke('client_status'),
      invoke('client_logs', { lines: 120 }),
    ]);
    paintRuntime(status);
    document.querySelector('#client-logs').textContent = logs || '暂无日志';
  } catch (error) {
    runtimeStatus.textContent = '状态读取失败';
    runtimeStatus.classList.add('missing');
    feedback.textContent = `错误：${error}`;
  }
}

document.querySelector('#add-proxy').addEventListener('click', () => addProxy());
document.querySelector('#about-button').addEventListener('click', () => aboutDialog.showModal());
aboutDialog.addEventListener('click', (event) => {
  if (event.target === aboutDialog) aboutDialog.close();
});
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
}, '✓ 原版 frpc 已启动'));
stopButton.addEventListener('click', () => showResult(async () => {
  const status = await invoke('stop_client');
  paintRuntime(status);
  await refreshRuntime();
}, '✓ 原版 frpc 已停止'));

invoke('load_profile').then((saved) => {
  if (!saved) { addProxy({ name: 'ssh-home', type: 'tcp', localIP: '127.0.0.1', localPort: 22, remotePort: 30022 }); return; }
  for (const key of ['deviceID', 'serverAddr', 'serverPort', 'token', 'protocol']) document.querySelector(`#${key}`).value = saved[key];
  saved.proxies.forEach(addProxy);
}).catch(() => addProxy());

refreshRuntime();
refreshTimer = window.setInterval(refreshRuntime, 2500);
window.addEventListener('beforeunload', () => window.clearInterval(refreshTimer));
