use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, ExitStatus, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

const FRPC_VERSION: &str = "0.71.0";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Proxy {
    name: String,
    #[serde(rename = "type")]
    proxy_type: String,
    #[serde(rename = "localIP")]
    local_ip: String,
    local_port: u16,
    remote_port: u16,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Profile {
    #[serde(default = "default_device_id", rename = "deviceID")]
    device_id: String,
    server_addr: String,
    server_port: u16,
    #[serde(default = "default_manager_port")]
    manager_port: u16,
    token: String,
    protocol: String,
    #[serde(default)]
    ssh_user: String,
    proxies: Vec<Proxy>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FRPCConfig<'a> {
    #[serde(rename = "clientID")]
    client_id: &'a str,
    user: &'a str,
    server_addr: &'a str,
    server_port: u16,
    login_fail_exit: bool,
    auth: Auth<'a>,
    transport: Transport<'a>,
    proxies: Vec<FRPCProxy<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FRPCProxy<'a> {
    name: &'a str,
    #[serde(rename = "type")]
    proxy_type: &'a str,
    #[serde(rename = "localIP")]
    local_ip: &'a str,
    local_port: u16,
    remote_port: u16,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    metadatas: BTreeMap<&'static str, String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Auth<'a> {
    method: &'static str,
    token: &'a str,
    additional_scopes: [&'static str; 2],
}

#[derive(Serialize)]
struct Transport<'a> {
    protocol: &'a str,
    tls: Tls,
}

#[derive(Serialize)]
struct Tls {
    enable: bool,
}

#[derive(Default)]
struct RuntimeState {
    child: Mutex<Option<Child>>,
}

impl RuntimeState {
    fn lock_child(&self) -> Result<std::sync::MutexGuard<'_, Option<Child>>, String> {
        self.child
            .lock()
            .map_err(|_| "客户端进程状态已损坏，请重启应用".to_string())
    }

    fn start_process(&self, binary: &Path, config: &Path, log_path: &Path) -> Result<u32, String> {
        if !binary.is_file() {
            return Err(format!(
                "未找到完整包内的原版 frpc{}，请重新安装或重新解压客户端：{}",
                std::env::consts::EXE_SUFFIX,
                binary.display()
            ));
        }
        if !config.is_file() {
            return Err(format!("frpc 配置不存在：{}", config.display()));
        }

        let mut child_slot = self.lock_child()?;
        if let Some(child) = child_slot.as_mut() {
            if child
                .try_wait()
                .map_err(|error| format!("读取 frpc 状态失败：{error}"))?
                .is_none()
            {
                return Err("frpc 已经在运行，请先停止后再重启".into());
            }
            *child_slot = None;
        }

        if let Some(parent) = log_path.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("创建日志目录失败：{error}"))?;
        }
        let stdout = OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_path)
            .map_err(|error| format!("打开 frpc 日志失败：{error}"))?;
        let stderr = stdout
            .try_clone()
            .map_err(|error| format!("打开 frpc 错误日志失败：{error}"))?;
        let mut command = Command::new(binary);
        command
            .arg("-c")
            .arg(config)
            .stdin(Stdio::null())
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr));
        hide_windows_console(&mut command);
        let child = command
            .spawn()
            .map_err(|error| format!("启动原版 frpc 失败：{error}"))?;
        let pid = child.id();
        *child_slot = Some(child);
        Ok(pid)
    }

    fn stop_process(&self) -> Result<(), String> {
        let mut child_slot = self.lock_child()?;
        let Some(mut child) = child_slot.take() else {
            return Ok(());
        };
        if child
            .try_wait()
            .map_err(|error| format!("读取 frpc 状态失败：{error}"))?
            .is_none()
        {
            child
                .kill()
                .map_err(|error| format!("停止 frpc 失败：{error}"))?;
            child
                .wait()
                .map_err(|error| format!("等待 frpc 停止失败：{error}"))?;
        }
        Ok(())
    }

    fn process_status(&self) -> Result<(bool, Option<u32>), String> {
        let mut child_slot = self.lock_child()?;
        let Some(child) = child_slot.as_mut() else {
            return Ok((false, None));
        };
        match child
            .try_wait()
            .map_err(|error| format!("读取 frpc 状态失败：{error}"))?
        {
            None => Ok((true, Some(child.id()))),
            Some(_) => {
                *child_slot = None;
                Ok((false, None))
            }
        }
    }

    #[cfg(test)]
    fn is_running(&self) -> Result<bool, String> {
        self.process_status().map(|status| status.0)
    }
}

