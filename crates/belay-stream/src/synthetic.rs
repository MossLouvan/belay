//! A generated frame source, for proving the pipeline without a live desktop.
//!
//! Desktop Duplication legitimately reports nothing when nothing changes, so an
//! idle or sleeping display yields only timeouts. That is correct behaviour and
//! it makes everything downstream — encode, pacing, congestion control, the
//! wire format, the client — untestable at exactly the hours automated runs
//! happen. This source removes that dependency.
//!
//! It produces desktop-SHAPED content on purpose: a static majority with one
//! moving region. A source that changed every pixel every frame would make the
//! encoder look far worse than it is and would exercise none of the
//! inter-frame coding that is the entire reason for leaving JPEG behind.

#![cfg(windows)]

use belay_encode::capture::{CursorInfo, FrameMeta};
use windows::core::Interface;
use windows::Win32::Graphics::Direct3D::*;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::*;

pub struct SyntheticSource {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    texture: ID3D11Texture2D,
    bgra: Vec<u8>,
    width: u32,
    height: u32,
    tick: usize,
}

impl SyntheticSource {
    pub fn new(width: u32, height: u32) -> Result<SyntheticSource, String> {
        unsafe {
            let mut device: Option<ID3D11Device> = None;
            let mut created = D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                None,
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                None,
            );
            if created.is_err() {
                // WARP: a software rasteriser. A machine with no GPU still
                // needs a device to hold the source texture, and this source
                // exists precisely to run where there is no GPU.
                created = D3D11CreateDevice(
                    None,
                    D3D_DRIVER_TYPE_WARP,
                    None,
                    D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                    None,
                    D3D11_SDK_VERSION,
                    Some(&mut device),
                    None,
                    None,
                );
            }
            created.map_err(|e| format!("no D3D11 device: {e}"))?;
            let device = device.ok_or("no D3D11 device")?;
            let context = device.GetImmediateContext().map_err(|e| format!("no context: {e}"))?;

            // Multithread protection for the same reason the converter needs
            // it: Media Foundation will drive this device from its own threads.
            if let Ok(mt) = device.cast::<ID3D11Multithread>() {
                let _ = mt.SetMultithreadProtected(true);
            }

            // DEFAULT usage and NO bind flags, matching what Desktop
            // Duplication produces — including the constraint that at least one
            // driver refuses SHADER_RESOURCE alone as a video processor input.
            let desc = D3D11_TEXTURE2D_DESC {
                Width: width,
                Height: height,
                MipLevels: 1,
                ArraySize: 1,
                Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                Usage: D3D11_USAGE_DEFAULT,
                BindFlags: 0,
                CPUAccessFlags: 0,
                MiscFlags: 0,
            };
            let mut texture: Option<ID3D11Texture2D> = None;
            device
                .CreateTexture2D(&desc, None, Some(&mut texture))
                .map_err(|e| format!("cannot create the source texture: {e}"))?;
            let texture = texture.ok_or("no source texture")?;

            Ok(SyntheticSource {
                device,
                context,
                texture,
                bgra: vec![0u8; (width * height * 4) as usize],
                width,
                height,
                tick: 0,
            })
        }
    }

    pub fn device(&self) -> &ID3D11Device {
        &self.device
    }

    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }

    /// The frame's pixels, already in CPU memory, with their row stride.
    ///
    /// The CPU fallback needs BGRA on the CPU. Reading it back from the texture
    /// would be absurd here — this source WROTE those pixels from CPU memory a
    /// moment ago, so the readback would be a round trip to the GPU purely to
    /// fetch something we still hold.
    pub fn cpu_bgra(&self) -> (&[u8], usize) {
        (&self.bgra, self.width as usize * 4)
    }

    /// Produce the next frame. Always returns one — that is the point.
    pub fn next_frame(&mut self) -> Result<(FrameMeta, Option<ID3D11Texture2D>), String> {
        let (w, h) = (self.width as usize, self.height as usize);
        let stride = w * 4;
        let t = self.tick;
        self.tick = self.tick.wrapping_add(1);

        // Static background with one moving block. Only the rows the block
        // touches are rewritten each frame — the rest is left alone, which is
        // both faster and a truer imitation of a desktop.
        if t == 0 {
            for y in 0..h {
                for x in 0..w {
                    let o = y * stride + x * 4;
                    self.bgra[o] = (x / 8) as u8;
                    self.bgra[o + 1] = (y / 8) as u8;
                    self.bgra[o + 2] = 40;
                    self.bgra[o + 3] = 255;
                }
            }
        } else {
            for y in 300..700.min(h) {
                for x in 0..w {
                    let o = y * stride + x * 4;
                    self.bgra[o] = (x / 8) as u8;
                    self.bgra[o + 1] = (y / 8) as u8;
                    self.bgra[o + 2] = 40;
                    self.bgra[o + 3] = 255;
                }
            }
        }
        let bx = 200 + (t * 9) % 900;
        for y in 300..700.min(h) {
            for x in bx..(bx + 420).min(w) {
                let o = y * stride + x * 4;
                self.bgra[o] = 200;
                self.bgra[o + 1] = 90;
                self.bgra[o + 2] = 40;
                self.bgra[o + 3] = 255;
            }
        }

        unsafe {
            self.context.UpdateSubresource(
                &self.texture,
                0,
                None,
                self.bgra.as_ptr() as *const _,
                stride as u32,
                0,
            );
        }

        // A cursor that moves, so the cursor channel is exercised too — it has
        // its own priority rules and its own failure modes, and a test that
        // only moves pixels would never touch them.
        let cursor = CursorInfo {
            x: (bx + 210) as i32,
            y: 500,
            visible: true,
            shape_id: 1,
        };

        Ok((
            FrameMeta {
                dirty: Vec::new(),
                cursor,
                idle: false,
                stride,
                width: w,
                height: h,
                copy_ms: 0.0,
            },
            Some(self.texture.clone()),
        ))
    }
}
