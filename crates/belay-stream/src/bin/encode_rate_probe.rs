//! Isolate hardware rate control from network pacing using coherent motion.
#[cfg(windows)]
#[path = "../synthetic.rs"]
mod synthetic;

#[cfg(not(windows))]
fn main() { eprintln!("Windows only"); }

#[cfg(windows)]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    use std::time::{Duration, Instant};
    use belay_encode::gpu::VideoConverter;
    use belay_encode::h264::{init_media_foundation, EncoderConfig, H264Encoder};
    let args: Vec<_> = std::env::args().collect();
    let count: u64 = args.iter().find_map(|a| a.strip_prefix("--frames=")).unwrap_or("180").parse()?;
    if !(60..=3600).contains(&count) { return Err("frames must be 60..3600".into()); }
    let initial: Option<u32> = args.iter().find_map(|a| a.strip_prefix("--initial-rate=")).map(str::parse).transpose()?;
    let initial_bps = initial.unwrap_or(20_000_000);
    if !(300_000..=50_000_000).contains(&initial_bps) { return Err("initial rate must be 300000..50000000".into()); }
    init_media_foundation()?;
    let mut source = synthetic::SyntheticSource::new(1920, 1080)?.with_motion();
    let mut converter = VideoConverter::new(source.device(), 1920, 1080)?;
    let mut encoder = H264Encoder::new(EncoderConfig {
        width: 1920, height: 1080, fps: 60, bitrate_bps: initial_bps,
        keyframe_interval_s: 4,
    })?;
    if !encoder.attach_d3d_device(source.device())? { return Err("GPU input unavailable".into()); }
    eprintln!("encoder backend: {}", encoder.backend_name());
    if let Some(value) = args.iter().find_map(|a| a.strip_prefix("--buffer=")) {
        encoder.set_rate_control_buffer(value.parse()?)?;
    }
    let budgets = if initial.is_some() { vec![initial_bps] } else { vec![20_000_000, 8_000_000] };
    for budget in budgets {
        encoder.set_bitrate(budget)?;
        eprintln!("codec rate control readback: {:?}", encoder.rate_control_state());
        eprintln!("codec rate control limits: {:?}", encoder.rate_control_limits());
        let mut frames = 0;
        let mut bytes = 0;
        let mut largest = 0;
        let mut latency = Vec::new();
        let started = Instant::now();
        for tick in 0..count {
            let (_, texture) = source.next_frame()?;
            converter.convert(&texture.ok_or("missing texture")?)?;
            let mut ready = encoder.encode_texture(converter.output_texture())?;
            let deadline = started + Duration::from_secs_f64((tick + 1) as f64 / 60.0);
            loop {
                ready.extend(encoder.poll_output()?);
                for frame in ready.drain(..) {
                    frames += 1;
                    bytes += frame.data.len();
                    largest = largest.max(frame.data.len());
                    if let Some(us) = frame.output_latency_us { latency.push(us); }
                }
                if Instant::now() >= deadline { break; }
                std::thread::sleep(Duration::from_millis(1));
            }
        }
        // Drain each submitted phase before changing rate; no encoder flush.
        let drain = Instant::now();
        while frames < count && drain.elapsed() < Duration::from_secs(2) {
            for frame in encoder.poll_output()? {
                frames += 1;
                bytes += frame.data.len();
                largest = largest.max(frame.data.len());
                if let Some(us) = frame.output_latency_us { latency.push(us); }
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        latency.sort_unstable();
        println!("{{\"targetBps\":{budget},\"frames\":{frames},\"bytes\":{bytes},\"largestFrame\":{largest},\"pictureBpsAt60\":{},\"elapsedSeconds\":{:.3},\"outputP95Us\":{}}}",
            bytes as u64 * 8 * 60 / frames.max(1), started.elapsed().as_secs_f64(),
            latency.get((latency.len()*95).div_ceil(100).saturating_sub(1)).copied().unwrap_or(0));
        if frames != count { return Err(format!("Only {frames}/{count} frames drained").into()); }
    }
    Ok(())
}
