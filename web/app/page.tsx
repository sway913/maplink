'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';

type Tab = 'overview' | 'clients' | 'ports' | 'credentials' | 'security' | 'logs';
type PortRange = { start: number; end: number };
type Config = {
  bindPort: number; kcpBindPort: number; quicBindPort: number;
  vhostHTTPPort: number; vhostHTTPSPort: number; tcpMuxHTTPPort: number;
  controlPorts: PortRange[]; allowedPorts: PortRange[]; maxPortsPerClient: number; maxPoolCount: number;
  tlsEnforced: boolean; detailedClientErrors: boolean;
};
type SystemInfo = {
  publicIP: string; hostname: string; frpVersion: string; serviceState: string;
  bindPort: number; controlPorts: PortRange[]; allowedPorts: PortRange[];
};
type Credentials = {
  serverAddr: string; serverPort: number; controlPorts: number[]; deviceID: string; token: string;
  tcpConfig: string; kcpConfig: string; quicConfig: string;
};
type ListeningPort = { protocol: string; port: number; address: string };
type JsonRecord = Record<string, unknown>;

const navigation: { id: Tab; label: string; detail: string }[] = [
  { id: 'overview', label: '服务总览', detail: '运行状态与流量' },
  { id: 'clients', label: '客户端与代理', detail: '原生 FRP 监控' },
  { id: 'ports', label: '端口管理', detail: '监听与允许范围' },
  { id: 'credentials', label: '连接凭据', detail: 'Token 与配置' },
  { id: 'security', label: '安全设置', detail: '管理密码与会话' },
  { id: 'logs', label: '运行日志', detail: 'systemd 日志' },
];

const proxyTypes = ['tcp', 'udp', 'http', 'https', 'stcp', 'sudp', 'xtcp', 'tcpmux'];

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function listFrom(value: unknown, keys: string[]): JsonRecord[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (isRecord(value)) {
    for (const key of keys) {
      if (Array.isArray(value[key])) return (value[key] as unknown[]).filter(isRecord);
    }
  }
  return [];
}

function metric(source: JsonRecord | null, ...keys: string[]) {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && Number.isFinite(Number(value))) return Number(value);
  }
  return 0;
}

