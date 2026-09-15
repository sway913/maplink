export function deriveConfigView({ profileLoaded = false, profile = null, profileError = '', runtimeLoaded = false, runtime = null, runtimeError = '' }) {
  if (!profileLoaded || !runtimeLoaded) return { mode: 'loading', phase: 'loading', label: '正在读取本机配置与 frpc 状态' };
  if (profileError) return { mode: 'error', phase: 'profile-error', label: '本机配置读取失败' };
  const mode = profile ? 'overview' : 'onboarding';
  if (runtimeError) return { mode, phase: 'read-error', label: '状态读取失败' };
  if (!runtime?.installed) return { mode, phase: 'missing-binary', label: '内置 frpc 缺失' };
  if (runtime.running) return { mode, phase: 'running', label: 'frpc 运行中' };
  return { mode, phase: 'stopped', label: profile ? 'frpc 已停止' : 'frpc 待启动' };
}

export function canStartOnboarding({ credentialsReady, mappingConfirmed, proxyCount, mappingValid = true }) {
  return Boolean(credentialsReady && mappingConfirmed && proxyCount > 0 && mappingValid);
}
