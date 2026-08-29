//! Turning an extracted game texture into a project icon.
//!
//! Mod artwork arrives at whatever size and format the mod author cooked it
//! at - 512x512 BC7, 1024x1024 with padding, occasionally something odd. What
//! the project stores is always the same thing: a 160x160 lossless WebP in the
//! project's own images folder, which is precedence 1 in icon resolution and
//! the only place a project-owned image is allowed to live.
//!
//! Conversion happens here rather than in the extractor so that the rule holds
//! however the bytes were obtained. An import from disk, a paste, and a
//! texture pulled out of a mod pak all land as the same shape of file.

use std::fs;
use std::path::{Component, Path, PathBuf};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use image::imageops::FilterType;
use image::{ImageEncoder, ImageReader, RgbaImage};

use super::project_io::write_atomic;

/// Every project icon is this square. Big enough for the largest place one is
/// shown, small enough that a few thousand of them are not a burden.
const ICON_SIZE: u32 = 160;

/// Roughly a 4096x4096 RGBA texture. Well past anything a mod icon needs, and
/// far short of what would exhaust memory decoding it.
const MAX_SOURCE_BYTES: usize = 64 * 1024 * 1024;

/// One level of grouping, so a project with hundreds of icons is navigable.
const MAX_STEM_DEPTH: usize = 2;

/// A relative name safe to write inside the images folder.
///
/// One forward slash is allowed, so icons can be filed under the mod they
/// came from - `AAHelicoprion/Helicoprion AA`. Everything else is rejected
/// rather than sanitised: a name that needed rewriting is a name the caller
/// got wrong, and quietly storing an icon somewhere other than where it was
/// asked for is worse than refusing.
fn safe_file_stem(value: &str) -> bool {
    if value.is_empty() || value.len() > 160 {
        return false;
    }
    if value.contains('\\') || value.contains(':') {
        return false;
    }
    let segments: Vec<&str> = value.split('/').collect();
    if segments.len() > MAX_STEM_DEPTH {
        return false;
    }
    if segments
        .iter()
        .any(|segment| segment.is_empty() || segment.starts_with('.'))
    {
        return false;
    }
    Path::new(value)
        .components()
        .all(|part| matches!(part, Component::Normal(_)))
}

/// Scales to fit inside the square and centres it, rather than stretching.
///
/// A creature portrait squashed to a square reads as a mistake, and cropping
/// throws away the part of the art that identifies it. Padding is transparent,
/// so a non-square texture keeps its shape against any background.
fn fit_to_square(source: &RgbaImage, size: u32) -> RgbaImage {
    let (width, height) = source.dimensions();
    if width == 0 || height == 0 {
        return RgbaImage::new(size, size);
    }
    let scale = f64::from(size) / f64::from(width.max(height));
    let target_width = ((f64::from(width) * scale).round() as u32).clamp(1, size);
    let target_height = ((f64::from(height) * scale).round() as u32).clamp(1, size);
    let scaled = image::imageops::resize(
        source,
        target_width,
        target_height,
        // Lanczos3 because these are downscales of detailed art, where the
        // cheaper filters visibly mush the silhouette.
        FilterType::Lanczos3,
    );

    let mut canvas = RgbaImage::new(size, size);
    let x = (size - target_width) / 2;
    let y = (size - target_height) / 2;
    image::imageops::overlay(&mut canvas, &scaled, i64::from(x), i64::from(y));
    canvas
}

/// Inverts colour, leaving transparency alone.
///
/// Mods routinely ship creature icons as black silhouettes, meant to be tinted
/// by the game's UI. Against a dark panel that is an invisible icon, and the
/// standing workaround was to open each one in an image editor and invert it.
/// Alpha is deliberately untouched: inverting it would turn the transparent
/// surround into an opaque block.
fn invert_colour(image: &mut RgbaImage) {
    for pixel in image.pixels_mut() {
        pixel.0[0] = 255 - pixel.0[0];
        pixel.0[1] = 255 - pixel.0[1];
        pixel.0[2] = 255 - pixel.0[2];
    }
}