function textValue(source: JsonRecord, ...keys: string[]) {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' || typeof value === 'number') return String(value);
  }
  return '—';
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index > 1 ? 2 : 0)} ${units[index]}`;
}

function rangesLabel(ranges?: PortRange[]) {
  return ranges?.map((range) => range.start === range.end ? `${range.start}` : `${range.start}–${range.end}`).join('，') || '未配置';
}

async function jsonRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((payload as { error?: string }).error || `请求失败（${response.status}）`);
  return payload as T;
}

export default function Home() {
  const [authState, setAuthState] = useState<'checking' | 'guest' | 'authenticated'>('checking');
  const [csrf, setCsrf] = useState('');
  const [activeTab, setActiveTab] = useState<Tab>('overview');
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [draft, setDraft] = useState<Config | null>(null);
  const [credentials, setCredentials] = useState<Credentials | null>(null);
  const [serverInfo, setServerInfo] = useState<JsonRecord | null>(null);
  const [clients, setClients] = useState<JsonRecord[]>([]);
  const [proxies, setProxies] = useState<(JsonRecord & { proxyType?: string })[]>([]);
  const [listeningPorts, setListeningPorts] = useState<ListeningPort[]>([]);
  const [logs, setLogs] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loginNotice, setLoginNotice] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [protocol, setProtocol] = useState<'tcp' | 'kcp' | 'quic'>('tcp');
  const [deviceID, setDeviceID] = useState('device-01');
  const [connectionPort, setConnectionPort] = useState(7000);

  const notify = (value: string) => { setMessage(value); setTimeout(() => setMessage(''), 2800); };

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError('');
    const [systemResult, configResult, credentialsResult, infoResult, clientsResult, portsResult, logsResult, ...proxyResults] = await Promise.allSettled([
      jsonRequest<SystemInfo>('/api/system'),
      jsonRequest<Config>('/api/config'),
      jsonRequest<Credentials>('/api/credentials'),
      jsonRequest<JsonRecord>('/api/frp/serverinfo'),
      jsonRequest<unknown>('/api/frp/clients'),
      jsonRequest<{ ports: ListeningPort[] }>('/api/ports'),
      jsonRequest<{ logs: string }>('/api/logs?lines=180'),
      ...proxyTypes.map((type) => jsonRequest<unknown>(`/api/frp/proxy/${type}`)),
    ]);
    if (systemResult.status === 'fulfilled') setSystem(systemResult.value);
    if (configResult.status === 'fulfilled') { setConfig(configResult.value); setDraft(structuredClone(configResult.value)); }
    if (credentialsResult.status === 'fulfilled') { setCredentials(credentialsResult.value); setDeviceID(credentialsResult.value.deviceID); setConnectionPort(credentialsResult.value.serverPort); }
    if (infoResult.status === 'fulfilled') setServerInfo(infoResult.value);
    if (clientsResult.status === 'fulfilled') setClients(listFrom(clientsResult.value, ['clients', 'data']));
    if (portsResult.status === 'fulfilled') setListeningPorts(portsResult.value.ports || []);
    if (logsResult.status === 'fulfilled') setLogs(logsResult.value.logs);
    const allProxies = proxyResults.flatMap((result, index) => result.status === 'fulfilled'
      ? listFrom(result.value, ['proxies', 'data']).map((item) => ({ ...item, proxyType: proxyTypes[index] }))
      : []);
    setProxies(allProxies);
    const rejected = [systemResult, configResult, credentialsResult].find((result) => result.status === 'rejected');
    if (rejected?.status === 'rejected') setError(rejected.reason instanceof Error ? rejected.reason.message : '读取服务数据失败');
    setLoading(false);
  }, []);

  useEffect(() => {
    jsonRequest<{ csrfToken: string }>('/api/auth/session')
      .then((session) => { setCsrf(session.csrfToken); setAuthState('authenticated'); return loadAll(); })
      .catch(() => setAuthState('guest'));
  }, [loadAll]);

  const mutate = async <T,>(path: string, body: unknown, method = 'POST') => jsonRequest<T>(path, {
    method, body: JSON.stringify(body), headers: { 'X-CSRF-Token': csrf },
  });

  const copy = async (value: string, label: string) => {
    await navigator.clipboard.writeText(value);
    notify(`${label}已复制`);
  };

  const login = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setError(''); setLoading(true);
    const form = new FormData(event.currentTarget);
    try {
      const result = await jsonRequest<{ csrfToken: string }>('/api/auth/login', {
        method: 'POST', body: JSON.stringify({ username: form.get('username'), password: form.get('password') }),
      });
      setCsrf(result.csrfToken); setLoginNotice(''); setAuthState('authenticated'); await loadAll();
    } catch (caught) { setError(caught instanceof Error ? caught.message : '登录失败'); }
    finally { setLoading(false); }
  };

  const logout = async () => {
    try { await mutate('/api/auth/logout', {}); } finally { setAuthState('guest'); setCsrf(''); }
  };

  const restart = async () => {
    if (!confirm('确认重启 frps？现有隧道会短暂重连。')) return;
    setLoading(true); setError('');
    try { await mutate('/api/service', { action: 'restart' }); notify('frps 已重启'); await loadAll(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : '重启失败'); setLoading(false); }
  };

  const saveConfig = async () => {
    if (!draft || !confirm('保存后将先校验配置，再自动重启 frps。继续吗？')) return;
    setLoading(true); setError('');
    try {
      await mutate('/api/config', draft, 'PUT'); notify('配置已生效'); await loadAll();
    } catch (caught) { setError(caught instanceof Error ? caught.message : '保存失败'); setLoading(false); }
  };

  const rotateToken = async () => {
    if (!confirm('轮换 Token 后，所有旧客户端必须更新配置才能重新连接。确认继续？')) return;
    setLoading(true); setError('');
    try { await mutate('/api/credentials/rotate', {}); setShowToken(true); notify('Token 已轮换'); await loadAll(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Token 轮换失败'); setLoading(false); }
  };

  const generateDeviceConfig = async () => {
    setLoading(true); setError('');
    try {
      const next = await jsonRequest<Credentials>(`/api/credentials?device=${encodeURIComponent(deviceID)}&port=${connectionPort}`);
      setCredentials(next); notify(`${deviceID} 的配置已生成`);
    } catch (caught) { setError(caught instanceof Error ? caught.message : '生成设备配置失败'); }
    finally { setLoading(false); }
  };

  const changeAdminPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setLoading(true); setError('');
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const currentPassword = String(form.get('currentPassword') || '');
    const newPassword = String(form.get('newPassword') || '');
    const confirmPassword = String(form.get('confirmPassword') || '');
    try {
      await mutate('/api/auth/password', { currentPassword, newPassword, confirmPassword });
      formElement.reset();
      setCsrf(''); setLoginNotice('管理密码已修改，请使用新密码重新登录。'); setAuthState('guest');
    } catch (caught) { setError(caught instanceof Error ? caught.message : '密码修改失败'); }
    finally { setLoading(false); }
  };

  const clientCount = clients.length || metric(serverInfo, 'clientCounts', 'clientCount', 'curClients');
  const proxyCount = proxies.length || metric(serverInfo, 'proxyCount', 'totalProxyCount');
  const currentConfig = credentials?.[`${protocol}Config` as keyof Credentials] as string || '';
  const trafficIn = metric(serverInfo, 'totalTrafficIn', 'trafficIn');
  const trafficOut = metric(serverInfo, 'totalTrafficOut', 'trafficOut');
  const isOnline = system?.serviceState === 'active';

  const proxyRows = useMemo(() => proxies.map((proxy) => ({
    name: textValue(proxy, 'name', 'proxyName'),
    type: String(proxy.proxyType || textValue(proxy, 'type')),
    client: textValue(proxy, 'clientVersion', 'client', 'clientAddr'),
    status: textValue(proxy, 'status'),
    connections: textValue(proxy, 'curConns', 'currentConnections'),
    traffic: formatBytes(metric(proxy, 'todayTrafficIn') + metric(proxy, 'todayTrafficOut')),
  })), [proxies]);

  if (authState === 'checking') return <div className="loading-screen"><span className="spinner" /><p>正在连接 MapLink 管理服务…</p></div>;

  if (authState === 'guest') return (
    <main className="login-shell">
      <section className="login-story">
        <div className="brand brand-large"><span className="brand-mark" aria-hidden="true" /><div><strong>映链 MapLink</strong><small>MAPLINK SERVER CONSOLE</small></div></div>
        <div><span className="eyebrow light">SELF-HOSTED CONTROL PLANE</span><h1>原版 FRP，<br />多一层可靠管理。</h1><p>配置校验、失败回滚、端口范围、连接凭据与原生监控，都集中在一处。</p></div>
        <ul><li>原版 frps 二进制，不修改协议底层</li><li>HTTPS 会话与 CSRF 防护</li><li>配置失败自动恢复上一版本</li></ul>
      </section>
      <section className="login-form-wrap">
        <form className="login-form" onSubmit={login}>
          <span className="eyebrow">SECURE SIGN IN</span><h2>登录服务端</h2><p>使用安装时生成的管理凭据。</p>
          <label>用户名<input name="username" defaultValue="admin" autoComplete="username" required /></label>
          <label>密码<input name="password" type="password" autoComplete="current-password" required /></label>
          {loginNotice && <div className="alert success">{loginNotice}</div>}
          {error && <div className="alert error">{error}</div>}
          <button className="primary wide" type="submit" disabled={loading}>{loading ? '正在验证…' : '安全登录'}</button>
          <small className="muted">首次访问自签名 HTTPS 证书时，浏览器会显示一次安全提示。</small>
        </form>
      </section>
    </main>
  );

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark" aria-hidden="true" /><div><strong>映链 MapLink</strong><small>MAPLINK SERVER CONSOLE</small></div></div>
        <nav aria-label="管理功能">
          {navigation.map((item, index) => <button className={activeTab === item.id ? 'active' : ''} key={item.id} onClick={() => setActiveTab(item.id)} type="button"><span>{String(index + 1).padStart(2, '0')}</span><div><strong>{item.label}</strong><small>{item.detail}</small></div></button>)}
        </nav>
        <div className="sidebar-foot"><span className={`status-dot ${isOnline ? '' : 'down'}`} /><div><strong>{isOnline ? 'frps 正常运行' : `frps ${system?.serviceState || '未知'}`}</strong><small>{system?.frpVersion || '读取版本中'} · Linux amd64</small></div></div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div><small>{system?.hostname || 'MapLink 节点'} / {system?.publicIP}</small><h1>{navigation.find((item) => item.id === activeTab)?.label}</h1></div>
          <div className="top-actions"><button onClick={() => loadAll()} disabled={loading} type="button">{loading ? '刷新中…' : '刷新数据'}</button><button className="primary" onClick={restart} type="button">重启 frps</button><button className="icon-button" onClick={logout} title="退出登录" type="button">退出</button></div>
        </header>

        <div className="content">
          {error && <div className="alert error"><strong>操作未完成</strong><span>{error}</span><button onClick={() => setError('')} type="button">×</button></div>}
          {message && <div className="toast">✓ {message}</div>}

          {activeTab === 'overview' && <>
            <section className="hero-card"><div><span className="eyebrow light">PUBLIC ENDPOINT</span><h2>{system?.publicIP || '—'}</h2><p>公网地址与控制端口已就绪，可从“连接凭据”生成客户端配置。</p></div><button onClick={() => copy(system?.publicIP || '', '公网 IP')} type="button">复制 IP 地址</button></section>
            <section className="metrics" aria-label="运行指标">
              <article><span>在线客户端</span><strong>{clientCount}</strong><small>当前已认证连接</small></article>
              <article><span>活动代理</span><strong>{proxyCount}</strong><small>TCP / UDP / HTTP / HTTPS</small></article>
              <article><span>累计流入</span><strong>{formatBytes(trafficIn)}</strong><small>FRP 原生监控统计</small></article>
              <article><span>累计流出</span><strong>{formatBytes(trafficOut)}</strong><small>FRP 原生监控统计</small></article>
            </section>
            <section className="overview-grid">
              <article className="panel"><header><div><span className="eyebrow">SERVICE PROFILE</span><h3>服务配置</h3></div><span className={`state-pill ${isOnline ? '' : 'bad'}`}>{isOnline ? '运行中' : '需检查'}</span></header><dl className="detail-list"><div><dt>客户端接入端口</dt><dd>{rangesLabel(system?.controlPorts)}</dd></div><div><dt>允许远程端口</dt><dd>{rangesLabel(system?.allowedPorts)}</dd></div><div><dt>FRP 版本</dt><dd>{system?.frpVersion}</dd></div><div><dt>TLS 强制</dt><dd>{config?.tlsEnforced ? '已启用' : '未启用'}</dd></div></dl></article>
              <article className="panel"><header><div><span className="eyebrow">LISTENING NOW</span><h3>监听端口</h3></div><button onClick={() => setActiveTab('ports')} type="button">管理</button></header><div className="port-chips">{listeningPorts.filter((port) => credentials?.controlPorts.includes(port.port) || [7100, 7400, 7500, 8080, 8443].includes(port.port)).map((port) => <span key={`${port.protocol}-${port.port}`}><i />{port.port}/{port.protocol.toUpperCase()}</span>)}</div><p className="panel-note">实际监听数据来自 Linux `ss`，不是静态配置推断。</p></article>
            </section>
          </>}

          {activeTab === 'clients' && <section className="stack">
            <div className="section-heading"><div><span className="eyebrow">NATIVE FRP TELEMETRY</span><h2>客户端与代理</h2><p>数据直接来自仅监听 127.0.0.1 的 FRP 原生仪表盘 API。</p></div><div className="summary-badges"><span>{clientCount} 客户端</span><span>{proxyRows.length} 代理</span></div></div>
            <article className="panel table-panel"><header><h3>在线客户端</h3><span>原生 `/api/clients`</span></header>{clients.length ? <div className="table-wrap"><table><thead><tr><th>客户端</th><th>来源地址</th><th>版本</th><th>连接时间</th></tr></thead><tbody>{clients.map((client, index) => <tr key={`${textValue(client, 'key', 'hostname', 'clientID')}-${index}`}><td>{textValue(client, 'hostname', 'clientID', 'key', 'user')}</td><td>{textValue(client, 'clientAddress', 'remoteAddr', 'address')}</td><td>{textValue(client, 'version', 'clientVersion')}</td><td>{textValue(client, 'lastStartTime', 'connectTime', 'startedAt')}</td></tr>)}</tbody></table></div> : <EmptyState title="暂无在线客户端" detail="客户端接入后会自动出现在这里。" />}</article>
            <article className="panel table-panel"><header><h3>代理列表</h3><span>全部官方代理类型</span></header>{proxyRows.length ? <div className="table-wrap"><table><thead><tr><th>名称</th><th>类型</th><th>客户端</th><th>状态</th><th>当前连接</th><th>今日流量</th></tr></thead><tbody>{proxyRows.map((row, index) => <tr key={`${row.type}-${row.name}-${index}`}><td>{row.name}</td><td><span className="type-pill">{row.type.toUpperCase()}</span></td><td>{row.client}</td><td>{row.status}</td><td>{row.connections}</td><td>{row.traffic}</td></tr>)}</tbody></table></div> : <EmptyState title="暂无活动代理" detail="已检查 TCP、UDP、HTTP、HTTPS、STCP、SUDP、XTCP 与 TCPMUX。" />}</article>
          </section>}

          {activeTab === 'ports' && draft && <section className="stack">
            <div className="section-heading"><div><span className="eyebrow">VALIDATE · APPLY · ROLLBACK</span><h2>端口与连接限制</h2><p>保存时先由原版 `frps verify` 校验；启动失败会自动回滚。</p></div><button className="primary" onClick={saveConfig} type="button">校验并保存</button></div>
            <article className="panel"><header><div><h3>客户端接入端口段</h3><p>多台设备可以任选其中一个 TCP 端口连接；主控制端口必须包含在范围内，最多 64 个入口。</p></div><button onClick={() => setDraft({ ...draft, controlPorts: [...draft.controlPorts, { start: 7200, end: 7209 }] })} disabled={draft.controlPorts.length >= 8} type="button">＋ 添加接入端口段</button></header><div className="range-list">{draft.controlPorts.map((range, index) => <div className="range-row" key={index}><span>{String(index + 1).padStart(2, '0')}</span><label>起始端口<input type="number" min="1024" max="65535" value={range.start} onChange={(event) => { const next = [...draft.controlPorts]; next[index] = { ...range, start: Number(event.target.value) }; setDraft({ ...draft, controlPorts: next }); }} /></label><i>—</i><label>结束端口<input type="number" min="1024" max="65535" value={range.end} onChange={(event) => { const next = [...draft.controlPorts]; next[index] = { ...range, end: Number(event.target.value) }; setDraft({ ...draft, controlPorts: next }); }} /></label><button aria-label={`删除接入端口段 ${index + 1}`} onClick={() => setDraft({ ...draft, controlPorts: draft.controlPorts.filter((_, itemIndex) => itemIndex !== index) })} disabled={draft.controlPorts.length === 1} type="button">删除</button></div>)}</div><p className="panel-note">入口层只做透明 TCP 转发，认证和协议处理仍由原版 frps 完成。</p></article>
            <article className="panel"><header><div><h3>服务监听端口</h3><p>填 0 可关闭可选协议监听。</p></div></header><div className="form-grid">{[
              ['bindPort', 'FRP 控制端口', 'TCP'], ['kcpBindPort', 'KCP 端口', 'UDP'], ['quicBindPort', 'QUIC 端口', 'UDP'],
              ['vhostHTTPPort', 'HTTP 虚拟主机', 'TCP'], ['vhostHTTPSPort', 'HTTPS 虚拟主机', 'TCP'], ['tcpMuxHTTPPort', 'TCPMUX HTTP CONNECT', 'TCP'],
            ].map(([key, label, suffix]) => <label key={key}><span>{label}<small>{suffix}</small></span><input type="number" min={key === 'bindPort' ? 1 : 0} max="65535" value={draft[key as keyof Config] as number} onChange={(event) => setDraft({ ...draft, [key]: Number(event.target.value) })} /></label>)}</div></article>
            <article className="panel"><header><div><h3>允许的远程端口段</h3><p>最多 32 段；支持单端口和连续范围，不能重叠或占用系统端口。</p></div><button onClick={() => setDraft({ ...draft, allowedPorts: [...draft.allowedPorts, { start: 50001, end: 51000 }] })} disabled={draft.allowedPorts.length >= 32} type="button">＋ 添加端口段</button></header><div className="range-list">{draft.allowedPorts.map((range, index) => <div className="range-row" key={index}><span>{String(index + 1).padStart(2, '0')}</span><label>起始端口<input type="number" min="1" max="65535" value={range.start} onChange={(event) => { const next = [...draft.allowedPorts]; next[index] = { ...range, start: Number(event.target.value) }; setDraft({ ...draft, allowedPorts: next }); }} /></label><i>—</i><label>结束端口<input type="number" min="1" max="65535" value={range.end} onChange={(event) => { const next = [...draft.allowedPorts]; next[index] = { ...range, end: Number(event.target.value) }; setDraft({ ...draft, allowedPorts: next }); }} /></label><button aria-label={`删除端口段 ${index + 1}`} onClick={() => setDraft({ ...draft, allowedPorts: draft.allowedPorts.filter((_, itemIndex) => itemIndex !== index) })} disabled={draft.allowedPorts.length === 1} type="button">删除</button></div>)}</div></article>
            <div className="two-columns"><article className="panel"><header><h3>连接限制</h3></header><div className="settings-list"><label><span>每客户端最大端口数<small>防止单客户端占满端口资源</small></span><input type="number" min="1" max="10000" value={draft.maxPortsPerClient} onChange={(event) => setDraft({ ...draft, maxPortsPerClient: Number(event.target.value) })} /></label><label><span>最大连接池数量<small>对应 transport.maxPoolCount</small></span><input type="number" min="1" max="10000" value={draft.maxPoolCount} onChange={(event) => setDraft({ ...draft, maxPoolCount: Number(event.target.value) })} /></label></div></article><article className="panel"><header><h3>安全选项</h3></header><div className="settings-list toggles"><label><span>强制 TLS<small>拒绝非 TLS 控制连接</small></span><input type="checkbox" checked={draft.tlsEnforced} onChange={(event) => setDraft({ ...draft, tlsEnforced: event.target.checked })} /></label><label><span>返回详细错误<small>关闭可减少向未认证客户端暴露的信息</small></span><input type="checkbox" checked={draft.detailedClientErrors} onChange={(event) => setDraft({ ...draft, detailedClientErrors: event.target.checked })} /></label></div></article></div>
          </section>}

          {activeTab === 'credentials' && credentials && <section className="stack">
            <div className="section-heading"><div><span className="eyebrow">CLIENT BOOTSTRAP</span><h2>连接凭据</h2><p>复制服务地址、Token 或完整基础配置；代理规则可在客户端继续添加。</p></div><button className="danger-button" onClick={rotateToken} type="button">轮换 Token</button></div>
            <article className="panel"><header><div><h3>为设备生成独立配置</h3><p>设备标识会同时写入 clientID 和 user，避免多台设备的代理名称冲突。</p></div><button className="primary" onClick={generateDeviceConfig} type="button">生成设备配置</button></header><div className="form-grid device-builder"><label><span>设备标识<small>字母 / 数字 / - / _</small></span><input value={deviceID} maxLength={32} onChange={(event) => setDeviceID(event.target.value)} /></label><label><span>客户端接入端口<small>TCP</small></span><select value={connectionPort} onChange={(event) => setConnectionPort(Number(event.target.value))}>{credentials.controlPorts.map((port) => <option value={port} key={port}>{port}</option>)}</select></label><div className="device-hint"><strong>多设备规则</strong><span>每台设备使用不同标识；TCP/UDP 的远程端口需避免同协议重复。</span></div></div></article>
            <div className="credential-grid"><article className="credential-card accent"><span>SERVER ADDRESS</span><strong>{credentials.serverAddr}</strong><small>公网 IPv4 地址</small><button onClick={() => copy(credentials.serverAddr, '服务器地址')} type="button">复制地址</button></article><article className="credential-card"><span>SERVER PORT</span><strong>{credentials.serverPort}</strong><small>FRP 控制连接端口</small><button onClick={() => copy(String(credentials.serverPort), '服务端口')} type="button">复制端口</button></article></div>
            <article className="panel secret-panel"><header><div><span className="eyebrow">AUTH TOKEN</span><h3>认证 Token</h3></div><span className="safe-pill">敏感信息</span></header><div className="secret-value"><code>{showToken ? credentials.token : '•'.repeat(32)}</code><button onClick={() => setShowToken(!showToken)} type="button">{showToken ? '隐藏' : '显示'}</button><button className="primary" onClick={() => copy(credentials.token, 'Token')} type="button">复制 Token</button></div><p>Token 同时用于控制连接、心跳和工作连接认证。轮换后旧客户端会失效。</p></article>
            <article className="panel config-panel"><header><div><h3>frpc 基础配置</h3><p>适用于原版 FRP v0.71.0 客户端。</p></div><div className="segmented">{(['tcp', 'kcp', 'quic'] as const).map((item) => <button className={protocol === item ? 'active' : ''} key={item} onClick={() => setProtocol(item)} type="button">{item.toUpperCase()}</button>)}</div></header><pre><code>{currentConfig}</code></pre><button className="copy-config" onClick={() => copy(currentConfig, `${protocol.toUpperCase()} 客户端配置`)} type="button">复制完整配置</button></article>
          </section>}

          {activeTab === 'security' && <section className="stack">
            <div className="section-heading"><div><span className="eyebrow">ACCOUNT SECURITY</span><h2>管理后台密码</h2><p>修改后密码会加盐哈希保存，所有现有管理会话立即退出。</p></div><span className="safe-pill">PBKDF2-SHA256</span></div>
            <article className="panel password-panel"><header><div><h3>修改登录密码</h3><p>用户名保持为 admin；新密码至少 14 个字符。</p></div></header><form onSubmit={changeAdminPassword}><label><span>当前密码<small>验证当前管理员身份</small></span><input name="currentPassword" type="password" autoComplete="current-password" required /></label><label><span>新密码<small>14–256 个字符</small></span><input name="newPassword" type="password" autoComplete="new-password" minLength={14} maxLength={256} required /></label><label><span>确认新密码<small>必须与新密码完全一致</small></span><input name="confirmPassword" type="password" autoComplete="new-password" minLength={14} maxLength={256} required /></label><div className="password-actions"><div><strong>修改后的影响</strong><span>当前浏览器及其他已登录会话都会退出，FRP 客户端 Token 不受影响。</span></div><button className="primary" disabled={loading} type="submit">{loading ? '正在修改…' : '修改管理密码'}</button></div></form></article>
          </section>}

          {activeTab === 'logs' && <section className="stack">
            <div className="section-heading"><div><span className="eyebrow">SYSTEMD JOURNAL</span><h2>运行日志</h2><p>只读显示 `frps.service` 最近 180 行日志，不开放 Shell。</p></div><button onClick={() => loadAll()} type="button">刷新日志</button></div>
            <article className="panel log-panel"><header><div><span className={`status-dot ${isOnline ? '' : 'down'}`} /><strong>{isOnline ? '服务运行中' : '服务状态异常'}</strong></div><span>journalctl · read only</span></header><pre>{logs || '暂无日志。'}</pre></article>
          </section>}
        </div>
      </section>
    </main>
  );
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div className="empty-state"><span>◎</span><h4>{title}</h4><p>{detail}</p></div>;
}
