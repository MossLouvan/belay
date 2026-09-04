//! The BWP client, over a C ABI.
//!
//! The protocol exists once, in Rust, tested. Reimplementing it in Swift for
//! iOS and Kotlin for Android would mean three implementations that must agree
//! byte-for-byte forever — on sequence wrapping, on the replay window, on the
//! frame-drop rule, on nonce construction. They would not agree, and the ways
//! they disagreed would show up as "the video is sometimes corrupt on iOS",
//! which is close to the hardest class of bug to chase.
//!
//! So the client links the same code the host was tested against, and the
//! platform layer does only what it alone can do: decode H.264 with the
//! hardware decoder, and put pixels on the screen.
//!
//! # Safety contract for callers
//!
//! * `belay_client_open` returns an opaque handle, or null on failure.
//! * Every other function takes that handle. Passing anything else, or a handle
//!   after `belay_client_close`, is undefined behaviour.
//! * A handle is **not** thread-safe. Call into one handle from one thread, or
//!   serialise the calls yourself. This is the normal shape for a client: one
//!   receive thread owns the session.
//! * Buffers handed out by `belay_client_next_frame` are owned by the handle
//!   and valid only until the next call on that handle.

use std::ffi::{c_char, c_int, c_void, CStr};
use std::net::SocketAddr;

use belay_net::{Event, Session};
use belay_wire::congestion::BitratePreset;
use belay_wire::crypto::Direction;
use belay_wire::cursor::CursorSample;
use belay_wire::packet::Channel;

/// Result codes. Zero is success; negatives are failures, and each names a
/// distinct cause so a caller can report something better than "it failed".
pub const BELAY_OK: c_int = 0;
pub const BELAY_ERR_ARGS: c_int = -1;
pub const BELAY_ERR_BIND: c_int = -2;
pub const BELAY_ERR_SESSION: c_int = -3;

/// `next_frame` outcomes.
pub const BELAY_FRAME_NONE: c_int = 0;
pub const BELAY_FRAME_VIDEO: c_int = 1;
pub const BELAY_FRAME_CURSOR: c_int = 2;
pub const BELAY_FRAME_BITRATE: c_int = 3;

/// What a poll produced, filled in by the callee.
#[repr(C)]
pub struct BelayFrame {
    /// One of the BELAY_FRAME_* constants.
    pub kind: c_int,
    /// Video only. Owned by the handle; valid until the next call.
    pub data: *const u8,
    pub len: usize,
    /// Video only: non-zero when this frame can start a decode.
    pub keyframe: c_int,
    /// Cursor only.
    pub cursor_x: i32,
    pub cursor_y: i32,
    pub cursor_visible: c_int,
    /// Bitrate events only.
    pub bitrate_bps: u64,
}

impl Default for BelayFrame {
    fn default() -> Self {
        BelayFrame {
            kind: BELAY_FRAME_NONE,
            data: std::ptr::null(),
            len: 0,
            keyframe: 0,
            cursor_x: 0,
            cursor_y: 0,
            cursor_visible: 0,
            bitrate_bps: 0,
        }
    }
}

pub struct BelayClient {
    session: Session,
    /// Events already pulled from the socket but not yet handed to the caller.
    ///
    /// One `poll` can return many events; a C API that returns one frame per
    /// call must not drop the rest. Dropping them would silently lose video —
    /// the exact failure that looks like "the stream stutters" and is
    /// impossible to attribute.
    pending: std::collections::VecDeque<Event>,
    /// Backing store for the buffer handed out by the last `next_frame`. Held
    /// so the pointer stays valid for the documented lifetime.
    last_frame: Vec<u8>,
}

fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 || s.is_empty() {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

/// Read a C string, refusing anything not valid UTF-8 rather than guessing.
///
/// # Safety
/// `p` must be null or a valid NUL-terminated C string.
unsafe fn cstr(p: *const c_char) -> Option<&'static str> {
    if p.is_null() {
        return None;
    }
    CStr::from_ptr(p).to_str().ok()
}

