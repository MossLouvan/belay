//! Screen capture via DXGI Desktop Duplication.
//!
//! Replaces the shipping path's GDI `CopyFromScreen`, which blits the entire
//! desktop through the CPU every frame whether or not anything changed. DDA is
//! better in three ways that all matter here:
//!
//! 1. **The compositor hands us the frame it already has.** No re-rasterising,
//!    no full-screen blit.
//! 2. **Dirty rectangles.** DXGI reports exactly which regions changed. On a
//!    desktop — mostly still, with a cursor and one window moving — that is the
//!    difference between processing 2 million pixels and processing a few
//!    thousand.
//! 3. **The cursor arrives separately**, with its position and shape, instead
//!    of being burned into the image. That is what lets the cursor go on its own
//!    low-latency channel (see belay_wire::cursor) rather than costing a whole
//!    frame to move.
//!
//! Works on the GPU-less dev VM: Hyper-V's synthetic adapter is a WDDM driver,
//! and DDA is a WDDM feature, not a hardware-encoder feature.
//!
//! `AcquireNextFrame` returning DXGI_ERROR_WAIT_TIMEOUT is the normal state of
//! an idle desktop, not an error — treating it as one is how a capture loop
//! ends up spinning at 100% CPU showing a static screen.

#![cfg(windows)]

use windows::core::Interface;
use windows::Win32::Foundation::E_FAIL;
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_UNKNOWN, D3D_DRIVER_TYPE_WARP};
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::*;
use windows::Win32::Graphics::Dxgi::*;

/// A region of the desktop that changed since the previous frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DirtyRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// Where the cursor is, kept out of the pixels on purpose.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CursorInfo {
    pub x: i32,
    pub y: i32,
    pub visible: bool,
    /// Increments whenever the shape changes, so a client can cache shapes.
    pub shape_id: u32,
}

#[derive(Debug)]
pub struct CapturedFrame<'a> {
    /// BGRA pixels.
    pub bgra: &'a [u8],
    /// Row pitch in bytes. NOT width*4 — the GPU pads rows.
    pub stride: usize,
    pub width: usize,
    pub height: usize,
    /// Regions that changed. Empty means only the cursor moved.
    pub dirty: Vec<DirtyRect>,
    pub cursor: CursorInfo,
    /// True when DXGI reported no accumulated frames — nothing changed.
    pub idle: bool,
}

pub struct DesktopCapture {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    duplication: IDXGIOutputDuplication,
    /// CPU-readable staging texture the GPU frame is copied into.
    staging: Option<ID3D11Texture2D>,
    width: usize,
    height: usize,
    /// Scratch for DXGI's dirty-rect and move-rect reports.
    meta: Vec<u8>,
    cursor: CursorInfo,
    holding_frame: bool,
}

impl core::fmt::Debug for DesktopCapture {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("DesktopCapture")
            .field("width", &self.width)
            .field("height", &self.height)
            .finish_non_exhaustive()
    }
}

impl DesktopCapture {
    /// Start duplicating `output_index` of `adapter_index`.
    pub fn new(adapter_index: u32, output_index: u32) -> windows::core::Result<DesktopCapture> {
        unsafe {
            let factory: IDXGIFactory1 = CreateDXGIFactory1()?;
            let adapter: IDXGIAdapter1 = factory.EnumAdapters1(adapter_index)?;

            // WARP fallback so a machine with no usable 3D device still runs.
            let mut device: Option<ID3D11Device> = None;
            let mut context: Option<ID3D11DeviceContext> = None;
            let mut created = D3D11CreateDevice(
                &adapter,
                D3D_DRIVER_TYPE_UNKNOWN,
                None,
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            );
            if created.is_err() {
                created = D3D11CreateDevice(
                    None,
                    D3D_DRIVER_TYPE_WARP,
                    None,
                    D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                    None,
                    D3D11_SDK_VERSION,
                    Some(&mut device),
                    None,
                    Some(&mut context),
                );
            }
            created?;
            let device = device.ok_or_else(|| windows::core::Error::new(E_FAIL, "no D3D11 device"))?;
            let context =
                context.ok_or_else(|| windows::core::Error::new(E_FAIL, "no D3D11 context"))?;

            let output: IDXGIOutput = adapter.EnumOutputs(output_index)?;
            let output1: IDXGIOutput1 = output.cast()?;
            let duplication = output1.DuplicateOutput(&device)?;

            let desc = duplication.GetDesc();

            Ok(DesktopCapture {
                device,
                context,
                duplication,
                staging: None,
                width: desc.ModeDesc.Width as usize,
                height: desc.ModeDesc.Height as usize,
                meta: vec![0u8; 64 * 1024],
                cursor: CursorInfo { x: 0, y: 0, visible: false, shape_id: 0 },
                holding_frame: false,
            })
        }
    }

