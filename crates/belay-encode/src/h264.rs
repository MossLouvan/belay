//! H.264 encoding via Media Foundation — the replacement for JPEG-per-frame.
//!
//! Why this matters more than the transport: the shipping path encodes every
//! frame as an independent JPEG. Nothing is shared between frames, so a static
//! desktop costs exactly as much as a moving one, and the bitrate needed for a
//! sharp 1080p picture is far beyond what a phone link should be asked to
//! carry. H.264 sends a keyframe occasionally and *differences* the rest of the
//! time; on desktop content, which is mostly still, that is an order of
//! magnitude, not a percentage.
//!
//! This drives the encoder MFT directly rather than going through SinkWriter.
//! SinkWriter is for writing files: it buffers to produce a well-formed
//! container, and that buffering is latency we exist to avoid. The MFT lets us
//! set `CODECAPI_AVLowLatencyMode` and pull each frame out as soon as it is
//! coded.
//!
//! Runs on a GPU-less VM. Media Foundation supplies a software H.264 encoder
//! when no hardware MFT is present, so the whole pipeline is exercisable in the
//! dev VM — slower than NVENC, but the same code path, the same bitstream, and
//! the same bandwidth win.

#![cfg(windows)]

use std::time::Duration;

use windows::core::{Interface, Result as WinResult, GUID};
use windows::Win32::Foundation::E_FAIL;
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

/// 100-nanosecond ticks, Media Foundation's time unit.
const HNS_PER_SEC: i64 = 10_000_000;

#[derive(Debug, Clone, Copy)]
pub struct EncoderConfig {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate_bps: u32,
    /// Seconds between forced keyframes. Keyframes are large; on a lossy link
    /// they are also the only way back after unrecoverable loss, so this trades
    /// bandwidth against recovery time. The transport can additionally demand
    /// one on demand via `request_keyframe`, which is the better mechanism —
    /// ask when actually broken rather than on a timer.
    pub keyframe_interval_s: u32,
}

impl Default for EncoderConfig {
    fn default() -> Self {
        EncoderConfig {
            width: 1920,
            height: 1080,
            fps: 60,
            bitrate_bps: 8_000_000,
            keyframe_interval_s: 4,
        }
    }
}

/// One coded frame, Annex-B, ready to hand to the packetiser.
#[derive(Debug, Clone)]
pub struct CodedFrame {
    pub data: Vec<u8>,
    pub keyframe: bool,
    /// Presentation timestamp in 100ns ticks.
    pub timestamp_hns: i64,
}

pub struct H264Encoder {
    transform: IMFTransform,
    config: EncoderConfig,
    input_stream: u32,
    output_stream: u32,
    /// Whether the MFT allocates output samples for us.
    provides_output_samples: bool,
    /// Hardware encoders are asynchronous MFTs: they must be unlocked and
    /// driven by events rather than by a straight ProcessInput/ProcessOutput
    /// loop. Software encoders are synchronous. Both are supported because the
    /// dev VM only has the software one and the real machine only has the
    /// hardware one — testing on either alone would miss half the code.
    is_async: bool,
    events: Option<IMFMediaEventGenerator>,
    frame_index: i64,
    /// True once the encoder has been told to emit a keyframe next.
    force_keyframe: bool,
    /// Frames collected while waiting for input capacity on an async MFT.
    pending_output: Vec<CodedFrame>,
}

impl core::fmt::Debug for H264Encoder {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("H264Encoder").field("config", &self.config).finish_non_exhaustive()
    }
}

/// Initialise COM + Media Foundation for this process. Safe to call repeatedly.
pub fn init_media_foundation() -> WinResult<()> {
    unsafe {
        // Ignore the "already initialised" outcomes: another part of the host
        // may have got here first, and that is not an error.
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        MFStartup(MF_VERSION, MFSTARTUP_NOSOCKET)?;
    }
    Ok(())
}

