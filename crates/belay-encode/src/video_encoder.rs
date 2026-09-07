//! Shared encoder surface for measured, explicitly selected backends.
use std::collections::VecDeque;
use std::time::Instant;
use windows::Win32::Graphics::Direct3D11::{ID3D11Device, ID3D11Texture2D};
use crate::h264::{CodedFrame, EncoderConfig, H264Encoder};

pub enum VideoEncoder {
    MediaFoundation(H264Encoder),
    Nvidia {
        encoder: belay_nvenc::Encoder,
        fps: u32,
        tick: i64,
        force_idr: bool,
        submitted: VecDeque<(i64, Instant)>,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use windows::Win32::Graphics::Direct3D::*;
    use windows::Win32::Graphics::Direct3D11::*;
    use windows::Win32::Graphics::Dxgi::Common::*;

    #[test]
    #[ignore = "requires an NVIDIA GPU and driver supporting NVENC API 13.0"]
    fn nvenc_lifecycle_preserves_timestamps_and_forced_idr() {
        unsafe {
            let mut device = None;
            D3D11CreateDevice(None, D3D_DRIVER_TYPE_HARDWARE, None,
                D3D11_CREATE_DEVICE_BGRA_SUPPORT, None, D3D11_SDK_VERSION,
                Some(&mut device), None, None).unwrap();
            let device = device.unwrap();
            let pixels = vec![128u8; 256 * 256 * 3 / 2];
            let desc = D3D11_TEXTURE2D_DESC { Width:256, Height:256, MipLevels:1,
                ArraySize:1, Format:DXGI_FORMAT_NV12,
                SampleDesc:DXGI_SAMPLE_DESC { Count:1, Quality:0 },
                Usage:D3D11_USAGE_DEFAULT, ..Default::default() };
            let initial = D3D11_SUBRESOURCE_DATA { pSysMem:pixels.as_ptr().cast(),
                SysMemPitch:256, SysMemSlicePitch:0 };
            let mut texture = None;
            device.CreateTexture2D(&desc, Some(&initial), Some(&mut texture)).unwrap();
            let texture = texture.unwrap();
            // Repeated creation exercises resource registration and teardown.
            for _ in 0..3 {
                let mut encoder = VideoEncoder::new(EncoderConfig { width:256,
                    height:256, fps:60, bitrate_bps:2_000_000,
                    keyframe_interval_s:4 }, &device, "nvenc").unwrap();
                for index in 0..4 {
                    if index == 2 {
                        encoder.set_bitrate(800_000).unwrap();
                        encoder.request_keyframe();
                    }
                    let started = Instant::now();
                    let mut output = encoder.encode_texture(&texture).unwrap();
                    while output.is_empty() && started.elapsed() < Duration::from_secs(2) {
                        output.extend(encoder.poll_output().unwrap());
                        std::thread::sleep(Duration::from_millis(1));
                    }
                    assert_eq!(output.len(), 1, "output must not need another input");
                    assert_eq!(output[0].timestamp_hns, index * (10_000_000 / 60));
                    assert!(output[0].output_latency_us.is_some());
                    assert!(!output[0].data.is_empty());
                    assert_eq!(output[0].keyframe, index == 0 || index == 2);
                }
            }
            let mut encoder = belay_nvenc::Encoder::new(&device,256,256,60,2_000_000,240).unwrap();
            assert!(encoder.submit(&texture, 0, true).unwrap());
            assert!(encoder.submit(&texture, 166_666, false).unwrap());
            assert!(!encoder.submit(&texture, 333_332, false).unwrap(),
                "third input must be refused until an output is collected");
            // Drop with in-flight work, then prove a fresh session can encode.
            drop(encoder);
            let mut encoder = belay_nvenc::Encoder::new(&device,256,256,60,2_000_000,240).unwrap();
            assert!(encoder.submit(&texture, 42, true).unwrap());
            let started = Instant::now();
            let output = loop {
                if let Some(output) = encoder.poll().unwrap() { break output; }
                assert!(started.elapsed() < Duration::from_secs(2));
                std::thread::sleep(Duration::from_millis(1));
            };
            assert_eq!(output.timestamp, 42);
            assert!(output.keyframe);
        }
    }
}

impl VideoEncoder {
    pub fn new(config: EncoderConfig, device: &ID3D11Device, backend: &str) -> Result<Self, String> {
        if backend == "nvenc" {
            let encoder = belay_nvenc::Encoder::new(device, config.width, config.height,
                config.fps, config.bitrate_bps, config.fps.saturating_mul(config.keyframe_interval_s).max(1))?;
            return Ok(Self::Nvidia { encoder, fps: config.fps, tick: 0, force_idr: false,
                submitted: VecDeque::new() });
        }
        let mut encoder = H264Encoder::new(config).map_err(|e| e.to_string())?;
        // A declined GPU manager retains the existing CPU-input fallback.
        let _ = encoder.attach_d3d_device(device);
        Ok(Self::MediaFoundation(encoder))
    }