/// Decodes any image this app accepts and re-encodes it as a project icon.
///
/// Lossless: an icon is flat colour and hard edges, which is what lossless
/// WebP is good at, and it keeps the alpha the padding depends on.
pub fn icon_webp_from_bytes(bytes: &[u8], invert: bool) -> Result<Vec<u8>, String> {
    if bytes.is_empty() {
        return Err("The image is empty".into());
    }
    if bytes.len() > MAX_SOURCE_BYTES {
        return Err("The image is larger than 64 MB".into());
    }
    let reader = ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| format!("Could not read the image: {e}"))?;
    let decoded = reader
        .decode()
        .map_err(|e| format!("Could not decode the image: {e}"))?;
    let mut source = decoded.to_rgba8();
    // Before scaling, so the resampler blends inverted colours rather than
    // inverting the blend - the difference shows on antialiased edges.
    if invert {
        invert_colour(&mut source);
    }
    let square = fit_to_square(&source, ICON_SIZE);

    let mut out = Vec::new();
    image::codecs::webp::WebPEncoder::new_lossless(&mut out)
        .write_image(
            square.as_raw(),
            ICON_SIZE,
            ICON_SIZE,
            image::ExtendedColorType::Rgba8,
        )
        .map_err(|e| format!("Could not encode the icon as WebP: {e}"))?;
    Ok(out)
}

fn images_dir(project_dir: &str, images_dir: &str) -> PathBuf {
    if images_dir.trim().is_empty() {
        Path::new(project_dir).join("images")
    } else {
        PathBuf::from(images_dir.trim())
    }
}

