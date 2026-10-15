//! Capa de playlist: baixa, redimensiona e comprime para JPEG ≤ `max_kb`.
//!
//! Substitui `sharp` (nativo, por-binário) pelo crate `image` (puro Rust) — sem
//! toolchain nativa extra na instalação. O teste `tests/cover.rs` prova que a
//! saída é JPEG válida e cabe no limite (pendência P4).

use super::http;
use crate::protocol::ToolResult;
use base64::Engine;
use image::codecs::jpeg::JpegEncoder;
use image::DynamicImage;
use serde_json::json;
use std::io::Cursor;
use std::time::Duration;

pub const MAX_SIDE: u32 = 600;
pub const DEFAULT_MAX_KB: usize = 256;

pub async fn prepare_cover(source: &str, max_kb: usize) -> ToolResult {
    let source = source.trim();
    if source.is_empty() {
        return ToolResult::err("cover_empty_source");
    }

    // 1. Data URI (Base64 inline)
    if let Some(rest) = source.strip_prefix("data:") {
        if let Some((_, b64)) = rest.split_once(";base64,") {
            let bytes = match base64::engine::general_purpose::STANDARD.decode(b64.trim()) {
                Ok(b) => b,
                Err(e) => return ToolResult::err(format!("cover_base64_decode:{e}")),
            };
            return encode_cover(&bytes, max_kb);
        }
    }

    // 2. HTTP / HTTPS URL
    if source.starts_with("http://") || source.starts_with("https://") {
        let res = http()
            .get(source)
            .timeout(Duration::from_secs(20))
            .send()
            .await;
        let res = match res {
            Ok(r) => r,
            Err(e) => return ToolResult::err(format!("cover_download:{e}")),
        };
        if !res.status().is_success() {
            return ToolResult::err(format!("cover_download_{}", res.status().as_u16()));
        }
        let bytes = match res.bytes().await {
            Ok(b) => b,
            Err(e) => return ToolResult::err(format!("cover_body:{e}")),
        };
        return encode_cover(&bytes, max_kb);
    }

    // 3. Local filesystem path
    let path = std::path::Path::new(source);
    match tokio::fs::read(path).await {
        Ok(bytes) => encode_cover(&bytes, max_kb),
        Err(e) => ToolResult::err(format!("cover_file_read:{e}")),
    }
}

/// Núcleo puro (testável sem rede).
pub fn encode_cover(raw: &[u8], max_kb: usize) -> ToolResult {
    let max_bytes = max_kb.max(1) * 1024;
    let img = match image::load_from_memory(raw) {
        Ok(i) => i,
        Err(e) => return ToolResult::err(format!("cover_decode:{e}")),
    };
    // "fit inside, without enlargement" — a mesma semântica do `sharp.resize`.
    let scaled = fit_inside(&img, MAX_SIDE);
    for quality in (40..=85).rev().step_by(10) {
        match encode_jpeg(&scaled, quality) {
            Ok(jpeg) if jpeg.len() <= max_bytes => {
                return ToolResult::ok(json!({
                    "image_b64": base64::engine::general_purpose::STANDARD.encode(&jpeg),
                    "bytes": jpeg.len(),
                    "quality": quality,
                }));
            }
            Ok(_) => continue,
            Err(e) => return ToolResult::err(format!("cover_encode:{e}")),
        }
    }
    // Última tentativa: menor qualidade possível.
    match encode_jpeg(&scaled, 35) {
        Ok(jpeg) if jpeg.len() <= max_bytes => ToolResult::ok(json!({
            "image_b64": base64::engine::general_purpose::STANDARD.encode(&jpeg),
            "bytes": jpeg.len(),
            "quality": 35,
        })),
        _ => ToolResult::err("cover_too_large"),
    }
}

fn fit_inside(img: &DynamicImage, max_side: u32) -> DynamicImage {
    let (w, h) = (img.width(), img.height());
    if w <= max_side && h <= max_side {
        return img.clone();
    }
    let scale = (max_side as f64 / w.max(h) as f64).min(1.0);
    let nw = ((w as f64 * scale).round() as u32).max(1);
    let nh = ((h as f64 * scale).round() as u32).max(1);
    img.resize_exact(nw, nh, image::imageops::FilterType::Lanczos3)
}

fn encode_jpeg(img: &DynamicImage, quality: u8) -> Result<Vec<u8>, image::ImageError> {
    let mut out: Vec<u8> = Vec::new();
    let mut cursor = Cursor::new(&mut out);
    let mut encoder = JpegEncoder::new_with_quality(&mut cursor, quality);
    encoder.encode_image(img)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_png(width: u32, height: u32) -> Vec<u8> {
        let mut img = image::RgbImage::new(width, height);
        for (x, y, px) in img.enumerate_pixels_mut() {
            *px = image::Rgb([(x % 256) as u8, (y % 256) as u8, ((x + y) % 256) as u8]);
        }
        let mut out = Vec::new();
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut Cursor::new(&mut out), image::ImageFormat::Png)
            .unwrap();
        out
    }

    #[test]
    fn cover_is_jpeg_and_within_limit() {
        let png = sample_png(1600, 1200);
        let res = encode_cover(&png, DEFAULT_MAX_KB);
        assert!(res.ok, "encode falhou: {:?}", res.code);
        let data = res.data.unwrap();
        let bytes = data["bytes"].as_u64().unwrap() as usize;
        assert!(
            bytes <= DEFAULT_MAX_KB * 1024,
            "cover com {bytes} bytes excede o limite"
        );
        let b64 = data["image_b64"].as_str().unwrap();
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .unwrap();
        assert_eq!(decoded.len(), bytes);
        // Assinatura JPEG (SOI + primeiro marcador).
        assert_eq!(&decoded[0..2], &[0xFF, 0xD8], "não é JPEG");
        assert_eq!(&decoded[decoded.len() - 2..], &[0xFF, 0xD9], "JPEG sem EOI");
        // Reencodável (prova que é um JPEG válido, não lixo com header).
        let decoded_img = image::load_from_memory(&decoded).expect("JPEG inválido");
        assert!(decoded_img.width() <= MAX_SIDE && decoded_img.height() <= MAX_SIDE);
    }

    #[test]
    fn small_images_are_not_enlarged() {
        let png = sample_png(120, 80);
        let res = encode_cover(&png, 256);
        assert!(res.ok);
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(res.data.unwrap()["image_b64"].as_str().unwrap())
            .unwrap();
        let img = image::load_from_memory(&decoded).unwrap();
        assert_eq!((img.width(), img.height()), (120, 80));
    }

    #[test]
    fn tiny_limit_still_returns_jpeg_or_reports_too_large() {
        let png = sample_png(900, 900);
        let res = encode_cover(&png, 1); // 1 KB é agressivo demais
        assert!(!res.ok);
        assert_eq!(res.code.as_deref(), Some("cover_too_large"));
    }

    #[test]
    fn garbage_input_is_an_error_not_a_panic() {
        let res = encode_cover(b"definitely not an image", 256);
        assert!(!res.ok);
        assert!(res.code.unwrap().starts_with("cover_decode"));
    }
}
