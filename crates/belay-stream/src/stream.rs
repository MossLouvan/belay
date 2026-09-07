//! The streaming loop itself.
//!
//! Capture and encoding overlap a dedicated session/pacing worker. Two credits
//! bound encoder submissions plus active/pending sends; a full pipeline skips
//! capture before encoding, preserving every submitted H.264 dependency.
//!
//! An idle desktop does none of steps 2-3 and costs nothing, which is the whole
//! reason Desktop Duplication is worth its complexity.

#![cfg(windows)]

use std::time::{Duration, Instant};

use belay_encode::capture::DesktopCapture;
use belay_encode::color::{bgra_to_nv12, nv12_len};
use belay_encode::gpu::VideoConverter;
use belay_encode::h264::{init_media_foundation, CodedFrame, EncoderConfig, H264Encoder};
use belay_net::Session;
use belay_wire::crypto::Direction;
use belay_wire::cursor::{CursorSample, CursorSampler};

use crate::config::{Config, Source};
use crate::sender::Sender;
use crate::synthetic::SyntheticSource;

/// Cap on cursor sample rate. Past roughly the display refresh rate the extra
/// samples cannot be shown, so they would be bandwidth spent on nothing.
const CURSOR_MAX_HZ: u32 = 120;

/// How long to wait on Desktop Duplication before going round the loop again.
///
/// Short enough that session polling and cursor updates stay responsive on a
/// completely static desktop; long enough that an idle screen is not a spin
/// loop. At 8 ms an idle desktop wakes ~125 times a second to do nothing, which
/// is cheap, and a moving one never waits at all.
const CAPTURE_TIMEOUT_MS: u32 = 8;

fn submit_coded(sender: &Sender, coded: Vec<CodedFrame>) -> Result<(), String> {
    for frame in coded {
        sender.submit(frame)?;
    }
    Ok(())
}

