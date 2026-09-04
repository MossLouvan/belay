//! The cursor fast path — the most visible latency win in the protocol.
//!
//! Today the cursor is composited *into* the JPEG frame (`Native.DrawCursor` in
//! BelayHost.cs). That means cursor motion costs a whole frame: at the default
//! 12 fps, up to 83 ms of lag on the one element the eye tracks continuously
//! and the one the hand is steering. It is the single biggest reason a remote
//! desktop feels remote even when the picture is fine.
//!
//! Splitting the cursor onto its own unreliable, newest-wins channel lets it
//! move at sampling rate (say 120 Hz, 16 bytes a sample — under 20 kbit/s)
//! while video continues at frame rate. The client draws it locally over the
//! last decoded frame.
//!
//! Two rules make it feel direct rather than merely frequent:
//!
//! 1. **Newest wins, always.** An out-of-order cursor sample is not reordered,
//!    it is discarded. A position from 30 ms ago is not information; drawing it
//!    would move the cursor backwards.
//! 2. **Never retransmit.** The repair for a lost sample is the next sample,
//!    which is already in flight and more current than the one that was lost.

use crate::packet::seq_newer;

/// A cursor sample. 16 bytes on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CursorSample {
    /// Position in virtual-desktop pixels.
    pub x: i16,
    pub y: i16,
    /// Identifies the cursor bitmap so the client can cache shapes and the host
    /// need not resend them. 0 means "unchanged from whatever you have".
    pub shape_id: u16,
    /// Hotspot within the shape.
    pub hot_x: i16,
    pub hot_y: i16,
    /// False while the cursor is hidden (fullscreen video, text caret, etc).
    pub visible: bool,
    /// Sender clock, microseconds — for measuring cursor-specific latency
    /// separately from video, since they now travel independently.
    pub send_us: u32,
}

impl CursorSample {
    pub const WIRE_LEN: usize = 16;

    pub fn encode(&self, out: &mut [u8]) -> usize {
        assert!(out.len() >= Self::WIRE_LEN);
        out[0..2].copy_from_slice(&self.x.to_le_bytes());
        out[2..4].copy_from_slice(&self.y.to_le_bytes());
        out[4..6].copy_from_slice(&self.shape_id.to_le_bytes());
        out[6..8].copy_from_slice(&self.hot_x.to_le_bytes());
        out[8..10].copy_from_slice(&self.hot_y.to_le_bytes());
        out[10] = self.visible as u8;
        out[11] = 0; // reserved
        out[12..16].copy_from_slice(&self.send_us.to_le_bytes());
        Self::WIRE_LEN
    }

    pub fn decode(buf: &[u8]) -> Option<CursorSample> {
        if buf.len() < Self::WIRE_LEN {
            return None;
        }
        Some(CursorSample {
            x: i16::from_le_bytes([buf[0], buf[1]]),
            y: i16::from_le_bytes([buf[2], buf[3]]),
            shape_id: u16::from_le_bytes([buf[4], buf[5]]),
            hot_x: i16::from_le_bytes([buf[6], buf[7]]),
            hot_y: i16::from_le_bytes([buf[8], buf[9]]),
            visible: buf[10] != 0,
            send_us: u32::from_le_bytes([buf[12], buf[13], buf[14], buf[15]]),
        })
    }
}

/// Receiver-side newest-wins gate.
#[derive(Debug, Default)]
pub struct CursorTrack {
    latest: Option<CursorSample>,
    latest_seq: Option<u32>,
    pub accepted: u64,
    pub rejected_stale: u64,
}

impl CursorTrack {
    pub fn new() -> Self {
        Self::default()
    }

    /// Offer a sample. Returns true when it is newer and was taken.
    pub fn offer(&mut self, sequence: u32, sample: CursorSample) -> bool {
        let newer = match self.latest_seq {
            None => true,
            Some(prev) => seq_newer(sequence, prev),
        };
        if !newer {
            // Deliberately dropped, not buffered: a stale position is not
            // information, and applying it would move the cursor backwards.
            self.rejected_stale += 1;
            return false;
        }
        self.latest_seq = Some(sequence);
        self.latest = Some(sample);
        self.accepted += 1;
        true
    }

    pub fn latest(&self) -> Option<CursorSample> {
        self.latest
    }
}

/// Sender-side sampling gate: emit only when something actually changed, and
/// never faster than the configured interval.
///
/// A cursor that is not moving costs nothing. A cursor that is moving costs
/// 16 bytes per sample, which at 120 Hz is under 20 kbit/s — negligible next to
/// video, and the reason it can be given strict priority over it.
#[derive(Debug)]
pub struct CursorSampler {
    last_sent: Option<CursorSample>,
    last_send_us: u32,
    min_interval_us: u32,
}

