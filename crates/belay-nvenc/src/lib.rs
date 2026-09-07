//! Safe ownership around Belay's dynamically loaded Windows NVENC bridge.
#![cfg(windows)]

use std::ffi::{c_char, c_int, c_void, CStr};
use std::marker::PhantomData;
use std::ptr::NonNull;
use std::rc::Rc;
use windows::core::Interface;
use windows::Win32::Graphics::Direct3D11::{ID3D11Device, ID3D11Texture2D};

extern "C" {
    fn belay_nvenc_create(device: *mut c_void, width: u32, height: u32, fps: u32,
        bitrate: u32, gop: u32, out: *mut *mut c_void, error: *mut c_char, capacity: usize) -> c_int;
    fn belay_nvenc_submit(context: *mut c_void, texture: *mut c_void, timestamp: i64, idr: c_int) -> c_int;
    fn belay_nvenc_poll(context: *mut c_void, data: *mut *const u8, length: *mut usize,
        timestamp: *mut i64, keyframe: *mut c_int) -> c_int;
    fn belay_nvenc_set_bitrate(context: *mut c_void, bitrate: u32) -> c_int;
    fn belay_nvenc_error(context: *mut c_void) -> *const c_char;
    fn belay_nvenc_destroy(context: *mut c_void);
}

pub struct Encoder {
    context: NonNull<c_void>,
    // The bridge and its D3D immediate context stay on the creating thread.
    _thread: PhantomData<Rc<()>>,
}

pub struct Frame {
    pub data: Vec<u8>,
    pub timestamp: i64,
    pub keyframe: bool,
}

impl Encoder {
    pub fn new(device: &ID3D11Device, width: u32, height: u32, fps: u32,
        bitrate: u32, gop: u32) -> Result<Self, String> {
        if width == 0 || height == 0 || width % 2 != 0 || height % 2 != 0
            || !(1..=120).contains(&fps) || bitrate == 0 || gop == 0 {
            return Err("invalid NVENC dimensions, cadence or bitrate".into());
        }
        let mut raw = std::ptr::null_mut();
        let mut error = [0i8; 1024];
        let status = unsafe { belay_nvenc_create(device.as_raw(), width, height, fps,
            bitrate, gop, &mut raw, error.as_mut_ptr(), error.len()) };
        if status != 0 {
            // Native create guarantees a terminated error buffer and cleans up
            // partial initialization. Clamp termination defensively as well.
            error[1023] = 0;
            return Err(unsafe { CStr::from_ptr(error.as_ptr()) }.to_string_lossy().into_owned());
        }
        let context = NonNull::new(raw).ok_or("NVENC returned a null context")?;
        Ok(Self { context, _thread: PhantomData })
    }

    fn error(&self) -> String {
        let pointer = unsafe { belay_nvenc_error(self.context.as_ptr()) };
        if pointer.is_null() { return "NVENC failed without diagnostic text".into(); }
        unsafe { CStr::from_ptr(pointer) }.to_string_lossy().into_owned()
    }

    /// Returns false when the two-frame native pipeline is full. On success
    /// the bridge owns an immutable GPU snapshot; caller may reuse its texture.
    pub fn submit(&mut self, texture: &ID3D11Texture2D, timestamp: i64, idr: bool) -> Result<bool, String> {
        match unsafe { belay_nvenc_submit(self.context.as_ptr(), texture.as_raw(), timestamp, i32::from(idr)) } {
            0 => Ok(true), 1 => Ok(false), _ => Err(self.error()),
        }
    }

    pub fn poll(&mut self) -> Result<Option<Frame>, String> {
        let mut data = std::ptr::null();
        let (mut length, mut timestamp, mut keyframe) = (0usize, 0i64, 0i32);
        match unsafe { belay_nvenc_poll(self.context.as_ptr(), &mut data, &mut length, &mut timestamp, &mut keyframe) } {
            1 => Ok(None),
            0 => {
                if data.is_null() || length == 0 || length > 16 * 1024 * 1024 {
                    return Err("invalid NVENC output buffer".into());
                }
                // Copy before the next bridge call invalidates its buffer.
                let data = unsafe { std::slice::from_raw_parts(data, length) }.to_vec();
                Ok(Some(Frame { data, timestamp, keyframe: keyframe != 0 }))
            }
            _ => Err(self.error()),
        }
    }

    pub fn set_bitrate(&mut self, bitrate: u32) -> Result<(), String> {
        if bitrate == 0 { return Err("NVENC bitrate must be positive".into()); }
        if unsafe { belay_nvenc_set_bitrate(self.context.as_ptr(), bitrate) } != 0 { return Err(self.error()); }
        Ok(())
    }
}

impl Drop for Encoder {
    fn drop(&mut self) { unsafe { belay_nvenc_destroy(self.context.as_ptr()) }; }
}
