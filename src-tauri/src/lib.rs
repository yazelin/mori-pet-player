use std::{collections::HashMap, fs::File, io::Read, path::Path};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::{Deserialize, Serialize};
use zip::ZipArchive;

const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
const MAX_SPRITE_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Debug, Deserialize)]
struct Manifest {
    schema_version: String,
    package_name: String,
    #[serde(default)]
    display_name: String,
    #[serde(default)]
    loop_durations_ms: HashMap<String, u64>,
}

#[derive(Debug, Serialize)]
struct LoadedPack {
    package_name: String,
    display_name: String,
    idle: String,
    sleeping: Option<String>,
    walking: Option<String>,
    dragging: Option<String>,
    durations_ms: HashMap<String, u64>,
}

fn read_entry(
    archive: &mut ZipArchive<File>,
    name: &str,
    max_bytes: u64,
) -> Result<Vec<u8>, String> {
    let entry = archive
        .by_name(name)
        .map_err(|_| format!("角色包缺少必要檔案：{name}"))?;
    if entry.size() > max_bytes {
        return Err(format!("檔案超過允許大小：{name}"));
    }

    let declared_size = entry.size();
    let mut bytes = Vec::with_capacity(declared_size as usize);
    entry
        .take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("讀取 {name} 失敗：{error}"))?;
    if bytes.len() as u64 > max_bytes {
        return Err(format!("檔案超過允許大小：{name}"));
    }
    Ok(bytes)
}

fn read_optional_entry(
    archive: &mut ZipArchive<File>,
    name: &str,
) -> Result<Option<Vec<u8>>, String> {
    if archive.file_names().any(|entry| entry == name) {
        read_entry(archive, name, MAX_SPRITE_BYTES).map(Some)
    } else {
        Ok(None)
    }
}

fn validate_sprite(bytes: &[u8], name: &str) -> Result<(), String> {
    if bytes.len() < 24 || &bytes[..8] != PNG_SIGNATURE {
        return Err(format!("{name} 不是有效的 PNG 圖片"));
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
    if width != 1024 || height != 1024 {
        return Err(format!(
            "{name} 尺寸須為 1024 × 1024，收到 {width} × {height}"
        ));
    }
    Ok(())
}

fn encode_sprite(bytes: Vec<u8>, name: &str) -> Result<String, String> {
    validate_sprite(&bytes, name)?;
    Ok(BASE64.encode(bytes))
}

fn duration_for(manifest: &Manifest, state: &str, fallback: u64) -> u64 {
    manifest
        .loop_durations_ms
        .get(state)
        .copied()
        .filter(|duration| (250..=60_000).contains(duration))
        .unwrap_or(fallback)
}

fn load_moripack(path: String) -> Result<LoadedPack, String> {
    let file = File::open(&path).map_err(|error| format!("無法開啟角色包：{error}"))?;
    let mut archive =
        ZipArchive::new(file).map_err(|error| format!("不是有效的 ZIP 角色包：{error}"))?;

    let manifest_bytes = read_entry(&mut archive, "manifest.json", MAX_MANIFEST_BYTES)?;
    let manifest: Manifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|error| format!("manifest.json 格式錯誤：{error}"))?;
    if !manifest.schema_version.starts_with("1.") {
        return Err(format!(
            "目前只支援 MoriPack 1.x，這份角色包是 {}",
            manifest.schema_version
        ));
    }
    if manifest.package_name.is_empty()
        || !manifest
            .package_name
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"_-".contains(&byte))
    {
        return Err("角色包 package_name 只能使用小寫英文字母、數字、底線和連字號".into());
    }

    let idle = encode_sprite(
        read_entry(&mut archive, "sprites/idle.png", MAX_SPRITE_BYTES)?,
        "sprites/idle.png",
    )?;
    let sleeping = read_optional_entry(&mut archive, "sprites/sleeping.png")?
        .map(|bytes| encode_sprite(bytes, "sprites/sleeping.png"))
        .transpose()?;
    let walking = read_optional_entry(&mut archive, "sprites/walking.png")?
        .map(|bytes| encode_sprite(bytes, "sprites/walking.png"))
        .transpose()?;
    let dragging = read_optional_entry(&mut archive, "sprites/dragging.png")?
        .map(|bytes| encode_sprite(bytes, "sprites/dragging.png"))
        .transpose()?;

    let mut durations_ms = HashMap::new();
    for (state, fallback) in [
        ("idle", 3_000),
        ("sleeping", 5_000),
        ("walking", 1_200),
        ("dragging", 1_200),
    ] {
        durations_ms.insert(state.to_string(), duration_for(&manifest, state, fallback));
    }

    let display_name = if manifest.display_name.trim().is_empty() {
        manifest.package_name.clone()
    } else {
        manifest.display_name
    };

    Ok(LoadedPack {
        package_name: manifest.package_name,
        display_name,
        idle,
        sleeping,
        walking,
        dragging,
        durations_ms,
    })
}

fn validate_pack_path(path: &str) -> Result<(), String> {
    if path.trim().is_empty() || !Path::new(path).is_file() {
        return Err("找不到 MoriPack 檔案，請重新匯入。".into());
    }
    Ok(())
}

#[tauri::command]
fn load_pack_from_path(path: String) -> Result<LoadedPack, String> {
    validate_pack_path(&path)?;
    load_moripack(path)
}

#[cfg(target_os = "linux")]
fn prefer_x11_when_unset() {
    if std::env::var_os("GDK_BACKEND").is_none() {
        std::env::set_var("GDK_BACKEND", "x11");
    }
}

#[cfg(not(target_os = "linux"))]
fn prefer_x11_when_unset() {}

pub fn run() {
    prefer_x11_when_unset();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![load_pack_from_path])
        .run(tauri::generate_context!())
        .expect("Mori Pet Player 啟動失敗");
}
