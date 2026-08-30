use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::Serialize;
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SSHReadiness {
    platform: &'static str,
    client_installed: bool,
    server_installed: bool,
    server_running: bool,
    key_available: bool,
    identity_path: String,
    message: String,
}

#[derive(Clone, Debug)]
pub(crate) struct SSHIdentity {
    pub(crate) private_key: PathBuf,
    pub(crate) public_key: String,
}

fn home_directory() -> Result<PathBuf, String> {
    #[cfg(windows)]
    let value = env::var_os("USERPROFILE");
    #[cfg(not(windows))]
    let value = env::var_os("HOME");
    value
        .filter(|item| !item.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| "无法确定当前用户目录".to_string())
}

fn identity_paths() -> Result<(PathBuf, PathBuf), String> {
    let directory = home_directory()?.join(".ssh");
    Ok((
        directory.join("maplink_ed25519"),
        directory.join("maplink_ed25519.pub"),
    ))
}

fn ssh_program(name: &str) -> PathBuf {
    #[cfg(windows)]
    {
        if let Some(windows) = env::var_os("WINDIR") {
            let candidate = PathBuf::from(windows)
                .join("System32")
                .join("OpenSSH")
                .join(format!("{name}.exe"));
            if candidate.is_file() {
                return candidate;
            }
        }
        PathBuf::from(format!("{name}.exe"))
    }
    #[cfg(not(windows))]
    {
        let candidate = PathBuf::from("/usr/bin").join(name);
        if candidate.is_file() {
            return candidate;
        }
        PathBuf::from(name)
    }
}

fn command_succeeds(program: &Path, arguments: &[&str]) -> bool {
    let mut command = Command::new(program);
    command
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    super::hide_windows_console(&mut command);
    command.status().is_ok_and(|status| status.success())
}

fn executable_available(program: &Path) -> bool {
    program.is_file() || command_succeeds(program, &["-V"])
}

fn server_running() -> bool {
    #[cfg(windows)]
    {
        let mut command = Command::new("sc.exe");
        command
            .args(["query", "sshd"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        super::hide_windows_console(&mut command);
        return command.output().is_ok_and(|output| {
            output.status.success() && String::from_utf8_lossy(&output.stdout).contains("RUNNING")
        });
    }
    #[cfg(target_os = "macos")]
    {
        return Command::new("/bin/launchctl")
            .args(["print-disabled", "system"])
            .output()
            .is_ok_and(|output| {
                output.status.success()
                    && String::from_utf8_lossy(&output.stdout)
                        .contains("\"com.openssh.sshd\" => false")
            });
    }
    #[allow(unreachable_code)]
    false
}

fn normalize_public_key(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.len() > 2048
        || value
            .chars()
            .any(|character| matches!(character, '\r' | '\n' | '\0'))
    {
        return Err("SSH 公钥格式无效".into());
    }
    let mut parts = value.split_whitespace();
    let algorithm = parts.next().unwrap_or_default();
    let encoded = parts.next().unwrap_or_default();
    let decoded = BASE64.decode(encoded).unwrap_or_default();
    if algorithm != "ssh-ed25519"
        || decoded.len() != 51
        || decoded.get(..15) != Some(b"\0\0\0\x0bssh-ed25519".as_slice())
        || !encoded.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '+' | '/' | '=')
        })
    {
        return Err("只接受有效的 Ed25519 SSH 公钥".into());
    }
    Ok(format!("{algorithm} {encoded} maplink-managed"))
}

#[cfg(unix)]
fn set_unix_mode(path: &Path, mode: u32) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
        .map_err(|error| format!("设置 SSH 文件权限失败：{error}"))
}

#[cfg(not(unix))]
fn set_unix_mode(_path: &Path, _mode: u32) -> Result<(), String> {
    Ok(())
}