impl Drop for RuntimeState {
    fn drop(&mut self) {
        if let Ok(child_slot) = self.child.get_mut() {
            if let Some(child) = child_slot.as_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClientStatus {
    installed: bool,
    running: bool,
    pid: Option<u32>,
    frpc_version: &'static str,
    binary_path: String,
    config_path: String,
    log_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RemotePlatformInfo {
    platform: &'static str,
    label: &'static str,
    username: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct OnlineSSHDevice {
    id: String,
    name: String,
    client_id: String,
    hostname: String,
    proxy_name: String,
    remote_port: u16,
    platform: String,
    ssh_user: String,
}

#[derive(Deserialize)]
struct OnlineSSHDevicesResponse {
    devices: Vec<OnlineSSHDevice>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteCommandRequest {
    host: String,
    username: String,
    port: u16,
    command: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteCommandResult {
    success: bool,
    timed_out: bool,
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteShellRequest {
    host: String,
    username: String,
    port: u16,
    platform: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteShellOutput {
    generation: u64,
    bytes: Vec<u8>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteShellClosed {
    generation: u64,
}

const REMOTE_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
const REMOTE_OUTPUT_LIMIT: usize = 256 * 1024;

struct RuntimePaths {
    binary: PathBuf,
    config: PathBuf,
    log: PathBuf,
}

struct RemoteShellSession {
    generation: u64,
    child: Child,
    stdin: ChildStdin,
}

#[derive(Default)]
struct RemoteShellInner {
    generation: u64,
    session: Option<RemoteShellSession>,
}

#[derive(Default)]
struct RemoteShellState {
    inner: Mutex<RemoteShellInner>,
}

impl RemoteShellState {
    fn lock_inner(&self) -> Result<std::sync::MutexGuard<'_, RemoteShellInner>, String> {
        self.inner
            .lock()
            .map_err(|_| "SSH 终端状态已损坏，请重启应用".to_string())
    }

    fn stop(&self, generation: Option<u64>) -> Result<(), String> {
        let mut inner = self.lock_inner()?;
        let should_stop = inner
            .session
            .as_ref()
            .is_some_and(|session| generation.is_none() || generation == Some(session.generation));
        if !should_stop {
            return Ok(());
        }
        if let Some(mut session) = inner.session.take() {
            if session
                .child
                .try_wait()
                .map_err(|error| format!("读取 SSH 终端状态失败：{error}"))?
                .is_none()
            {
                session
                    .child
                    .kill()
                    .map_err(|error| format!("断开 SSH 终端失败：{error}"))?;
                session
                    .child
                    .wait()
                    .map_err(|error| format!("等待 SSH 终端退出失败：{error}"))?;
            }
        }
        Ok(())
    }
}

impl Drop for RemoteShellState {
    fn drop(&mut self) {
        if let Ok(inner) = self.inner.get_mut() {
            if let Some(session) = inner.session.as_mut() {
                let _ = session.child.kill();
                let _ = session.child.wait();
            }
        }
    }
}

fn default_device_id() -> String {
    "device-01".into()
}

fn default_manager_port() -> u16 {
    7400
}

fn local_platform() -> &'static str {
    #[cfg(windows)]
    return "windows";
    #[cfg(target_os = "macos")]
    return "macos";
    #[allow(unreachable_code)]
    "linux"
}

fn local_username() -> String {
    let keys: &[&str] = if cfg!(windows) {
        &["USERNAME", "USER"]
    } else {
        &["USER", "USERNAME"]
    };
    keys.iter()
        .find_map(|key| std::env::var(key).ok())
        .unwrap_or_default()
}

fn hide_windows_console(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = command;
}

fn validate(profile: &Profile) -> Result<(), String> {
    if profile.device_id.is_empty()
        || profile.device_id.len() > 32
        || !profile
            .device_id
            .chars()
            .all(|char| char.is_ascii_alphanumeric() || char == '-' || char == '_')
    {
        return Err("设备标识只能包含字母、数字、短横线和下划线，长度 1-32".into());
    }
    if profile.server_addr.trim().is_empty() {
        return Err("服务器地址不能为空".into());
    }
    if profile.manager_port == 0 {
        return Err("管理端口必须在 1-65535 之间".into());
    }
    if profile.token.len() < 16 {
        return Err("Token 至少需要 16 个字符".into());
    }
    if !matches!(profile.protocol.as_str(), "tcp" | "kcp" | "quic") {
        return Err("不支持的传输协议".into());
    }
    if !profile.ssh_user.is_empty()
        && (profile.ssh_user.len() > 64
            || !profile.ssh_user.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-' | '\\')
            }))
    {
        return Err("本机 SSH 用户名格式无效".into());
    }
    if profile.proxies.is_empty() {
        return Err("至少需要一条端口映射".into());
    }
    for proxy in &profile.proxies {
        if proxy.name.trim().is_empty() || proxy.local_ip.trim().is_empty() {
            return Err("映射名称和本地 IP 不能为空".into());
        }
        if !matches!(proxy.proxy_type.as_str(), "tcp" | "udp") {
            return Err(format!("映射 {} 的类型无效", proxy.name));
        }
    }
    Ok(())
}

fn validate_remote_connection(host: &str, username: &str, port: u16) -> Result<(), String> {
    let host = host.trim();
    if host.is_empty()
        || host.len() > 253
        || !host.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | ':' | '[' | ']')
        })
        || !host
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_alphanumeric() || character == '[')
    {
        return Err("SSH 主机名或地址无效".into());
    }
    let username = username.trim();
    if username.is_empty()
        || username.len() > 64
        || !username.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-' | '\\')
        })
    {
        return Err("SSH 用户名只能包含字母、数字、点、短横线、下划线或域分隔符".into());
    }
    if port == 0 {
        return Err("SSH 端口必须在 1-65535 之间".into());
    }
    Ok(())
}

