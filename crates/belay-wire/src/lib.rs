//! BWP — the Belay Wire Protocol.
//!
//! A datagram protocol for remote desktop: framing, fragmentation, reassembly
//! with a frame-aware loss policy, bitrate control, and a cursor fast path.
//!
//! **This crate owns no sockets, no encoder and no clock.** Everything here is
//! bytes and arithmetic, so every rule is exercised under `cargo test` with no
//! network, no GPU, no phone and no VM. That is the same discipline that made
//! the WebRTC slice in `app/src/stream/webrtc/` testable, and it is deliberate:
//! the parts of a transport that are hardest to get right — loss policy,
//! congestion control, staleness, bounds — are exactly the parts that are
//! miserable to debug over a real link.
//!
//! The host layer above supplies the UDP socket, the encoder, the clock and the
//! AEAD. See `docs/WIRE-PROTOCOL.md` for the design and, importantly, for an
//! honest account of what building our own transport costs versus finishing the
//! WebRTC path that already exists in this tree.
//!
//! # Status
//!
//! Not wired into the shipping path. JPEG-over-WebSocket remains the default
//! until BWP beats it on the loss-lab bar in `docs/PERFORMANCE-PLAN.md`
//! (p50 ≤ 40 ms, p95 ≤ 60 ms on LAN/Tailscale-direct), measured on real
//! hardware — the dev VM has no GPU and therefore no hardware encoder, so any
//! latency number taken there would misrepresent the product.

#![forbid(unsafe_code)]
#![warn(missing_debug_implementations)]

pub mod congestion;
pub mod crypto;
pub mod cursor;
pub mod packet;
pub mod reassembly;

pub use congestion::{AbrConfig, AbrState, BitratePreset, LinkFeedback};
pub use crypto::{CryptoError, Direction, DirectionKey, ReplayWindow};
pub use cursor::{CursorSample, CursorSampler, CursorTrack};
pub use packet::{Channel, Header, DecodeError, HEADER_LEN, MAX_DATAGRAM, MAX_PAYLOAD, VERSION};
pub use reassembly::{Accepted, DropReason, Reassembler};

#[cfg(test)]
mod integration {
    //! End-to-end over a simulated lossy, reordering link.
    //!
    //! This is the loss-lab idea from `app/src/stream/webrtc/loss-lab.ts`
    //! carried over: a deterministic, seeded channel, so a regression in the
    //! loss policy shows up as a failing test rather than as a bad call three
    //! months later.

    use super::*;
    use crate::packet::{flags, fragment_count, fragment_range};

