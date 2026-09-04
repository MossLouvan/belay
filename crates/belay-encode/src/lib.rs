//! Capture and encode for Belay — the path that retires JPEG-per-frame.
//!
//! The shipping transport encodes every frame as an independent JPEG. Nothing
//! is shared between frames, so a motionless desktop costs exactly as much as a
//! moving one. On desktop content — mostly still, with small regions changing —
//! that is the single largest waste in the pipeline, and no transport can
//! recover it.
//!
//! `color` is pure and tested anywhere. `h264` is Windows-only and needs Media
//! Foundation, but runs on the GPU-less dev VM via the software encoder, so the
//! whole path is developable there and only performance has to be measured on
//! real hardware.

pub mod color;

#[cfg(windows)]
pub mod h264;

pub use color::{bgra_to_nv12, nv12_len, ConvertError};

#[cfg(windows)]
pub use h264::{init_media_foundation, CodedFrame, EncoderConfig, H264Encoder};