/// Writes one extracted texture into the project as `<stem>.webp`.
///
/// Returns the file name, which is what a `file:` icon reference stores - the
/// images folder is the root those are resolved against, so a path never
/// travels in shared project JSON.
#[tauri::command]
pub fn project_icon_write(
    project_dir: String,
    images_dir_override: String,
    file_stem: String,
    image_b64: String,
    #[allow(unused)] invert: Option<bool>,
) -> Result<String, String> {
    if !safe_file_stem(&file_stem) {
        return Err("That icon name cannot be used as a file name".into());
    }
    let bytes = STANDARD
        .decode(image_b64.trim())
        .map_err(|_| "The image was not valid base64".to_string())?;
    let webp = icon_webp_from_bytes(&bytes, invert.unwrap_or(false))?;

    let dir = images_dir(&project_dir, &images_dir_override);
    let name = format!("{file_stem}.webp");
    let target = dir.join(&name);
    // The stem may name a subfolder, so the parent is what has to exist.
    let parent = target.parent().unwrap_or(dir.as_path());
    fs::create_dir_all(parent)
        .map_err(|e| format!("Could not create the images folder: {e}"))?;
    write_atomic(&target, &webp)?;
    // Forward slashes: a `file:` value is read on whatever machine opens the
    // project, and a backslash would not resolve on any of them.
    Ok(name.replace('\\', "/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut image = RgbaImage::new(width, height);
        for (x, y, pixel) in image.enumerate_pixels_mut() {
            *pixel = image::Rgba([(x % 256) as u8, (y % 256) as u8, 128, 255]);
        }
        let mut out = Vec::new();
        image::codecs::png::PngEncoder::new(&mut out)
            .write_image(
                image.as_raw(),
                width,
                height,
                image::ExtendedColorType::Rgba8,
            )
            .unwrap();
        out
    }

    fn decode(bytes: &[u8]) -> RgbaImage {
        ImageReader::new(std::io::Cursor::new(bytes))
            .with_guessed_format()
            .unwrap()
            .decode()
            .unwrap()
            .to_rgba8()
    }

    #[test]
    fn every_icon_comes_out_the_same_square() {
        for (width, height) in [(512, 512), (1024, 256), (64, 90), (1, 1)] {
            let webp = icon_webp_from_bytes(&png(width, height), false).unwrap();
            assert_eq!(decode(&webp).dimensions(), (ICON_SIZE, ICON_SIZE));
        }
    }

    #[test]
    fn a_wide_texture_is_padded_rather_than_stretched() {
        // 1024x256 scaled to fit is 160x40, so the top and bottom rows are
        // padding. Stretching would fill them with art instead.
        let webp = icon_webp_from_bytes(&png(1024, 256), false).unwrap();
        let icon = decode(&webp);
        assert_eq!(
            icon.get_pixel(0, 0).0[3],
            0,
            "top row should be transparent"
        );
        assert_eq!(
            icon.get_pixel(ICON_SIZE / 2, ICON_SIZE / 2).0[3],
            255,
            "the middle should be the art"
        );
    }

    #[test]
    fn inverting_flips_colour_and_leaves_transparency_alone() {
        // A black silhouette on transparent padding is the case this exists
        // for: the art has to come out white, the surround has to stay clear.
        let mut source = RgbaImage::new(8, 8);
        for pixel in source.pixels_mut() {
            *pixel = image::Rgba([0, 0, 0, 255]);
        }
        let mut png = Vec::new();
        image::codecs::png::PngEncoder::new(&mut png)
            .write_image(source.as_raw(), 8, 8, image::ExtendedColorType::Rgba8)
            .unwrap();

        let plain = decode(&icon_webp_from_bytes(&png, false).unwrap());
        let flipped = decode(&icon_webp_from_bytes(&png, true).unwrap());
        let middle = (ICON_SIZE / 2, ICON_SIZE / 2);
        assert_eq!(plain.get_pixel(middle.0, middle.1).0[..3], [0, 0, 0]);
        assert_eq!(flipped.get_pixel(middle.0, middle.1).0[..3], [255, 255, 255]);
        assert_eq!(flipped.get_pixel(middle.0, middle.1).0[3], 255);
    }

    #[test]
    fn refuses_bytes_that_are_not_an_image() {
        assert!(icon_webp_from_bytes(b"not an image at all", false).is_err());
        assert!(icon_webp_from_bytes(&[], false).is_err());
    }

    #[test]
    fn refuses_a_name_that_would_escape_the_images_folder() {
        for name in [
            "../escape",
            "a/../b",
            "C:cursed",
            "",
            ".hidden",
            "mod/.hidden",
            "a/b/c",
            "trailing/",
        ] {
            assert!(!safe_file_stem(name), "{name} should be refused");
        }
    }

    #[test]
    fn allows_one_level_of_grouping_by_mod() {
        assert!(safe_file_stem("Rex Alpha (variant)"));
        assert!(safe_file_stem("AAHelicoprion/Helicoprion AA"));
    }

    #[test]
    fn writes_into_the_subfolder_the_stem_names() {
        let temp = tempfile::tempdir().unwrap();
        let name = project_icon_write(
            temp.path().to_string_lossy().to_string(),
            String::new(),
            "AAHelicoprion/Helicoprion AA".into(),
            STANDARD.encode(png(64, 64)),
            None,
        )
        .unwrap();
        assert_eq!(name, "AAHelicoprion/Helicoprion AA.webp");
        assert!(temp
            .path()
            .join("images")
            .join("AAHelicoprion")
            .join("Helicoprion AA.webp")
            .is_file());
    }
}

#[cfg(test)]
mod real_texture_tests {
    use super::*;

    /// End-to-end against a texture the extractor actually pulled out of an
    /// installed mod, rather than a synthetic gradient. Skipped when the spike
    /// output is not present, so this never fails a clean checkout.
    #[test]
    fn converts_a_texture_extracted_from_a_mod() {
        let source = std::env::temp_dir().join("01_T_ROGUE_SUIT_BaseColor_01.png");
        let Ok(bytes) = fs::read(&source) else {
            eprintln!("skipped: no extracted texture at {}", source.display());
            return;
        };
        let webp = icon_webp_from_bytes(&bytes, false).expect("a 4096x4096 mod texture should convert");
        let icon = ImageReader::new(std::io::Cursor::new(&webp))
            .with_guessed_format()
            .unwrap()
            .decode()
            .unwrap();
        assert_eq!(icon.width(), ICON_SIZE);
        assert_eq!(icon.height(), ICON_SIZE);
        eprintln!(
            "converted {} bytes of PNG into {} bytes of 160x160 WebP",
            bytes.len(),
            webp.len()
        );
    }
}
