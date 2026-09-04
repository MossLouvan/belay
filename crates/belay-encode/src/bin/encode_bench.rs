//! Measures what replacing JPEG actually buys, on whatever machine it runs on.
//!
//! Generates synthetic desktop-like frames (mostly static, a small moving
//! region — the shape real desktop content has), encodes them with H.264, and
//! reports bytes per frame, effective bitrate and per-frame encode latency.
//!
//! Synthetic rather than captured on purpose: the comparison has to be against
//! *identical* content to mean anything, and it removes capture from the
//! measurement so the encoder is what is being judged.

use std::time::Instant;

use belay_encode::color::{bgra_to_nv12, bgra_to_nv12_scalar, nv12_len};

#[cfg(windows)]
use belay_encode::h264::{init_media_foundation, EncoderConfig, H264Encoder};

const WIDTH: usize = 1920;
const HEIGHT: usize = 1080;
const FRAMES: usize = 120;

/// A desktop-ish frame: static background, one moving block, a little text-like
/// high-frequency detail. The static majority is the point — it is what
/// inter-frame coding exploits and JPEG cannot.
fn synth_frame(buf: &mut [u8], stride: usize, t: usize) {
    for y in 0..HEIGHT {
        let row = &mut buf[y * stride..y * stride + WIDTH * 4];
        for x in 0..WIDTH {
            let p = &mut row[x * 4..x * 4 + 4];
            // Static gradient background.
            let (mut b, mut g, mut r) = ((x / 8) as u8, (y / 8) as u8, 40u8);
            // Text-like detail: thin vertical stems on a grid.
            if y % 32 < 12 && x % 7 == 0 {
                b = 230;
                g = 230;
                r = 230;
            }
            // One moving window.
            let bx = 200 + (t * 9) % 900;
            if x >= bx && x < bx + 420 && y >= 300 && y < 700 {
                b = 200;
                g = 90;
                r = 40;
            }
            p[0] = b;
            p[1] = g;
            p[2] = r;
            p[3] = 255;
        }
    }
}

fn main() {
    let stride = WIDTH * 4;
    let mut bgra = vec![0u8; stride * HEIGHT];
    let mut nv12 = vec![0u8; nv12_len(WIDTH, HEIGHT)];

    println!("belay encode bench — {WIDTH}x{HEIGHT}, {FRAMES} frames");

    // Colour conversion is on the hot path for every frame, so measure it —
    // and measure what parallelising it actually bought, since "it felt faster"
    // is not a number.
    let mut scalar_ms = 0.0f64;
    let mut par_ms = 0.0f64;
    const REPS: usize = 16;
    for t in 0..REPS {
        synth_frame(&mut bgra, stride, t);
        let start = Instant::now();
        bgra_to_nv12_scalar(&bgra, stride, WIDTH, HEIGHT, &mut nv12).expect("convert");
        scalar_ms += start.elapsed().as_secs_f64() * 1000.0;

        let start = Instant::now();
        bgra_to_nv12(&bgra, stride, WIDTH, HEIGHT, &mut nv12).expect("convert");
        par_ms += start.elapsed().as_secs_f64() * 1000.0;
    }
    let scalar = scalar_ms / REPS as f64;
    let par = par_ms / REPS as f64;
    println!(
        "BGRA->NV12 : {:.2} ms/frame single-threaded, {:.2} ms/frame parallel ({:.1}x, {} cores)",
        scalar,
        par,
        scalar / par.max(0.0001),
        std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1)
    );

    #[cfg(windows)]
    {
        if let Err(e) = init_media_foundation() {
            eprintln!("Media Foundation unavailable: {e}");
            return;
        }
        for bitrate in [4_000_000u32, 8_000_000] {
            let cfg = EncoderConfig {
                width: WIDTH as u32,
                height: HEIGHT as u32,
                fps: 60,
                bitrate_bps: bitrate,
                keyframe_interval_s: 4,
            };
            let mut enc = match H264Encoder::new(cfg) {
                Ok(e) => e,
                Err(e) => {
                    eprintln!("encoder init failed at {bitrate} bps: {e}");
                    continue;
                }
            };

            let mut bytes_total = 0usize;
            let mut coded = 0usize;
            let mut keyframes = 0usize;
            let mut largest = 0usize;
            let mut encode_ms = 0.0f64;

            for t in 0..FRAMES {
                synth_frame(&mut bgra, stride, t);
                bgra_to_nv12(&bgra, stride, WIDTH, HEIGHT, &mut nv12).expect("convert");
                let start = Instant::now();
                match enc.encode(&nv12) {
                    Ok(frames) => {
                        encode_ms += start.elapsed().as_secs_f64() * 1000.0;
                        for f in frames {
                            bytes_total += f.data.len();
                            largest = largest.max(f.data.len());
                            if f.keyframe {
                                keyframes += 1;
                            }
                            coded += 1;
                        }
                    }
                    Err(e) => {
                        eprintln!("encode failed: {e}");
                        break;
                    }
                }
            }
            if let Ok(tail) = enc.finish() {
                for f in tail {
                    bytes_total += f.data.len();
                    coded += 1;
                }
            }

            if coded == 0 {
                eprintln!("no frames coded at {bitrate} bps");
                continue;
            }
            let avg = bytes_total as f64 / coded as f64;
            let effective = avg * 8.0 * 60.0 / 1_000_000.0;
            println!(
                "H.264 @{:>5} kbps : {:>3} frames, {:>2} key, avg {:>7.0} B, max {:>7} B, \
                 {:.2} Mbps @60fps, encode {:.2} ms/frame",
                bitrate / 1000,
                coded,
                keyframes,
                avg,
                largest,
                effective,
                encode_ms / FRAMES as f64
            );
            println!(
                "                    -> {:.1}x fewer bytes per frame than the measured JPEG path",
                83_701.0 / avg
            );
        }

        // The comparison that matters, against a REAL measurement rather than
        // an estimate: capturing the Belay virtual display through the shipping
        // path produced a single 1920x1080 JPEG of 83,701 bytes (quality 85).
        // That is one frame, independently coded, with nothing shared with the
        // frame before or after it.
        const SHIPPING_JPEG_BYTES: f64 = 83_701.0;
        println!(
            "
shipping JPEG path, measured: {:.0} B for one 1920x1080 frame
             at 12 fps that is {:.1} Mbps for a desktop that is barely moving,
             and every frame pays full price because nothing is shared between them.",
            SHIPPING_JPEG_BYTES,
            SHIPPING_JPEG_BYTES * 8.0 * 12.0 / 1_000_000.0
        );
    }

    #[cfg(not(windows))]
    println!("(H.264 encoding is Windows-only in this crate; colour conversion measured above)");
}