impl H264Encoder {
    pub fn new(config: EncoderConfig) -> WinResult<H264Encoder> {
        unsafe {
            let transform = find_h264_encoder()?;

            // Must happen before anything else touches the transform: an async
            // MFT rejects ProcessInput with MF_E_TRANSFORM_ASYNC_LOCKED
            // (0xC00D6D77) until the caller declares it understands the async
            // model. That error is what a hardware encoder returns to a caller
            // written only against the synchronous one.
            let mut is_async = false;
            if let Ok(attrs) = transform.GetAttributes() {
                is_async = attrs.GetUINT32(&MF_TRANSFORM_ASYNC).unwrap_or(0) == 1;
                if is_async {
                    attrs.SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1)?;
                }
                // Ask for low latency here too; some MFTs honour the attribute
                // even when they ignore the ICodecAPI property.
                let _ = attrs.SetUINT32(&MF_LOW_LATENCY, 1);
            }

            // Output type FIRST. The H.264 MFT will not accept an input type
            // until it knows what it is producing, and the failure if you try
            // is an opaque E_INVALIDARG.
            let out_type: IMFMediaType = MFCreateMediaType()?;
            out_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
            out_type.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264)?;
            out_type.SetUINT32(&MF_MT_AVG_BITRATE, config.bitrate_bps)?;
            set_ratio(&out_type, &MF_MT_FRAME_RATE, config.fps, 1)?;
            set_ratio(&out_type, &MF_MT_FRAME_SIZE, config.width, config.height)?;
            set_ratio(&out_type, &MF_MT_PIXEL_ASPECT_RATIO, 1, 1)?;
            out_type.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
            // Baseline keeps decoder support universal (every phone decodes it
            // in hardware) at a small bitrate cost versus High.
            out_type.SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_Base.0 as u32)?;
            transform.SetOutputType(0, &out_type, 0)?;

            let in_type: IMFMediaType = MFCreateMediaType()?;
            in_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
            in_type.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12)?;
            set_ratio(&in_type, &MF_MT_FRAME_RATE, config.fps, 1)?;
            set_ratio(&in_type, &MF_MT_FRAME_SIZE, config.width, config.height)?;
            set_ratio(&in_type, &MF_MT_PIXEL_ASPECT_RATIO, 1, 1)?;
            in_type.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
            transform.SetInputType(0, &in_type, 0)?;

            // Low latency: without this the encoder buffers frames to look
            // ahead, which is exactly the delay this product cannot afford.
            if let Ok(codec_api) = transform.cast::<ICodecAPI>() {
                let _ = set_codec_bool(&codec_api, &CODECAPI_AVLowLatencyMode, true);
                let _ = set_codec_u32(&codec_api, &CODECAPI_AVEncCommonRateControlMode, 0); // CBR
                let _ = set_codec_u32(&codec_api, &CODECAPI_AVEncCommonMeanBitRate, config.bitrate_bps);
                let gop = config.keyframe_interval_s.saturating_mul(config.fps).max(1);
                let _ = set_codec_u32(&codec_api, &CODECAPI_AVEncMPVGOPSize, gop);
                // No B-frames: they reorder output, and reordering is latency.
                let _ = set_codec_u32(&codec_api, &CODECAPI_AVEncMPVDefaultBPictureCount, 0);
            }

            let info = transform.GetOutputStreamInfo(0)?;
            let provides_output_samples = info.dwFlags
                & (MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32
                    | MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES.0 as u32)
                != 0;

            // Order matters, and the two encoder families disagree about how
            // much. A FLUSH before streaming has begun is meaningless: the
            // hardware MFT tolerates it, the software MFT in a GPU-less VM
            // rejects it outright with E_FAIL. Begin streaming first, and treat
            // START_OF_STREAM as advisory since not every MFT implements it.
            transform.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)?;
            let _ = transform.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0);

            let events = if is_async { transform.cast::<IMFMediaEventGenerator>().ok() } else { None };

            Ok(H264Encoder {
                transform,
                config,
                is_async,
                events,
                input_stream: 0,
                output_stream: 0,
                provides_output_samples,
                frame_index: 0,
                force_keyframe: false,
                pending_output: Vec::new(),
            })
        }
    }

    pub fn config(&self) -> EncoderConfig {
        self.config
    }

    /// Ask for the next frame to be a keyframe.
    ///
    /// The transport calls this when the decoder is known broken — a frame it
    /// gave up repairing. Demanding a keyframe on evidence beats emitting them
    /// on a timer, which spends bandwidth on recovery nobody needed.
    pub fn request_keyframe(&mut self) {
        self.force_keyframe = true;
    }

    /// Change the target bitrate mid-stream.
    ///
    /// This is where the congestion controller's setpoint lands: owning both
    /// the encoder and the transport means the number the control law produces
    /// is applied directly, with no ABR estimator in between.
    pub fn set_bitrate(&mut self, bps: u32) -> WinResult<()> {
        self.config.bitrate_bps = bps;
        unsafe {
            if let Ok(codec_api) = self.transform.cast::<ICodecAPI>() {
                set_codec_u32(&codec_api, &CODECAPI_AVEncCommonMeanBitRate, bps)?;
            }
        }
        Ok(())
    }

    /// Encode one NV12 frame, returning any coded frames the encoder produced.
    ///
    /// Returns a Vec because an encoder may emit zero (still buffering) or more
    /// than one; treating it as strictly one-in-one-out is a classic way to
    /// lose frames or stall.
    pub fn encode(&mut self, nv12: &[u8]) -> WinResult<Vec<CodedFrame>> {
        let expected = (self.config.width as usize) * (self.config.height as usize) * 3 / 2;
        if nv12.len() < expected {
            return Err(windows::core::Error::new(E_FAIL, "NV12 buffer too small for frame size"));
        }

        unsafe {
            if self.is_async {
                self.await_need_input()?;
            }
            let sample = self.make_input_sample(nv12, expected)?;
            if self.force_keyframe {
                // MFSampleExtension_CleanPoint on the INPUT asks the encoder to
                // start a new GOP here.
                sample.SetUINT32(&MFSampleExtension_CleanPoint, 1)?;
                self.force_keyframe = false;
            }
            self.transform.ProcessInput(self.input_stream, &sample, 0)?;
            self.drain()
        }
    }

    /// Flush buffered frames at end of stream.
    pub fn finish(&mut self) -> WinResult<Vec<CodedFrame>> {
        unsafe {
            self.transform.ProcessMessage(MFT_MESSAGE_COMMAND_DRAIN, 0)?;
            self.drain()
        }
    }

    /// Block until the async MFT asks for input.
    ///
    /// An async MFT signals METransformNeedInput when it has capacity; feeding
    /// it before that is an error, not backpressure.
    unsafe fn await_need_input(&mut self) -> WinResult<()> {
        let Some(events) = self.events.clone() else { return Ok(()) };
        // Bounded so a wedged encoder surfaces as an error instead of hanging
        // the capture thread forever.
        for _ in 0..256 {
            let ev = events.GetEvent(MF_EVENT_FLAG_NONE)?;
            match ev.GetType()? {
                x if x == METransformNeedInput.0 as u32 => return Ok(()),
                x if x == METransformHaveOutput.0 as u32 => {
                    // Output arriving before we asked: collect it so it is not
                    // lost, then keep waiting for capacity.
                    let mut got = self.process_output_once()?;
                    self.pending_output.append(&mut got);
                }
                _ => {}
            }
        }
        Err(windows::core::Error::new(E_FAIL, "encoder never asked for input"))
    }

    unsafe fn make_input_sample(&self, nv12: &[u8], len: usize) -> WinResult<IMFSample> {
        let buffer: IMFMediaBuffer = MFCreateMemoryBuffer(len as u32)?;
        let mut ptr = std::ptr::null_mut();
        let mut max = 0u32;
        buffer.Lock(&mut ptr, Some(&mut max), None)?;
        std::ptr::copy_nonoverlapping(nv12.as_ptr(), ptr, len);
        buffer.Unlock()?;
        buffer.SetCurrentLength(len as u32)?;

        let sample: IMFSample = MFCreateSample()?;
        sample.AddBuffer(&buffer)?;
        let dur = HNS_PER_SEC / self.config.fps.max(1) as i64;
        sample.SetSampleTime(self.frame_index * dur)?;
        sample.SetSampleDuration(dur)?;
        Ok(sample)
    }

    /// Collect whatever the encoder has ready.
    ///
    /// Async and sync MFTs differ here: a sync MFT is polled until it says
    /// NEED_MORE_INPUT, while an async one only produces output when it has
    /// raised METransformHaveOutput, and polling it otherwise just fails.
    unsafe fn drain(&mut self) -> WinResult<Vec<CodedFrame>> {
        let mut out = core::mem::take(&mut self.pending_output);

        if self.is_async {
            let Some(events) = self.events.clone() else { return Ok(out) };
            // Non-blocking: take output that is already waiting, then return.
            // Blocking here would serialise encode with the capture loop.
            loop {
                match events.GetEvent(MF_EVENT_FLAG_NO_WAIT) {
                    Ok(ev) => {
                        if ev.GetType()? == METransformHaveOutput.0 as u32 {
                            let mut got = self.process_output_once()?;
                            out.append(&mut got);
                        }
                    }
                    Err(_) => break, // no event pending
                }
            }
            return Ok(out);
        }

        loop {
            match self.process_output_once() {
                Ok(mut frames) => {
                    if frames.is_empty() {
                        break;
                    }
                    out.append(&mut frames);
                }
                Err(e) if e.code() == MF_E_TRANSFORM_NEED_MORE_INPUT => break,
                Err(e) => return Err(e),
            }
        }
        Ok(out)
    }

    /// One ProcessOutput attempt. Returns the frames it yielded, or the raw
    /// error so the caller can distinguish "need more input" from a fault.
    unsafe fn process_output_once(&mut self) -> WinResult<Vec<CodedFrame>> {
        let info = self.transform.GetOutputStreamInfo(self.output_stream)?;

        let mut buffers = [MFT_OUTPUT_DATA_BUFFER {
            dwStreamID: self.output_stream,
            pSample: core::mem::ManuallyDrop::new(if self.provides_output_samples {
                None
            } else {
                let buf: IMFMediaBuffer = MFCreateMemoryBuffer(info.cbSize.max(1))?;
                let s: IMFSample = MFCreateSample()?;
                s.AddBuffer(&buf)?;
                Some(s)
            }),
            dwStatus: 0,
            pEvents: core::mem::ManuallyDrop::new(None),
        }];

        let mut status = 0u32;
        let hr = self.transform.ProcessOutput(0, &mut buffers, &mut status);
        let sample = core::mem::ManuallyDrop::take(&mut buffers[0].pSample);

        match hr {
            Ok(()) => {
                self.frame_index += 1;
                match sample {
                    Some(s) => Ok(vec![self.read_sample(&s)?]),
                    None => Ok(Vec::new()),
                }
            }
            Err(e) if e.code() == MF_E_TRANSFORM_STREAM_CHANGE => {
                // The encoder renegotiated its output type. Accept it and let
                // the caller retry rather than silently dropping the frame.
                let new_type = self.transform.GetOutputAvailableType(self.output_stream, 0)?;
                self.transform.SetOutputType(self.output_stream, &new_type, 0)?;
                Ok(Vec::new())
            }
            Err(e) => Err(e),
        }
    }

    unsafe fn read_sample(&self, sample: &IMFSample) -> WinResult<CodedFrame> {
        let buffer = sample.ConvertToContiguousBuffer()?;
        let mut ptr = std::ptr::null_mut();
        let mut len = 0u32;
        buffer.Lock(&mut ptr, None, Some(&mut len))?;
        let data = std::slice::from_raw_parts(ptr, len as usize).to_vec();
        buffer.Unlock()?;

        // A missing CleanPoint attribute means "not a keyframe"; absence is
        // normal, so it must not be treated as an error.
        let keyframe = sample.GetUINT32(&MFSampleExtension_CleanPoint).unwrap_or(0) != 0;
        let timestamp_hns = sample.GetSampleTime().unwrap_or(0);
        Ok(CodedFrame { data, keyframe, timestamp_hns })
    }
}

