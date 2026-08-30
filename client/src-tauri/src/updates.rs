use reqwest::{blocking::Client, header, StatusCode};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

const LATEST_RELEASE_URL: &str = "https://api.github.com/repos/sway913/maplink/releases/latest";
const RELEASE_DOWNLOAD_PREFIX: &str = "https://github.com/sway913/maplink/releases/download/";
const MAX_UPDATE_SIZE: u64 = 1024 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    html_url: String,
    assets: Vec<GitHubAsset>,
}

#[derive(Clone, Debug, Deserialize)]
struct GitHubAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateInfo {
    current_version: String,
    latest_version: String,
    available: bool,
    release_url: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateInstallResult {
    version: String,
    installer_path: String,
    message: String,
}

fn update_client() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(12))
        .timeout(Duration::from_secs(180))
        .user_agent(format!("MapLink/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| format!("初始化更新连接失败：{error}"))
}

fn fetch_latest_release(client: &Client) -> Result<GitHubRelease, String> {
    let response = client
        .get(LATEST_RELEASE_URL)
        .header(header::ACCEPT, "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .map_err(|error| format!("连接 GitHub 检查更新失败：{error}"))?;
    let status = response.status();
    if status != StatusCode::OK {
        return Err(format!("GitHub 更新接口返回 HTTP {status}"));
    }
    response
        .json::<GitHubRelease>()
        .map_err(|error| format!("GitHub 发行版响应无效：{error}"))
}

fn version_parts(value: &str) -> Option<Vec<u64>> {
    let value = value
        .trim()
        .trim_start_matches(|character| matches!(character, 'v' | 'V'));
    if value.is_empty() || value.contains('-') || value.contains('+') {
        return None;
    }
    let parts = value
        .split('.')
        .map(str::parse::<u64>)
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    if parts.is_empty() || parts.len() > 4 {
        return None;
    }
    Some(parts)
}

fn is_newer_version(latest: &str, current: &str) -> Result<bool, String> {
    let mut latest = version_parts(latest).ok_or_else(|| "GitHub 版本号格式无效".to_string())?;
    let mut current = version_parts(current).ok_or_else(|| "当前版本号格式无效".to_string())?;
    let width = latest.len().max(current.len());
    latest.resize(width, 0);
    current.resize(width, 0);
    Ok(latest > current)
}

fn release_asset_names(version: &str) -> Result<(String, String), String> {
    #[cfg(target_os = "windows")]
    {
        return Ok((
            format!("MapLink-Complete-Setup-v{version}-win64.exe"),
            format!("MapLink-v{version}-windows-x64-SHA256SUMS.txt"),
        ));
    }
    #[cfg(target_os = "macos")]
    {
        return Ok((
            format!("MapLink-v{version}-macos-arm64.dmg"),
            format!("MapLink-v{version}-macos-arm64-SHA256SUMS.txt"),
        ));
    }
    #[allow(unreachable_code)]
    Err("当前系统暂不支持自动安装更新".into())
}

fn find_asset<'a>(release: &'a GitHubRelease, name: &str) -> Result<&'a GitHubAsset, String> {
    let asset = release
        .assets
        .iter()
        .find(|asset| asset.name == name)
        .ok_or_else(|| format!("发行版缺少更新文件：{name}"))?;
    if !asset
        .browser_download_url
        .starts_with(RELEASE_DOWNLOAD_PREFIX)
    {
        return Err("更新下载地址不是受信任的 MapLink GitHub Release".into());
    }
    Ok(asset)
}

fn download_asset(client: &Client, asset: &GitHubAsset, path: &Path) -> Result<(), String> {
    let response = client
        .get(&asset.browser_download_url)
        .header(header::ACCEPT, "application/octet-stream")
        .send()
        .map_err(|error| format!("下载 {} 失败：{error}", asset.name))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("下载 {} 返回 HTTP {status}", asset.name));
    }
    if response.content_length().unwrap_or(0) > MAX_UPDATE_SIZE {
        return Err("更新文件超过安全大小限制".into());
    }
    let bytes = response
        .bytes()
        .map_err(|error| format!("读取 {} 下载内容失败：{error}", asset.name))?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_UPDATE_SIZE {
        return Err("更新文件为空或超过安全大小限制".into());
    }
    fs::write(path, &bytes).map_err(|error| format!("保存更新文件失败：{error}"))
}

fn checksum_for_asset(contents: &str, asset_name: &str) -> Option<String> {
    contents.lines().find_map(|line| {
        let mut fields = line.split_whitespace();
        let checksum = fields.next()?;
        let name = fields.next()?.trim_start_matches('*');
        if name == asset_name
            && checksum.len() == 64
            && checksum
                .chars()
                .all(|character| character.is_ascii_hexdigit())
        {
            Some(checksum.to_ascii_lowercase())
        } else {
            None
        }
    })
}

