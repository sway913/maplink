use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use enigo::{Axis, Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use hmac::{Hmac, Mac};
use image::{codecs::jpeg::JpegEncoder, DynamicImage};
use reqwest::{blocking::Client, Method, StatusCode};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::State;
use xcap::Monitor;

const HOST_RETRY_DELAY: Duration = Duration::from_secs(5);
const IDLE_POLL_DELAY: Duration = Duration::from_millis(700);
const FRAME_DELAY: Duration = Duration::from_millis(120);

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteProfile {
    #[serde(rename = "deviceID")]
    device_id: String,
    server_addr: String,
    manager_port: u16,
    token: String,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteHostStatus {
    enabled: bool,
    state: String,
    message: String,
}

pub(crate) struct RemoteHostState {
    generation: Arc<AtomicU64>,
    status: Arc<Mutex<RemoteHostStatus>>,
}

impl Default for RemoteHostState {
    fn default() -> Self {
        Self {
            generation: Arc::new(AtomicU64::new(0)),
            status: Arc::new(Mutex::new(RemoteHostStatus {
                enabled: false,
                state: "disabled".into(),
                message: "远程控制主机未开启".into(),
            })),
        }
    }
}

impl RemoteHostState {
    pub(crate) fn stop(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        set_host_status(
            &self.status,
            RemoteHostStatus {
                enabled: false,
                state: "disabled".into(),
                message: "远程控制主机未开启".into(),
            },
        );
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteDevice {
    device_id: String,
    name: String,
    platform: String,
    permission: String,
}

#[derive(Deserialize)]
struct RemoteDevicesResponse {
    devices: Vec<RemoteDevice>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteSession {
    id: String,
    target_device_id: String,
    controller_device_id: String,
    state: String,
    #[serde(default)]
    error: String,
    screen_x: i32,
    screen_y: i32,
    screen_width: i32,
    screen_height: i32,
    frame_sequence: u64,
}

#[derive(Deserialize)]
struct RemoteSessionsResponse {
    sessions: Vec<RemoteSession>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteInput {
    #[serde(rename = "type")]
    input_type: String,
    #[serde(default)]
    x: f64,
    #[serde(default)]
    y: f64,
    #[serde(default)]
    button: i32,
    #[serde(default)]
    delta_x: i32,
    #[serde(default)]
    delta_y: i32,
    #[serde(default)]
    key: String,
    #[serde(default)]
    code: String,
    #[serde(default)]
    down: bool,
}

#[derive(Deserialize)]
struct SequencedRemoteInput {
    sequence: u64,
    event: RemoteInput,
}

#[derive(Deserialize)]
struct RemoteInputsResponse {
    sequence: u64,
    state: String,
    events: Vec<SequencedRemoteInput>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteFrame {
    sequence: u64,
    width: i32,
    height: i32,
    data_url: String,
}

struct RelayClient {
    profile: RemoteProfile,
    client: Client,
}

impl RelayClient {
    fn new(profile: RemoteProfile) -> Result<Self, String> {
        validate_remote_profile(&profile)?;
        let client = Client::builder()
            .danger_accept_invalid_certs(true)
            .connect_timeout(Duration::from_secs(8))
            .timeout(Duration::from_secs(24))
            .build()
            .map_err(|error| format!("初始化远程控制连接失败：{error}"))?;
        Ok(Self { profile, client })
    }

    fn request(
        &self,
        method: Method,
        path: &str,
        body: Vec<u8>,
        headers: Vec<(String, String)>,
    ) -> Result<reqwest::blocking::Response, String> {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "系统时间无效".to_string())?
            .as_secs()
            .to_string();
        let nonce = request_nonce();
        let signature = remote_signature(
            &self.profile.token,
            method.as_str(),
            path,
            &timestamp,
            &nonce,
            &body,
        )?;
        let url = format!(
            "https://{}:{}{}",
            manager_host(&self.profile.server_addr),
            self.profile.manager_port,
            path
        );
        let mut request = self
            .client
            .request(method, url)
            .header(reqwest::header::ACCEPT, "application/json")
            .header(reqwest::header::ACCEPT_ENCODING, "identity")
            .header("X-MapLink-Timestamp", timestamp)
            .header("X-MapLink-Nonce", nonce)
            .header("X-MapLink-Signature", signature)
            .header(reqwest::header::CACHE_CONTROL, "no-store")
            .body(body);
        for (name, value) in headers {
            request = request.header(name, value);
        }
        request
            .send()
            .map_err(|error| format!("无法连接 MapLink 远程中转服务：{error}"))
    }

    fn json_request<T: Serialize, R: for<'de> Deserialize<'de>>(
        &self,
        method: Method,
        path: &str,
        value: &T,
    ) -> Result<R, String> {
        let body = serde_json::to_vec(value).map_err(|error| error.to_string())?;
        let response = self.request(
            method,
            path,
            body,
            vec![("Content-Type".into(), "application/json".into())],
        )?;
        decode_response(response)
    }

    fn empty_json<R: for<'de> Deserialize<'de>>(
        &self,
        method: Method,
        path: &str,
    ) -> Result<R, String> {
        let response = self.request(method, path, Vec::new(), Vec::new())?;
        decode_response(response)
    }
}

fn decode_response<R: for<'de> Deserialize<'de>>(
    response: reqwest::blocking::Response,
) -> Result<R, String> {
    let status = response.status();
    if !status.is_success() {
        let text = response.text().unwrap_or_default();
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(message) = value.get("error").and_then(|item| item.as_str()) {
                return Err(message.to_string());
            }
        }
        return Err(format!("远程中转服务返回 HTTP {status}"));
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("未知")
        .to_string();
    let body = response
        .bytes()
        .map_err(|error| format!("读取远程中转响应失败：{error}"))?;
    serde_json::from_slice::<R>(&body).map_err(|error| {
        format!(
            "远程中转响应不是有效 JSON（Content-Type: {content_type}，长度: {}）：{error}",
            body.len()
        )
    })
}

fn manager_host(host: &str) -> String {
    let host = host.trim();
    if host.contains(':') && !(host.starts_with('[') && host.ends_with(']')) {
        format!("[{host}]")
    } else {
        host.to_string()
    }
}

fn validate_remote_profile(profile: &RemoteProfile) -> Result<(), String> {
    if profile.device_id.is_empty() || profile.device_id.len() > 64 {
        return Err("设备 ID 无效".into());
    }
    if profile.server_addr.trim().is_empty() || profile.server_addr.len() > 253 {
        return Err("服务器地址无效".into());
    }
    if profile.manager_port == 0 || profile.token.len() < 16 {
        return Err("管理端口或 Token 无效".into());
    }
    Ok(())
}

fn request_nonce() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or_default();
    format!(
        "{nanos:032x}{:016x}",
        COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

fn remote_signature(
    token: &str,
    method: &str,
    path: &str,
    timestamp: &str,
    nonce: &str,
    body: &[u8],
) -> Result<String, String> {
    let body_hash = Sha256::digest(body);
    let payload = format!(
        "{method}\n{path}\n{timestamp}\n{nonce}\n{}",
        body_hash
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    );
    let mut mac = Hmac::<Sha256>::new_from_slice(token.as_bytes())
        .map_err(|_| "Token 无法用于远程控制签名".to_string())?;
    mac.update(payload.as_bytes());
    Ok(mac
        .finalize()
        .into_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn local_platform() -> &'static str {
    #[cfg(windows)]
    return "windows";
    #[cfg(target_os = "macos")]
    return "macos";
    #[allow(unreachable_code)]
    "unsupported"
}

fn local_device_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "MapLink Device".into())
}

fn set_host_status(status: &Arc<Mutex<RemoteHostStatus>>, value: RemoteHostStatus) {
    if let Ok(mut current) = status.lock() {
        *current = value;
    }
}

#[tauri::command]
pub(crate) fn start_remote_host(
    state: State<'_, RemoteHostState>,
    profile: RemoteProfile,
    enabled: bool,
) -> Result<RemoteHostStatus, String> {
    validate_remote_profile(&profile)?;
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    if !enabled {
        state.stop();
        return remote_host_status(state);
    }
    let status_value = RemoteHostStatus {
        enabled: true,
        state: "starting".into(),
        message: "正在检查屏幕与辅助控制权限…".into(),
    };
    set_host_status(&state.status, status_value.clone());
    let generation_state = state.generation.clone();
    let status = state.status.clone();
    thread::Builder::new()
        .name("maplink-remote-host".into())
        .spawn(move || remote_host_loop(profile, generation, generation_state, status))
        .map_err(|error| format!("启动远程控制主机失败：{error}"))?;
    Ok(status_value)
}

#[tauri::command]
pub(crate) fn remote_host_status(
    state: State<'_, RemoteHostState>,
) -> Result<RemoteHostStatus, String> {
    state
        .status
        .lock()
        .map(|value| value.clone())
        .map_err(|_| "远程控制主机状态已损坏".into())
}

fn remote_host_loop(
    profile: RemoteProfile,
    generation: u64,
    generation_state: Arc<AtomicU64>,
    status: Arc<Mutex<RemoteHostStatus>>,
) {
    let relay = match RelayClient::new(profile.clone()) {
        Ok(value) => value,
        Err(error) => {
            set_host_status(
                &status,
                RemoteHostStatus {
                    enabled: true,
                    state: "error".into(),
                    message: error,
                },
            );
            return;
        }
    };
    while generation_state.load(Ordering::SeqCst) == generation {
        let permission = match capture_environment() {
            Ok(_) => "ready",
            Err(_) => "permission-required",
        };
        let heartbeat = serde_json::json!({
            "deviceID": profile.device_id,
            "name": local_device_name(),
            "platform": local_platform(),
            "permission": permission,
        });
        let heartbeat_result: Result<serde_json::Value, String> =
            relay.json_request(Method::POST, "/api/remote/hosts/heartbeat", &heartbeat);
        if let Err(error) = heartbeat_result {
            set_host_status(
                &status,
                RemoteHostStatus {
                    enabled: true,
                    state: "error".into(),
                    message: error,
                },
            );
            interruptible_sleep(&generation_state, generation, HOST_RETRY_DELAY);
            continue;
        }
        if permission != "ready" {
            set_host_status(
                &status,
                RemoteHostStatus {
                    enabled: true,
                    state: "permission-required".into(),
                    message: if cfg!(target_os = "macos") {
                        "请在系统设置中允许 MapLink 的屏幕录制与辅助功能权限".into()
                    } else {
                        "无法访问桌面，请确认以管理员身份运行".into()
                    },
                },
            );
            interruptible_sleep(&generation_state, generation, HOST_RETRY_DELAY);
            continue;
        }
        set_host_status(
            &status,
            RemoteHostStatus {
                enabled: true,
                state: "ready".into(),
                message: "本机可被同一 MapLink 服务器下的设备发现".into(),
            },
        );
        let path = format!("/api/remote/hosts/{}/sessions", profile.device_id);
        let sessions = relay.empty_json::<RemoteSessionsResponse>(Method::GET, &path);
        if let Ok(response) = sessions {
            if let Some(session) = response
                .sessions
                .into_iter()
                .find(|session| session.state == "pending" || session.state == "active")
            {
                set_host_status(
                    &status,
                    RemoteHostStatus {
                        enabled: true,
                        state: "controlled".into(),
                        message: "远程控制会话进行中".into(),
                    },
                );
                if let Err(error) =
                    serve_remote_session(&relay, &session, generation, &generation_state)
                {
                    set_host_status(
                        &status,
                        RemoteHostStatus {
                            enabled: true,
                            state: "error".into(),
                            message: error,
                        },
                    );
                }
                continue;
            }
        }
        interruptible_sleep(&generation_state, generation, IDLE_POLL_DELAY);
    }
}

fn interruptible_sleep(generation_state: &AtomicU64, generation: u64, duration: Duration) {
    let steps = (duration.as_millis() / 100).max(1);
    for _ in 0..steps {
        if generation_state.load(Ordering::SeqCst) != generation {
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }
}

struct CaptureEnvironment {
    monitor: Monitor,
    enigo: Enigo,
    pressed_buttons: HashSet<Button>,
    pressed_keys: HashSet<Key>,
    screen_x: i32,
    screen_y: i32,
    screen_width: i32,
    screen_height: i32,
}

fn track_pressed<T: Eq + std::hash::Hash>(pressed: &mut HashSet<T>, value: T, down: bool) {
    if down {
        pressed.insert(value);
    } else {
        pressed.remove(&value);
    }
}

impl Drop for CaptureEnvironment {
    fn drop(&mut self) {
        for button in self.pressed_buttons.drain() {
            let _ = self.enigo.button(button, Direction::Release);
        }
        for key in self.pressed_keys.drain() {
            let _ = self.enigo.key(key, Direction::Release);
        }
    }
}

fn capture_environment() -> Result<CaptureEnvironment, String> {
    let monitors = Monitor::all().map_err(|error| format!("读取显示器失败：{error}"))?;
    let monitor = monitors
        .into_iter()
        .find(|monitor| monitor.is_primary().unwrap_or(false))
        .ok_or_else(|| "未找到主显示器".to_string())?;
    let screen_x = monitor.x().map_err(|error| error.to_string())?;
    let screen_y = monitor.y().map_err(|error| error.to_string())?;
    let screen_width = monitor.width().map_err(|error| error.to_string())? as i32;
    let screen_height = monitor.height().map_err(|error| error.to_string())? as i32;
    monitor
        .capture_image()
        .map_err(|error| format!("屏幕录制权限不可用：{error}"))?;
    let enigo =
        Enigo::new(&Settings::default()).map_err(|error| format!("辅助控制权限不可用：{error}"))?;
    Ok(CaptureEnvironment {
        monitor,
        enigo,
        pressed_buttons: HashSet::new(),
        pressed_keys: HashSet::new(),
        screen_x,
        screen_y,
        screen_width,
        screen_height,
    })
}

fn serve_remote_session(
    relay: &RelayClient,
    session: &RemoteSession,
    generation: u64,
    generation_state: &AtomicU64,
) -> Result<(), String> {
    let mut environment = capture_environment()?;
    let accept_path = format!("/api/remote/sessions/{}/accept", session.id);
    let accept = serde_json::json!({
        "screenX": environment.screen_x,
        "screenY": environment.screen_y,
        "screenWidth": environment.screen_width,
        "screenHeight": environment.screen_height,
        "error": "",
    });
    let _: RemoteSession = relay.json_request(Method::POST, &accept_path, &accept)?;
    let mut frame_sequence = 0_u64;
    let mut input_sequence = 0_u64;
    let mut heartbeat_at = SystemTime::now();
    while generation_state.load(Ordering::SeqCst) == generation {
        if heartbeat_at.elapsed().unwrap_or_default() >= Duration::from_secs(10) {
            let heartbeat = serde_json::json!({
                "deviceID": relay.profile.device_id,
                "name": local_device_name(),
                "platform": local_platform(),
                "permission": "ready",
            });
            let _: serde_json::Value =
                relay.json_request(Method::POST, "/api/remote/hosts/heartbeat", &heartbeat)?;
            heartbeat_at = SystemTime::now();
        }
        let input_path = format!(
            "/api/remote/sessions/{}/inputs?after={input_sequence}&wait=0",
            session.id
        );
        let input_response: RemoteInputsResponse = relay.empty_json(Method::GET, &input_path)?;
        if input_response.state != "active" {
            break;
        }
        for item in input_response.events {
            apply_remote_input(&mut environment, &item.event)?;
            input_sequence = input_sequence.max(item.sequence);
        }
        input_sequence = input_sequence.max(input_response.sequence);

        let (jpeg, width, height) = capture_jpeg(&environment.monitor)?;
        frame_sequence += 1;
        let frame_path = format!("/api/remote/sessions/{}/frames", session.id);
        let response = relay.request(
            Method::POST,
            &frame_path,
            jpeg,
            vec![
                ("Content-Type".into(), "image/jpeg".into()),
                ("X-MapLink-Sequence".into(), frame_sequence.to_string()),
                ("X-MapLink-Width".into(), width.to_string()),
                ("X-MapLink-Height".into(), height.to_string()),
            ],
        )?;
        if !response.status().is_success() {
            if response.status() == StatusCode::CONFLICT
                || response.status() == StatusCode::NOT_FOUND
            {
                break;
            }
            return Err(format!("上传远程画面失败：HTTP {}", response.status()));
        }
        interruptible_sleep(generation_state, generation, FRAME_DELAY);
    }
    Ok(())
}

fn capture_jpeg(monitor: &Monitor) -> Result<(Vec<u8>, u32, u32), String> {
    let image = monitor
        .capture_image()
        .map_err(|error| format!("采集屏幕失败：{error}"))?;
    let resized =
        DynamicImage::ImageRgba8(image).resize(1440, 1000, image::imageops::FilterType::Triangle);
    let width = resized.width();
    let height = resized.height();
    let mut jpeg = Vec::with_capacity((width * height / 3) as usize);
    JpegEncoder::new_with_quality(&mut jpeg, 72)
        .encode_image(&resized)
        .map_err(|error| format!("压缩远程画面失败：{error}"))?;
    Ok((jpeg, width, height))
}

fn apply_remote_input(
    environment: &mut CaptureEnvironment,
    input: &RemoteInput,
) -> Result<(), String> {
    match input.input_type.as_str() {
        "move" => {
            let x = environment.screen_x
                + (input.x.clamp(0.0, 1.0) * f64::from(environment.screen_width - 1)).round()
                    as i32;
            let y = environment.screen_y
                + (input.y.clamp(0.0, 1.0) * f64::from(environment.screen_height - 1)).round()
                    as i32;
            environment
                .enigo
                .move_mouse(x, y, Coordinate::Abs)
                .map_err(|error| format!("移动远程鼠标失败：{error}"))?;
        }
        "button" => {
            let button = match input.button {
                0 => Button::Left,
                1 => Button::Middle,
                2 => Button::Right,
                3 => Button::Back,
                _ => Button::Forward,
            };
            environment
                .enigo
                .button(
                    button,
                    if input.down {
                        Direction::Press
                    } else {
                        Direction::Release
                    },
                )
                .map_err(|error| format!("发送远程鼠标按键失败：{error}"))?;
            track_pressed(&mut environment.pressed_buttons, button, input.down);
        }
        "wheel" => {
            if input.delta_y != 0 {
                let amount = (input.delta_y / 100).clamp(-12, 12);
                environment
                    .enigo
                    .scroll(
                        if amount == 0 {
                            input.delta_y.signum()
                        } else {
                            amount
                        },
                        Axis::Vertical,
                    )
                    .map_err(|error| format!("发送远程滚轮失败：{error}"))?;
            }
            if input.delta_x != 0 {
                let amount = (input.delta_x / 100).clamp(-12, 12);
                environment
                    .enigo
                    .scroll(
                        if amount == 0 {
                            input.delta_x.signum()
                        } else {
                            amount
                        },
                        Axis::Horizontal,
                    )
                    .map_err(|error| format!("发送远程滚轮失败：{error}"))?;
            }
        }
        "key" => {
            let key = remote_key(&input.key, &input.code)
                .ok_or_else(|| "不支持的远程按键".to_string())?;
            environment
                .enigo
                .key(
                    key,
                    if input.down {
                        Direction::Press
                    } else {
                        Direction::Release
                    },
                )
                .map_err(|error| format!("发送远程键盘输入失败：{error}"))?;
            track_pressed(&mut environment.pressed_keys, key, input.down);
        }
        _ => return Err("远程输入类型无效".into()),
    }
    Ok(())
}

fn remote_key(value: &str, code: &str) -> Option<Key> {
    Some(match value {
        "Alt" => Key::Alt,
        "Backspace" => Key::Backspace,
        "CapsLock" => Key::CapsLock,
        "Control" => Key::Control,
        "Delete" => Key::Delete,
        "ArrowDown" => Key::DownArrow,
        "End" => Key::End,
        "Enter" => Key::Return,
        "Escape" => Key::Escape,
        "Home" => Key::Home,
        #[cfg(not(target_os = "macos"))]
        "Insert" => Key::Insert,
        "ArrowLeft" => Key::LeftArrow,
        "Meta" => Key::Meta,
        "PageDown" => Key::PageDown,
        "PageUp" => Key::PageUp,
        "ArrowRight" => Key::RightArrow,
        "Shift" => Key::Shift,
        " " => Key::Space,
        "Tab" => Key::Tab,
        "ArrowUp" => Key::UpArrow,
        "F1" => Key::F1,
        "F2" => Key::F2,
        "F3" => Key::F3,
        "F4" => Key::F4,
        "F5" => Key::F5,
        "F6" => Key::F6,
        "F7" => Key::F7,
        "F8" => Key::F8,
        "F9" => Key::F9,
        "F10" => Key::F10,
        "F11" => Key::F11,
        "F12" => Key::F12,
        _ if value.chars().count() == 1 => Key::Unicode(value.chars().next()?),
        _ if code == "NumpadEnter" => Key::Return,
        _ => return None,
    })
}

#[tauri::command]
pub(crate) async fn remote_control_devices(
    profile: RemoteProfile,
) -> Result<Vec<RemoteDevice>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut last_error = "未知错误".to_string();
        for attempt in 0..3 {
            let relay = RelayClient::new(profile.clone())?;
            match relay.empty_json::<RemoteDevicesResponse>(Method::GET, "/api/remote/devices") {
                Ok(response) => return Ok(response.devices),
                Err(error) => last_error = error,
            }
            if attempt < 2 {
                thread::sleep(Duration::from_millis(350));
            }
        }
        Err(format!("读取远程设备列表失败（已重试 3 次）：{last_error}"))
    })
    .await
    .map_err(|error| format!("远程设备查询任务异常：{error}"))?
}

#[tauri::command]
pub(crate) async fn start_remote_control(
    profile: RemoteProfile,
    target_device_id: String,
) -> Result<RemoteSession, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let relay = RelayClient::new(profile.clone())?;
        let request = serde_json::json!({
            "targetDeviceID": target_device_id,
            "controllerDeviceID": profile.device_id,
        });
        relay.json_request(Method::POST, "/api/remote/sessions", &request)
    })
    .await
    .map_err(|error| format!("远程会话任务异常：{error}"))?
}

#[tauri::command]
pub(crate) async fn remote_control_session(
    profile: RemoteProfile,
    session_id: String,
) -> Result<RemoteSession, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let relay = RelayClient::new(profile)?;
        relay.empty_json(Method::GET, &format!("/api/remote/sessions/{session_id}"))
    })
    .await
    .map_err(|error| format!("远程会话状态任务异常：{error}"))?
}