/// Locate an H.264 encoder MFT, preferring hardware, accepting software.
///
/// On a GPU-less VM only the software encoder exists — which is the point: the
/// pipeline still runs, so correctness is developed there and only performance
/// has to be measured on real hardware.
unsafe fn find_h264_encoder() -> WinResult<IMFTransform> {
    let output = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Video, guidSubtype: MFVideoFormat_H264 };
    let input = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Video, guidSubtype: MFVideoFormat_NV12 };

    // Hardware first, then software. SORTANDFILTER puts the better ones first.
    for flags in [
        MFT_ENUM_FLAG_HARDWARE.0 | MFT_ENUM_FLAG_SORTANDFILTER.0,
        MFT_ENUM_FLAG_SYNCMFT.0 | MFT_ENUM_FLAG_SORTANDFILTER.0,
        MFT_ENUM_FLAG_ALL.0,
    ] {
        let mut activates: *mut Option<IMFActivate> = std::ptr::null_mut();
        let mut count = 0u32;
        let hr = MFTEnumEx(
            MFT_CATEGORY_VIDEO_ENCODER,
            MFT_ENUM_FLAG(flags),
            Some(&input),
            Some(&output),
            &mut activates,
            &mut count,
        );
        if hr.is_err() || count == 0 {
            continue;
        }
        let list = std::slice::from_raw_parts(activates, count as usize);
        let mut chosen: Option<IMFTransform> = None;
        for act in list.iter().flatten() {
            if chosen.is_none() {
                if let Ok(t) = act.ActivateObject::<IMFTransform>() {
                    chosen = Some(t);
                }
            }
        }
        windows::Win32::System::Com::CoTaskMemFree(Some(activates as *const _));
        if let Some(t) = chosen {
            return Ok(t);
        }
    }
    Err(windows::core::Error::new(E_FAIL, "no H.264 encoder MFT available"))
}

