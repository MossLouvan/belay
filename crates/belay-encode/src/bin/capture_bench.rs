//! End-to-end: Desktop Duplication -> BGRA->NV12 -> H.264.
//!
//! The whole replacement pipeline on real screen content, reporting where the
//! time actually goes. Run it on both machines: the numbers only mean something
//! next to the hardware they came from.

use std::time::Instant;

use belay_encode::capture::DesktopCapture;
use belay_encode::color::{bgra_to_nv12, nv12_len};
use belay_encode::h264::{init_media_foundation, EncoderConfig, H264Encoder};

fn main() {
    if let Err(e) = init_media_foundation() {
        eprintln!("Media Foundation unavailable: {e}");
        return;
    }

    let mut cap = match DesktopCapture::new(0, 0) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Desktop Duplication unavailable: {e}");
            eprintln!("(needs an interactive desktop session — session 0 has none)");
            return;
        }
    };
    // H.264 needs even dimensions; a desktop can legitimately be odd.
    let w = cap.width() & !1;
    let h = cap.height() & !1;
    println!("capture   : {}x{} (duplication reports {}x{})", w, h, cap.width(), cap.height());

    let mut enc = match H264Encoder::new(EncoderConfig {
        width: w as u32,
        height: h as u32,
        fps: 60,
        bitrate_bps: 8_000_000,
        keyframe_interval_s: 4,
    }) {
        Ok(e) => e,
        Err(e) => {
            eprintln!("encoder init failed: {e}");
            return;
        }
    };

    let mut bgra = Vec::new();
    let mut nv12 = vec![0u8; nv12_len(w, h)];

    let (mut frames, mut idle, mut timeouts, mut coded, mut bytes) = (0u32, 0u32, 0u32, 0u32, 0usize);
    let (mut wait_ms, mut copy_ms, mut conv_ms, mut enc_ms) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
    let mut dirty_fraction_total = 0.0f64;

    let deadline = Instant::now() + std::time::Duration::from_secs(6);
    while Instant::now() < deadline {
        let t0 = Instant::now();
        let meta = match cap.next_frame(100, &mut bgra) {
            Ok(Some(m)) => m,
            // An idle desktop times out constantly. That is the normal state,
            // not an error, and is why the loop must not busy-spin on it.
            Ok(None) => {
                timeouts += 1;
                continue;
            }
            Err(e) => {
                eprintln!("capture failed: {e}");
                break;
            }
        };
        // Everything not spent copying was spent waiting for the compositor.
        wait_ms += t0.elapsed().as_secs_f64() * 1000.0 - meta.copy_ms;
        copy_ms += meta.copy_ms;

        if meta.idle {
            // Only the pointer moved: no pixels to encode at all. On the
            // shipping JPEG path this case still costs a full-screen blit and a
            // full-frame encode.
            idle += 1;
            continue;
        }
        frames += 1;
        dirty_fraction_total += meta.dirty_fraction();

        let t1 = Instant::now();
        if bgra_to_nv12(&bgra, meta.stride, w, h, &mut nv12).is_err() {
            continue;
        }
        conv_ms += t1.elapsed().as_secs_f64() * 1000.0;

        let t2 = Instant::now();
        match enc.encode(&nv12) {
            Ok(out) => {
                enc_ms += t2.elapsed().as_secs_f64() * 1000.0;
                for f in out {
                    coded += 1;
                    bytes += f.data.len();
                }
            }
            Err(e) => {
                eprintln!("encode failed: {e}");
                break;
            }
        }
    }

    if frames == 0 {
        println!("no frames captured — was the desktop completely idle?");
        println!("idle={idle} timeouts={timeouts}");
        return;
    }

    let f = frames as f64;
    println!("frames    : {frames} with pixels, {idle} cursor-only, {timeouts} idle timeouts");
    println!("dirty     : {:.2}% of the screen changed per frame on average", 100.0 * dirty_fraction_total / f);
    println!("capture   : {:.2} ms/frame copying (the work); {:.2} ms/frame waiting for a new frame", copy_ms / f, wait_ms / f);
    println!("convert   : {:.2} ms/frame", conv_ms / f);
    println!("encode    : {:.2} ms/frame", enc_ms / f);
    println!("pipeline  : {:.2} ms/frame of actual work (copy + convert + encode)", (copy_ms + conv_ms + enc_ms) / f);
    if coded > 0 {
        let avg = bytes as f64 / coded as f64;
        println!("bitstream : {:.0} B/frame avg -> {:.1}x fewer than the 83,701 B JPEG measured", avg, 83_701.0 / avg);
    }
    println!(
        "\ncursor-only frames cost NOTHING here. On the JPEG path each one is a\n\
         full-screen blit plus a full-frame encode, because the cursor is drawn\n\
         into the image."
    );
}
