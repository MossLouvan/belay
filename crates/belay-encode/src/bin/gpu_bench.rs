//! Does keeping the frame on the GPU actually make preparation cheaper than
//! encoding it?
//!
//! The target is specific: per-frame *preparation* — everything between the
//! captured texture and the encoder's input — must cost less than the encode.
//! If preparation costs as much as the work, the pipeline cannot reach 60fps
//! without spending the whole frame budget on plumbing.
//!
//! Both paths are measured on identical content so the comparison means
//! something, and the CPU path is measured with the parallel converter it
//! actually ships with, not the slow scalar one.

#[cfg(not(windows))]
fn main() {
    eprintln!("windows only");
}

#[cfg(windows)]
fn main() -> windows::core::Result<()> {
    use std::time::Instant;

    use belay_encode::color::{bgra_to_nv12, nv12_len};
    use belay_encode::gpu::VideoConverter;
    use belay_encode::h264::{init_media_foundation, EncoderConfig, H264Encoder};
    use windows::Win32::Graphics::Direct3D::*;
    use windows::Win32::Graphics::Direct3D11::*;
    use windows::Win32::Graphics::Dxgi::Common::*;

    const W: u32 = 1920;
    const H: u32 = 1080;
    const FRAMES: usize = 120;

    println!("belay GPU path bench — {W}x{H}, {FRAMES} frames");

    let mut device: Option<ID3D11Device> = None;
    unsafe {
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            None,
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            None,
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            None,
        )?;
    }
    let device = device.expect("no D3D11 device");

    // Desktop-ish content: a static majority with one moving region. The same
    // shape the encode bench uses, for the same reason.
    let stride = (W * 4) as usize;
    let mut bgra = vec![0u8; stride * H as usize];
    let fill = |buf: &mut [u8], t: usize| {
        for y in 0..H as usize {
            for x in 0..W as usize {
                let o = y * stride + x * 4;
                let bx = 200 + (t * 9) % 900;
                let inside = x >= bx && x < bx + 420 && (300..700).contains(&y);
                let (b, g, r) = if inside { (200u8, 90, 40) } else { ((x / 8) as u8, (y / 8) as u8, 40) };
                buf[o] = b;
                buf[o + 1] = g;
                buf[o + 2] = r;
                buf[o + 3] = 255;
            }
        }
    };

    // A dynamic texture, written each frame — this stands in for Desktop
    // Duplication handing us a fresh GPU texture.
    let desc = D3D11_TEXTURE2D_DESC {
        Width: W,
        Height: H,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        // Shaped exactly like a Desktop Duplication texture: DEFAULT usage and
        // NO bind flags. Both matter. A DYNAMIC texture cannot back a video
        // processor input view at all, and this driver refuses SHADER_RESOURCE
        // on its own (see src/bin/vp_probe.rs) — which would have made the
        // benchmark fail on a constraint the real pipeline never hits.
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: 0,
        CPUAccessFlags: 0,
        MiscFlags: 0,
    };
    let mut src: Option<ID3D11Texture2D> = None;
    unsafe {
        device
            .CreateTexture2D(&desc, None, Some(&mut src))
            .expect("create source texture")
    };
    let src = src.expect("no source texture");
    let context = unsafe { device.GetImmediateContext()? };

    let mut conv = match VideoConverter::new(&device, W, H) {
        Ok(c) => c,
        Err(e) => {
            println!("no video processor on this machine ({e:?}) — CPU path is the only path here");
            return Ok(());
        }
    };

    init_media_foundation()?;
    let mut encoder = H264Encoder::new(EncoderConfig {
        width: W,
        height: H,
        fps: 60,
        bitrate_bps: 8_000_000,
        ..Default::default()
    })?;
    let zero_copy = encoder.attach_d3d_device(&device)?;
    println!(
        "  encoder input: {}",
        if zero_copy { "GPU texture (zero-copy)" } else { "CPU buffer (readback required)" }
    );

    let mut nv12_cpu = vec![0u8; nv12_len(W as usize, H as usize)];
    let mut nv12_gpu = Vec::new();

    let mut upload_us = 0u128;
    let mut gpu_convert_us = 0u128;
    let mut gpu_readback_us = 0u128;
    let mut cpu_convert_us = 0u128;
    let mut encode_us = 0u128;
    let mut bytes = 0usize;
    let mut keyframes = 0usize;
    let mut coded_frames = 0usize;
    let mut first_bytes: Vec<u8> = Vec::new();

    for t in 0..FRAMES {
        fill(&mut bgra, t);

        // Upload, standing in for what Desktop Duplication produces for free.
        // Timed separately and excluded from the comparison for exactly that
        // reason — in the real pipeline this cost does not exist.
        let s = Instant::now();
        unsafe {
            context.UpdateSubresource(
                &src,
                0,
                None,
                bgra.as_ptr() as *const _,
                stride as u32,
                0,
            );
        }
        upload_us += s.elapsed().as_micros();

        // The GPU path: conversion with no CPU involvement.
        let s = Instant::now();
        conv.convert(&src).expect("gpu convert");
        gpu_convert_us += s.elapsed().as_micros();

        // The readback is what a texture-accepting encoder makes unnecessary.
        // Measured either way, so the cost of NOT having that binding is
        // visible rather than assumed.
        let s = Instant::now();
        conv.read_back(&mut nv12_gpu).expect("gpu readback");
        gpu_readback_us += s.elapsed().as_micros();

        // The CPU path, for comparison, on identical content.
        let s = Instant::now();
        bgra_to_nv12(&bgra, stride, W as usize, H as usize, &mut nv12_cpu).unwrap();
        cpu_convert_us += s.elapsed().as_micros();

        let s = Instant::now();
        let coded = if zero_copy {
            encoder.encode_texture(conv.output_texture())?
        } else {
            encoder.encode(&nv12_gpu)?
        };
        for f in coded {
            if first_bytes.is_empty() {
                first_bytes = f.data.iter().take(8).copied().collect();
            }
            if f.keyframe {
                keyframes += 1;
            }
            coded_frames += 1;
            bytes += f.data.len();
        }
        encode_us += s.elapsed().as_micros();
    }
    for f in encoder.finish()? {
        if f.keyframe {
            keyframes += 1;
        }
        coded_frames += 1;
        bytes += f.data.len();
    }

    let n = FRAMES as f64;
    let ms = |us: u128| us as f64 / 1000.0 / n;
    let (gpu_prep, cpu_prep, enc) = (ms(gpu_convert_us), ms(cpu_convert_us), ms(encode_us));

    println!();
    println!("  upload (not in the real pipeline) : {:.2} ms/frame", ms(upload_us));
    println!("  GPU convert  (BGRA->NV12 in VRAM) : {gpu_prep:.2} ms/frame");
    println!(
        "  GPU readback {:<21}: {:.2} ms/frame",
        if zero_copy { "(measured, not used)" } else { "(REQUIRED)" },
        ms(gpu_readback_us)
    );
    println!("  CPU convert  (parallel, shipping) : {cpu_prep:.2} ms/frame");
    println!("  H.264 encode                      : {enc:.2} ms/frame");
    println!(
        "  encoded                           : {} frames, {keyframes} key, {} B/frame avg",
        coded_frames,
        bytes / FRAMES
    );

    // A path that is fast because it is silently producing nothing is the
    // failure this check exists to catch. Annex-B start code, then a NAL header
    // whose type (low 5 bits) must be SPS (7) on the first frame out.
    let valid = first_bytes.len() >= 5
        && first_bytes[0] == 0
        && first_bytes[1] == 0
        && (first_bytes[2] == 1 || (first_bytes[2] == 0 && first_bytes[3] == 1));
    let nal_type = first_bytes.get(if first_bytes.get(2) == Some(&1) { 3 } else { 4 }).map(|b| b & 0x1f);
    println!(
        "  bitstream                         : {} (first NAL type {:?})",
        if valid { "valid Annex-B" } else { "NOT VALID" },
        nal_type
    );
    assert!(valid, "encoder produced something that is not an H.264 bitstream");
    assert!(coded_frames > FRAMES / 2, "encoder dropped most frames: {coded_frames}/{FRAMES}");
    assert!(keyframes > 0, "no keyframe in {coded_frames} frames — nothing could ever decode");
    println!();
    // The honest number: what the shipping pipeline actually pays per frame
    // between the captured texture and the encoder's input.
    let real_prep = if zero_copy { gpu_prep } else { gpu_prep + ms(gpu_readback_us) };
    println!();
    println!("  per-frame prep, CPU path : {cpu_prep:.2} ms  ({:.2}x the encode)", cpu_prep / enc);
    println!("  per-frame prep, GPU path : {real_prep:.2} ms  ({:.2}x the encode)", real_prep / enc);
    if real_prep < enc {
        println!("  GOAL MET: preparation is cheaper than the encode it feeds.");
    } else {
        println!("  GOAL NOT MET: preparation still costs more than the encode.");
    }
    Ok(())
}