    /// Deterministic pseudo-random source. Seeded, so failures reproduce.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            // xorshift64*
            let mut x = self.0;
            x ^= x >> 12;
            x ^= x << 25;
            x ^= x >> 27;
            self.0 = x;
            x.wrapping_mul(0x2545_F491_4F6C_DD1D)
        }
        /// True with probability `p`.
        fn chance(&mut self, p: f64) -> bool {
            (self.next() % 10_000) as f64 / 10_000.0 < p
        }
    }

    /// Fragment a frame into (header, payload) datagrams.
    fn emit(frame_id: u32, seq0: u32, body: &[u8], keyframe: bool) -> Vec<(Header, Vec<u8>)> {
        let count = fragment_count(body.len());
        (0..count)
            .map(|i| {
                let (s, e) = fragment_range(body.len(), i);
                let mut f = 0u8;
                if keyframe {
                    f |= flags::KEYFRAME;
                }
                if i == count - 1 {
                    f |= flags::FRAME_END;
                }
                (
                    Header {
                        channel: Channel::Video,
                        flags: f,
                        sequence: seq0.wrapping_add(i as u32),
                        frame_id,
                        frag_index: i,
                        frag_count: count,
                        send_us: 0,
                    },
                    body[s..e].to_vec(),
                )
            })
            .collect()
    }

    #[test]
    fn a_clean_link_delivers_every_frame_byte_for_byte() {
        let mut r = Reassembler::new();
        let mut seq = 0u32;
        for id in 1..=20u32 {
            let body: Vec<u8> = (0..5000).map(|i| (i as u8).wrapping_add(id as u8)).collect();
            let dgrams = emit(id, seq, &body, id == 1);
            seq = seq.wrapping_add(dgrams.len() as u32);
            let mut done = None;
            for (h, p) in &dgrams {
                if let Accepted::Complete { payload, .. } = r.push(h, p) {
                    done = Some(payload);
                }
            }
            assert_eq!(done.as_deref(), Some(&body[..]), "frame {id} must arrive intact");
        }
        assert_eq!(r.stats().frames_completed, 20);
    }

    #[test]
    fn reordering_alone_loses_nothing() {
        let mut r = Reassembler::new();
        let body: Vec<u8> = (0..4000).map(|i| i as u8).collect();
        let mut dgrams = emit(1, 0, &body, true);
        dgrams.reverse();

        let mut done = None;
        for (h, p) in &dgrams {
            if let Accepted::Complete { payload, .. } = r.push(h, p) {
                done = Some(payload);
            }
        }
        assert_eq!(done.as_deref(), Some(&body[..]));
    }

    /// The behaviour that matters under loss: incomplete frames must not pile
    /// up, and a keyframe must clear the backlog so recovery is immediate.
    #[test]
    fn under_heavy_loss_a_keyframe_restores_delivery() {
        let mut rng = Rng(0xBE1A_9000);
        let mut r = Reassembler::new();
        let body: Vec<u8> = (0..8000).map(|i| i as u8).collect();
        let mut seq = 0u32;

        // 30% loss on delta frames: most will never complete.
        for id in 1..=12u32 {
            let dgrams = emit(id, seq, &body, false);
            seq = seq.wrapping_add(dgrams.len() as u32);
            for (h, p) in &dgrams {
                if !rng.chance(0.30) {
                    r.push(h, p);
                }
            }
        }
        assert!(
            r.nack_list(Channel::Video).len() <= reassembly::MAX_PENDING_FRAMES,
            "partial frames must stay bounded under sustained loss"
        );

        // A clean keyframe: delivery resumes and the backlog is discarded.
        let dgrams = emit(100, seq, &body, true);
        let mut done = None;
        for (h, p) in &dgrams {
            if let Accepted::Complete { payload, .. } = r.push(h, p) {
                done = Some(payload);
            }
        }
        assert_eq!(done.as_deref(), Some(&body[..]), "keyframe must get through");
        assert!(
            r.nack_list(Channel::Video).is_empty(),
            "the keyframe supersedes every stalled older frame"
        );
    }

    /// The controller and the loss policy have to agree: a link that is losing
    /// packets should end up sending less, not oscillating.
    #[test]
    fn sustained_loss_drives_the_bitrate_down_and_recovery_brings_it_back() {
        let cfg = AbrConfig::default();
        let mut st = AbrState::new(8_000_000, &cfg);

        for _ in 0..20 {
            st = st.next(LinkFeedback { loss_ratio: 0.20, rtt_ms: 60.0 }, &cfg);
        }
        let bottom = st.bitrate_bps;
        assert!(bottom < 2_000_000, "20% loss must back off hard, got {bottom}");

        for _ in 0..60 {
            st = st.next(LinkFeedback { loss_ratio: 0.0, rtt_ms: 20.0 }, &cfg);
        }
        assert!(st.bitrate_bps > bottom * 4, "a recovered link must climb back");
        assert!(st.bitrate_bps <= cfg.max_bps);
    }

    /// The cursor path must stay current under exactly the conditions that
    /// wreck video: loss and reordering. Its correctness is "shows the newest
    /// position", not "shows every position".
    #[test]
    fn cursor_stays_current_under_loss_and_reordering() {
        let mut rng = Rng(0x0C0F_FEE0);
        let mut track = CursorTrack::new();

        let mut delivered: Vec<(u32, CursorSample)> = Vec::new();
        for i in 0..200u32 {
            let sample = CursorSample {
                x: i as i16,
                y: (i * 2) as i16,
                shape_id: 1,
                hot_x: 0,
                hot_y: 0,
                visible: true,
                send_us: i * 1000,
            };
            if !rng.chance(0.25) {
                delivered.push((i, sample));
            }
        }
        // Shuffle crudely: swap neighbours to model reordering.
        for i in (1..delivered.len()).step_by(2) {
            delivered.swap(i - 1, i);
        }

        let newest_seq = delivered.iter().map(|(s, _)| *s).max().unwrap();
        for (seq, sample) in delivered {
            track.offer(seq, sample);
        }

        let latest = track.latest().expect("something got through");
        assert_eq!(
            latest.x, newest_seq as i16,
            "the cursor must end on the newest sample that arrived, never an older one"
        );
    }
}
