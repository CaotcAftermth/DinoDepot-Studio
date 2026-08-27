use image::{imageops::FilterType, GenericImageView, ImageEncoder, RgbaImage};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

const TERMS_PREFIX: &str = "DDS-ICON-PERMISSION-v";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PermissionRecord {
    permission_id: String,
    #[serde(rename = "mod")]
    mod_info: ModInfo,
    grantor: Grantor,
    terms: Terms,
    requested_at: String,
    approved_at: String,
    authority_confirmed: bool,
    status: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ModInfo {
    id: u64,
    name: String,
    project_url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Grantor {
    display_name: String,
    platform: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Terms {
    version: String,
    sha256: String,
    scope: Vec<String>,
    desktop_app: bool,
    web_viewer: bool,
    max_resolution: String,
    format_conversion: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicAsset {
    status: &'static str,
    path: String,
    version: u64,
    sha256: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicRights {
    status: &'static str,
    permission_id: String,
    permission_version: String,
    approved_at: String,
    scope: Vec<String>,
    attribution: Attribution,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Attribution {
    creator: String,
    project_url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SanitizedFragment {
    schema_version: u64,
    mod_id: u64,
    mod_name: String,
    rights: PublicRights,
    asset_key: String,
    asset: PublicAsset,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UploadOperation {
    order: u64,
    kind: &'static str,
    local_file: String,
    object_key: String,
    cache_control: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PublishPlan {
    schema_version: u64,
    bucket: &'static str,
    public_origin: &'static str,
    default_deny_validated: bool,
    operations: Vec<UploadOperation>,
    note: &'static str,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("REJECT PUBLICATION: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 9 || args[1] != "prepare" {
        return Err("usage: rights_asset_publisher prepare <record.json> <terms.md> <source-image> <creature|item> <asset-id> <asset-version> <output-dir>".into());
    }
    let record_path = Path::new(&args[2]);
    let terms_path = Path::new(&args[3]);
    let source_path = Path::new(&args[4]);
    let asset_type = args[5].as_str();
    let asset_id = &args[6];
    let asset_version = args[7]
        .parse::<u64>()
        .map_err(|_| "asset version must be a positive integer")?;
    let output = PathBuf::from(&args[8]);
    if !matches!(asset_type, "creature" | "item") {
        return Err("asset type must be creature or item".into());
    }
    if asset_version == 0 {
        return Err("asset version must be positive".into());
    }
    if !valid_slug(asset_id) {
        return Err("asset id must be a lowercase slug".into());
    }

    let record: PermissionRecord =
        serde_json::from_slice(&fs::read(record_path).map_err(|error| error.to_string())?)
            .map_err(|error| format!("permission record schema: {error}"))?;
    validate_permission(&record, terms_path, asset_type)?;

    let normalized = normalize_webp(source_path)?;
    let hash = format!("{:x}", Sha256::digest(&normalized));
    let folder = if asset_type == "creature" {
        "creatures"
    } else {
        "items"
    };
    let object_key = format!(
        "mods/{}/{}/{}.v{}.{}.webp",
        record.mod_info.id, folder, asset_id, asset_version, hash
    );
    let asset_file = output.join(&object_key);
    fs::create_dir_all(asset_file.parent().ok_or("invalid output path")?)
        .map_err(|error| error.to_string())?;
    fs::write(&asset_file, &normalized).map_err(|error| error.to_string())?;

    let fragment = SanitizedFragment {
        schema_version: 1,
        mod_id: record.mod_info.id,
        mod_name: record.mod_info.name.clone(),
        rights: PublicRights {
            status: "author-approved",
            permission_id: record.permission_id.clone(),
            permission_version: record.terms.version.clone(),
            approved_at: record.approved_at.chars().take(10).collect(),
            scope: record.terms.scope.clone(),
            attribution: Attribution {
                creator: record.grantor.display_name.clone(),
                project_url: record.mod_info.project_url.clone(),
            },
        },
        asset_key: format!("{asset_type}:{asset_id}"),
        asset: PublicAsset {
            status: "active",
            path: format!("/{object_key}"),
            version: asset_version,
            sha256: hash,
        },
    };
    let metadata_dir = output.join("metadata");
    fs::create_dir_all(&metadata_dir).map_err(|error| error.to_string())?;
    let fragment_file = metadata_dir.join("sanitized-fragment.json");
    fs::write(&fragment_file, pretty(&fragment)?).map_err(|error| error.to_string())?;

    let plan = PublishPlan {
        schema_version: 1,
        bucket: "dinodepot-assets",
        public_origin: "https://assets.dinodepot.app",
        default_deny_validated: true,
        operations: vec![
            UploadOperation { order: 1, kind: "asset", local_file: relative(&output, &asset_file), object_key: object_key.clone(), cache_control: "public, max-age=604800" },
            UploadOperation { order: 2, kind: "manifest", local_file: format!("registry/mods/{}.json", record.mod_info.id), object_key: format!("registry/mods/{}.json", record.mod_info.id), cache_control: "public, max-age=300" },
            UploadOperation { order: 3, kind: "index", local_file: "registry/index.json".into(), object_key: "registry/index.json".into(), cache_control: "public, max-age=300" },
        ],
        note: "Merge the sanitized fragment into reviewed registry files. Upload the index last. Credentials are read only by the execution environment.",
    };
    fs::write(output.join("publish-plan.json"), pretty(&plan)?)
        .map_err(|error| error.to_string())?;
    println!(
        "Prepared verified 160x160 WebP and registry-last publish plan at {}",
        output.display()
    );
    Ok(())
}

fn validate_permission(
    record: &PermissionRecord,
    terms_path: &Path,
    asset_type: &str,
) -> Result<(), String> {
    if record.status != "active" {
        return Err("permission lifecycle is not active".into());
    }
    if !record.authority_confirmed {
        return Err("grantor authority is not confirmed".into());
    }
    if record.permission_id.trim().is_empty()
        || record.requested_at.trim().is_empty()
        || record.approved_at.trim().is_empty()
    {
        return Err("permission lifecycle fields are incomplete".into());
    }
    if record.grantor.display_name.trim().is_empty() || record.grantor.platform.trim().is_empty() {
        return Err("public attribution is incomplete".into());
    }
    if !record.terms.version.starts_with(TERMS_PREFIX) {
        return Err("unsupported permission terms identifier".into());
    }
    let expected_terms_name = format!("{}.md", record.terms.version);
    if terms_path.file_name().and_then(|name| name.to_str()) != Some(expected_terms_name.as_str()) {
        return Err(format!(
            "permission terms file must be named {expected_terms_name}"
        ));
    }
    if !record.terms.desktop_app || !record.terms.web_viewer {
        return Err("permission must cover desktop app and web viewer".into());
    }
    if record.terms.max_resolution != "160x160" {
        return Err("permission max resolution must be exactly 160x160".into());
    }
    if !record
        .terms
        .format_conversion
        .iter()
        .any(|value| value == "webp")
    {
        return Err("permission does not allow WebP conversion".into());
    }
    let scope = format!("{asset_type}-icons");
    if !record.terms.scope.iter().any(|value| value == &scope) {
        return Err(format!("permission scope does not include {scope}"));
    }
    let terms = fs::read(terms_path).map_err(|error| error.to_string())?;
    let actual = format!("{:x}", Sha256::digest(&terms));
    if actual != record.terms.sha256 {
        return Err("permission terms hash does not match the immutable external input".into());
    }
    Ok(())
}

fn normalize_webp(source: &Path) -> Result<Vec<u8>, String> {
    let image = image::open(source).map_err(|error| error.to_string())?;
    let (width, height) = image.dimensions();
    if width == 0 || height == 0 {
        return Err("source image is empty".into());
    }
    let scale = (160.0 / width as f64).min(160.0 / height as f64).min(1.0);
    let target_width = ((width as f64 * scale).round() as u32).max(1);
    let target_height = ((height as f64 * scale).round() as u32).max(1);
    let resized = image
        .resize_exact(target_width, target_height, FilterType::Lanczos3)
        .to_rgba8();
    let mut canvas = RgbaImage::new(160, 160);
    image::imageops::overlay(
        &mut canvas,
        &resized,
        ((160 - target_width) / 2) as i64,
        ((160 - target_height) / 2) as i64,
    );
    let mut output = Vec::new();
    image::codecs::webp::WebPEncoder::new_lossless(&mut output)
        .write_image(canvas.as_raw(), 160, 160, image::ExtendedColorType::Rgba8)
        .map_err(|error| error.to_string())?;
    Ok(output)
}

fn valid_slug(value: &str) -> bool {
    !value.is_empty()
        && value.split('-').all(|part| {
            !part.is_empty()
                && part
                    .chars()
                    .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit())
        })
}

fn pretty<T: Serialize>(value: &T) -> Result<Vec<u8>, String> {
    let mut bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    Ok(bytes)
}

fn relative(root: &Path, file: &Path) -> String {
    file.strip_prefix(root)
        .unwrap_or(file)
        .to_string_lossy()
        .replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_dir() -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "dds-rights-publisher-{}-{stamp}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn record(hash: String) -> PermissionRecord {
        PermissionRecord {
            permission_id: "permission-test".into(),
            mod_info: ModInfo {
                id: 123,
                name: "Test Mod".into(),
                project_url: "https://example.invalid/mod".into(),
            },
            grantor: Grantor {
                display_name: "Test Creator".into(),
                platform: "test".into(),
            },
            terms: Terms {
                version: "DDS-ICON-PERMISSION-v1.0".into(),
                sha256: hash,
                scope: vec!["creature-icons".into()],
                desktop_app: true,
                web_viewer: true,
                max_resolution: "160x160".into(),
                format_conversion: vec!["webp".into()],
            },
            requested_at: "2026-01-01".into(),
            approved_at: "2026-01-02".into(),
            authority_confirmed: true,
            status: "active".into(),
        }
    }

    #[test]
    fn permission_is_default_denied_before_image_processing() {
        let dir = test_dir();
        let terms = dir.join("DDS-ICON-PERMISSION-v1.0.md");
        fs::write(&terms, b"external terms").unwrap();
        let hash = format!("{:x}", Sha256::digest(b"external terms"));
        let mut candidate = record(hash);
        candidate.status = "withdrawn".into();
        assert!(validate_permission(&candidate, &terms, "creature")
            .unwrap_err()
            .contains("lifecycle"));
        candidate.status = "active".into();
        candidate.terms.scope = vec!["item-icons".into()];
        assert!(validate_permission(&candidate, &terms, "creature")
            .unwrap_err()
            .contains("scope"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn exact_terms_identity_and_hash_are_required() {
        let dir = test_dir();
        let wrong_name = dir.join("terms.md");
        fs::write(&wrong_name, b"external terms").unwrap();
        let hash = format!("{:x}", Sha256::digest(b"external terms"));
        let candidate = record(hash);
        assert!(validate_permission(&candidate, &wrong_name, "creature")
            .unwrap_err()
            .contains("named"));
        let exact_name = dir.join("DDS-ICON-PERMISSION-v1.0.md");
        fs::write(&exact_name, b"changed terms").unwrap();
        assert!(validate_permission(&candidate, &exact_name, "creature")
            .unwrap_err()
            .contains("hash"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn normalization_transparently_pads_to_exact_dimensions() {
        let dir = test_dir();
        let source = dir.join("source.png");
        let mut image = RgbaImage::new(80, 40);
        for pixel in image.pixels_mut() {
            *pixel = image::Rgba([5, 10, 15, 255]);
        }
        image.save(&source).unwrap();
        let bytes = normalize_webp(&source).unwrap();
        let decoded = image::load_from_memory_with_format(&bytes, image::ImageFormat::WebP)
            .unwrap()
            .to_rgba8();
        assert_eq!(decoded.dimensions(), (160, 160));
        assert_eq!(decoded.get_pixel(0, 0).0[3], 0);
        assert_eq!(decoded.get_pixel(80, 80).0[3], 255);
        fs::remove_dir_all(dir).unwrap();
    }
}
