use arboard::Clipboard;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
#[cfg(target_os = "macos")]
use core_graphics::access::ScreenCaptureAccess;
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
        mpsc::{self, Receiver, TrySendError},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::State;
use xcap::Monitor;

const HOST_RETRY_DELAY: Duration = Duration::from_secs(5);
const IDLE_POLL_DELAY: Duration = Duration::from_millis(700);
const CLIPBOARD_POLL_DELAY: Duration = Duration::from_millis(500);
const REMOTE_CLIPBOARD_LIMIT: usize = 64 << 10;
const FRAME_UPLOAD_WORKERS: usize = 4;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteProfile {
    #[serde(rename = "deviceID")]
    device_id: String,
    server_addr: String,
    manager_port: u16,
    token: String,
    #[serde(default)]
    device_credential: String,
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
    #[serde(rename = "deviceID")]
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
    #[serde(rename = "targetDeviceID")]
    target_device_id: String,
    #[serde(rename = "controllerDeviceID")]
    controller_device_id: String,
    #[serde(default)]
    controller_ssh_public_key: String,
    #[serde(default)]
    ssh_authorized: bool,
    state: String,
    #[serde(default)]
    error: String,
    screen_x: i32,
    screen_y: i32,
    screen_width: i32,
    screen_height: i32,
    frame_sequence: u64,
    #[serde(default = "default_remote_quality")]
    quality: String,
    #[serde(default)]
    clipboard_enabled: bool,
    #[serde(default)]
    clipboard_sequence: u64,
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
    #[serde(default)]
    text: String,
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteFrameExchange {
    sequence: u64,
    state: String,
    events: Vec<SequencedRemoteInput>,
    quality: String,
    clipboard_enabled: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteClipboard {
    sequence: u64,
    text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteFrame {
    sequence: u64,
    width: i32,
    height: i32,
    data_url: String,
    byte_length: usize,
}

#[derive(Clone, Copy)]
struct CapturePreset {
    max_width: u32,
    max_height: u32,
    jpeg_quality: u8,
    frame_interval: Duration,
}

struct FrameUpload {
    sequence: u64,
    width: u32,
    height: u32,
    jpeg: Vec<u8>,
}

enum FrameUploadFeedback {
    Exchange(RemoteFrameExchange),
    Closed,
    Error(String),
}

fn default_remote_quality() -> String {
    "720p30".into()
}

fn capture_preset(quality: &str) -> Result<CapturePreset, String> {
    match quality {
        "720p30" => Ok(CapturePreset {
            max_width: 1280,
            max_height: 720,
            jpeg_quality: 72,
            frame_interval: Duration::from_micros(33_333),
        }),
        "1080p60" => Ok(CapturePreset {
            max_width: 1920,
            max_height: 1080,
            jpeg_quality: 82,
            frame_interval: Duration::from_micros(16_667),
        }),
        "4k60" => Ok(CapturePreset {
            max_width: 3840,
            max_height: 2160,
            jpeg_quality: 88,
            frame_interval: Duration::from_micros(16_667),
        }),
        _ => Err("远程画质选项无效".into()),
    }
}

#[derive(Clone)]
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
        let credential = if self.profile.device_credential.is_empty() {
            &self.profile.token
        } else {
            &self.profile.device_credential
        };
        let signature =
            remote_signature(credential, method.as_str(), path, &timestamp, &nonce, &body)?;
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
        if !self.profile.device_credential.is_empty() {
            request = request.header("X-MapLink-Device-ID", &self.profile.device_id);
        }
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
    request_permissions: bool,
) -> Result<RemoteHostStatus, String> {
    validate_remote_profile(&profile)?;
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    if !enabled {
        state.stop();
        return remote_host_status(state);
    }
    if request_permissions {
        request_remote_control_permissions();
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
        let permission_error = capture_environment().err();
        let permission = if permission_error.is_none() {
            "ready"
        } else {
            "permission-required"
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
        if let Some(permission_error) = permission_error {
            set_host_status(
                &status,
                RemoteHostStatus {
                    enabled: true,
                    state: "permission-required".into(),
                    message: if cfg!(target_os = "macos") {
                        format!(
                            "{permission_error}。请在系统设置中确认当前 MapLink 已获授权；授权后完全退出并重新打开 MapLink"
                        )
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
    clipboard: Option<Clipboard>,
    last_clipboard_text: Option<String>,
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

fn input_settings(prompt_for_permissions: bool) -> Settings {
    Settings {
        open_prompt_to_get_permissions: prompt_for_permissions,
        ..Settings::default()
    }
}

#[cfg(target_os = "macos")]
fn request_remote_control_permissions() {
    let screen_capture = ScreenCaptureAccess;
    if !screen_capture.preflight() {
        let _ = screen_capture.request();
    }
    let _ = Enigo::new(&input_settings(true));
}

#[cfg(not(target_os = "macos"))]
fn request_remote_control_permissions() {}

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
    #[cfg(target_os = "macos")]
    if !ScreenCaptureAccess.preflight() {
        return Err("屏幕录制权限尚未生效".into());
    }
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
    let enigo = Enigo::new(&input_settings(false))
        .map_err(|error| format!("辅助功能权限尚未生效：{error}"))?;
    let mut clipboard = Clipboard::new().ok();
    let last_clipboard_text = clipboard.as_mut().and_then(|value| value.get_text().ok());
    Ok(CaptureEnvironment {
        monitor,
        enigo,
        clipboard,
        last_clipboard_text,
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
    let ssh_authorized = !session.controller_ssh_public_key.is_empty()
        && crate::ssh_setup::authorize_public_key(&session.controller_ssh_public_key).is_ok();
    let mut environment = capture_environment()?;
    let accept_path = format!("/api/remote/sessions/{}/accept", session.id);
    let accept = serde_json::json!({
        "screenX": environment.screen_x,
        "screenY": environment.screen_y,
        "screenWidth": environment.screen_width,
        "screenHeight": environment.screen_height,
        "sshAuthorized": ssh_authorized,
        "error": "",
    });
    let _: RemoteSession = relay.json_request(Method::POST, &accept_path, &accept)?;
    let (feedback_sender, feedback_receiver) = mpsc::channel();
    let mut upload_senders = Vec::with_capacity(FRAME_UPLOAD_WORKERS);
    for worker_index in 0..FRAME_UPLOAD_WORKERS {
        let (upload_sender, upload_receiver) = mpsc::sync_channel(0);
        let worker_relay = relay.clone();
        let worker_session_id = session.id.clone();
        let worker_feedback = feedback_sender.clone();
        thread::Builder::new()
            .name(format!("maplink-frame-upload-{worker_index}"))
            .spawn(move || {
                frame_uploader_loop(
                    worker_relay,
                    worker_session_id,
                    worker_index == 0,
                    upload_receiver,
                    worker_feedback,
                );
            })
            .map_err(|error| format!("启动远程画面上传线程失败：{error}"))?;
        upload_senders.push(upload_sender);
    }
    drop(feedback_sender);
    let mut frame_sequence = 0_u64;
    let mut applied_input_sequence = 0_u64;
    let mut next_uploader = 0_usize;
    let mut heartbeat_at = SystemTime::now();
    let mut clipboard_check_at = Instant::now();
    let mut quality = if capture_preset(&session.quality).is_ok() {
        session.quality.clone()
    } else {
        default_remote_quality()
    };
    let mut clipboard_enabled = session.clipboard_enabled;
    while generation_state.load(Ordering::SeqCst) == generation {
        let frame_started = Instant::now();
        for feedback in feedback_receiver.try_iter() {
            match feedback {
                FrameUploadFeedback::Exchange(exchange) => {
                    if exchange.state != "active" {
                        return Ok(());
                    }
                    apply_remote_events(
                        &mut environment,
                        exchange.events,
                        exchange.sequence,
                        &mut applied_input_sequence,
                    )?;
                    if capture_preset(&exchange.quality).is_ok() {
                        quality = exchange.quality;
                        clipboard_enabled = exchange.clipboard_enabled;
                    }
                }
                FrameUploadFeedback::Closed => return Ok(()),
                FrameUploadFeedback::Error(error) => return Err(error),
            }
        }
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
        if clipboard_enabled && clipboard_check_at.elapsed() >= CLIPBOARD_POLL_DELAY {
            publish_target_clipboard(relay, session, &mut environment)?;
            clipboard_check_at = Instant::now();
        }

        let preset = capture_preset(&quality)?;
        let (jpeg, width, height) = capture_jpeg(&environment.monitor, preset)?;
        frame_sequence += 1;
        let mut pending = Some(FrameUpload {
            sequence: frame_sequence,
            width,
            height,
            jpeg,
        });
        for offset in 0..upload_senders.len() {
            let worker_index = (next_uploader + offset) % upload_senders.len();
            let frame = pending.take().expect("frame upload remains available");
            match upload_senders[worker_index].try_send(frame) {
                Ok(()) => {
                    next_uploader = (worker_index + 1) % upload_senders.len();
                    break;
                }
                Err(TrySendError::Full(frame) | TrySendError::Disconnected(frame)) => {
                    pending = Some(frame);
                }
            }
        }
        if let Some(remaining) = preset.frame_interval.checked_sub(frame_started.elapsed()) {
            if generation_state.load(Ordering::SeqCst) == generation {
                thread::sleep(remaining);
            }
        }
    }
    Ok(())
}

fn frame_uploader_loop(
    relay: RelayClient,
    session_id: String,
    receives_input: bool,
    uploads: Receiver<FrameUpload>,
    feedback: mpsc::Sender<FrameUploadFeedback>,
) {
    let mut input_sequence = 0_u64;
    for frame in uploads {
        let frame_path = if receives_input {
            format!("/api/remote/sessions/{session_id}/frames?inputAfter={input_sequence}")
        } else {
            format!("/api/remote/sessions/{session_id}/frames")
        };
        let response = relay.request(
            Method::POST,
            &frame_path,
            frame.jpeg,
            vec![
                ("Content-Type".into(), "image/jpeg".into()),
                ("X-MapLink-Sequence".into(), frame.sequence.to_string()),
                ("X-MapLink-Width".into(), frame.width.to_string()),
                ("X-MapLink-Height".into(), frame.height.to_string()),
            ],
        );
        let response = match response {
            Ok(response) => response,
            Err(error) => {
                let _ = feedback.send(FrameUploadFeedback::Error(error));
                return;
            }
        };
        let status = response.status();
        if status == StatusCode::CONFLICT || status == StatusCode::NOT_FOUND {
            let _ = feedback.send(FrameUploadFeedback::Closed);
            return;
        }
        if !status.is_success() {
            let _ = feedback.send(FrameUploadFeedback::Error(format!(
                "上传远程画面失败：HTTP {status}"
            )));
            return;
        }
        if !receives_input {
            continue;
        }
        let exchange = if status == StatusCode::NO_CONTENT {
            let input_path =
                format!("/api/remote/sessions/{session_id}/inputs?after={input_sequence}&wait=0");
            match relay.empty_json::<RemoteInputsResponse>(Method::GET, &input_path) {
                Ok(input) => RemoteFrameExchange {
                    sequence: input.sequence,
                    state: input.state,
                    events: input.events,
                    quality: String::new(),
                    clipboard_enabled: false,
                },
                Err(error) => {
                    let _ = feedback.send(FrameUploadFeedback::Error(error));
                    return;
                }
            }
        } else {
            match decode_response::<RemoteFrameExchange>(response) {
                Ok(exchange) => exchange,
                Err(error) => {
                    let _ = feedback.send(FrameUploadFeedback::Error(error));
                    return;
                }
            }
        };
        input_sequence = input_sequence.max(exchange.sequence);
        if feedback
            .send(FrameUploadFeedback::Exchange(exchange))
            .is_err()
        {
            return;
        }
    }
}

fn apply_remote_events(
    environment: &mut CaptureEnvironment,
    events: Vec<SequencedRemoteInput>,
    sequence: u64,
    input_sequence: &mut u64,
) -> Result<(), String> {
    for item in events {
        apply_remote_input(environment, &item.event)?;
        *input_sequence = (*input_sequence).max(item.sequence);
    }
    *input_sequence = (*input_sequence).max(sequence);
    Ok(())
}

fn publish_target_clipboard(
    relay: &RelayClient,
    session: &RemoteSession,
    environment: &mut CaptureEnvironment,
) -> Result<(), String> {
    let Some(clipboard) = environment.clipboard.as_mut() else {
        return Ok(());
    };
    let Ok(text) = clipboard.get_text() else {
        return Ok(());
    };
    if environment.last_clipboard_text.as_deref() == Some(text.as_str()) {
        return Ok(());
    }
    environment.last_clipboard_text = Some(text.clone());
    if text.len() > REMOTE_CLIPBOARD_LIMIT {
        return Ok(());
    }
    let _: serde_json::Value = relay.json_request(
        Method::POST,
        &format!("/api/remote/sessions/{}/clipboard", session.id),
        &serde_json::json!({ "text": text }),
    )?;
    Ok(())
}

fn capture_jpeg(monitor: &Monitor, preset: CapturePreset) -> Result<(Vec<u8>, u32, u32), String> {
    let image = monitor
        .capture_image()
        .map_err(|error| format!("采集屏幕失败：{error}"))?;
    let source = DynamicImage::ImageRgba8(image);
    let resized = if source.width() > preset.max_width || source.height() > preset.max_height {
        source.resize(
            preset.max_width,
            preset.max_height,
            image::imageops::FilterType::Triangle,
        )
    } else {
        source
    };
    let width = resized.width();
    let height = resized.height();
    let mut jpeg = Vec::with_capacity((width * height / 3) as usize);
    JpegEncoder::new_with_quality(&mut jpeg, preset.jpeg_quality)
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
        "clipboard" => {
            if input.text.len() > REMOTE_CLIPBOARD_LIMIT {
                return Err("远程剪贴板文本过大".into());
            }
            let clipboard = environment
                .clipboard
                .as_mut()
                .ok_or_else(|| "本机剪贴板不可用".to_string())?;
            clipboard
                .set_text(input.text.clone())
                .map_err(|error| format!("写入本机剪贴板失败：{error}"))?;
            environment.last_clipboard_text = Some(input.text.clone());
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
    quality: String,
    clipboard_enabled: bool,
) -> Result<RemoteSession, String> {
    capture_preset(&quality)?;
    tauri::async_runtime::spawn_blocking(move || {
        let relay = RelayClient::new(profile.clone())?;
        let controller_ssh_public_key = crate::ssh_setup::ensure_identity()
            .map(|identity| identity.public_key)
            .unwrap_or_default();
        let request = serde_json::json!({
            "targetDeviceID": target_device_id,
            "controllerDeviceID": profile.device_id,
            "controllerSSHPublicKey": controller_ssh_public_key,
            "quality": quality,
            "clipboardEnabled": clipboard_enabled,
        });
        relay.json_request(Method::POST, "/api/remote/sessions", &request)
    })
    .await
    .map_err(|error| format!("远程会话任务异常：{error}"))?
}

#[tauri::command]
pub(crate) async fn update_remote_control_settings(
    profile: RemoteProfile,
    session_id: String,
    quality: String,
    clipboard_enabled: bool,
) -> Result<RemoteSession, String> {
    capture_preset(&quality)?;
    tauri::async_runtime::spawn_blocking(move || {
        let relay = RelayClient::new(profile)?;
        relay.json_request(
            Method::PATCH,
            &format!("/api/remote/sessions/{session_id}/settings"),
            &serde_json::json!({
                "quality": quality,
                "clipboardEnabled": clipboard_enabled,
            }),
        )
    })
    .await
    .map_err(|error| format!("更新远程会话设置任务异常：{error}"))?
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
        let byte_length = bytes.len();
        Ok(Some(RemoteFrame {
            sequence,
            width,
            height,
            data_url: format!("data:image/jpeg;base64,{}", BASE64.encode(bytes)),
            byte_length,
        }))
    })
    .await
    .map_err(|error| format!("远程画面任务异常：{error}"))?
}

#[tauri::command]
pub(crate) async fn remote_control_clipboard(
    profile: RemoteProfile,
    session_id: String,
    after: u64,
) -> Result<Option<RemoteClipboard>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let relay = RelayClient::new(profile)?;
        let path = format!("/api/remote/sessions/{session_id}/clipboard?after={after}");
        let response = relay.request(Method::GET, &path, Vec::new(), Vec::new())?;
        if response.status() == StatusCode::NO_CONTENT {
            return Ok(None);
        }
        decode_response(response).map(Some)
    })
    .await
    .map_err(|error| format!("远程剪贴板任务异常：{error}"))?
}

#[tauri::command]
pub(crate) fn read_local_clipboard() -> Option<String> {
    Clipboard::new().ok()?.get_text().ok()
}

#[tauri::command]
pub(crate) fn write_local_clipboard(text: String) -> Result<(), String> {
    if text.len() > REMOTE_CLIPBOARD_LIMIT {
        return Err("远程剪贴板文本过大".into());
    }
    Clipboard::new()
        .map_err(|error| format!("打开本机剪贴板失败：{error}"))?
        .set_text(text)
        .map_err(|error| format!("写入本机剪贴板失败：{error}"))
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
    if events
        .iter()
        .any(|event| event.input_type == "clipboard" && event.text.len() > REMOTE_CLIPBOARD_LIMIT)
    {
        return Err("远程剪贴板文本过大".into());
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

    #[test]
    fn remote_session_accepts_the_server_id_fields() {
        let session: RemoteSession = serde_json::from_str(
            r#"{"id":"session-a","targetDeviceID":"desktop-a","controllerDeviceID":"desktop-b","state":"active","screenX":0,"screenY":0,"screenWidth":1920,"screenHeight":1080,"frameSequence":1}"#,
        )
        .unwrap();
        assert_eq!(session.target_device_id, "desktop-a");
        assert_eq!(session.controller_device_id, "desktop-b");
        assert_eq!(session.quality, "720p30");
        assert!(!session.clipboard_enabled);
    }

    #[test]
    fn quality_presets_have_the_requested_resolution_and_frame_targets() {
        let low = capture_preset("720p30").unwrap();
        assert_eq!((low.max_width, low.max_height), (1280, 720));
        assert!(low.frame_interval >= Duration::from_millis(33));

        let full_hd = capture_preset("1080p60").unwrap();
        assert_eq!((full_hd.max_width, full_hd.max_height), (1920, 1080));
        assert!(full_hd.frame_interval <= Duration::from_millis(17));

        let ultra_hd = capture_preset("4k60").unwrap();
        assert_eq!((ultra_hd.max_width, ultra_hd.max_height), (3840, 2160));
        assert!(ultra_hd.frame_interval <= Duration::from_millis(17));
        assert!(capture_preset("unlimited").is_err());
    }

    #[test]
    fn combined_frame_exchange_accepts_input_and_settings() {
        let exchange: RemoteFrameExchange = serde_json::from_str(
            r#"{"sequence":2,"state":"active","events":[{"sequence":2,"event":{"type":"clipboard","text":"hello"}}],"quality":"4k60","clipboardEnabled":true}"#,
        )
        .unwrap();
        assert_eq!(exchange.sequence, 2);
        assert_eq!(exchange.quality, "4k60");
        assert!(exchange.clipboard_enabled);
        assert_eq!(exchange.events[0].event.text, "hello");
    }

    #[test]
    fn background_permission_checks_never_open_the_system_prompt() {
        assert!(!input_settings(false).open_prompt_to_get_permissions);
        assert!(input_settings(true).open_prompt_to_get_permissions);
    }
}