/// Open a session.
///
/// `bind` and `peer` are addresses like "0.0.0.0:41234". `key_hex` and
/// `salt_hex` come from the host's `bwpOffer` over the authenticated control
/// channel. `preset` is one of auto/data-saver/balanced/high/max.
///
/// Returns null on any failure. The handle must be released with
/// `belay_client_close`.
///
/// # Safety
/// All pointer arguments must be null or valid NUL-terminated C strings.
#[no_mangle]
pub unsafe extern "C" fn belay_client_open(
    bind: *const c_char,
    peer: *const c_char,
    key_hex: *const c_char,
    salt_hex: *const c_char,
    preset: *const c_char,
) -> *mut c_void {
    let (Some(bind), Some(peer), Some(key_hex), Some(salt_hex)) =
        (cstr(bind), cstr(peer), cstr(key_hex), cstr(salt_hex))
    else {
        return std::ptr::null_mut();
    };
    let (Ok(bind), Ok(peer)) = (bind.parse::<SocketAddr>(), peer.parse::<SocketAddr>()) else {
        return std::ptr::null_mut();
    };
    let Some(key) = hex_decode(key_hex) else { return std::ptr::null_mut() };
    // The session's whole confidentiality rests on this key. A short one means
    // short keys derived from a placeholder, so refuse rather than proceed.
    if key.len() < 16 {
        return std::ptr::null_mut();
    }
    let Some(salt_vec) = hex_decode(salt_hex) else { return std::ptr::null_mut() };
    let Ok(salt) = <[u8; 8]>::try_from(salt_vec.as_slice()) else {
        return std::ptr::null_mut();
    };
    let preset = cstr(preset).and_then(BitratePreset::parse).unwrap_or(BitratePreset::Auto);

    // ClientToHost: the mirror of the host's direction, so both derive the same
    // pair of directional keys.
    let Ok(session) = Session::bind(bind, peer, &key, salt, Direction::ClientToHost, preset) else {
        return std::ptr::null_mut();
    };

    let client = Box::new(BelayClient {
        session,
        pending: std::collections::VecDeque::new(),
        last_frame: Vec::new(),
    });
    Box::into_raw(client) as *mut c_void
}

/// The local UDP port, needed because the client usually binds port 0 and must
/// tell the host where to send. Returns 0 if unknown.
///
/// # Safety
/// `handle` must be a live handle from `belay_client_open`.
#[no_mangle]
pub unsafe extern "C" fn belay_client_local_port(handle: *mut c_void) -> u16 {
    let Some(client) = (handle as *mut BelayClient).as_ref() else { return 0 };
    client.session.local_addr().map(|a| a.port()).unwrap_or(0)
}

/// Pull the next event. Never blocks.
///
/// Returns the frame kind, or a negative error code. `BELAY_FRAME_NONE` means
/// nothing was ready — the normal case between frames, not an error.
///
/// # Safety
/// `handle` must be live and `out` must point at a writable `BelayFrame`.
#[no_mangle]
pub unsafe extern "C" fn belay_client_next_frame(
    handle: *mut c_void,
    out: *mut BelayFrame,
) -> c_int {
    let Some(client) = (handle as *mut BelayClient).as_mut() else { return BELAY_ERR_ARGS };
    if out.is_null() {
        return BELAY_ERR_ARGS;
    }
    *out = BelayFrame::default();

    if client.pending.is_empty() {
        match client.session.poll() {
            Ok(events) => client.pending.extend(events),
            Err(_) => return BELAY_ERR_SESSION,
        }
    }

    while let Some(event) = client.pending.pop_front() {
        match event {
            Event::Frame { channel: Channel::Video, payload, keyframe, .. } => {
                client.last_frame = payload;
                (*out).kind = BELAY_FRAME_VIDEO;
                (*out).data = client.last_frame.as_ptr();
                (*out).len = client.last_frame.len();
                (*out).keyframe = i32::from(keyframe);
                return BELAY_FRAME_VIDEO;
            }
            Event::Frame { channel: Channel::Cursor, payload, .. } => {
                let Some(s) = CursorSample::decode(&payload) else { continue };
                (*out).kind = BELAY_FRAME_CURSOR;
                (*out).cursor_x = s.x as i32;
                (*out).cursor_y = s.y as i32;
                (*out).cursor_visible = i32::from(s.visible);
                return BELAY_FRAME_CURSOR;
            }
            Event::Bitrate { bps } => {
                (*out).kind = BELAY_FRAME_BITRATE;
                (*out).bitrate_bps = bps;
                return BELAY_FRAME_BITRATE;
            }
            // Channels the client does not consume, and a keyframe request the
            // host makes of itself. Skipped rather than returned so a caller
            // never has to know about them.
            Event::Frame { .. } | Event::KeyframeNeeded => continue,
        }
    }
    BELAY_FRAME_NONE
}

