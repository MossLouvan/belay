//! Decode an H.264 Annex-B file with a real decoder and report what came out.
//!
//! The whole product rests on a phone being able to decode what the host sends.
//! A start-code check proves the bytes look like H.264; it does not prove a
//! decoder will accept them. Profile, level, missing SPS/PPS, a keyframe the
//! encoder never actually emitted — all of those pass a byte inspection and
//! fail on the device, at the point where debugging costs a device build.
//!
//! Windows' H.264 decoder MFT is the same class of hardware decoder
//! VideoToolbox uses on iOS. If this accepts the stream, the phone will too.

#[cfg(not(windows))]
fn main() {
    eprintln!("windows only");
}

#[cfg(windows)]
fn main() -> windows::core::Result<()> {
    use windows::core::Interface;
    use windows::Win32::Media::MediaFoundation::*;
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

    let path = match std::env::args().nth(1) {
        Some(p) => p,
        None => {
            eprintln!("usage: decode-probe <file.h264>");
            std::process::exit(2);
        }
    };
    let data = std::fs::read(&path).expect("read the bitstream");
    println!("decoding {path} ({} bytes)", data.len());

    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        MFStartup(MF_VERSION, MFSTARTUP_NOSOCKET)?;

        let input = MFT_REGISTER_TYPE_INFO {
            guidMajorType: MFMediaType_Video,
            guidSubtype: MFVideoFormat_H264,
        };
        let output = MFT_REGISTER_TYPE_INFO {
            guidMajorType: MFMediaType_Video,
            guidSubtype: MFVideoFormat_NV12,
        };
        let mut activates: *mut Option<IMFActivate> = std::ptr::null_mut();
        let mut count = 0u32;
        MFTEnumEx(
            MFT_CATEGORY_VIDEO_DECODER,
            MFT_ENUM_FLAG(MFT_ENUM_FLAG_SYNCMFT.0 | MFT_ENUM_FLAG_SORTANDFILTER.0),
            Some(&input),
            Some(&output),
            &mut activates,
            &mut count,
        )?;
        if count == 0 {
            eprintln!("no H.264 decoder on this machine");
            std::process::exit(1);
        }
        let list = std::slice::from_raw_parts(activates, count as usize);
        let decoder: IMFTransform = list
            .iter()
            .flatten()
            .find_map(|a| a.ActivateObject::<IMFTransform>().ok())
            .expect("activate a decoder");

        let in_type: IMFMediaType = MFCreateMediaType()?;
        in_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
        in_type.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264)?;
        decoder.SetInputType(0, &in_type, 0)?;

        // The decoder learns the real size from the stream's SPS, so we accept
        // whatever it settles on rather than asserting a size up front — which
        // is also how we find out the SPS actually made it into the file.
        let mut i = 0;
        loop {
            let Ok(t) = decoder.GetOutputAvailableType(0, i) else { break };
            if t.GetGUID(&MF_MT_SUBTYPE) == Ok(MFVideoFormat_NV12) {
                decoder.SetOutputType(0, &t, 0)?;
                break;
            }
            i += 1;
        }

        decoder.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)?;

        // Feed the file in as one sample. The decoder parses NAL boundaries
        // itself, which is exactly what a client receiving whole frames does.
        let buffer: IMFMediaBuffer = MFCreateMemoryBuffer(data.len() as u32)?;
        let mut ptr = std::ptr::null_mut();
        buffer.Lock(&mut ptr, None, None)?;
        std::ptr::copy_nonoverlapping(data.as_ptr(), ptr, data.len());
        buffer.Unlock()?;
        buffer.SetCurrentLength(data.len() as u32)?;
        let sample: IMFSample = MFCreateSample()?;
        sample.AddBuffer(&buffer)?;
        sample.SetSampleTime(0)?;

        if let Err(e) = decoder.ProcessInput(0, &sample, 0) {
            eprintln!("decoder REJECTED the stream: {e}");
            std::process::exit(1);
        }
        decoder.ProcessMessage(MFT_MESSAGE_COMMAND_DRAIN, 0)?;

        let mut decoded = 0u64;
        let mut width = 0u32;
        let mut height = 0u32;
        loop {
            let info = decoder.GetOutputStreamInfo(0)?;
            let provides = info.dwFlags
                & (MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32
                    | MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES.0 as u32)
                != 0;

            let mut out = [MFT_OUTPUT_DATA_BUFFER::default(); 1];
            if !provides {
                let buf: IMFMediaBuffer = MFCreateMemoryBuffer(info.cbSize.max(1))?;
                let s: IMFSample = MFCreateSample()?;
                s.AddBuffer(&buf)?;
                out[0].pSample = std::mem::ManuallyDrop::new(Some(s));
            }
            let mut status = 0u32;
            match decoder.ProcessOutput(0, &mut out, &mut status) {
                Ok(()) => {
                    decoded += 1;
                    let _ = std::mem::ManuallyDrop::take(&mut out[0].pSample);
                }
                Err(e) if e.code() == MF_E_TRANSFORM_NEED_MORE_INPUT => break,
                Err(e) if e.code() == MF_E_TRANSFORM_STREAM_CHANGE => {
                    // The decoder has read the SPS and is telling us the real
                    // frame size. Renegotiating here is not optional — refusing
                    // it stalls the decoder permanently.
                    let mut j = 0;
                    loop {
                        let Ok(t) = decoder.GetOutputAvailableType(0, j) else { break };
                        if t.GetGUID(&MF_MT_SUBTYPE) == Ok(MFVideoFormat_NV12) {
                            if let Ok(size) = t.GetUINT64(&MF_MT_FRAME_SIZE) {
                                width = (size >> 32) as u32;
                                height = size as u32;
                            }
                            decoder.SetOutputType(0, &t, 0)?;
                            break;
                        }
                        j += 1;
                    }
                    let _ = std::mem::ManuallyDrop::take(&mut out[0].pSample);
                }
                Err(e) => {
                    let _ = std::mem::ManuallyDrop::take(&mut out[0].pSample);
                    eprintln!("decode failed after {decoded} frames: {e}");
                    std::process::exit(1);
                }
            }
        }

        println!("  decoded {decoded} frames at {width}x{height}");
        if decoded == 0 {
            eprintln!("FAILED: the decoder accepted the stream but produced no pictures");
            std::process::exit(1);
        }
        println!("  OK — a real hardware-class decoder accepts this stream");
    }
    Ok(())
}