#[tauri::command]
pub(crate) async fn remote_control_frame(
    profile: RemoteProfile,
    session_id: String,
    after: u64,
) -> Result<Option<RemoteFrame>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let relay = RelayClient::new(profile)?;
        let path = format!("/api/remote/sessions/{session_id}/frames?after={after}");
        let response = relay.request(Method::GET, &path, Vec::new(), Vec::new())?;
        if response.status() == StatusCode::NO_CONTENT {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(format!("读取远程画面失败：HTTP {}", response.status()));
        }
        let sequence = response
            .headers()
            .get("X-MapLink-Sequence")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse().ok())
            .ok_or_else(|| "远程画面序号无效".to_string())?;
        let width = response
            .headers()
            .get("X-MapLink-Width")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse().ok())
            .ok_or_else(|| "远程画面宽度无效".to_string())?;
        let height = response
            .headers()
            .get("X-MapLink-Height")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse().ok())
            .ok_or_else(|| "远程画面高度无效".to_string())?;
        let bytes = response
            .bytes()
            .map_err(|error| format!("读取远程画面失败：{error}"))?;
        Ok(Some(RemoteFrame {
            sequence,
            width,
            height,
            data_url: format!("data:image/jpeg;base64,{}", BASE64.encode(bytes)),
        }))
    })
    .await
    .map_err(|error| format!("远程画面任务异常：{error}"))?
}