/// The bitrate the controller has settled on, for display.
///
/// # Safety
/// `handle` must be a live handle from `belay_client_open`.
#[no_mangle]
pub unsafe extern "C" fn belay_client_bitrate(handle: *mut c_void) -> u64 {
    let Some(client) = (handle as *mut BelayClient).as_ref() else { return 0 };
    client.session.bitrate_bps()
}

/// Release the handle. Safe to call with null. Calling twice is not safe.
///
/// # Safety
/// `handle` must be null, or a handle from `belay_client_open` not yet closed.
#[no_mangle]
pub unsafe extern "C" fn belay_client_close(handle: *mut c_void) {
    if handle.is_null() {
        return;
    }
    drop(Box::from_raw(handle as *mut BelayClient));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CString;

    fn c(s: &str) -> CString {
        CString::new(s).unwrap()
    }

    const KEY: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
    const SALT: &str = "0102030405060708";

    #[test]
    fn a_valid_configuration_opens_and_reports_its_port() {
        unsafe {
            let h = belay_client_open(
                c("127.0.0.1:0").as_ptr(),
                c("127.0.0.1:59999").as_ptr(),
                c(KEY).as_ptr(),
                c(SALT).as_ptr(),
                c("high").as_ptr(),
            );
            assert!(!h.is_null());
            assert_ne!(belay_client_local_port(h), 0, "must report the bound port");
            belay_client_close(h);
        }
    }

    #[test]
    fn null_and_malformed_arguments_return_null_rather_than_crashing() {
        unsafe {
            let good_bind = c("127.0.0.1:0");
            let good_peer = c("127.0.0.1:59999");
            let key = c(KEY);
            let salt = c(SALT);

            assert!(belay_client_open(
                std::ptr::null(),
                good_peer.as_ptr(),
                key.as_ptr(),
                salt.as_ptr(),
                std::ptr::null()
            )
            .is_null());
            assert!(belay_client_open(
                c("not-an-address").as_ptr(),
                good_peer.as_ptr(),
                key.as_ptr(),
                salt.as_ptr(),
                std::ptr::null()
            )
            .is_null());
            assert!(belay_client_open(
                good_bind.as_ptr(),
                good_peer.as_ptr(),
                c("zzzz").as_ptr(),
                salt.as_ptr(),
                std::ptr::null()
            )
            .is_null());
            // A salt of the wrong length must fail, not be padded.
            assert!(belay_client_open(
                good_bind.as_ptr(),
                good_peer.as_ptr(),
                key.as_ptr(),
                c("0102").as_ptr(),
                std::ptr::null()
            )
            .is_null());
        }
    }

    /// A placeholder key must fail loudly rather than derive weak keys in
    /// silence — the same rule the host applies to its side.
    #[test]
    fn a_short_key_is_refused() {
        unsafe {
            let h = belay_client_open(
                c("127.0.0.1:0").as_ptr(),
                c("127.0.0.1:59999").as_ptr(),
                c("aabb").as_ptr(),
                c(SALT).as_ptr(),
                std::ptr::null(),
            );
            assert!(h.is_null());
        }
    }

    #[test]
    fn polling_an_idle_session_reports_nothing_rather_than_an_error() {
        unsafe {
            let h = belay_client_open(
                c("127.0.0.1:0").as_ptr(),
                c("127.0.0.1:59999").as_ptr(),
                c(KEY).as_ptr(),
                c(SALT).as_ptr(),
                std::ptr::null(),
            );
            let mut frame = BelayFrame::default();
            assert_eq!(belay_client_next_frame(h, &mut frame), BELAY_FRAME_NONE);
            assert_eq!(frame.kind, BELAY_FRAME_NONE);
            belay_client_close(h);
        }
    }

    #[test]
    fn a_null_handle_is_an_argument_error_not_a_crash() {
        unsafe {
            let mut frame = BelayFrame::default();
            assert_eq!(
                belay_client_next_frame(std::ptr::null_mut(), &mut frame),
                BELAY_ERR_ARGS
            );
            let h = belay_client_open(
                c("127.0.0.1:0").as_ptr(),
                c("127.0.0.1:59999").as_ptr(),
                c(KEY).as_ptr(),
                c(SALT).as_ptr(),
                std::ptr::null(),
            );
            assert_eq!(belay_client_next_frame(h, std::ptr::null_mut()), BELAY_ERR_ARGS);
            belay_client_close(h);
            // Closing null must be a no-op, since cleanup paths will do it.
            belay_client_close(std::ptr::null_mut());
        }
    }

    /// The end-to-end shape: a real host session sending to a real client
    /// handle over loopback. This is what proves the C layer does not lose
    /// frames between `poll` and the caller.
    #[test]
    fn frames_from_a_real_host_reach_the_c_api() {
        use belay_wire::crypto::Direction;
        use std::net::UdpSocket;

        let key = hex_decode(KEY).unwrap();
        let salt: [u8; 8] = hex_decode(SALT).unwrap().try_into().unwrap();

        // Reserve two ports the way the real client does.
        let probe = UdpSocket::bind("127.0.0.1:0").unwrap();
        let client_addr = probe.local_addr().unwrap();
        drop(probe);
        let probe = UdpSocket::bind("127.0.0.1:0").unwrap();
        let host_addr = probe.local_addr().unwrap();
        drop(probe);

        let mut host = Session::bind(
            host_addr,
            client_addr,
            &key,
            salt,
            Direction::HostToClient,
            BitratePreset::Max,
        )
        .unwrap();

        unsafe {
            let h = belay_client_open(
                c(&client_addr.to_string()).as_ptr(),
                c(&host_addr.to_string()).as_ptr(),
                c(KEY).as_ptr(),
                c(SALT).as_ptr(),
                c("max").as_ptr(),
            );
            assert!(!h.is_null());

            // Bigger than one datagram, so fragmentation and reassembly are
            // exercised rather than assumed.
            let payload: Vec<u8> = (0..5000).map(|i| (i % 251) as u8).collect();
            host.send_frame(Channel::Video, &payload, true).unwrap();
            host.send_frame(Channel::Cursor, &{
                let s = CursorSample {
                    x: 640,
                    y: 480,
                    shape_id: 1,
                    hot_x: 0,
                    hot_y: 0,
                    visible: true,
                    send_us: 1234,
                };
                let mut b = [0u8; CursorSample::WIRE_LEN];
                s.encode(&mut b);
                b
            }, false)
            .unwrap();

            std::thread::sleep(std::time::Duration::from_millis(60));

            let mut got_video = false;
            let mut got_cursor = false;
            for _ in 0..16 {
                let mut frame = BelayFrame::default();
                match belay_client_next_frame(h, &mut frame) {
                    BELAY_FRAME_VIDEO => {
                        let data = std::slice::from_raw_parts(frame.data, frame.len);
                        assert_eq!(data, &payload[..], "must arrive byte-for-byte");
                        assert_eq!(frame.keyframe, 1);
                        got_video = true;
                    }
                    BELAY_FRAME_CURSOR => {
                        assert_eq!(frame.cursor_x, 640);
                        assert_eq!(frame.cursor_y, 480);
                        assert_eq!(frame.cursor_visible, 1);
                        got_cursor = true;
                    }
                    BELAY_FRAME_NONE => {}
                    other => panic!("unexpected result {other}"),
                }
                if got_video && got_cursor {
                    break;
                }
            }
            assert!(got_video, "video must reach the C API");
            assert!(got_cursor, "cursor must reach the C API");
            belay_client_close(h);
        }
    }
}