fn verify_download(path: &Path, checksum_text: &str, asset_name: &str) -> Result<(), String> {
    let expected = checksum_for_asset(checksum_text, asset_name)
        .ok_or_else(|| "SHA-256 校验文件中没有安装包记录".to_string())?;
    let bytes = fs::read(path).map_err(|error| format!("读取更新文件失败：{error}"))?;
    let actual = format!("{:x}", Sha256::digest(bytes));
    if actual != expected {
        return Err("更新安装包 SHA-256 校验失败，已拒绝运行".into());
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn launch_installer(path: &Path) -> Result<(), String> {
    Command::new(path)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("启动 Windows 安装程序失败：{error}"))
}

#[cfg(target_os = "macos")]
fn launch_installer(path: &Path) -> Result<(), String> {
    Command::new("open")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("打开 macOS 安装镜像失败：{error}"))
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn launch_installer(_path: &Path) -> Result<(), String> {
    Err("当前系统暂不支持自动安装更新".into())
}

fn current_update_info() -> Result<(Client, GitHubRelease, UpdateInfo), String> {
    let client = update_client()?;
    let release = fetch_latest_release(&client)?;
    let current = env!("CARGO_PKG_VERSION");
    let latest = release
        .tag_name
        .trim_start_matches(|character| matches!(character, 'v' | 'V'));
    let available = is_newer_version(latest, current)?;
    let info = UpdateInfo {
        current_version: current.into(),
        latest_version: latest.into(),
        available,
        release_url: release.html_url.clone(),
    };
    Ok((client, release, info))
}

#[tauri::command]
pub(crate) async fn check_for_update() -> Result<UpdateInfo, String> {
    tauri::async_runtime::spawn_blocking(|| current_update_info().map(|(_, _, info)| info))
        .await
        .map_err(|error| format!("检查更新任务异常：{error}"))?
}

#[tauri::command]
pub(crate) async fn download_and_install_update() -> Result<UpdateInstallResult, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let (client, release, info) = current_update_info()?;
        if !info.available {
            return Err("当前已经是最新版本".into());
        }
        let (installer_name, checksum_name) = release_asset_names(&info.latest_version)?;
        let installer_asset = find_asset(&release, &installer_name)?;
        let checksum_asset = find_asset(&release, &checksum_name)?;
        let update_dir: PathBuf = std::env::temp_dir()
            .join("MapLink")
            .join("updates")
            .join(format!("v{}", info.latest_version));
        fs::create_dir_all(&update_dir).map_err(|error| format!("创建更新目录失败：{error}"))?;
        let installer_path = update_dir.join(&installer_name);
        let checksum_path = update_dir.join(&checksum_name);
        download_asset(&client, installer_asset, &installer_path)?;
        download_asset(&client, checksum_asset, &checksum_path)?;
        let checksum_text = fs::read_to_string(&checksum_path)
            .map_err(|error| format!("读取 SHA-256 校验文件失败：{error}"))?;
        verify_download(&installer_path, &checksum_text, &installer_name)?;
        launch_installer(&installer_path)?;
        Ok(UpdateInstallResult {
            version: info.latest_version,
            installer_path: installer_path.to_string_lossy().into_owned(),
            message: if cfg!(target_os = "macos") {
                "更新已校验并打开安装镜像，请将 MapLink 拖入 Applications 完成安装。".into()
            } else {
                "更新已校验并启动安装程序，请按安装向导完成更新。".into()
            },
        })
    })
    .await
    .map_err(|error| format!("下载安装更新任务异常：{error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_release_versions_numerically() {
        assert!(is_newer_version("0.6.1", "0.6.0").unwrap());
        assert!(is_newer_version("v0.10.0", "0.9.9").unwrap());
        assert!(!is_newer_version("v0.5.1", "0.5.1").unwrap());
        assert!(!is_newer_version("0.5.0", "0.5.1").unwrap());
        assert!(is_newer_version("1.0", "0.9.9").unwrap());
        assert!(is_newer_version("1.0.0-beta", "0.9.9").is_err());
    }

    #[test]
    fn reads_only_the_requested_checksum_entry() {
        let text = "abc  unrelated.exe\n0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef *MapLink.exe\n";
        assert_eq!(
            checksum_for_asset(text, "MapLink.exe").as_deref(),
            Some("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
        );
        assert!(checksum_for_asset(text, "missing.exe").is_none());
    }
}
