use image::{imageops::FilterType, GenericImageView, ImageEncoder, RgbaImage};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

const TERMS_PREFIX: &str = "DDS-ICON-PERMISSION-v";
const OFFICIAL_TERMS_PREFIX: &str = "DDS-OFFICIAL-REFERENCE-POLICY-v";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PermissionRecord {
    permission_id: String,
    #[serde(default = "default_approval_basis")]
    approval_basis: String,
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
struct OfficialPolicyRecord {
    policy_id: String,
    source: OfficialSource,
    terms: Terms,
    reviewed_at: String,
    review_state: String,
    distribution_eligible: bool,
    status: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OfficialSource {
    display_name: String,
    reference_url: String,
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
    status: String,
    permission_id: String,
    permission_version: String,
    approved_at: String,
    scope: Vec<String>,
    attribution: Attribution,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicOfficialRights {
    status: &'static str,
    policy_id: String,
    reviewed_at: String,
    review_state: &'static str,
    distribution_eligible: bool,
    scope: Vec<String>,
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
struct OfficialSanitizedFragment {
    schema_version: u64,
    rights: PublicOfficialRights,
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
    match args.get(1).map(String::as_str) {
        Some("prepare") => prepare_mod(&args[2..]),
        Some("mod") if args.get(2).map(String::as_str) == Some("prepare") => {
            prepare_mod(&args[3..])
        }
        Some("official") if args.get(2).map(String::as_str) == Some("prepare") => {
            prepare_official(&args[3..])
        }
        _ => Err(
            "usage: rights_asset_publisher <mod|official> prepare <record.json> <terms.md> <source-image> <creature|item|map> <asset-id> <asset-version> <output-dir> [author-approved|license-approved]"
                .into(),
        ),
    }
}

fn prepare_mod(args: &[String]) -> Result<(), String> {
    if args.len() != 7 && args.len() != 8 {
        return Err("usage: rights_asset_publisher mod prepare <record.json> <terms.md> <source-image> <creature|item> <asset-id> <asset-version> <output-dir> [author-approved|license-approved]".into());
    }
    let record_path = Path::new(&args[0]);
    let terms_path = Path::new(&args[1]);
    let source_path = Path::new(&args[2]);
    let asset_type = args[3].as_str();
    let asset_id = &args[4];
    let asset_version = args[5]
        .parse::<u64>()
        .map_err(|_| "asset version must be a positive integer")?;
    let output = PathBuf::from(&args[6]);
    let requested_approval = args.get(7).map(String::as_str);
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
    if requested_approval.is_some_and(|value| value != record.approval_basis) {
        return Err(
            "requested approval status does not match the private permission record".into(),
        );
    }

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
            status: record.approval_basis.clone(),
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
        public_origin: "https://assets.dinodepot-studio.app",
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

fn prepare_official(args: &[String]) -> Result<(), String> {
    if args.len() != 7 {
        return Err("usage: rights_asset_publisher official prepare <policy.json> <terms.md> <source-image> <creature|item|map> <asset-id> <asset-version> <output-dir>".into());
    }
    let policy_path = Path::new(&args[0]);
    let terms_path = Path::new(&args[1]);
    let source_path = Path::new(&args[2]);
    let asset_type = args[3].as_str();
    let asset_id = &args[4];
    let asset_version = args[5]
        .parse::<u64>()
        .map_err(|_| "asset version must be a positive integer")?;
    let output = PathBuf::from(&args[6]);
    if !matches!(asset_type, "creature" | "item" | "map") {
        return Err("official asset type must be creature, item, or map".into());
    }
    if asset_version == 0 {
        return Err("asset version must be positive".into());
    }
    if !valid_slug(asset_id) {
        return Err("asset id must be a lowercase slug".into());
    }

    let policy: OfficialPolicyRecord =
        serde_json::from_slice(&fs::read(policy_path).map_err(|error| error.to_string())?)
            .map_err(|error| format!("official policy record schema: {error}"))?;
    validate_official_policy(&policy, terms_path, asset_type)?;

    let normalized = normalize_webp(source_path)?;
    let hash = format!("{:x}", Sha256::digest(&normalized));
    let folder = asset_folder(asset_type)?;
    let object_key = format!("official/{folder}/{asset_id}.v{asset_version}.{hash}.webp");
    let asset_file = output.join(&object_key);
    fs::create_dir_all(asset_file.parent().ok_or("invalid output path")?)
        .map_err(|error| error.to_string())?;
    fs::write(&asset_file, &normalized).map_err(|error| error.to_string())?;

    let fragment = OfficialSanitizedFragment {
        schema_version: 1,
        rights: PublicOfficialRights {
            status: "official-reference-policy",
            policy_id: policy.policy_id.clone(),
            reviewed_at: policy.reviewed_at.chars().take(10).collect(),
            review_state: "approved",
            distribution_eligible: true,
            scope: policy.terms.scope.clone(),
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
    fs::write(
        metadata_dir.join("sanitized-fragment.json"),
        pretty(&fragment)?,
    )
    .map_err(|error| error.to_string())?;

    let plan = PublishPlan {
        schema_version: 1,
        bucket: "dinodepot-assets",
        public_origin: "https://assets.dinodepot-studio.app",
        default_deny_validated: true,
        operations: vec![
            UploadOperation { order: 1, kind: "asset", local_file: relative(&output, &asset_file), object_key: object_key.clone(), cache_control: "public, max-age=604800" },
            UploadOperation { order: 2, kind: "manifest", local_file: "registry/official.json".into(), object_key: "registry/official.json".into(), cache_control: "public, max-age=300" },
            UploadOperation { order: 3, kind: "index", local_file: "registry/index.json".into(), object_key: "registry/index.json".into(), cache_control: "public, max-age=300" },
        ],
        note: "Merge the sanitized fragment into reviewed registry files. Upload the index last. Credentials are read only by the execution environment.",
    };
    fs::write(output.join("publish-plan.json"), pretty(&plan)?)
        .map_err(|error| error.to_string())?;
    println!(
        "Prepared verified 160x160 official WebP and registry-last publish plan at {}",
        output.display()
    );
    Ok(())
}

fn validate_permission(
    record: &PermissionRecord,
    terms_path: &Path,
    asset_type: &str,
) -> Result<(), String> {
    if !matches!(
        record.approval_basis.as_str(),
        "author-approved" | "license-approved"
    ) {
        return Err("private permission record approval basis is invalid".into());
    }
    if record.status != "active" {
        return Err("permission lifecycle is not active".into());
    }
    if !record.authority_confirmed {
        return Err("grantor authority is not confirmed".into());
    }
    if record.mod_info.id == 0
        || record.mod_info.name.trim().is_empty()
        || !valid_https_url(&record.mod_info.project_url)
    {
        return Err("mod identity and HTTPS project URL are required".into());
    }
    if !valid_public_id(&record.permission_id)
        || record.requested_at.trim().is_empty()
        || record.approved_at.trim().is_empty()
    {
        return Err("permission lifecycle fields are incomplete".into());
    }
    if record.grantor.display_name.trim().is_empty() || record.grantor.platform.trim().is_empty() {
        return Err("public attribution is incomplete".into());
    }
    if !valid_terms_version(&record.terms.version, TERMS_PREFIX) {
        return Err("unsupported permission terms identifier".into());
    }
    if !valid_date_prefix(&record.approved_at) {
        return Err("permission approval date must begin with YYYY-MM-DD".into());
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

fn validate_official_policy(
    policy: &OfficialPolicyRecord,
    terms_path: &Path,
    asset_type: &str,
) -> Result<(), String> {
    if policy.status != "active" {
        return Err("official policy lifecycle is not active".into());
    }
    if policy.review_state != "approved" || !policy.distribution_eligible {
        return Err("official policy is not approved for distribution".into());
    }
    if !valid_public_id(&policy.policy_id) || policy.reviewed_at.trim().is_empty() {
        return Err("official policy identity and review date are required".into());
    }
    if policy.source.display_name.trim().is_empty()
        || !valid_https_url(&policy.source.reference_url)
    {
        return Err("official source provenance is incomplete".into());
    }
    if !valid_terms_version(&policy.terms.version, OFFICIAL_TERMS_PREFIX) {
        return Err("unsupported official policy terms identifier".into());
    }
    if !valid_date_prefix(&policy.reviewed_at) {
        return Err("official policy review date must begin with YYYY-MM-DD".into());
    }
    let expected_terms_name = format!("{}.md", policy.terms.version);
    if terms_path.file_name().and_then(|name| name.to_str()) != Some(expected_terms_name.as_str()) {
        return Err(format!(
            "official policy terms file must be named {expected_terms_name}"
        ));
    }
    if !policy.terms.desktop_app || !policy.terms.web_viewer {
        return Err("official policy must cover desktop app and web viewer".into());
    }
    if policy.terms.max_resolution != "160x160" {
        return Err("official policy max resolution must be exactly 160x160".into());
    }
    if !policy
        .terms
        .format_conversion
        .iter()
        .any(|value| value == "webp")
    {
        return Err("official policy does not allow WebP conversion".into());
    }
    let scope = format!("{asset_type}-icons");
    if !policy.terms.scope.iter().any(|value| value == &scope) {
        return Err(format!("official policy scope does not include {scope}"));
    }
    let terms = fs::read(terms_path).map_err(|error| error.to_string())?;
    let actual = format!("{:x}", Sha256::digest(&terms));
    if actual != policy.terms.sha256 {
        return Err(
            "official policy terms hash does not match the immutable external input".into(),
        );
    }
    Ok(())
}

fn asset_folder(asset_type: &str) -> Result<&'static str, String> {
    match asset_type {
        "creature" => Ok("creatures"),
        "item" => Ok("items"),
        "map" => Ok("maps"),
        _ => Err("asset type must be creature, item, or map".into()),
    }
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

fn valid_public_id(value: &str) -> bool {
    !value.is_empty()
        && value.chars().all(|ch| {
            ch.is_ascii_uppercase() || ch.is_ascii_digit() || matches!(ch, '.' | '_' | '-')
        })
        && value
            .chars()
            .next()
            .is_some_and(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit())
}

fn default_approval_basis() -> String {
    "author-approved".into()
}

fn valid_terms_version(value: &str, prefix: &str) -> bool {
    let Some(version) = value.strip_prefix(prefix) else {
        return false;
    };
    let mut parts = version.split('.');
    matches!(
        (parts.next(), parts.next(), parts.next()),
        (Some(major), Some(minor), None)
            if !major.is_empty()
                && !minor.is_empty()
                && major.chars().all(|ch| ch.is_ascii_digit())
                && minor.chars().all(|ch| ch.is_ascii_digit())
    )
}

fn valid_date_prefix(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 10
        && bytes[0..4].iter().all(u8::is_ascii_digit)
        && bytes[4] == b'-'
        && bytes[5..7].iter().all(u8::is_ascii_digit)
        && bytes[7] == b'-'
        && bytes[8..10].iter().all(u8::is_ascii_digit)
}

fn valid_https_url(value: &str) -> bool {
    url::Url::parse(value)
        .ok()
        .is_some_and(|parsed| parsed.scheme() == "https" && parsed.host_str().is_some())
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
            permission_id: "PERMISSION-TEST".into(),
            approval_basis: "author-approved".into(),
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

    fn official_policy(hash: String) -> OfficialPolicyRecord {
        OfficialPolicyRecord {
            policy_id: "OFFICIAL-POLICY-TEST".into(),
            source: OfficialSource {
                display_name: "Official reference".into(),
                reference_url: "https://example.invalid/reference".into(),
            },
            terms: Terms {
                version: "DDS-OFFICIAL-REFERENCE-POLICY-v1.0".into(),
                sha256: hash,
                scope: vec!["map-icons".into()],
                desktop_app: true,
                web_viewer: true,
                max_resolution: "160x160".into(),
                format_conversion: vec!["webp".into()],
            },
            reviewed_at: "2026-08-27".into(),
            review_state: "approved".into(),
            distribution_eligible: true,
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
    fn official_policy_is_default_denied_and_scope_checked() {
        let dir = test_dir();
        let terms = dir.join("DDS-OFFICIAL-REFERENCE-POLICY-v1.0.md");
        fs::write(&terms, b"official external policy").unwrap();
        let hash = format!("{:x}", Sha256::digest(b"official external policy"));
        let mut candidate = official_policy(hash);
        candidate.distribution_eligible = false;
        assert!(validate_official_policy(&candidate, &terms, "map")
            .unwrap_err()
            .contains("not approved"));
        candidate.distribution_eligible = true;
        assert!(validate_official_policy(&candidate, &terms, "creature")
            .unwrap_err()
            .contains("scope"));
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