pub(crate) fn ensure_identity() -> Result<SSHIdentity, String> {
    let (private_key, public_key_path) = identity_paths()?;
    let directory = private_key.parent().ok_or("SSH 密钥目录无效")?;
    fs::create_dir_all(directory).map_err(|error| format!("创建 SSH 密钥目录失败：{error}"))?;
    set_unix_mode(directory, 0o700)?;

    if !private_key.is_file() {
        let mut command = Command::new(ssh_program("ssh-keygen"));
        command
            .args([
                "-q",
                "-t",
                "ed25519",
                "-N",
                "",
                "-C",
                "maplink-managed",
                "-f",
            ])
            .arg(&private_key)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        super::hide_windows_console(&mut command);
        let output = command
            .output()
            .map_err(|error| format!("启动 ssh-keygen 失败：{error}"))?;
        if !output.status.success() {
            return Err(format!(
                "生成 MapLink SSH 密钥失败：{}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
    }
    set_unix_mode(&private_key, 0o600)?;

    if !public_key_path.is_file() {
        let mut command = Command::new(ssh_program("ssh-keygen"));
        command
            .args(["-y", "-f"])
            .arg(&private_key)
            .stdin(Stdio::null());
        super::hide_windows_console(&mut command);
        let output = command
            .output()
            .map_err(|error| format!("读取 MapLink SSH 公钥失败：{error}"))?;
        if !output.status.success() {
            return Err("无法从 MapLink 私钥恢复公钥".into());
        }
        fs::write(&public_key_path, &output.stdout)
            .map_err(|error| format!("保存 MapLink SSH 公钥失败：{error}"))?;
    }
    let public_key = normalize_public_key(
        &fs::read_to_string(&public_key_path)
            .map_err(|error| format!("读取 MapLink SSH 公钥失败：{error}"))?,
    )?;
    set_unix_mode(&public_key_path, 0o644)?;
    Ok(SSHIdentity {
        private_key,
        public_key,
    })
}

pub(crate) fn identity_private_key() -> Option<PathBuf> {
    identity_paths()
        .ok()
        .map(|paths| paths.0)
        .filter(|path| path.is_file())
}

pub(crate) fn add_identity_arguments(arguments: &mut Vec<String>) {
    let Some(identity) = identity_private_key() else {
        return;
    };
    let insertion = arguments
        .iter()
        .position(|argument| argument == "--")
        .unwrap_or(arguments.len());
    arguments.splice(
        insertion..insertion,
        [
            "-o".into(),
            "IdentitiesOnly=yes".into(),
            "-i".into(),
            identity.to_string_lossy().into_owned(),
        ],
    );
}

fn append_authorized_key(path: &Path, public_key: &str) -> Result<bool, String> {
    let public_key = normalize_public_key(public_key)?;
    let key_blob = public_key.split_whitespace().nth(1).unwrap_or_default();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建 SSH 授权目录失败：{error}"))?;
        set_unix_mode(parent, 0o700)?;
    }
    let current = fs::read_to_string(path).unwrap_or_default();
    if current
        .lines()
        .any(|line| line.split_whitespace().nth(1) == Some(key_blob))
    {
        return Ok(false);
    }
    let mut next = current;
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    next.push_str(&public_key);
    next.push('\n');
    fs::write(path, next).map_err(|error| format!("写入 SSH 授权文件失败：{error}"))?;
    set_unix_mode(path, 0o600)?;
    Ok(true)
}

#[cfg(windows)]
fn current_user_is_administrator() -> bool {
    let mut command = Command::new("powershell.exe");
    command.args([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
    ]);
    super::hide_windows_console(&mut command);
    command.output().is_ok_and(|output| {
        output.status.success()
            && String::from_utf8_lossy(&output.stdout)
                .trim()
                .eq_ignore_ascii_case("true")
    })
}

#[cfg(windows)]
fn lock_windows_authorized_keys(path: &Path) {
    let mut command = Command::new("icacls.exe");
    command.arg(path).args([
        "/inheritance:r",
        "/grant:r",
        "*S-1-5-18:F",
        "*S-1-5-32-544:F",
    ]);
    super::hide_windows_console(&mut command);
    let _ = command.status();
}

pub(crate) fn authorize_public_key(public_key: &str) -> Result<bool, String> {
    #[cfg(windows)]
    if current_user_is_administrator() {
        let program_data = env::var_os("PROGRAMDATA").ok_or("无法确定 ProgramData 目录")?;
        let path = PathBuf::from(program_data)
            .join("ssh")
            .join("administrators_authorized_keys");
        let changed = append_authorized_key(&path, public_key)?;
        lock_windows_authorized_keys(&path);
        return Ok(changed);
    }
    let path = home_directory()?.join(".ssh").join("authorized_keys");
    append_authorized_key(&path, public_key)
}

pub(crate) fn readiness(ensure_key: bool) -> SSHReadiness {
    let client_installed = executable_available(&ssh_program("ssh"));
    let server_installed = if cfg!(windows) {
        executable_available(&ssh_program("sshd"))
    } else if cfg!(target_os = "macos") {
        Path::new("/usr/sbin/sshd").is_file()
    } else {
        false
    };
    let identity = if client_installed && ensure_key {
        ensure_identity().ok()
    } else {
        identity_private_key().map(|private_key| SSHIdentity {
            private_key,
            public_key: String::new(),
        })
    };
    let running = server_installed && server_running();
    let message = if !client_installed || !server_installed {
        if cfg!(windows) {
            "未完整安装 Windows OpenSSH，点击安装后即可使用。"
        } else {
            "当前系统缺少 OpenSSH 组件。"
        }
    } else if !running {
        if cfg!(target_os = "macos") {
            "OpenSSH 已安装，请开启 macOS“远程登录”。"
        } else {
            "OpenSSH 已安装，但 SSH 服务尚未运行。"
        }
    } else if identity.is_none() {
        "OpenSSH 已就绪，但 MapLink 专用密钥创建失败。"
    } else {
        "OpenSSH 与 MapLink 专用免密密钥已就绪。"
    };
    SSHReadiness {
        platform: if cfg!(windows) {
            "windows"
        } else if cfg!(target_os = "macos") {
            "macos"
        } else {
            "unsupported"
        },
        client_installed,
        server_installed,
        server_running: running,
        key_available: identity.is_some(),
        identity_path: identity
            .map(|value| value.private_key.to_string_lossy().into_owned())
            .unwrap_or_default(),
        message: message.into(),
    }
}

pub(crate) fn install_or_enable() -> Result<SSHReadiness, String> {
    #[cfg(windows)]
    {
        let script = "$ErrorActionPreference = 'Stop'; $client = Get-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0; if ($client.State -ne 'Installed') { Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0 | Out-Null }; $server = Get-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0; if ($server.State -ne 'Installed') { Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 | Out-Null }; Set-Service -Name sshd -StartupType Automatic; Start-Service sshd";
        let mut command = Command::new("powershell.exe");
        command.args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ]);
        super::hide_windows_console(&mut command);
        let output = command
            .output()
            .map_err(|error| format!("启动 OpenSSH 安装失败：{error}"))?;
        if !output.status.success() {
            return Err(format!(
                "安装或启动 OpenSSH 失败：{}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
    }
    #[cfg(target_os = "macos")]
    {
        let script = r#"do shell script "/usr/sbin/systemsetup -setremotelogin on" with administrator privileges"#;
        let output = Command::new("/usr/bin/osascript")
            .args(["-e", script])
            .output()
            .map_err(|error| format!("打开远程登录授权失败：{error}"))?;
        if !output.status.success() {
            return Err(format!(
                "开启 macOS 远程登录失败：{}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    return Err("当前系统暂不支持自动配置 OpenSSH".into());
    Ok(readiness(true))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_private_key_or_multiline_content() {
        assert!(normalize_public_key("-----BEGIN OPENSSH PRIVATE KEY-----").is_err());
        assert!(normalize_public_key("ssh-ed25519 AAAA\nssh-ed25519 BBBB").is_err());
    }

    #[test]
    fn authorized_key_is_idempotent_and_never_writes_private_material() {
        let path =
            std::env::temp_dir().join(format!("maplink-authorized-{}.txt", std::process::id()));
        let key =
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH test";
        let _ = fs::remove_file(&path);
        assert!(append_authorized_key(&path, key).unwrap());
        assert!(!append_authorized_key(&path, key).unwrap());
        let contents = fs::read_to_string(&path).unwrap();
        assert_eq!(contents.lines().count(), 1);
        assert!(contents.ends_with("maplink-managed\n"));
        let _ = fs::remove_file(path);
    }
}