fn validate_remote_request(request: &RemoteCommandRequest) -> Result<(), String> {
    validate_remote_connection(&request.host, &request.username, request.port)?;
    let command = request.command.trim();
    if command.is_empty() || command.len() > 8192 || command.contains('\0') {
        return Err("远程命令不能为空，且长度不能超过 8192 个字符".into());
    }
    Ok(())
}

fn ssh_shell_arguments(request: &RemoteShellRequest) -> Result<Vec<String>, String> {
    validate_remote_connection(&request.host, &request.username, request.port)?;
    if !matches!(request.platform.as_str(), "windows" | "macos") {
        return Err("远端系统类型无效".into());
    }
    let mut arguments = vec![
        "-tt".into(),
        "-p".into(),
        request.port.to_string(),
        "-o".into(),
        "BatchMode=yes".into(),
        "-o".into(),
        "ConnectTimeout=8".into(),
        "-o".into(),
        "ServerAliveInterval=5".into(),
        "-o".into(),
        "ServerAliveCountMax=1".into(),
        "-o".into(),
        "StrictHostKeyChecking=accept-new".into(),
        "--".into(),
        format!("{}@{}", request.username.trim(), request.host.trim()),
    ];
    if request.platform == "windows" {
        arguments.push("powershell.exe -NoExit".into());
    }
    Ok(arguments)
}

fn ssh_arguments(request: &RemoteCommandRequest) -> Result<Vec<String>, String> {
    validate_remote_request(request)?;
    Ok(vec![
        "-p".into(),
        request.port.to_string(),
        "-o".into(),
        "BatchMode=yes".into(),
        "-o".into(),
        "ConnectTimeout=8".into(),
        "-o".into(),
        "ServerAliveInterval=5".into(),
        "-o".into(),
        "ServerAliveCountMax=1".into(),
        "-o".into(),
        "StrictHostKeyChecking=accept-new".into(),
        "--".into(),
        format!("{}@{}", request.username.trim(), request.host.trim()),
        request.command.trim().into(),
    ])
}

fn read_capped<R: Read>(mut reader: R) -> Result<Vec<u8>, String> {
    let mut retained = Vec::new();
    let mut buffer = [0_u8; 8192];
    let mut truncated = false;
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|error| format!("读取 SSH 输出失败：{error}"))?;
        if count == 0 {
            break;
        }
        if retained.len() < REMOTE_OUTPUT_LIMIT {
            let remaining = REMOTE_OUTPUT_LIMIT - retained.len();
            retained.extend_from_slice(&buffer[..count.min(remaining)]);
            truncated |= count > remaining;
        } else {
            truncated = true;
        }
    }
    if truncated {
        retained.extend_from_slice(b"\n[MapLink: output truncated at 256 KB]\n");
    }
    Ok(retained)
}

