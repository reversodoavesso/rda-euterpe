//! Pendência P4: provar que `sharp` → `image` continua entregando JPEG ≤256 KB e
//! válida (o Rust tem que aceitar a mesma capa que o Node aceitava).

use euterpe::tools::server::cover::{encode_cover, DEFAULT_MAX_KB, MAX_SIDE};
use std::io::Cursor;

fn gradient(width: u32, height: u32) -> Vec<u8> {
    let mut img = image::RgbImage::new(width, height);
    for (x, y, px) in img.enumerate_pixels_mut() {
        *px = image::Rgb([(x % 256) as u8, (y % 256) as u8, ((x * y) % 256) as u8]);
    }
    let mut out = Vec::new();
    image::DynamicImage::ImageRgb8(img)
        .write_to(&mut Cursor::new(&mut out), image::ImageFormat::Png)
        .unwrap();
    out
}

fn jpeg_bytes(data: &serde_json::Value) -> Vec<u8> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(data["image_b64"].as_str().unwrap())
        .unwrap()
}

#[test]
fn cover_output_is_a_valid_jpeg_within_the_limit() {
    let result = encode_cover(&gradient(2400, 1800), DEFAULT_MAX_KB);
    assert!(result.ok, "codificação falhou: {:?}", result.code);
    let data = result.data.unwrap();
    let bytes = jpeg_bytes(&data);
    assert!(
        bytes.len() <= DEFAULT_MAX_KB * 1024,
        "{} bytes > 256 KB",
        bytes.len()
    );
    assert_eq!(data["bytes"].as_u64().unwrap() as usize, bytes.len());
    assert_eq!(&bytes[0..2], &[0xFF, 0xD8], "assinatura SOI ausente");
    assert_eq!(
        &bytes[bytes.len() - 2..],
        &[0xFF, 0xD9],
        "assinatura EOI ausente"
    );
    let decoded = image::load_from_memory(&bytes).expect("JPEG inválido");
    assert!(decoded.width() <= MAX_SIDE && decoded.height() <= MAX_SIDE);
}

#[test]
fn cover_handles_a_png_input_and_keeps_aspect_ratio() {
    // A Openverse devolve PNG às vezes; o `sharp` aceitava, o `image` também precisa.
    let result = encode_cover(&gradient(1200, 600), DEFAULT_MAX_KB);
    assert!(result.ok);
    let decoded = image::load_from_memory(&jpeg_bytes(&result.data.unwrap())).unwrap();
    assert_eq!(decoded.width(), 600);
    assert_eq!(decoded.height(), 300, "proporção preservada (2:1)");
}

#[test]
fn cover_is_smaller_than_the_source_for_large_images() {
    let source = gradient(3000, 3000);
    let result = encode_cover(&source, DEFAULT_MAX_KB);
    assert!(result.ok);
    let out = jpeg_bytes(&result.data.unwrap());
    assert!(out.len() < source.len());
    assert!(out.len() <= 256 * 1024);
}

#[test]
fn cover_reports_too_large_instead_of_writing_a_broken_file() {
    let result = encode_cover(&gradient(1500, 1500), 1);
    assert!(!result.ok);
    assert_eq!(result.code.as_deref(), Some("cover_too_large"));
}

#[test]
fn cover_decodes_transparent_png_without_panicking() {
    let mut img = image::RgbaImage::new(64, 64);
    for (x, y, px) in img.enumerate_pixels_mut() {
        *px = image::Rgba([(x * 4) as u8, (y * 4) as u8, 200, 128]);
    }
    let mut png = Vec::new();
    image::DynamicImage::ImageRgba8(img)
        .write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)
        .unwrap();
    let result = encode_cover(&png, DEFAULT_MAX_KB);
    assert!(result.ok, "{:?}", result.code);
}