    pub fn backend_name(&self) -> &str {
        match self { Self::MediaFoundation(e) => e.backend_name(), Self::Nvidia { .. } => "NVIDIA NVENC (direct)" }
    }
    pub fn accepts_textures(&self) -> bool {
        match self { Self::MediaFoundation(e) => e.accepts_textures(), Self::Nvidia { .. } => true }
    }
    pub fn request_keyframe(&mut self) {
        match self { Self::MediaFoundation(e) => e.request_keyframe(), Self::Nvidia { force_idr, .. } => *force_idr = true }
    }
    pub fn set_bitrate(&mut self, bps: u32) -> Result<(), String> {
        match self {
            Self::MediaFoundation(e) => e.set_bitrate(bps).map_err(|e| e.to_string()),
            Self::Nvidia { encoder, .. } => encoder.set_bitrate(bps),
        }
    }
    pub fn poll_output(&mut self) -> Result<Vec<CodedFrame>, String> {
        match self {
            Self::MediaFoundation(e) => e.poll_output().map_err(|e| e.to_string()),
            Self::Nvidia { encoder, submitted, .. } => {
                let mut frames = Vec::new();
                while let Some(frame) = encoder.poll()? {
                    let output_latency_us = submitted.iter().position(|(stamp, _)| *stamp == frame.timestamp)
                        .and_then(|index| submitted.remove(index))
                        .map(|(_, when)| when.elapsed().as_micros().min(u64::MAX as u128) as u64);
                    frames.push(CodedFrame { data: frame.data, keyframe: frame.keyframe,
                        timestamp_hns: frame.timestamp, output_latency_us });
                }
                Ok(frames)
            }
        }
    }
    pub fn encode_texture(&mut self, texture: &ID3D11Texture2D) -> Result<Vec<CodedFrame>, String> {
        if let Self::MediaFoundation(e) = self { return e.encode_texture(texture).map_err(|e| e.to_string()); }
        let mut ready = self.poll_output()?;
        if let Self::Nvidia { encoder, fps, tick, force_idr, submitted } = self {
            if submitted.len() >= 2 { return Err("NVENC input exceeds two-frame pipeline".into()); }
            let stamp = *tick * (10_000_000 / (*fps).max(1) as i64);
            let when = Instant::now();
            if !encoder.submit(texture, stamp, *force_idr)? { return Err("NVENC input is busy".into()); }
            submitted.push_back((stamp, when));
            *tick += 1;
            *force_idr = false;
        }
        ready.extend(self.poll_output()?);
        Ok(ready)
    }
    pub fn encode(&mut self, bytes: &[u8]) -> Result<Vec<CodedFrame>, String> {
        match self {
            Self::MediaFoundation(e) => e.encode(bytes).map_err(|e| e.to_string()),
            Self::Nvidia { .. } => Err("direct NVENC requires GPU conversion".into()),
        }
    }
}
