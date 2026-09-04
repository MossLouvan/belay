//! The streaming loop itself.
//!
//! One thread, running flat out, doing the same four things per frame. The
//! ordering is not arbitrary:
//!
//!   1. **Poll the session first.** Bitrate decisions and keyframe requests
//!      from the client should apply to the frame we are about to encode, not
//!      the one after it. Polling last means every reaction is a frame late.
//!   2. **Cursor before video.** The cursor is 16 bytes and its entire value is
//!      being current; video is hundreds of datagrams. Sending video first puts
//!      the cursor behind a frame's worth of pacing delay, which is exactly the
//!      lag that makes remote control feel remote.
//!   3. Capture, convert, encode, send.
//!
//! An idle desktop does none of steps 2-3 and costs nothing, which is the whole
//! reason Desktop Duplication is worth its complexity.

#![cfg(windows)]

use std::time::{Duration, Instant};

use belay_encode::capture::DesktopCapture;
use belay_encode::color::{bgra_to_nv12, nv12_len};
use belay_encode::gpu::VideoConverter;
use belay_encode::h264::{init_media_foundation, EncoderConfig, H264Encoder};
use belay_net::{Event, Session};
use belay_wire::crypto::Direction;
use belay_wire::cursor::{CursorSample, CursorSampler};
use belay_wire::packet::Channel;

use crate::config::{Config, Source};
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

pub fn run(
    config: Config,
    emit: fn(&str, &str),
    escape: fn(&str) -> String,
) -> Result<(), String> {
    // The two sources are kept behind one shape rather than two loops: every
    // step after "get a texture" is identical, and duplicating the loop is how
    // the test path and the real path quietly drift apart.
    let mut capture = match config.source {
        Source::Desktop => Some(
            DesktopCapture::new(0, config.monitor)
                .map_err(|e| format!("cannot duplicate display {}: {e}", config.monitor))?,
        ),
        Source::Synthetic => None,
    };
    let mut synthetic = match config.source {
        Source::Synthetic => Some(SyntheticSource::new(1920, 1080)?),
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

    let mut sampler = CursorSampler::new(CURSOR_MAX_HZ);
    let started = Instant::now();
    let frame_budget = Duration::from_micros(1_000_000 / config.fps.max(1) as u64);
    let mut last_stats = Instant::now();
    let (mut frames, mut sent_bytes) = (0u64, 0u64);
    // Counted separately because they mean different things and only one of
    // them is a problem: `no_change` is an idle desktop working as designed,
    // `cursor_only` is the cursor moving over a still screen. A stream that is
    // producing nothing looks identical to one that is broken unless these are
    // reported, which is what hid the first end-to-end failure.
    let (mut no_change, mut cursor_only) = (0u64, 0u64);

    loop {
        let loop_start = Instant::now();
        let now_us = started.elapsed().as_micros() as u32;

        // Stats first, and unconditionally. Reporting them only on the path
        // that encodes a frame means a stream producing no frames reports
        // nothing at all — silence that reads as a crash.
        if last_stats.elapsed() >= Duration::from_secs(1) {
            let secs = last_stats.elapsed().as_secs_f64();
            emit(
                "stats",
                &format!(
                    "\"fps\":{:.1},\"kbps\":{:.0},\"bitrate\":{},\"noChange\":{no_change},\"cursorOnly\":{cursor_only}",
                    frames as f64 / secs,
                    (sent_bytes as f64 * 8.0 / 1000.0) / secs,
                    session.bitrate_bps()
                ),
            );
            frames = 0;
            sent_bytes = 0;
            no_change = 0;
            cursor_only = 0;
            last_stats = Instant::now();
        }

        // 1. Session first, so the client's feedback applies to THIS frame.
        match session.poll() {
            Ok(events) => {
                for event in events {
                    match event {
                        Event::Bitrate { bps } => {
                            // One setpoint reaching both the transport and the
                            // encoder. Letting them disagree is how a link
                            // that has backed off keeps being handed frames it
                            // cannot carry.
                            let _ = encoder.set_bitrate(bps as u32);
                            emit("bitrate", &format!("\"bps\":{bps}"));
                        }
                        Event::KeyframeNeeded => {
                            encoder.request_keyframe();
                        }
                        // The host does not consume media from the client on
                        // this session; input arrives over the existing
                        // authenticated WebSocket.
                        Event::Frame { .. } => {}
                    }
                }
            }
            Err(e) => return Err(format!("session failed: {e:?}")),
        }

        // 2. Capture. Ok(None) is a static desktop, which is the common case
        //    and costs nothing.
        let grabbed = match (capture.as_mut(), synthetic.as_mut()) {
            (Some(c), _) => c
                .next_frame_gpu(CAPTURE_TIMEOUT_MS)
                .map_err(|e| format!("capture failed: {e}"))?,
            (_, Some(s)) => Some(s.next_frame().map_err(|e| format!("synthetic source failed: {e}"))?),
            _ => unreachable!("one source is always constructed"),
        };

        let Some((meta, texture)) = grabbed else {
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
            if let Err(e) = session.send_frame(Channel::Cursor, &buf, false) {
                return Err(format!("cursor send failed: {e:?}"));
            }
        }

        // 4. Video, when there are pixels. `idle` means only the cursor moved,
        //    and re-encoding an unchanged desktop is the waste this whole path
        //    exists to remove.
        let Some(texture) = texture else {
            cursor_only += 1;
            continue;
        };
        if meta.idle {
            cursor_only += 1;
            continue;
        }

        let coded = if let Some(conv) = converter.as_mut() {
            conv.convert(&texture).map_err(|e| format!("gpu convert failed: {e}"))?;
            encoder
                .encode_texture(conv.output_texture())
                .map_err(|e| format!("encode failed: {e}"))?
        } else {
            // CPU fallback: the texture must come down to us first.
            let Some(cap) = capture.as_mut() else {
                return Err("the CPU fallback needs a real capture device".into());
            };
            let stride = cap
                .copy_texture_to_cpu(&texture, &mut bgra)
                .map_err(|e| format!("readback failed: {e}"))?;
            bgra_to_nv12(&bgra, stride, width as usize, height as usize, &mut nv12)
                .map_err(|e| format!("colour conversion failed: {e:?}"))?;
            encoder.encode(&nv12).map_err(|e| format!("encode failed: {e}"))?
        };

        for frame in coded {
            let bytes = frame.data.len();
            session
                .send_frame(Channel::Video, &frame.data, frame.keyframe)
                .map_err(|e| format!("video send failed: {e:?}"))?;
            frames += 1;
            sent_bytes += bytes as u64;
        }

        let _ = escape; // reserved for error paths that carry free text

        // Pace the capture loop. Without this a fast machine captures and
        // encodes far past the requested rate and spends the bitrate on frames
        // the client will never display.
        let elapsed = loop_start.elapsed();
        if elapsed < frame_budget {
            std::thread::sleep(frame_budget - elapsed);
        }
    }
}