pub fn run(config: Config, emit: fn(&str, &str), escape: fn(&str) -> String) -> Result<(), String> {
    // The two sources are kept behind one shape rather than two loops: every
    // step after "get a texture" is identical, and duplicating the loop is how
    // the test path and the real path quietly drift apart.
    let mut capture = match config.source {
        Source::Desktop => Some(
            // for_monitor, not new(0, n): the virtual display is an adapter of
            // its own, so an output index scoped to adapter 0 can never name it.
            DesktopCapture::for_monitor(config.monitor)
                .map_err(|e| format!("cannot duplicate display {}: {e}", config.monitor))?,
        ),
        Source::Synthetic | Source::SyntheticMotion => None,
    };
    let mut synthetic = match config.source {
        Source::Synthetic => Some(SyntheticSource::new(1920, 1080)?),
        Source::SyntheticMotion => Some(SyntheticSource::new(1920, 1080)?.with_motion()),
        Source::Desktop => None,
    };
    let (width, height) = match (&capture, &synthetic) {
        (Some(c), _) => (c.width() as u32, c.height() as u32),
        (_, Some(s)) => (s.width(), s.height()),
        _ => unreachable!("one source is always constructed"),
    };
    let device = match (&capture, &synthetic) {
        (Some(c), _) => c.device().clone(),
        (_, Some(s)) => s.device().clone(),
        _ => unreachable!("one source is always constructed"),
    };

    let mut session = Session::bind(
        config.bind,
        config.peer,
        &config.token,
        config.salt,
        Direction::HostToClient,
        config.preset,
    )
    .map_err(|e| format!("cannot bind the session: {e:?}"))?;
    session.set_fec_allowed(config.fec);
    session.set_video_fps(config.fps);
    let local = session
        .local_addr()
        .map_err(|e| format!("cannot read the local address: {e}"))?;

    init_media_foundation().map_err(|e| format!("Media Foundation would not start: {e}"))?;
    let mut encoder = H264Encoder::new(EncoderConfig {
        width,
        height,
        fps: config.fps,
        bitrate_bps: session.bitrate_bps() as u32,
        keyframe_interval_s: config.keyframe_interval_s,
    })
    .map_err(|e| format!("no usable H.264 encoder: {e}"))?;

    // The GPU path, when the machine has one. Both halves must succeed
    // together: converting on the GPU only to read the result back would cost
    // more than converting on the CPU in the first place.
    let converter = VideoConverter::new(&device, width, height).ok();
    let zero_copy = match converter {
        Some(_) => encoder.attach_d3d_device(&device).unwrap_or(false),
        None => false,
    };
    let mut converter = if zero_copy { converter } else { None };

    // CPU fallback buffers, allocated only if they will be used.
    let mut bgra = Vec::new();
    let mut nv12 = Vec::new();
    if converter.is_none() {
        nv12 = vec![0u8; nv12_len(width as usize, height as usize)];
    }

    emit(
        "ready",
        &format!(
            "\"port\":{},\"width\":{width},\"height\":{height},\"path\":\"{}\",\"bitrate\":{}",
            local.port(),
            if converter.is_some() { "gpu" } else { "cpu" },
            session.bitrate_bps()
        ),
    );

    let sender = Sender::start(session)?;
    let mut sampler = CursorSampler::new(CURSOR_MAX_HZ);
    let started = Instant::now();
    let frame_budget = Duration::from_micros(1_000_000 / config.fps.max(1) as u64);
    let mut last_stats = Instant::now();
    let mut last_keyframe = Instant::now();
    let (mut capture_us, mut encode_us, mut samples) = (0u128, 0u128, 0u64);
    let mut skipped = 0u64;
    let mut next_capture = Instant::now();
    // Counted separately because they mean different things and only one of
    // them is a problem: `no_change` is an idle desktop working as designed,
    // `cursor_only` is the cursor moving over a still screen. A stream that is
    // producing nothing looks identical to one that is broken unless these are
    // reported, which is what hid the first end-to-end failure.
    let (mut no_change, mut cursor_only) = (0u64, 0u64);

    loop {
        let now_us = started.elapsed().as_micros() as u32;

        // Stats first, and unconditionally. Reporting them only on the path
        // that encodes a frame means a stream producing no frames reports
        // nothing at all — silence that reads as a crash.
        if last_stats.elapsed() >= Duration::from_secs(1) {
            let secs = last_stats.elapsed().as_secs_f64();
            let mut sent = sender.take_stats()?;
            sent.output_latencies.sort_unstable();
            let output_p95_ms = sent
                .output_latencies
                .get(
                    (sent.output_latencies.len() * 95)
                        .div_ceil(100)
                        .saturating_sub(1),
                )
                .copied()
                .unwrap_or(0) as f64
                / 1000.0;
            emit(
                "stats",
                &format!(
                    "\"fps\":{:.1},\"kbps\":{:.0},\"bitrate\":{},\"noChange\":{no_change},\"cursorOnly\":{cursor_only},\"captureMs\":{:.3},\"convertEncodeMs\":{:.3},\"sendMs\":{:.3},\"rttMs\":{:.3},\"encoderOutputP95Ms\":{output_p95_ms:.3},\"encoderTimingSamples\":{},\"fec\":{},\"mediaBitrate\":{},\"sendQueueMs\":{:.3},\"captureSkipped\":{skipped}",
                    sent.frames as f64 / secs,
                    (sent.bytes as f64 * 8.0 / 1000.0) / secs,
                    sent.status.bitrate,
                    capture_us as f64 / samples.max(1) as f64 / 1000.0,
                    encode_us as f64 / samples.max(1) as f64 / 1000.0,
                    sent.send_us as f64 / sent.frames.max(1) as f64 / 1000.0,
                    sent.status.rtt_ms,
                    sent.output_latencies.len(),
                    sent.status.fec,
                    sent.status.media_bitrate,
                    sent.queue_us as f64 / sent.frames.max(1) as f64 / 1000.0
                ),
            );
            no_change = 0;
            cursor_only = 0;
            last_stats = Instant::now();
            capture_us = 0;
            encode_us = 0;
            samples = 0;
            skipped = 0;
        }

        // Apply the latest coalesced setpoint before the next submission.
        let feedback = sender.take_feedback()?;
        if let Some(bps) = feedback.bitrate {
            match encoder.set_bitrate(bps as u32) {
                Ok(()) => emit("bitrate", &format!("\"bps\":{bps},\"applied\":true")),
                Err(error) => {
                    eprintln!("encoder rejected bitrate {bps}: {error}");
                    emit("bitrate", &format!("\"bps\":{bps},\"applied\":false"));
                }
            }
        }
        if feedback.keyframe {
            encoder.request_keyframe();
        }

        let ready = encoder
            .poll_output()
            .map_err(|e| format!("encode failed: {e}"))?;
        submit_coded(&sender, ready)?;

        let now = Instant::now();
        if now < next_capture {
            std::thread::sleep((next_capture - now).min(Duration::from_millis(1)));
            continue;
        }
        // Keep a fixed cadence, skipping missed slots instead of attempting
        // catch-up captures or resetting the deadline after every network wait.
        while next_capture <= now {
            next_capture += frame_budget;
        }
        if !sender.try_reserve()? {
            skipped += 1;
            continue;
        }

        // 2. Capture. Ok(None) is a static desktop, which is the common case
        //    and costs nothing.
        let capture_started = Instant::now();
        let grabbed = match (capture.as_mut(), synthetic.as_mut()) {
            (Some(c), _) => c
                .next_frame_gpu(CAPTURE_TIMEOUT_MS)
                .map_err(|e| format!("capture failed: {e}"))?,
            (_, Some(s)) => Some(
                s.next_frame()
                    .map_err(|e| format!("synthetic source failed: {e}"))?,
            ),
            _ => unreachable!("one source is always constructed"),
        };

        let Some((meta, texture)) = grabbed else {
            sender.cancel_reservation();
            no_change += 1;
            continue;
        };

        // 3. Cursor before video: 16 bytes whose whole value is being current,
        //    ahead of a frame's worth of pacing delay.
        let sample = CursorSample {
            x: meta.cursor.x.clamp(i16::MIN as i32, i16::MAX as i32) as i16,
            y: meta.cursor.y.clamp(i16::MIN as i32, i16::MAX as i32) as i16,
            shape_id: meta.cursor.shape_id as u16,
            hot_x: 0,
            hot_y: 0,
            visible: meta.cursor.visible,
            send_us: now_us,
        };
        if sampler.should_send(sample, now_us) {
            let mut buf = [0u8; CursorSample::WIRE_LEN];
            sample.encode(&mut buf);
            sender.cursor(buf);
        }

        // 4. Video, when there are pixels. `idle` means only the cursor moved,
        //    and re-encoding an unchanged desktop is the waste this whole path
        //    exists to remove.
        let Some(texture) = texture else {
            sender.cancel_reservation();
            cursor_only += 1;
            continue;
        };
        if meta.idle {
            sender.cancel_reservation();
            cursor_only += 1;
            continue;
        }

        // Some hardware drivers ignore the GOP hint. Bound recovery time even
        // with older clients that cannot request an IDR after dropped input.
        if last_keyframe.elapsed() >= Duration::from_secs(config.keyframe_interval_s as u64) {
            encoder.request_keyframe();
            last_keyframe = Instant::now();
        }
        capture_us += capture_started.elapsed().as_micros();
        samples += 1;
        let encode_started = Instant::now();
        let coded = if let Some(conv) = converter.as_mut() {
            conv.convert(&texture)
                .map_err(|e| format!("gpu convert failed: {e}"))?;
            encoder
                .encode_texture(conv.output_texture())
                .map_err(|e| format!("encode failed: {e}"))?
        } else {
            // CPU fallback: the pixels must be on the CPU to convert them.
            //
            // The synthetic source already holds them — it wrote that texture
            // from CPU memory a moment ago — so reading it back would be a
            // round trip to the GPU to fetch something we still have.
            let stride = if let Some(synth) = synthetic.as_ref() {
                let (pixels, stride) = synth.cpu_bgra();
                if bgra.len() != pixels.len() {
                    bgra.resize(pixels.len(), 0);
                }
                bgra.copy_from_slice(pixels);
                stride
            } else {
                let Some(cap) = capture.as_mut() else {
                    return Err("the CPU fallback has no source of pixels".into());
                };
                cap.copy_texture_to_cpu(&texture, &mut bgra)
                    .map_err(|e| format!("readback failed: {e}"))?
            };
            bgra_to_nv12(&bgra, stride, width as usize, height as usize, &mut nv12)
                .map_err(|e| format!("colour conversion failed: {e:?}"))?;
            encoder
                .encode(&nv12)
                .map_err(|e| format!("encode failed: {e}"))?
        };

        encode_us += encode_started.elapsed().as_micros();
        submit_coded(&sender, coded)?;

        let _ = escape; // reserved for error paths that carry free text
    }
}