#[tauri::command]
pub(crate) async fn send_remote_control_input(
    profile: RemoteProfile,
    session_id: String,
    events: Vec<RemoteInput>,
) -> Result<(), String> {
    if events.is_empty() || events.len() > 64 {
        return Err("远程输入批次数量无效".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let relay = RelayClient::new(profile)?;
        let request = serde_json::json!({ "events": events });
        let _: serde_json::Value = relay.json_request(
            Method::POST,
            &format!("/api/remote/sessions/{session_id}/inputs"),
            &request,
        )?;
        Ok(())
    })
    .await
    .map_err(|error| format!("远程输入任务异常：{error}"))?
}

#[tauri::command]
pub(crate) async fn stop_remote_control(
    profile: RemoteProfile,
    session_id: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let relay = RelayClient::new(profile)?;
        let response = relay.request(
            Method::DELETE,
            &format!("/api/remote/sessions/{session_id}"),
            Vec::new(),
            Vec::new(),
        )?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(format!("断开远程控制失败：HTTP {}", response.status()))
        }
    })
    .await
    .map_err(|error| format!("断开远程控制任务异常：{error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relay_signature_binds_method_path_nonce_and_body() {
        let first = remote_signature(
            "1234567890123456",
            "POST",
            "/api/remote/sessions",
            "1",
            "abcdefghijklmnop",
            b"{}",
        )
        .unwrap();
        let second = remote_signature(
            "1234567890123456",
            "POST",
            "/api/remote/sessions",
            "1",
            "abcdefghijklmnop",
            b"{\"x\":1}",
        )
        .unwrap();
        assert_ne!(first, second);
        assert_eq!(
            first,
            "537e596ef44b757fc3113680aa0a1a6e6760bd0dbffec3aa33e5de8bea123c2d"
        );
    }

    #[test]
    fn browser_keys_map_to_native_keys() {
        assert_eq!(remote_key("Enter", "Enter"), Some(Key::Return));
        assert_eq!(remote_key("a", "KeyA"), Some(Key::Unicode('a')));
        assert_eq!(remote_key("Unknown", "Unknown"), None);
    }

    #[test]
    fn only_inputs_pressed_by_remote_session_are_tracked_for_release() {
        let mut buttons = HashSet::new();
        assert!(buttons.is_empty());
        track_pressed(&mut buttons, Button::Right, true);
        assert!(buttons.contains(&Button::Right));
        track_pressed(&mut buttons, Button::Right, false);
        assert!(buttons.is_empty());
    }

    #[test]
    fn remote_device_list_accepts_the_server_response_shape() {
        let response: RemoteDevicesResponse = serde_json::from_str(
            r#"{"devices":[{"deviceID":"desktop-a","name":"Desktop A","platform":"windows","permission":"ready"}]}"#,
        )
        .unwrap();
        assert_eq!(response.devices.len(), 1);
        assert_eq!(response.devices[0].device_id, "desktop-a");
        assert_eq!(response.devices[0].permission, "ready");
    }
}
