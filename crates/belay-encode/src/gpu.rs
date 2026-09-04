//! Keeping the frame on the GPU.
//!
//! The CPU path costs, per frame: a `CopyResource` into a staging texture, a
//! `Map` that stalls until the GPU is done, a ~8 MB memcpy out of
//! write-combined memory, and then a BGRA->NV12 conversion. The conversion
//! alone is ~4.7 ms single-threaded, and getting it under 1 ms means burning
//! every core on the machine — cores the encoder and the rest of the app also
//! want. Even at 1 ms it is comparable to the encode itself, which is the wrong
//! shape: the *preparation* should be a rounding error next to the work.
//!
//! Desktop Duplication already hands us a GPU texture, and the hardware H.264
//! encoder wants a GPU texture. The CPU is a detour between two things that
//! were already in the right place. This module removes it: the D3D11 video
//! processor converts BGRA->NV12 entirely in VRAM.
//!
//! This requires real hardware. On a VM with no GPU there is no video processor,
//! so `VideoConverter::new` fails and the caller falls back to the CPU path —
//! which is why that path is kept rather than deleted.

use windows::core::{Interface, Result as WinResult};
use windows::Win32::Foundation::E_FAIL;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::*;

/// BGRA -> NV12 in VRAM, via the fixed-function video processor.
///
/// The video processor is used rather than a compute shader deliberately: it is
/// dedicated silicon for exactly this conversion, it does not compete with the
/// shader cores the encoder may be using, and it gets the colour space
/// conversion right without us hand-rolling BT.601/709 coefficients.
pub struct VideoConverter {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    video_device: ID3D11VideoDevice,
    video_context: ID3D11VideoContext,
    processor: ID3D11VideoProcessor,
    enumerator: ID3D11VideoProcessorEnumerator,
    /// The NV12 target, reused every frame. Allocating one per frame would
    /// reintroduce the cost this module exists to remove.
    output: ID3D11Texture2D,
    output_view: ID3D11VideoProcessorOutputView,
    /// Staging texture for `read_back`, also reused — same reason.
    staging: Option<ID3D11Texture2D>,
    width: u32,
    height: u32,
}

impl VideoConverter {
    pub fn new(device: &ID3D11Device, width: u32, height: u32) -> WinResult<VideoConverter> {
        unsafe {
            let context = device.GetImmediateContext()?;

            // Media Foundation drives the same device from its own threads.
            // Without this the two race and the driver faults — intermittently,
            // under load, which is the worst way to find out.
            if let Ok(mt) = device.cast::<ID3D11Multithread>() {
                let _ = mt.SetMultithreadProtected(true);
            }

            let video_device: ID3D11VideoDevice = device.cast()?;
            let video_context: ID3D11VideoContext = context.cast()?;

            let desc = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
                InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
                InputWidth: width,
                InputHeight: height,
                OutputWidth: width,
                OutputHeight: height,
                // Desktop content is latency-sensitive and is not film: ask the
                // driver for the fast path, not the quality path.
                Usage: D3D11_VIDEO_USAGE_PLAYBACK_NORMAL,
                ..Default::default()
            };
            let enumerator = video_device.CreateVideoProcessorEnumerator(&desc)?;
            let processor = video_device.CreateVideoProcessor(&enumerator, 0)?;

            // Desktop Duplication gives full-range RGB; H.264 wants studio-range
            // YUV. Saying so explicitly avoids the washed-out greys that come
            // from the driver guessing.
            let in_cs = D3D11_VIDEO_PROCESSOR_COLOR_SPACE {
                _bitfield: Self::color_space_bits(true),
            };
            let out_cs = D3D11_VIDEO_PROCESSOR_COLOR_SPACE {
                _bitfield: Self::color_space_bits(false),
            };
            video_context.VideoProcessorSetStreamColorSpace(&processor, 0, &in_cs);
            video_context.VideoProcessorSetOutputColorSpace(&processor, &out_cs);
            // No frame-rate conversion: one in, one out. Letting the driver
            // interpolate would add a frame of latency to save nothing.
            video_context.VideoProcessorSetStreamFrameFormat(
                &processor,
                0,
                D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
            );

            let mut out_desc = D3D11_TEXTURE2D_DESC {
                Width: width,
                Height: height,
                MipLevels: 1,
                ArraySize: 1,
                Format: DXGI_FORMAT_NV12,
                SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                Usage: D3D11_USAGE_DEFAULT,
                BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_VIDEO_ENCODER.0) as u32,
                CPUAccessFlags: 0,
                MiscFlags: 0,
            };
            let mut output: Option<ID3D11Texture2D> = None;
            if device.CreateTexture2D(&out_desc, None, Some(&mut output)).is_err() {
                // Some drivers refuse the encoder bind flag on a video processor
                // output. Render target alone still performs the conversion.
                out_desc.BindFlags = D3D11_BIND_RENDER_TARGET.0 as u32;
                device.CreateTexture2D(&out_desc, None, Some(&mut output))?;
            }
            let output =
                output.ok_or_else(|| windows::core::Error::new(E_FAIL, "no NV12 texture"))?;