fn wait_for_remote_child(
    child: &mut Child,
    timeout: Duration,
) -> Result<(ExitStatus, bool), String> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("等待 SSH 命令失败：{error}"))?
        {
            return Ok((status, false));
        }
        if Instant::now() >= deadline {
            child
                .kill()
                .map_err(|error| format!("终止超时 SSH 命令失败：{error}"))?;
            let status = child
                .wait()
                .map_err(|error| format!("回收超时 SSH 命令失败：{error}"))?;
            return Ok((status, true));
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn execute_remote_command_with(
    ssh_program: &Path,
    request: RemoteCommandRequest,
    timeout: Duration,
) -> Result<RemoteCommandResult, String> {
    let arguments = ssh_arguments(&request)?;
    let mut command = Command::new(ssh_program);
    command
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_windows_console(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("启动系统 SSH 客户端失败：{error}"))?;
    let stdout = child.stdout.take().ok_or("无法读取 SSH 标准输出")?;
    let stderr = child.stderr.take().ok_or("无法读取 SSH 错误输出")?;
    let stdout_reader = thread::spawn(move || read_capped(stdout));
    let stderr_reader = thread::spawn(move || read_capped(stderr));
    let (status, timed_out) = wait_for_remote_child(&mut child, timeout)?;
    let stdout = stdout_reader
        .join()
        .map_err(|_| "SSH 标准输出读取线程异常".to_string())??;
    let stderr = stderr_reader
        .join()
        .map_err(|_| "SSH 错误输出读取线程异常".to_string())??;
    Ok(RemoteCommandResult {
        success: status.success() && !timed_out,
        timed_out,
        exit_code: status.code(),
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
    })
}

#[tauri::command]
fn remote_platform() -> RemotePlatformInfo {
    #[cfg(windows)]
    return RemotePlatformInfo {
        platform: "windows",
        label: "Windows",
        username: local_username(),
    };
    #[cfg(target_os = "macos")]
    return RemotePlatformInfo {
        platform: "macos",
        label: "macOS",
        username: local_username(),
    };
    #[allow(unreachable_code)]
    RemotePlatformInfo {
        platform: "linux",
        label: "Linux",
        username: local_username(),
    }
}

fn manager_host(host: &str) -> String {
    let host = host.trim();
    if host.contains(':') && !(host.starts_with('[') && host.ends_with(']')) {
        format!("[{host}]")
    } else {
        host.to_string()
    }
}

fn device_discovery_signature(token: &str, timestamp: u64) -> Result<String, String> {
    let payload = format!("GET\n/api/client/devices\n{timestamp}");
    let mut mac = Hmac::<Sha256>::new_from_slice(token.as_bytes())
        .map_err(|_| "Token 无法用于设备查询签名".to_string())?;
    mac.update(payload.as_bytes());
    Ok(mac
        .finalize()
        .into_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

#[tauri::command]
async fn online_ssh_devices(profile: Profile) -> Result<Vec<OnlineSSHDevice>, String> {
    validate(&profile)?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "系统时间无效，无法查询在线设备".to_string())?
        .as_secs();
    let signature = device_discovery_signature(&profile.token, timestamp)?;
    let url = format!(
        "https://{}:{}/api/client/devices",
        manager_host(&profile.server_addr),
        profile.manager_port
    );
    // MapLink Server installs a local/self-signed certificate by default. The
    // request sends a short-lived HMAC proof instead of the FRP token itself.
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|error| format!("初始化在线设备查询失败：{error}"))?;
    let response = client
        .get(url)
        .header("X-MapLink-Timestamp", timestamp.to_string())
        .header("X-MapLink-Signature", signature)
        .header(reqwest::header::CACHE_CONTROL, "no-store")
        .send()
        .await
        .map_err(|error| format!("无法连接 MapLink 管理服务：{error}"))?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err("管理服务拒绝访问，请检查 Token".into());
    }
    if !response.status().is_success() {
        return Err(format!("在线设备查询失败：HTTP {}", response.status()));
    }
    let body = response
        .json::<OnlineSSHDevicesResponse>()
        .await
        .map_err(|error| format!("在线设备响应无效：{error}"))?;
    Ok(body.devices)
}

#[tauri::command]
async fn run_remote_command(request: RemoteCommandRequest) -> Result<RemoteCommandResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let program = std::env::var_os("MAPLINK_SSH_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("ssh"));
        execute_remote_command_with(&program, request, REMOTE_COMMAND_TIMEOUT)
    })
    .await
    .map_err(|error| format!("远程命令任务异常：{error}"))?
}

fn stream_remote_shell<R: Read + Send + 'static>(
    mut reader: R,
    app: AppHandle,
    generation: u64,
    notify_closed: bool,
) {
    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    let _ = app.emit(
                        "remote-shell-output",
                        RemoteShellOutput {
                            generation,
                            bytes: buffer[..count].to_vec(),
                        },
                    );
                }
                Err(error) => {
                    let _ = app.emit(
                        "remote-shell-output",
                        RemoteShellOutput {
                            generation,
                            bytes: format!("\r\n[MapLink: 读取 SSH 终端失败：{error}]\r\n")
                                .into_bytes(),
                        },
                    );
                    break;
                }
            }
        }
        if notify_closed {
            let _ = app.emit("remote-shell-closed", RemoteShellClosed { generation });
        }
    });
}