    pub fn width(&self) -> usize {
        self.width
    }
    pub fn height(&self) -> usize {
        self.height
    }

    /// Grab the next frame, waiting up to `timeout_ms`.
    ///
    /// `Ok(None)` means the desktop did not change in that window. That is the
    /// normal state of an idle screen and the caller should simply not send a
    /// frame — it is not an error and must not be logged as one.
    pub fn next_frame(&mut self, timeout_ms: u32, out: &mut Vec<u8>) -> windows::core::Result<Option<FrameMeta>> {
        unsafe {
            self.release_if_held();

            let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
            let mut resource: Option<IDXGIResource> = None;
            match self.duplication.AcquireNextFrame(timeout_ms, &mut info, &mut resource) {
                Ok(()) => {}
                Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => return Ok(None),
                Err(e) => return Err(e),
            }
            self.holding_frame = true;

            // Cursor first: it updates even on frames with no pixel change,
            // which is exactly the case worth capturing cheaply.
            if info.LastMouseUpdateTime != 0 {
                self.cursor.x = info.PointerPosition.Position.x;
                self.cursor.y = info.PointerPosition.Position.y;
                self.cursor.visible = info.PointerPosition.Visible.as_bool();
            }
            if info.PointerShapeBufferSize > 0 {
                self.cursor.shape_id = self.cursor.shape_id.wrapping_add(1);
            }

            // AccumulatedFrames == 0 means only the pointer moved. Copying the
            // whole desktop for that would waste the entire saving DDA exists
            // to provide.
            if info.AccumulatedFrames == 0 || info.TotalMetadataBufferSize == 0 {
                return Ok(Some(FrameMeta {
                    dirty: Vec::new(),
                    cursor: self.cursor,
                    idle: true,
                    stride: 0,
                    width: self.width,
                    height: self.height,
                    copy_ms: 0.0,
                }));
            }

            let dirty = self.read_dirty_rects(info.TotalMetadataBufferSize)?;

            let resource = resource.ok_or_else(|| windows::core::Error::new(E_FAIL, "no frame resource"))?;
            let texture: ID3D11Texture2D = resource.cast()?;
            let copy_start = std::time::Instant::now();
            let stride = self.copy_to_cpu(&texture, out)?;
            let copy_ms = copy_start.elapsed().as_secs_f64() * 1000.0;

            Ok(Some(FrameMeta {
                dirty,
                cursor: self.cursor,
                idle: false,
                stride,
                width: self.width,
                height: self.height,
                copy_ms,
            }))
        }
    }

    unsafe fn read_dirty_rects(&mut self, total: u32) -> windows::core::Result<Vec<DirtyRect>> {
        if self.meta.len() < total as usize {
            self.meta.resize(total as usize, 0);
        }
        // Move rects come first in the buffer, then dirty rects. We treat a
        // moved region as dirty: the encoder has no way to exploit a copy, so
        // pretending otherwise would only lose pixels.
        let mut move_bytes = 0u32;
        self.duplication.GetFrameMoveRects(
            self.meta.len() as u32,
            self.meta.as_mut_ptr() as *mut DXGI_OUTDUPL_MOVE_RECT,
            &mut move_bytes,
        )?;

        let mut dirty_bytes = 0u32;
        let dirty_start = move_bytes as usize;
        self.duplication.GetFrameDirtyRects(
            (self.meta.len() - dirty_start) as u32,
            self.meta[dirty_start..].as_mut_ptr() as *mut windows::Win32::Foundation::RECT,
            &mut dirty_bytes,
        )?;

        let count = dirty_bytes as usize / core::mem::size_of::<windows::Win32::Foundation::RECT>();
        let rects = core::slice::from_raw_parts(
            self.meta[dirty_start..].as_ptr() as *const windows::Win32::Foundation::RECT,
            count,
        );
        Ok(rects
            .iter()
            .map(|r| DirtyRect {
                x: r.left,
                y: r.top,
                width: r.right - r.left,
                height: r.bottom - r.top,
            })
            .collect())
    }

