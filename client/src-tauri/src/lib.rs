use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
};
use tauri::{AppHandle, Manager, RunEvent, State};

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
    token: String,
    protocol: String,
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
    proxies: &'a [Proxy],
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
    tls: TLS,
}

#[derive(Serialize)]
struct TLS {
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
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
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

struct RuntimePaths {
    binary: PathBuf,
    config: PathBuf,
    log: PathBuf,
}

fn default_device_id() -> String {
    "device-01".into()
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
    if profile.token.len() < 16 {
        return Err("Token 至少需要 16 个字符".into());
    }
    if !matches!(profile.protocol.as_str(), "tcp" | "kcp" | "quic") {
        return Err("不支持的传输协议".into());
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
            tls: TLS { enable: true },
        },
        proxies: &profile.proxies,
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
        .invoke_handler(tauri::generate_handler![
            render_config,
            save_profile,
            load_profile,
            start_client,
            stop_client,
            client_status,
            client_logs
        ])
        .build(tauri::generate_context!())
        .expect("error while building MapLink Client");
    app.run(|app_handle, event| {
        if matches!(event, RunEvent::Exit) {
            let runtime = app_handle.state::<RuntimeState>();
            let _ = runtime.stop_process();
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
            token: "0123456789abcdef".into(),
            protocol: "tcp".into(),
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
        ] {
            assert!(config.contains(expected), "missing {expected}:\n{config}");
        }
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