unsafe fn set_ratio(t: &IMFMediaType, key: &GUID, hi: u32, lo: u32) -> WinResult<()> {
    t.SetUINT64(key, ((hi as u64) << 32) | lo as u64)
}

unsafe fn set_codec_u32(api: &ICodecAPI, key: &GUID, value: u32) -> WinResult<()> {
    let v = windows::core::VARIANT::from(value as i32);
    api.SetValue(key, &v)
}

unsafe fn set_codec_bool(api: &ICodecAPI, key: &GUID, value: bool) -> WinResult<()> {
    set_codec_u32(api, key, value as u32)
}

/// How long a coded frame would take to send at a given bitrate — the honest
/// unit for comparing codecs, since bytes are what the link carries.
pub fn transmit_time(bytes: usize, bitrate_bps: u32) -> Duration {
    if bitrate_bps == 0 {
        return Duration::ZERO;
    }
    Duration::from_secs_f64((bytes as f64 * 8.0) / bitrate_bps as f64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transmit_time_is_bytes_over_bitrate() {
        // 1 Mbit at 1 Mbps is one second.
        assert_eq!(transmit_time(125_000, 1_000_000), Duration::from_secs(1));
        assert_eq!(transmit_time(0, 1_000_000), Duration::ZERO);
        assert_eq!(transmit_time(1000, 0), Duration::ZERO, "must not divide by zero");
    }

    #[test]
    fn default_config_is_a_sane_starting_point() {
        let c = EncoderConfig::default();
        assert_eq!(c.width % 2, 0, "H.264 requires even dimensions");
        assert_eq!(c.height % 2, 0);
        assert!(c.fps > 0 && c.bitrate_bps > 0);
    }
}
