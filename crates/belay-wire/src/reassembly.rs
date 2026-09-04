//! Frame reassembly with a frame-aware loss policy.
//!
//! A generic transport retransmits anything lost. This one asks a second
//! question first: **is the loss still worth repairing?** A fragment of a frame
//! that has already been superseded by a newer keyframe is worthless — spending
//! the link to deliver it delays the frame the viewer is actually waiting for.
//! Knowing that requires understanding frames, which is precisely what a
//! generic transport cannot do and why owning this layer is worth anything.
//!
//! Bounded by construction: a fixed number of in-flight frames, each with a
//! fixed fragment ceiling. A peer cannot make this allocate without limit by
//! announcing enormous frames or never finishing the ones it starts.

use crate::packet::{seq_newer, Channel, Header, MAX_PAYLOAD};
use std::collections::HashMap;

/// How many partially-received frames to track at once. Beyond a couple of
/// frames of jitter, an unfinished frame is late enough to be worthless.
pub const MAX_PENDING_FRAMES: usize = 8;

/// Ceiling on fragments per frame. 512 * 1184B ≈ 600 KB, comfortably more than
/// a 1080p keyframe and far less than an allocation worth worrying about.
pub const MAX_FRAGMENTS: u16 = 512;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Accepted {
    /// Fragment stored; the frame is still incomplete.
    Partial { frame_id: u32, have: u16, need: u16 },
    /// Frame is complete; payload is returned in order.
    Complete { frame_id: u32, keyframe: bool, payload: Vec<u8> },
    /// Deliberately dropped, with the reason.
    Dropped(DropReason),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DropReason {
    /// Older than a frame already delivered — the viewer has moved on.
    Stale,
    /// A duplicate of a fragment already held.
    Duplicate,
    /// frag_count exceeds MAX_FRAGMENTS.
    TooManyFragments,
    /// Payload longer than a datagram permits.
    Oversize,
    /// Evicted to make room for newer frames.
    Evicted,
}

#[derive(Debug)]
struct Pending {
    frag_count: u16,
    keyframe: bool,
    /// Fragment slots. `None` until that fragment arrives.
    parts: Vec<Option<Vec<u8>>>,
    have: u16,
    /// Highest sequence seen for this frame, for age comparisons.
    newest_seq: u32,
}

impl Pending {
    fn missing(&self) -> Vec<u16> {
        self.parts
            .iter()
            .enumerate()
            .filter_map(|(i, p)| if p.is_none() { Some(i as u16) } else { None })
            .collect()
    }
}

/// Reassembles one channel's frames.
#[derive(Debug, Default)]
pub struct Reassembler {
    pending: HashMap<u32, Pending>,
    /// Newest frame id fully delivered, if any.
    delivered: Option<u32>,
    /// Newest keyframe id seen, for the supersede rule.
    newest_keyframe: Option<u32>,
    stats: ReassemblyStats,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct ReassemblyStats {
    pub frames_completed: u64,
    pub frames_dropped: u64,
    pub fragments_accepted: u64,
    pub fragments_duplicate: u64,
}

impl Reassembler {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn stats(&self) -> ReassemblyStats {
        self.stats
    }

    pub fn push(&mut self, header: &Header, payload: &[u8]) -> Accepted {
        if payload.len() > MAX_PAYLOAD {
            self.stats.frames_dropped += 1;
            return Accepted::Dropped(DropReason::Oversize);
        }
        if header.frag_count > MAX_FRAGMENTS {
            self.stats.frames_dropped += 1;
            return Accepted::Dropped(DropReason::TooManyFragments);
        }

        // Already delivered this frame, or one after it: the viewer has moved
        // on and this fragment can only make things later.
        if let Some(d) = self.delivered {
            if !seq_newer(header.frame_id, d) {
                self.stats.frames_dropped += 1;
                return Accepted::Dropped(DropReason::Stale);
            }
        }

        let keyframe = header.has(crate::packet::flags::KEYFRAME);

        // A frame older than the newest keyframe is unshowable: the decoder has
        // been reset past it. This is the frame-aware rule that a generic
        // transport cannot express.
        if let Some(kf) = self.newest_keyframe {
            if seq_newer(kf, header.frame_id) {
                self.stats.frames_dropped += 1;
                return Accepted::Dropped(DropReason::Stale);
            }
        }
        if keyframe {
            let newer = match self.newest_keyframe {
                None => true,
                Some(kf) => seq_newer(header.frame_id, kf),
            };
            if newer {
                self.newest_keyframe = Some(header.frame_id);
                // Everything older is now undecodable; stop holding it.
                let id = header.frame_id;
                self.pending.retain(|&fid, _| !seq_newer(id, fid));
            }
        }

        let entry = self.pending.entry(header.frame_id).or_insert_with(|| Pending {
            frag_count: header.frag_count,
            keyframe,
            parts: vec![None; header.frag_count as usize],
            have: 0,
            newest_seq: header.sequence,
        });

        // A peer changing its mind about a frame's size mid-frame is either a
        // bug or an attack; either way the earlier fragments are unusable.
        if entry.frag_count != header.frag_count {
            self.pending.remove(&header.frame_id);
            self.stats.frames_dropped += 1;
            return Accepted::Dropped(DropReason::TooManyFragments);
        }

        let idx = header.frag_index as usize;
        if entry.parts[idx].is_some() {
            self.stats.fragments_duplicate += 1;
            return Accepted::Dropped(DropReason::Duplicate);
        }

        entry.parts[idx] = Some(payload.to_vec());
        entry.have += 1;
        entry.keyframe |= keyframe;
        if seq_newer(header.sequence, entry.newest_seq) {
            entry.newest_seq = header.sequence;
        }
        self.stats.fragments_accepted += 1;

        if entry.have == entry.frag_count {
            let done = self.pending.remove(&header.frame_id).expect("just checked");
            let mut payload = Vec::with_capacity(done.frag_count as usize * MAX_PAYLOAD);
            for part in done.parts.into_iter() {
                payload.extend_from_slice(&part.expect("complete frame has every part"));
            }
            self.delivered = Some(header.frame_id);
            self.stats.frames_completed += 1;
            // Anything still pending that is older is now unshowable.
            let id = header.frame_id;
            self.pending.retain(|&fid, _| seq_newer(fid, id));
            return Accepted::Complete { frame_id: header.frame_id, keyframe: done.keyframe, payload };
        }

        let (have, need) = (entry.have, entry.frag_count);
        self.evict_if_needed();
        Accepted::Partial { frame_id: header.frame_id, have, need }
    }

    /// Fragments worth asking for again, for frames still within reach.
    ///
    /// Only for repairable channels: on cursor and audio the next sample is the
    /// repair and is already more current than anything a NACK could recover.
    pub fn nack_list(&self, channel: Channel) -> Vec<(u32, Vec<u16>)> {
        if !channel.repairable() {
            return Vec::new();
        }
        let mut out: Vec<(u32, Vec<u16>)> = self
            .pending
            .iter()
            .filter(|(&fid, _)| match self.newest_keyframe {
                Some(kf) => !seq_newer(kf, fid),
                None => true,
            })
            .map(|(&fid, p)| (fid, p.missing()))
            .filter(|(_, m)| !m.is_empty())
            .collect();
        out.sort_by_key(|(fid, _)| *fid);
        out
    }

    /// Keep the pending set bounded by discarding the oldest frames.
    fn evict_if_needed(&mut self) {
        while self.pending.len() > MAX_PENDING_FRAMES {
            let oldest = self
                .pending
                .keys()
                .copied()
                .reduce(|a, b| if seq_newer(a, b) { b } else { a });
            match oldest {
                Some(id) => {
                    self.pending.remove(&id);
                    self.stats.frames_dropped += 1;
                }
                None => break,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::packet::flags;

    fn hdr(frame_id: u32, idx: u16, count: u16, seq: u32, key: bool) -> Header {
        Header {
            channel: Channel::Video,
            flags: if key { flags::KEYFRAME } else { 0 },
            sequence: seq,
            frame_id,
            frag_index: idx,
            frag_count: count,
            send_us: 0,
        }
    }

    #[test]
    fn single_fragment_frame_completes_immediately() {
        let mut r = Reassembler::new();
        let got = r.push(&hdr(1, 0, 1, 1, true), b"hello");
        assert_eq!(
            got,
            Accepted::Complete { frame_id: 1, keyframe: true, payload: b"hello".to_vec() }
        );
    }

    #[test]
    fn fragments_reassemble_in_order_regardless_of_arrival_order() {
        let mut r = Reassembler::new();
        // Deliberately out of order — UDP does not promise order.
        assert!(matches!(r.push(&hdr(7, 2, 3, 3, false), b"ccc"), Accepted::Partial { .. }));
        assert!(matches!(r.push(&hdr(7, 0, 3, 1, false), b"aaa"), Accepted::Partial { .. }));
        let done = r.push(&hdr(7, 1, 3, 2, false), b"bbb");
        assert_eq!(
            done,
            Accepted::Complete { frame_id: 7, keyframe: false, payload: b"aaabbbccc".to_vec() }
        );
    }

    #[test]
    fn duplicate_fragments_are_counted_not_applied() {
        let mut r = Reassembler::new();
        r.push(&hdr(1, 0, 2, 1, false), b"aa");
        let dup = r.push(&hdr(1, 0, 2, 9, false), b"aa");
        assert_eq!(dup, Accepted::Dropped(DropReason::Duplicate));
        assert_eq!(r.stats().fragments_duplicate, 1);
    }

    #[test]
    fn frames_older_than_one_already_delivered_are_dropped() {
        let mut r = Reassembler::new();
        r.push(&hdr(10, 0, 1, 1, true), b"x");
        let late = r.push(&hdr(9, 0, 1, 2, false), b"y");
        assert_eq!(late, Accepted::Dropped(DropReason::Stale));
    }

    /// The frame-aware rule: once a newer keyframe exists, older frames cannot
    /// be shown, so holding or repairing them is wasted link.
    #[test]
    fn a_newer_keyframe_supersedes_older_pending_frames() {
        let mut r = Reassembler::new();
        r.push(&hdr(5, 0, 3, 1, false), b"aa"); // partial, will never finish
        assert_eq!(r.nack_list(Channel::Video).len(), 1);

        r.push(&hdr(6, 0, 1, 2, true), b"K"); // keyframe supersedes it
        assert!(
            r.nack_list(Channel::Video).is_empty(),
            "no point repairing a frame the decoder has moved past"
        );

        // And a straggler for the superseded frame is refused outright.
        assert_eq!(r.push(&hdr(5, 1, 3, 3, false), b"bb"), Accepted::Dropped(DropReason::Stale));
    }

    #[test]
    fn nacks_name_exactly_the_missing_fragments() {
        let mut r = Reassembler::new();
        r.push(&hdr(3, 0, 4, 1, false), b"a");
        r.push(&hdr(3, 2, 4, 2, false), b"c");
        let nacks = r.nack_list(Channel::Video);
        assert_eq!(nacks, vec![(3, vec![1, 3])]);
    }

    #[test]
    fn unrepairable_channels_never_produce_nacks() {
        let mut r = Reassembler::new();
        let mut h = hdr(1, 0, 2, 1, false);
        h.channel = Channel::Cursor;
        r.push(&h, b"a");
        assert!(
            r.nack_list(Channel::Cursor).is_empty(),
            "the next cursor sample is the repair, and it is fresher"
        );
    }

    #[test]
    fn pending_frames_are_bounded_against_a_peer_that_never_finishes_one() {
        let mut r = Reassembler::new();
        for id in 1..=40u32 {
            r.push(&hdr(id, 0, 4, id, false), b"x");
        }
        assert!(
            r.pending.len() <= MAX_PENDING_FRAMES,
            "unfinished frames must not accumulate without limit"
        );
    }

    #[test]
    fn absurd_fragment_counts_and_oversize_payloads_are_refused() {
        let mut r = Reassembler::new();
        assert_eq!(
            r.push(&hdr(1, 0, MAX_FRAGMENTS + 1, 1, false), b"x"),
            Accepted::Dropped(DropReason::TooManyFragments)
        );
        let big = vec![0u8; MAX_PAYLOAD + 1];
        assert_eq!(r.push(&hdr(2, 0, 1, 2, false), &big), Accepted::Dropped(DropReason::Oversize));
    }

    #[test]
    fn a_peer_changing_a_frames_size_mid_frame_is_refused() {
        let mut r = Reassembler::new();
        r.push(&hdr(1, 0, 4, 1, false), b"a");
        let bad = r.push(&hdr(1, 1, 9, 2, false), b"b");
        assert_eq!(bad, Accepted::Dropped(DropReason::TooManyFragments));
    }
}