    /// Copy the GPU texture into a CPU-readable staging texture and out to
    /// `dst`. Returns the row pitch, which is NOT width*4.
    unsafe fn copy_to_cpu(
        &mut self,
        src: &ID3D11Texture2D,
        dst: &mut Vec<u8>,
    ) -> windows::core::Result<usize> {
        if self.staging.is_none() {
            let mut desc = D3D11_TEXTURE2D_DESC::default();
            src.GetDesc(&mut desc);
            desc.Usage = D3D11_USAGE_STAGING;
            desc.BindFlags = 0;
            desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
            desc.MiscFlags = 0;
            let mut tex: Option<ID3D11Texture2D> = None;
            self.device.CreateTexture2D(&desc, None, Some(&mut tex))?;
            self.staging = tex;
        }
        let staging = self
            .staging
            .as_ref()
            .ok_or_else(|| windows::core::Error::new(E_FAIL, "no staging texture"))?;

        self.context.CopyResource(staging, src);

        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        self.context.Map(staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;
        let stride = mapped.RowPitch as usize;
        let len = stride * self.height;
        dst.clear();
        dst.reserve(len);
        dst.set_len(len);
        core::ptr::copy_nonoverlapping(mapped.pData as *const u8, dst.as_mut_ptr(), len);
        self.context.Unmap(staging, 0);
        Ok(stride)
    }

    unsafe fn release_if_held(&mut self) {
        if self.holding_frame {
            // Must be released before the next acquire, or DXGI refuses with
            // DXGI_ERROR_INVALID_CALL and the capture loop stops dead.
            let _ = self.duplication.ReleaseFrame();
            self.holding_frame = false;
        }
    }
}

impl Drop for DesktopCapture {
    fn drop(&mut self) {
        unsafe { self.release_if_held() }
    }
}

/// What `next_frame` learned, separate from the pixels so an idle frame costs
/// nothing to report.
#[derive(Debug, Clone)]
pub struct FrameMeta {
    pub dirty: Vec<DirtyRect>,
    pub cursor: CursorInfo,
    /// True when only the cursor moved; `out` was not written.
    pub idle: bool,
    pub stride: usize,
    pub width: usize,
    pub height: usize,
    /// Milliseconds spent actually MOVING the frame (GPU copy + map + memcpy),
    /// excluding the wait for the compositor to produce one.
    ///
    /// Reported separately because a capture loop on an idle desktop spends
    /// almost all its wall-clock waiting, and folding that into "capture cost"
    /// makes a cheap capture look catastrophically expensive.
    pub copy_ms: f64,
}

impl FrameMeta {
    /// Total changed area in pixels — the number that decides whether a full
    /// re-encode is worth it.
    pub fn dirty_pixels(&self) -> u64 {
        self.dirty.iter().map(|r| (r.width.max(0) as u64) * (r.height.max(0) as u64)).sum()
    }

    /// Fraction of the screen that changed, 0..=1.
    pub fn dirty_fraction(&self) -> f64 {
        let total = (self.width * self.height) as f64;
        if total <= 0.0 {
            return 0.0;
        }
        (self.dirty_pixels() as f64 / total).min(1.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(rects: Vec<DirtyRect>) -> FrameMeta {
        FrameMeta {
            dirty: rects,
            cursor: CursorInfo { x: 0, y: 0, visible: true, shape_id: 0 },
            idle: false,
            stride: 1920 * 4,
            width: 1920,
            height: 1080,
            copy_ms: 0.0,
        }
    }

    #[test]
    fn dirty_area_sums_the_rects() {
        let m = meta(vec![
            DirtyRect { x: 0, y: 0, width: 100, height: 100 },
            DirtyRect { x: 200, y: 200, width: 50, height: 20 },
        ]);
        assert_eq!(m.dirty_pixels(), 100 * 100 + 50 * 20);
    }

    /// The number that justifies DDA: a typing cursor dirties a sliver of the
    /// screen, and the shipping path re-encodes all 2 million pixels for it.
    #[test]
    fn a_typical_edit_dirties_a_tiny_fraction_of_the_screen() {
        let m = meta(vec![DirtyRect { x: 400, y: 300, width: 220, height: 40 }]);
        assert!(m.dirty_fraction() < 0.005, "got {}", m.dirty_fraction());
    }

    #[test]
    fn dirty_fraction_is_clamped_and_safe_on_degenerate_input() {
        let mut m = meta(vec![DirtyRect { x: 0, y: 0, width: 99_999, height: 99_999 }]);
        assert_eq!(m.dirty_fraction(), 1.0, "cannot exceed the whole screen");

        m.width = 0;
        m.height = 0;
        assert_eq!(m.dirty_fraction(), 0.0, "must not divide by zero");

        // DXGI should never report these, but a negative extent must not
        // underflow into an enormous unsigned area.
        let neg = meta(vec![DirtyRect { x: 0, y: 0, width: -5, height: -5 }]);
        assert_eq!(neg.dirty_pixels(), 0);
    }

    #[test]
    fn an_idle_frame_reports_no_dirty_area() {
        let mut m = meta(Vec::new());
        m.idle = true;
        assert_eq!(m.dirty_pixels(), 0);
        assert_eq!(m.dirty_fraction(), 0.0);
    }
}