#[tauri::command]
fn start_remote_shell(
    app: AppHandle,
    state: State<'_, RemoteShellState>,
    request: RemoteShellRequest,
) -> Result<u64, String> {
    let arguments = ssh_shell_arguments(&request)?;
    let program = std::env::var_os("MAPLINK_SSH_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("ssh"));
    let mut inner = state.lock_inner()?;
    if let Some(mut previous) = inner.session.take() {
        let _ = previous.child.kill();
        let _ = previous.child.wait();
    }
    inner.generation = inner.generation.wrapping_add(1).max(1);
    let generation = inner.generation;
    let mut command = Command::new(program);
    command
        .args(arguments)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_windows_console(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("启动交互式 SSH 终端失败：{error}"))?;
    let stdin = child.stdin.take().ok_or("无法写入 SSH 终端")?;
    let stdout = child.stdout.take().ok_or("无法读取 SSH 终端输出")?;
    let stderr = child.stderr.take().ok_or("无法读取 SSH 终端错误输出")?;
    stream_remote_shell(stdout, app.clone(), generation, true);
    stream_remote_shell(stderr, app, generation, false);
    inner.session = Some(RemoteShellSession {
        generation,
        child,
        stdin,
    });
    Ok(generation)
}

#[tauri::command]
fn write_remote_shell(
    state: State<'_, RemoteShellState>,
    generation: u64,
    input: String,
) -> Result<(), String> {
    if input.len() > 64 * 1024 {
        return Err("单次终端输入不能超过 64 KB".into());
    }
    let mut inner = state.lock_inner()?;
    let session = inner.session.as_mut().ok_or("SSH 终端尚未连接")?;
    if session.generation != generation {
        return Err("SSH 终端会话已更新".into());
    }
    session
        .stdin
        .write_all(input.as_bytes())
        .and_then(|_| session.stdin.flush())
        .map_err(|error| format!("写入 SSH 终端失败：{error}"))
}

#[tauri::command]
fn stop_remote_shell(
    state: State<'_, RemoteShellState>,
    generation: Option<u64>,
) -> Result<(), String> {
    state.stop(generation)
}

fn profile_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|path| path.join("profile.toml"))
        .map_err(|error| error.to_string())
}

fn resolve_frpc_binary(
    override_path: Option<PathBuf>,
    resource_dir: &Path,
    executable_dir: &Path,
) -> PathBuf {
    if let Some(path) = override_path {
        return path;
    }
    let packaged = resource_dir.join(format!("frpc{}", std::env::consts::EXE_SUFFIX));
    if packaged.is_file() {
        return packaged;
    }
    executable_dir.join(format!("frpc{}", std::env::consts::EXE_SUFFIX))
}

fn runtime_paths(app: &AppHandle) -> Result<RuntimePaths, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("读取应用资源目录失败：{error}"))?;
    let executable =
        std::env::current_exe().map_err(|error| format!("读取应用程序路径失败：{error}"))?;
    let executable_dir = executable.parent().ok_or("应用程序目录无效")?;
    let binary = resolve_frpc_binary(
        std::env::var_os("FRP_DESKTOP_FRPC_PATH").map(PathBuf::from),
        &resource_dir,
        executable_dir,
    );
    Ok(RuntimePaths {
        binary,
        config: config_dir.join("frpc.toml"),
        log: config_dir.join("frpc.log"),
    })
}