            let ov_desc = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
                ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
                ..Default::default()
            };
            let mut output_view: Option<ID3D11VideoProcessorOutputView> = None;
            video_device.CreateVideoProcessorOutputView(
                &output,
                &enumerator,
                &ov_desc,
                Some(&mut output_view),
            )?;
            let output_view =
                output_view.ok_or_else(|| windows::core::Error::new(E_FAIL, "no output view"))?;

            Ok(VideoConverter {
                device: device.clone(),
                context,
                video_device,
                video_context,
                processor,
                enumerator,
                output,
                output_view,
                staging: None,
                width,
                height,
            })
        }
    }

    /// Pack the colour-space bitfield the way the D3D11 header lays it out.
    ///
    /// The `windows` crate exposes this struct as a raw `_bitfield` rather than
    /// named members, so the packing has to be written out. Bit 0 is `Usage`
    /// (0 = playback), bit 1 `RGB_Range` (0 = full), bit 2 `YCbCr_Matrix`
    /// (1 = BT.709), bit 3 `YCbCr_xvYCC`, bits 4-7 `Nominal_Range`.
    fn color_space_bits(full_range: bool) -> u32 {
        let mut bits = 1u32 << 2; // BT.709
        if !full_range {
            bits |= 1 << 1;
        }
        // Nominal_Range: 1 = 0-255, 2 = 16-235.
        bits |= if full_range { 1 << 4 } else { 2 << 4 };
        bits
    }

    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }

    /// The NV12 texture the last `convert` wrote into.
    ///
    /// Borrowed, not cloned: it is overwritten by the next conversion, and a
    /// caller holding it across frames would be reading a frame being rewritten
    /// underneath them.
    pub fn output_texture(&self) -> &ID3D11Texture2D {
        &self.output
    }

    /// Convert one BGRA texture into the NV12 output texture. No CPU access, no
    /// readback, no stall.
    ///
    /// `source` must be a `D3D11_USAGE_DEFAULT` texture — which is what Desktop
    /// Duplication hands out. Note that bind flags are not simply optional
    /// here: at least one driver accepts a texture with NO bind flags but
    /// rejects `SHADER_RESOURCE` on its own with a bare `E_INVALIDARG`. See
    /// `src/bin/vp_probe.rs`, which exists to answer that question on whatever
    /// machine is being debugged.
    pub fn convert(&mut self, source: &ID3D11Texture2D) -> WinResult<()> {
        unsafe {
            let iv_desc = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
                FourCC: 0,
                ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
                ..Default::default()
            };
            let mut input_view: Option<ID3D11VideoProcessorInputView> = None;
            self.video_device
                .CreateVideoProcessorInputView(source, &self.enumerator, &iv_desc, Some(&mut input_view))
                .map_err(|e| {
                    windows::core::Error::new(e.code(), "CreateVideoProcessorInputView")
                })?;
            let input_view =
                input_view.ok_or_else(|| windows::core::Error::new(E_FAIL, "no input view"))?;

            let mut stream = D3D11_VIDEO_PROCESSOR_STREAM {
                Enable: true.into(),
                OutputIndex: 0,
                InputFrameOrField: 0,
                pInputSurface: std::mem::ManuallyDrop::new(Some(input_view)),
                ..Default::default()
            };
            let result =
                self.video_context
                    .VideoProcessorBlt(&self.processor, &self.output_view, 0, &[stream.clone()])
                    .map_err(|e| windows::core::Error::new(e.code(), "VideoProcessorBlt"));
            // The struct holds a ManuallyDrop reference; release it whether or
            // not the blt succeeded, or every frame leaks a view.
            let _ = std::mem::ManuallyDrop::take(&mut stream.pInputSurface);
            result
        }
    }

    /// Read the NV12 result back to the CPU.
    ///
    /// Only for tests and for feeding a software encoder — it is the exact
    /// stall this module exists to avoid, and must not be on the hot path when
    /// a hardware encoder is available.
    pub fn read_back(&mut self, out: &mut Vec<u8>) -> WinResult<()> {
        unsafe {
            if self.staging.is_none() {
                let desc = D3D11_TEXTURE2D_DESC {
                    Width: self.width,
                    Height: self.height,
                    MipLevels: 1,
                    ArraySize: 1,
                    Format: DXGI_FORMAT_NV12,
                    SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                    Usage: D3D11_USAGE_STAGING,
                    BindFlags: 0,
                    CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                    MiscFlags: 0,
                };
                let mut staging: Option<ID3D11Texture2D> = None;
                self.device.CreateTexture2D(&desc, None, Some(&mut staging))?;
                self.staging = staging;
            }
            let staging = self
                .staging
                .as_ref()
                .ok_or_else(|| windows::core::Error::new(E_FAIL, "no staging"))?;
            self.context.CopyResource(staging, &self.output);

            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            self.context.Map(staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;

            let w = self.width as usize;
            let h = self.height as usize;
            out.clear();
            out.reserve(w * h * 3 / 2);
            let base = mapped.pData as *const u8;
            let pitch = mapped.RowPitch as usize;
            for y in 0..h {
                out.extend_from_slice(std::slice::from_raw_parts(base.add(y * pitch), w));
            }
            // Chroma follows luma in the same mapping, at half the height.
            let chroma = base.add(h * pitch);
            for y in 0..h / 2 {
                out.extend_from_slice(std::slice::from_raw_parts(chroma.add(y * pitch), w));
            }
            self.context.Unmap(staging, 0);
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::Graphics::Direct3D::*;

    /// A device built the way capture builds one, or None on a machine with no
    /// usable GPU. Every test here is a no-op there rather than a failure: "no
    /// GPU" is a supported configuration, not a broken one.
    fn test_device() -> Option<ID3D11Device> {
        unsafe {
            let mut device: Option<ID3D11Device> = None;
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
            )
            .ok()?;
            device
        }
    }

    fn bgra_texture(device: &ID3D11Device, w: u32, h: u32, px: [u8; 4]) -> ID3D11Texture2D {
        let data: Vec<u8> = px.iter().cycle().take((w * h * 4) as usize).copied().collect();
        let desc = D3D11_TEXTURE2D_DESC {
            Width: w,
            Height: h,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_DEFAULT,
            // No bind flags, matching what Desktop Duplication produces —
            // and required: this driver refuses SHADER_RESOURCE alone as a
            // video processor input (src/bin/vp_probe.rs).
            BindFlags: 0,
            ..Default::default()
        };
        let init = D3D11_SUBRESOURCE_DATA {
            pSysMem: data.as_ptr() as *const _,
            SysMemPitch: w * 4,
            SysMemSlicePitch: 0,
        };
        unsafe {
            let mut tex = None;
            device.CreateTexture2D(&desc, Some(&init), Some(&mut tex)).unwrap();
            tex.unwrap()
        }
    }

    #[test]
    fn converts_white_to_bright_neutral_nv12() {
        let Some(device) = test_device() else { return };
        let Ok(mut conv) = VideoConverter::new(&device, 64, 64) else { return };

        let src = bgra_texture(&device, 64, 64, [255, 255, 255, 255]);
        conv.convert(&src).unwrap();

        let mut nv12 = Vec::new();
        conv.read_back(&mut nv12).unwrap();
        assert_eq!(nv12.len(), 64 * 64 * 3 / 2);

        // Ranges, not exact values: the precise figures are the driver's
        // business, but a misconfigured colour space shows up as luma nowhere
        // near the top or chroma far from neutral.
        let luma = nv12[0];
        assert!(luma > 200, "white must be bright, got luma {luma}");
        let chroma = &nv12[64 * 64..64 * 64 + 2];
        assert!(
            chroma.iter().all(|&c| (108..=148).contains(&c)),
            "white must be chroma-neutral, got {chroma:?}"
        );
    }

    #[test]
    fn converts_black_to_dark_nv12() {
        let Some(device) = test_device() else { return };
        let Ok(mut conv) = VideoConverter::new(&device, 64, 64) else { return };
        let src = bgra_texture(&device, 64, 64, [0, 0, 0, 255]);
        conv.convert(&src).unwrap();
        let mut nv12 = Vec::new();
        conv.read_back(&mut nv12).unwrap();
        assert!(nv12[0] < 40, "black must be dark, got {}", nv12[0]);
    }

    /// The output texture is reused every frame; converting twice must not leak
    /// views or leave the second frame still showing the first.
    #[test]
    fn a_second_conversion_replaces_the_first() {
        let Some(device) = test_device() else { return };
        let Ok(mut conv) = VideoConverter::new(&device, 64, 64) else { return };
        let white = bgra_texture(&device, 64, 64, [255, 255, 255, 255]);
        let black = bgra_texture(&device, 64, 64, [0, 0, 0, 255]);

        let mut buf = Vec::new();
        conv.convert(&white).unwrap();
        conv.read_back(&mut buf).unwrap();
        let bright = buf[0];

        conv.convert(&black).unwrap();
        conv.read_back(&mut buf).unwrap();
        let dark = buf[0];

        assert!(
            bright > dark + 100,
            "the second frame must replace the first ({bright} -> {dark})"
        );
    }
}
