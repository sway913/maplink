const invoke = window.__TAURI__.core.invoke;
const listen = window.__TAURI__.event.listen;
const emit = window.__TAURI__.event.emit;
const screen = document.querySelector('#viewer-screen');
const image = document.querySelector('#viewer-image');
const placeholder = document.querySelector('#viewer-placeholder');
const status = document.querySelector('#viewer-status');
const metrics = document.querySelector('#viewer-metrics');
const quality = document.querySelector('#viewer-quality');
const clipboard = document.querySelector('#viewer-clipboard');
let connected = false;
let inputQueue = [];
let inputTimer;
let pendingFrame;
let frameAnimation;

function scheduleFrame(frame) {
  pendingFrame = frame;
  if (frameAnimation !== undefined) return;
  frameAnimation = window.requestAnimationFrame(() => {
    frameAnimation = undefined;
    const latest = pendingFrame;
    pendingFrame = undefined;
    if (!latest || !connected) return;
    image.src = latest.dataUrl;
    image.hidden = false;
    placeholder.hidden = true;
    if (pendingFrame) scheduleFrame(pendingFrame);
  });
}

function normalizedPoint(event) {
  const bounds = image.getBoundingClientRect();
  if (!bounds.width || !bounds.height || !image.naturalWidth || !image.naturalHeight) return null;
  const scale = Math.min(bounds.width / image.naturalWidth, bounds.height / image.naturalHeight);
  const renderedWidth = image.naturalWidth * scale;
  const renderedHeight = image.naturalHeight * scale;
  const left = bounds.left + (bounds.width - renderedWidth) / 2;
  const top = bounds.top + (bounds.height - renderedHeight) / 2;
  return {
    x: Math.max(0, Math.min(1, (event.clientX - left) / renderedWidth)),
    y: Math.max(0, Math.min(1, (event.clientY - top) / renderedHeight)),
  };
}

function queueInput(event) {
  if (!connected) return;
  if (event.type === 'move' && inputQueue.at(-1)?.type === 'move') inputQueue[inputQueue.length - 1] = event;
  else inputQueue.push(event);
  if (inputQueue.length > 64) inputQueue.splice(0, inputQueue.length - 64);
  if (inputTimer === undefined) inputTimer = window.setTimeout(flushInput, 16);
}

function flushInput() {
  inputTimer = undefined;
  const events = inputQueue.splice(0, 64);
  if (events.length) emit('remote-viewer-input', { events }).catch(() => {});
  if (inputQueue.length) inputTimer = window.setTimeout(flushInput, 16);
}

Promise.all([
  listen('remote-viewer-state', ({ payload }) => {
    connected = Boolean(payload.connected);
    status.textContent = payload.status || (connected ? '已连接' : '未连接');
    quality.value = payload.quality || '1080p60';
    clipboard.checked = Boolean(payload.clipboardEnabled);
    if (!connected) {
      pendingFrame = undefined;
      if (frameAnimation !== undefined) window.cancelAnimationFrame(frameAnimation);
      frameAnimation = undefined;
      image.hidden = true;
      image.removeAttribute('src');
      placeholder.hidden = false;
      placeholder.textContent = '远程会话已断开';
    }
  }),
  listen('remote-viewer-frame', ({ payload }) => {
    scheduleFrame(payload);
  }),
  listen('remote-viewer-metrics', ({ payload }) => {
    metrics.textContent = payload.text || '服务器实时中转';
  }),
]).then(() => emit('remote-viewer-ready')).catch((error) => {
  status.textContent = `窗口通信失败：${error}`;
});

quality.addEventListener('change', () => emit('remote-viewer-quality', { quality: quality.value }));
clipboard.addEventListener('change', () => emit('remote-viewer-clipboard', { enabled: clipboard.checked }));
document.querySelector('#viewer-exit-fullscreen').addEventListener('click', () => invoke('set_remote_viewer_fullscreen', { fullscreen: false }));
document.querySelector('#viewer-close').addEventListener('click', () => invoke('close_remote_viewer'));

screen.addEventListener('contextmenu', (event) => event.preventDefault());
screen.addEventListener('pointermove', (event) => {
  const point = normalizedPoint(event);
  if (point) queueInput({ type: 'move', ...point });
});
screen.addEventListener('pointerdown', (event) => {
  if (!connected) return;
  event.preventDefault();
  screen.focus();
  screen.setPointerCapture?.(event.pointerId);
  const point = normalizedPoint(event);
  if (point) queueInput({ type: 'move', ...point });
  queueInput({ type: 'button', button: event.button, down: true, ...(point || {}) });
});
screen.addEventListener('pointerup', (event) => {
  if (!connected) return;
  event.preventDefault();
  const point = normalizedPoint(event);
  queueInput({ type: 'button', button: event.button, down: false, ...(point || {}) });
  screen.releasePointerCapture?.(event.pointerId);
});
screen.addEventListener('wheel', (event) => {
  if (!connected) return;
  event.preventDefault();
  queueInput({ type: 'wheel', deltaX: Math.round(event.deltaX), deltaY: Math.round(event.deltaY) });
}, { passive: false });
for (const eventName of ['keydown', 'keyup']) {
  screen.addEventListener(eventName, (event) => {
    if (!connected || event.isComposing) return;
    event.preventDefault();
    queueInput({ type: 'key', key: event.key, code: event.code, down: eventName === 'keydown' });
  });
}

window.addEventListener('beforeunload', () => {
  emit('remote-viewer-closed').catch(() => {});
  window.clearTimeout(inputTimer);
  if (frameAnimation !== undefined) window.cancelAnimationFrame(frameAnimation);
  inputQueue = [];
});