fn write_runtime_config(path: &Path, contents: &str) -> Result<(), String> {
    let parent = path.parent().ok_or("配置目录无效")?;
    fs::create_dir_all(parent).map_err(|error| format!("创建配置目录失败：{error}"))?;
    fs::write(path, contents).map_err(|error| format!("写入 frpc 配置失败：{error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("限制配置文件权限失败：{error}"))?;
    }
    Ok(())
}

#[tauri::command]
fn render_config(profile: Profile) -> Result<String, String> {
    validate(&profile)?;
    let proxies = profile
        .proxies
        .iter()
        .map(|proxy| {
            let mut metadatas = BTreeMap::new();
            if proxy.proxy_type == "tcp" && proxy.local_port == 22 {
                metadatas.insert("maplinkPlatform", local_platform().to_string());
                if !profile.ssh_user.is_empty() {
                    metadatas.insert("maplinkSSHUser", profile.ssh_user.clone());
                }
            }
            FRPCProxy {
                name: &proxy.name,
                proxy_type: &proxy.proxy_type,
                local_ip: &proxy.local_ip,
                local_port: proxy.local_port,
                remote_port: proxy.remote_port,
                metadatas,
            }
        })
        .collect();
    toml::to_string_pretty(&FRPCConfig {
        client_id: &profile.device_id,
        user: &profile.device_id,
        server_addr: &profile.server_addr,
        server_port: profile.server_port,
        login_fail_exit: false,
        auth: Auth {
            method: "token",
            token: &profile.token,
            additional_scopes: ["HeartBeats", "NewWorkConns"],
        },
        transport: Transport {
            protocol: &profile.protocol,
            tls: Tls { enable: true },
        },
        proxies,
    })
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn save_profile(app: AppHandle, profile: Profile) -> Result<(), String> {
    validate(&profile)?;
    let path = profile_path(&app)?;
    let parent = path.parent().ok_or("配置目录无效")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let contents = toml::to_string_pretty(&profile).map_err(|error| error.to_string())?;
    fs::write(path, contents).map_err(|error| error.to_string())
}

#[tauri::command]
fn load_profile(app: AppHandle) -> Result<Option<Profile>, String> {
    let path = profile_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    let contents = fs::read_to_string(path).map_err(|error| error.to_string())?;
    toml::from_str(&contents)
        .map(Some)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn start_client(
    app: AppHandle,
    runtime: State<'_, RuntimeState>,
    profile: Profile,
) -> Result<ClientStatus, String> {
    let config = render_config(profile.clone())?;
    save_profile(app.clone(), profile)?;
    let paths = runtime_paths(&app)?;
    write_runtime_config(&paths.config, &config)?;
    runtime.start_process(&paths.binary, &paths.config, &paths.log)?;
    client_status(app, runtime)
}

#[tauri::command]
fn stop_client(app: AppHandle, runtime: State<'_, RuntimeState>) -> Result<ClientStatus, String> {
    runtime.stop_process()?;
    client_status(app, runtime)
}

#[tauri::command]
fn client_status(app: AppHandle, runtime: State<'_, RuntimeState>) -> Result<ClientStatus, String> {
    let paths = runtime_paths(&app)?;
    let (running, pid) = runtime.process_status()?;
    Ok(ClientStatus {
        installed: paths.binary.is_file(),
        running,
        pid,
        frpc_version: FRPC_VERSION,
        binary_path: paths.binary.to_string_lossy().into_owned(),
        config_path: paths.config.to_string_lossy().into_owned(),
        log_path: paths.log.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
fn client_logs(app: AppHandle, lines: Option<usize>) -> Result<String, String> {
    let path = runtime_paths(&app)?.log;
    if !path.exists() {
        return Ok(String::new());
    }
    let contents =
        fs::read_to_string(&path).map_err(|error| format!("读取 frpc 日志失败：{error}"))?;
    let lines = lines.unwrap_or(120).clamp(20, 500);
    let selected = contents.lines().rev().take(lines).collect::<Vec<_>>();
    Ok(selected.into_iter().rev().collect::<Vec<_>>().join("\n"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(RuntimeState::default())
        .manage(RemoteShellState::default())
        .invoke_handler(tauri::generate_handler![
            render_config,
            save_profile,
            load_profile,
            start_client,
            stop_client,
            client_status,
            client_logs,
            remote_platform,
            online_ssh_devices,
            run_remote_command,
            start_remote_shell,
            write_remote_shell,
            stop_remote_shell
        ])
        .build(tauri::generate_context!())
        .expect("error while building MapLink Client");
    app.run(|app_handle, event| {
        if matches!(event, RunEvent::Exit) {
            let runtime = app_handle.state::<RuntimeState>();
            let _ = runtime.stop_process();
            let remote_shell = app_handle.state::<RemoteShellState>();
            let _ = remote_shell.stop(None);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEST_DIRECTORY_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn renders_official_frpc_toml_with_multiple_proxies() {
        let profile = Profile {
            device_id: "office-pc".into(),
            server_addr: "203.0.113.10".into(),
            server_port: 7000,
            manager_port: 7400,
            token: "0123456789abcdef".into(),
            protocol: "tcp".into(),
            ssh_user: "codex-user".into(),
            proxies: vec![
                Proxy {
                    name: "ssh".into(),
                    proxy_type: "tcp".into(),
                    local_ip: "127.0.0.1".into(),
                    local_port: 22,
                    remote_port: 30022,
                },
                Proxy {
                    name: "dns".into(),
                    proxy_type: "udp".into(),
                    local_ip: "127.0.0.1".into(),
                    local_port: 53,
                    remote_port: 30053,
                },
            ],
        };
        let config = render_config(profile).expect("config should render");
        for expected in [
            "clientID = \"office-pc\"",
            "user = \"office-pc\"",
            "serverAddr = \"203.0.113.10\"",
            "additionalScopes = [",
            "\"HeartBeats\"",
            "\"NewWorkConns\"",
            "transport",
            "localIP = \"127.0.0.1\"",
            "remotePort = 30022",
            "remotePort = 30053",
            "maplinkPlatform",
            "maplinkSSHUser = \"codex-user\"",
        ] {
            assert!(config.contains(expected), "missing {expected}:\n{config}");
        }
    }

    #[test]
    fn old_profiles_gain_safe_online_device_defaults() {
        let profile: Profile = toml::from_str(
            r#"
deviceID = "legacy-pc"
serverAddr = "203.0.113.10"
serverPort = 7000
token = "0123456789abcdef"
protocol = "tcp"

[[proxies]]
name = "ssh"
type = "tcp"
localIP = "127.0.0.1"
localPort = 22
remotePort = 30022
"#,
        )
        .expect("v0.3 profile should remain readable");
        assert_eq!(profile.manager_port, 7400);
        assert!(profile.ssh_user.is_empty());
    }

    fn sidecar_test_dir() -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be valid")
            .as_nanos();
        let sequence = TEST_DIRECTORY_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "frp-desktop-sidecar-{}-{suffix}-{sequence}",
            std::process::id(),
        ))
    }

    fn remote_request(command: &str) -> RemoteCommandRequest {
        RemoteCommandRequest {
            host: "demo.maplink.local".into(),
            username: "codex-user".into(),
            port: 23022,
            command: command.into(),
        }
    }

    #[test]
    fn remote_shell_validates_connection_fields_and_keeps_command_as_one_argument() {
        let request = remote_request("printf MAPLINK_OK; uname -a");
        let arguments = ssh_arguments(&request).expect("valid SSH request should render");
        assert_eq!(arguments.last().unwrap(), "printf MAPLINK_OK; uname -a");
        assert!(arguments.contains(&"BatchMode=yes".to_string()));
        assert!(arguments.contains(&"StrictHostKeyChecking=accept-new".to_string()));
        assert!(arguments.contains(&"codex-user@demo.maplink.local".to_string()));

        for (host, username) in [
            ("demo host", "codex-user"),
            ("-oProxyCommand=bad", "codex-user"),
            ("demo.maplink.local", "user;bad"),
            ("demo.maplink.local", "user@bad"),
        ] {
            let invalid = RemoteCommandRequest {
                host: host.into(),
                username: username.into(),
                port: 23022,
                command: "whoami".into(),
            };
            assert!(validate_remote_request(&invalid).is_err());
        }
    }

    #[test]
    fn interactive_remote_shell_allocates_a_tty_and_opens_the_selected_system_shell() {
        let windows = RemoteShellRequest {
            host: "demo.maplink.local".into(),
            username: "codex-user".into(),
            port: 23022,
            platform: "windows".into(),
        };
        let windows_arguments = ssh_shell_arguments(&windows).expect("Windows shell should render");
        assert_eq!(windows_arguments.first().unwrap(), "-tt");
        assert_eq!(windows_arguments.last().unwrap(), "powershell.exe -NoExit");

        let macos = RemoteShellRequest {
            platform: "macos".into(),
            ..windows
        };
        let macos_arguments = ssh_shell_arguments(&macos).expect("macOS shell should render");
        assert_eq!(macos_arguments.first().unwrap(), "-tt");
        assert_eq!(
            macos_arguments.last().unwrap(),
            "codex-user@demo.maplink.local"
        );
        assert!(!macos_arguments
            .iter()
            .any(|argument| argument.contains("powershell")));
    }

    #[test]
    fn online_device_request_uses_a_short_lived_hmac_proof() {
        assert_eq!(
            device_discovery_signature("0123456789abcdef", 1_700_000_000).unwrap(),
            "f2b1286b57ce28ed4e1a9cca5d12a1bebb6cf22d876d3a0cb92bf6abe9487d0a"
        );
    }

    #[test]
    fn remote_shell_caps_large_output() {
        let oversized = vec![b'x'; REMOTE_OUTPUT_LIMIT + 4096];
        let output = read_capped(oversized.as_slice()).expect("large output should be readable");
        assert!(output.starts_with(&vec![b'x'; REMOTE_OUTPUT_LIMIT]));
        assert!(String::from_utf8_lossy(&output).contains("output truncated at 256 KB"));
    }

    #[test]
    #[cfg(unix)]
    fn remote_shell_executes_through_ssh_program_and_captures_output() {
        use std::os::unix::fs::PermissionsExt;
        let dir = sidecar_test_dir();
        fs::create_dir_all(&dir).expect("test directory should be created");
        let fake_ssh = dir.join("fake-ssh");
        fs::write(
            &fake_ssh,
            "#!/bin/sh\nprintf 'ARG:%s\\n' \"$@\"\nprintf 'fake ssh stderr\\n' >&2\nexit 0\n",
        )
        .expect("fake SSH should be written");
        fs::set_permissions(&fake_ssh, fs::Permissions::from_mode(0o700))
            .expect("fake SSH should be executable");

        let result = execute_remote_command_with(
            &fake_ssh,
            remote_request("printf MAPLINK_OK; uname -a"),
            Duration::from_secs(2),
        )
        .expect("fake SSH should execute");
        assert!(result.success);
        assert!(!result.timed_out);
        assert_eq!(result.exit_code, Some(0));
        assert!(result.stdout.contains("ARG:printf MAPLINK_OK; uname -a"));
        assert!(result.stderr.contains("fake ssh stderr"));
        fs::remove_dir_all(&dir).expect("test directory should be removed");
    }

    #[test]
    #[cfg(unix)]
    fn remote_shell_terminates_commands_after_the_deadline() {
        use std::os::unix::fs::PermissionsExt;
        let dir = sidecar_test_dir();
        fs::create_dir_all(&dir).expect("test directory should be created");
        let fake_ssh = dir.join("slow-ssh");
        fs::write(&fake_ssh, "#!/bin/sh\nexec sleep 5\n").expect("slow SSH should be written");
        fs::set_permissions(&fake_ssh, fs::Permissions::from_mode(0o700))
            .expect("slow SSH should be executable");

        let result = execute_remote_command_with(
            &fake_ssh,
            remote_request("whoami"),
            Duration::from_millis(100),
        )
        .expect("slow SSH should be terminated cleanly");
        assert!(!result.success);
        assert!(result.timed_out);
        fs::remove_dir_all(&dir).expect("test directory should be removed");
    }

    #[test]
    fn starts_reports_and_stops_original_sidecar_process() {
        let dir = sidecar_test_dir();
        fs::create_dir_all(&dir).expect("test directory should be created");
        let config = dir.join("frpc.toml");
        fs::write(&config, "serverAddr = \"127.0.0.1\"\n").expect("config should be written");
        let log = dir.join("frpc.log");

        #[cfg(windows)]
        let binary = {
            let path = dir.join("fake-frpc.cmd");
            fs::write(
                &path,
                "@echo fake-frpc-started\r\n@ping -n 30 127.0.0.1 >nul\r\n",
            )
            .expect("fake sidecar should be written");
            path
        };
        #[cfg(unix)]
        let binary = {
            use std::os::unix::fs::PermissionsExt;
            let path = dir.join("fake-frpc");
            fs::write(&path, "#!/bin/sh\necho fake-frpc-started\nsleep 30\n")
                .expect("fake sidecar should be written");
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
                .expect("fake sidecar should be executable");
            path
        };

        let runtime = RuntimeState::default();
        runtime
            .start_process(&binary, &config, &log)
            .expect("sidecar should start");
        let mut log_contents = String::new();
        for _ in 0..40 {
            log_contents = fs::read_to_string(&log).expect("log should be readable");
            if log_contents.contains("fake-frpc-started") {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(runtime.is_running().expect("status should be readable"));
        runtime.stop_process().expect("sidecar should stop");
        assert!(!runtime.is_running().expect("status should be readable"));
        assert!(log_contents.contains("fake-frpc-started"));

        fs::remove_dir_all(&dir).expect("test directory should be removed");
    }

    #[test]
    fn refuses_to_start_when_original_frpc_is_missing() {
        let dir = sidecar_test_dir();
        fs::create_dir_all(&dir).expect("test directory should be created");
        let runtime = RuntimeState::default();
        let error = runtime
            .start_process(
                &dir.join("missing-frpc"),
                &dir.join("frpc.toml"),
                &dir.join("frpc.log"),
            )
            .expect_err("missing official binary must be rejected");
        assert!(error.contains("frpc"));
        fs::remove_dir_all(&dir).expect("test directory should be removed");
    }

    #[test]
    fn prefers_the_packaged_frpc_over_an_adjacent_fallback() {
        let dir = sidecar_test_dir();
        let resources = dir.join("resources");
        let executable_dir = dir.join("app");
        fs::create_dir_all(&resources).expect("resource directory should be created");
        fs::create_dir_all(&executable_dir).expect("app directory should be created");
        let packaged = resources.join(format!("frpc{}", std::env::consts::EXE_SUFFIX));
        let adjacent = executable_dir.join(format!("frpc{}", std::env::consts::EXE_SUFFIX));
        fs::write(&packaged, b"packaged").expect("packaged sidecar should be written");
        fs::write(&adjacent, b"adjacent").expect("adjacent sidecar should be written");

        let resolved = resolve_frpc_binary(None, &resources, &executable_dir);

        assert_eq!(resolved, packaged);
        fs::remove_dir_all(&dir).expect("test directory should be removed");
    }

    #[test]
    #[cfg(windows)]
    fn bundled_frpc_is_the_pinned_official_version() {
        let binary = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("frpc.exe");
        assert!(
            binary.is_file(),
            "the complete Windows package must include {}",
            binary.display()
        );
        let output = Command::new(&binary)
            .arg("--version")
            .output()
            .expect("bundled frpc should start");
        assert!(output.status.success(), "frpc --version should succeed");
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "0.71.0");
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn bundled_macos_frpc_is_the_pinned_official_version() {
        let binary = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("frpc");
        assert!(
            binary.is_file(),
            "the complete macOS package must include {}",
            binary.display()
        );
        let output = Command::new(&binary)
            .arg("--version")
            .output()
            .expect("bundled frpc should start");
        assert!(output.status.success(), "frpc --version should succeed");
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "0.71.0");
    }
}