impl CursorSampler {
    /// `max_hz` caps the sample rate. 120 is a good default: past roughly the
    /// display's refresh rate the extra samples cannot be shown.
    pub fn new(max_hz: u32) -> Self {
        let hz = max_hz.clamp(1, 1000);
        CursorSampler { last_sent: None, last_send_us: 0, min_interval_us: 1_000_000 / hz }
    }

    /// Should this sample go on the wire now?
    pub fn should_send(&mut self, sample: CursorSample, now_us: u32) -> bool {
        let changed = match self.last_sent {
            None => true,
            Some(prev) => {
                prev.x != sample.x
                    || prev.y != sample.y
                    || prev.visible != sample.visible
                    || (sample.shape_id != 0 && prev.shape_id != sample.shape_id)
            }
        };
        if !changed {
            return false;
        }
        // wrapping_sub so the microsecond clock rolling over does not stall the
        // cursor for an hour.
        if self.last_sent.is_some() && now_us.wrapping_sub(self.last_send_us) < self.min_interval_us
        {
            return false;
        }
        self.last_sent = Some(sample);
        self.last_send_us = now_us;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(x: i16, y: i16) -> CursorSample {
        CursorSample { x, y, shape_id: 1, hot_x: 0, hot_y: 0, visible: true, send_us: 0 }
    }

    #[test]
    fn sample_round_trips() {
        let a = CursorSample {
            x: -300,
            y: 1080,
            shape_id: 7,
            hot_x: 4,
            hot_y: 9,
            visible: false,
            send_us: 123_456,
        };
        let mut buf = [0u8; CursorSample::WIRE_LEN];
        a.encode(&mut buf);
        assert_eq!(CursorSample::decode(&buf), Some(a));
        assert_eq!(CursorSample::decode(&buf[..4]), None);
    }

    #[test]
    fn a_sample_costs_16_bytes() {
        // The whole argument for prioritising cursor over video rests on it
        // being tiny. 120 Hz * 16 B = ~15 kbit/s.
        assert_eq!(CursorSample::WIRE_LEN, 16);
    }

    #[test]
    fn newest_wins_and_stale_samples_are_discarded_not_reordered() {
        let mut t = CursorTrack::new();
        assert!(t.offer(10, s(100, 100)));
        assert!(t.offer(11, s(110, 100)));
        // Arrives late, out of order: must NOT move the cursor backwards.
        assert!(!t.offer(10, s(100, 100)));
        assert_eq!(t.latest(), Some(s(110, 100)));
        assert_eq!(t.rejected_stale, 1);
    }

    #[test]
    fn newest_wins_survives_sequence_wrap() {
        let mut t = CursorTrack::new();
        assert!(t.offer(u32::MAX, s(1, 1)));
        assert!(t.offer(0, s(2, 2)), "0 follows u32::MAX, it does not precede it");
        assert_eq!(t.latest(), Some(s(2, 2)));
    }

    #[test]
    fn an_idle_cursor_costs_nothing() {
        let mut g = CursorSampler::new(120);
        assert!(g.should_send(s(5, 5), 0));
        assert!(!g.should_send(s(5, 5), 1_000_000), "unchanged position sends nothing");
    }

    #[test]
    fn sampling_is_rate_limited() {
        let mut g = CursorSampler::new(100); // 10ms minimum interval
        assert!(g.should_send(s(0, 0), 0));
        assert!(!g.should_send(s(1, 0), 5_000), "too soon");
        assert!(g.should_send(s(2, 0), 10_000), "interval elapsed");
    }

    #[test]
    fn visibility_and_shape_changes_always_get_through() {
        let mut g = CursorSampler::new(100);
        g.should_send(s(0, 0), 0);
        let mut hidden = s(0, 0);
        hidden.visible = false;
        assert!(g.should_send(hidden, 10_000), "hiding the cursor is a real change");

        let mut reshaped = hidden;
        reshaped.visible = true;
        reshaped.shape_id = 42;
        assert!(g.should_send(reshaped, 20_000));
    }

    #[test]
    fn a_wrapping_microsecond_clock_does_not_stall_the_cursor() {
        let mut g = CursorSampler::new(100);
        assert!(g.should_send(s(0, 0), u32::MAX - 5_000));
        // Clock wraps past zero; the gap is really 10ms, not ~71 minutes.
        assert!(g.should_send(s(1, 0), 5_000));
    }
}
