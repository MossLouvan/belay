//! Authenticated, per-frame XOR repair. This module never authenticates packets
//! or counts reconstructed shards as network arrivals; the session owns both.

use crate::packet::{flags, seq_newer, Channel, Header};
use std::collections::HashMap;

pub const SHARD_BYTES: usize = 1120;
pub const GROUP_SIZE: usize = 8;
const MAX_FRAGMENTS: usize = 512;
const MAX_FRAMES: usize = 8;
// A full group takes about 275 ms on a 300 kbps link, but successive
// datagrams still make progress every ~31 ms. Expire inactivity, not the
// age of the group's first shard. A hard frame cap prevents slow keepalive.
const GROUP_IDLE_MS: u64 = 200;
const FRAME_LIFETIME_MS: u64 = 2000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Parity {
    pub frame_id: u32,
    pub keyframe: bool,
    pub total_count: u16,
    pub first: u16,
    pub lengths: Vec<u16>,
    pub parity: Vec<u8>,
}

impl Parity {
    pub fn from_frame(frame_id: u32, keyframe: bool, payload: &[u8], first: u16) -> Option<Self> {
        let total = payload.len().div_ceil(SHARD_BYTES);
        if total == 0
            || total > MAX_FRAGMENTS
            || first as usize >= total
            || first as usize % GROUP_SIZE != 0
        {
            return None;
        }
        let end = (first as usize + GROUP_SIZE).min(total);
        let mut lengths = Vec::new();
        let mut parity = Vec::new();
        for index in first as usize..end {
            let shard =
                &payload[index * SHARD_BYTES..((index + 1) * SHARD_BYTES).min(payload.len())];
            lengths.push(shard.len() as u16);
            parity.resize(parity.len().max(shard.len()), 0);
            for (out, byte) in parity.iter_mut().zip(shard) {
                *out ^= byte;
            }
        }
        Some(Self {
            frame_id,
            keyframe,
            total_count: total as u16,
            first,
            lengths,
            parity,
        })
    }

    fn valid(&self) -> bool {
        let total = self.total_count as usize;
        let first = self.first as usize;
        if total == 0
            || total > MAX_FRAGMENTS
            || first >= total
            || first % GROUP_SIZE != 0
            || self.lengths.len() != GROUP_SIZE.min(total - first)
        {
            return false;
        }
        for (offset, &length) in self.lengths.iter().enumerate() {
            if length == 0
                || length as usize > SHARD_BYTES
                || (first + offset + 1 < total && length as usize != SHARD_BYTES)
            {
                return false;
            }
        }
        self.parity.len() == self.lengths.iter().copied().max().unwrap_or(0) as usize
    }

    /// Invalid public metadata produces no wire packet.
    pub fn encode(&self) -> Vec<u8> {
        if !self.valid() {
            return Vec::new();
        }
        let mut out = Vec::with_capacity(14 + self.lengths.len() * 2 + self.parity.len());
        out.extend_from_slice(b"FEC1");
        out.extend_from_slice(&self.frame_id.to_le_bytes());
        out.extend_from_slice(&self.total_count.to_le_bytes());
        out.extend_from_slice(&self.first.to_le_bytes());
        out.push(self.lengths.len() as u8);
        out.push(u8::from(self.keyframe));
        for length in &self.lengths {
            out.extend_from_slice(&length.to_le_bytes());
        }
        out.extend_from_slice(&self.parity);
        out
    }

    pub fn decode(bytes: &[u8]) -> Option<Self> {
        if bytes.len() < 14
            || bytes.len() > 14 + 2 * GROUP_SIZE + SHARD_BYTES
            || &bytes[..4] != b"FEC1"
            || bytes[13] > 1
        {
            return None;
        }
        let count = bytes[12] as usize;
        if count == 0 || count > GROUP_SIZE || bytes.len() < 14 + 2 * count {
            return None;
        }
        let result = Self {
            frame_id: u32::from_le_bytes(bytes[4..8].try_into().ok()?),
            total_count: u16::from_le_bytes(bytes[8..10].try_into().ok()?),
            first: u16::from_le_bytes(bytes[10..12].try_into().ok()?),
            keyframe: bytes[13] == 1,
            lengths: bytes[14..14 + count * 2]
                .chunks_exact(2)
                .map(|b| u16::from_le_bytes([b[0], b[1]]))
                .collect(),
            parity: bytes[14 + count * 2..].to_vec(),
        };
        result.valid().then_some(result)
    }
}

#[derive(Debug)]
struct Frame {
    keyframe: bool,
    created_ms: u64,
    parts: Vec<Option<Vec<u8>>>,
    groups: Vec<Option<Parity>>,
    group_progress_ms: Vec<Option<u64>>,
    group_expired: Vec<bool>,
    expired: bool,
}

#[derive(Debug, Default)]
pub struct FecReceiver {
    frames: HashMap<u32, Frame>,
    retired: Option<u32>,
    newest_keyframe: Option<u32>,
}

impl FecReceiver {
    pub fn expire(&mut self, now_ms: u64) {
        for frame in self.frames.values_mut() {
            frame.expired |= now_ms.saturating_sub(frame.created_ms) >= FRAME_LIFETIME_MS;
            for group in 0..frame.groups.len() {
                if frame.group_expired[group] {
                    continue;
                }
                if frame.expired
                    || frame.group_progress_ms[group]
                        .is_some_and(|last| now_ms.saturating_sub(last) >= GROUP_IDLE_MS)
                {
                    frame.group_expired[group] = true;
                    frame.groups[group] = None;
                    let first = group * GROUP_SIZE;
                    let end = (first + GROUP_SIZE).min(frame.parts.len());
                    frame.parts[first..end].fill(None);
                }
            }
        }
        // Keep bounded metadata tombstones until retirement or eviction.
        // Otherwise a late duplicate could recreate an expired frame and
        // reset its hard lifetime. No expired shard/parity bytes are retained.
    }

    pub fn retire(&mut self, frame_id: u32) {
        if self.retired.is_none_or(|last| seq_newer(frame_id, last)) {
            self.retired = Some(frame_id);
            self.frames.retain(|&id, _| seq_newer(id, frame_id));
        }
    }

    fn prepare(&mut self, id: u32, count: u16, keyframe: bool, now_ms: u64) -> bool {
        self.expire(now_ms);
        if count == 0
            || count as usize > MAX_FRAGMENTS
            || self.retired.is_some_and(|last| !seq_newer(id, last))
            || self.newest_keyframe.is_some_and(|last| seq_newer(last, id))
        {
            return false;
        }
        if let Some(frame) = self.frames.get(&id) {
            return !frame.expired
                && frame.parts.len() == count as usize
                && frame.keyframe == keyframe;
        }
        if keyframe && self.newest_keyframe.is_none_or(|last| seq_newer(id, last)) {
            self.newest_keyframe = Some(id);
            self.frames.retain(|&other, _| !seq_newer(id, other));
        }
        if self.frames.len() == MAX_FRAMES {
            let oldest = self
                .frames
                .keys()
                .copied()
                .reduce(|a, b| if seq_newer(a, b) { b } else { a })
                .unwrap();
            if !seq_newer(id, oldest) {
                return false;
            }
            self.frames.remove(&oldest);
        }
        self.frames.insert(
            id,
            Frame {
                keyframe,
                created_ms: now_ms,
                parts: vec![None; count as usize],
                groups: vec![None; (count as usize).div_ceil(GROUP_SIZE)],
                group_progress_ms: vec![None; (count as usize).div_ceil(GROUP_SIZE)],
                group_expired: vec![false; (count as usize).div_ceil(GROUP_SIZE)],
                expired: false,
            },
        );
        true
    }

    pub fn on_data(
        &mut self,
        header: &Header,
        bytes: &[u8],
        now_ms: u64,
    ) -> Vec<(Header, Vec<u8>)> {
        let count = header.frag_count;
        let index = header.frag_index as usize;
        if header.channel != Channel::Video
            || index >= count as usize
            || bytes.is_empty()
            || bytes.len() > SHARD_BYTES
            || (index + 1 < count as usize && bytes.len() != SHARD_BYTES)
            || !self.prepare(header.frame_id, count, header.has(flags::KEYFRAME), now_ms)
        {
            return Vec::new();
        }
        let frame = self.frames.get_mut(&header.frame_id).unwrap();
        let group = index / GROUP_SIZE;
        if frame.group_expired[group] {
            return Vec::new();
        }
        if let Some(parity) = &frame.groups[group] {
            if parity.lengths[index - parity.first as usize] as usize != bytes.len() {
                return Vec::new();
            }
        }
        if frame.parts[index].is_some() {
            return Vec::new();
        }
        frame.parts[index] = Some(bytes.to_vec());
        frame.group_progress_ms[group] =
            Some(now_ms.max(frame.group_progress_ms[group].unwrap_or(0)));
        Self::recover(header.frame_id, frame, group)
    }

    pub fn on_parity(&mut self, parity: Parity, now_ms: u64) -> Vec<(Header, Vec<u8>)> {
        if !parity.valid()
            || !self.prepare(parity.frame_id, parity.total_count, parity.keyframe, now_ms)
        {
            return Vec::new();
        }
        let id = parity.frame_id;
        let frame = self.frames.get_mut(&id).unwrap();
        let group = parity.first as usize / GROUP_SIZE;
        if frame.group_expired[group] {
            return Vec::new();
        }
        for (offset, &length) in parity.lengths.iter().enumerate() {
            if frame.parts[parity.first as usize + offset]
                .as_ref()
                .is_some_and(|part| part.len() != length as usize)
            {
                return Vec::new();
            }
        }
        if frame.groups[group].is_some() {
            return Vec::new();
        }
        frame.groups[group] = Some(parity);
        frame.group_progress_ms[group] =
            Some(now_ms.max(frame.group_progress_ms[group].unwrap_or(0)));
        Self::recover(id, frame, group)
    }

    fn recover(id: u32, frame: &mut Frame, group: usize) -> Vec<(Header, Vec<u8>)> {
        let Some(parity) = &frame.groups[group] else {
            return Vec::new();
        };
        let first = parity.first as usize;
        let missing: Vec<usize> = (first..first + parity.lengths.len())
            .filter(|&i| frame.parts[i].is_none())
            .collect();
        if missing.len() != 1 {
            return Vec::new();
        }
        let index = missing[0];
        let mut restored = parity.parity.clone();
        for part in frame.parts[first..first + parity.lengths.len()]
            .iter()
            .flatten()
        {
            for (out, byte) in restored.iter_mut().zip(part) {
                *out ^= byte;
            }
        }
        restored.truncate(parity.lengths[index - first] as usize);
        frame.parts[index] = Some(restored.clone());
        let header = Header {
            channel: Channel::Video,
            flags: if frame.keyframe { flags::KEYFRAME } else { 0 }
                | if index + 1 == frame.parts.len() {
                    flags::FRAME_END
                } else {
                    0
                },
            sequence: 0,
            frame_id: id,
            frag_index: index as u16,
            frag_count: frame.parts.len() as u16,
            send_us: 0,
        };
        vec![(header, restored)]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload(length: usize) -> Vec<u8> {
        (0..length)
            .map(|i| (i.wrapping_mul(37) % 251) as u8)
            .collect()
    }
    fn header(id: u32, index: usize, count: usize, key: bool) -> Header {
        Header {
            channel: Channel::Video,
            flags: if key { flags::KEYFRAME } else { 0 },
            sequence: index as u32,
            frame_id: id,
            frag_index: index as u16,
            frag_count: count as u16,
            send_us: 0,
        }
    }

    #[test]
    fn every_position_tail_and_single_shard_recover_exactly_once() {
        for size in [37, SHARD_BYTES, SHARD_BYTES * 8, SHARD_BYTES * 10 + 23] {
            let data = payload(size);
            let count = size.div_ceil(SHARD_BYTES);
            for missing in 0..count {
                for parity_first in [false, true] {
                    let mut receiver = FecReceiver::default();
                    let mut recovered = Vec::new();
                    let parity: Vec<_> = (0..count)
                        .step_by(GROUP_SIZE)
                        .map(|first| Parity::from_frame(7, true, &data, first as u16).unwrap())
                        .collect();
                    if parity_first {
                        for p in &parity {
                            recovered.extend(receiver.on_parity(p.clone(), 0));
                        }
                    }
                    for (index, shard) in data.chunks(SHARD_BYTES).enumerate() {
                        if index != missing {
                            recovered.extend(receiver.on_data(
                                &header(7, index, count, true),
                                shard,
                                1,
                            ));
                        }
                    }
                    if !parity_first {
                        for p in &parity {
                            recovered.extend(receiver.on_parity(p.clone(), 2));
                        }
                    }
                    // Parity-first can reconstruct the final arriving original
                    // early in other groups; all emitted repairs must be exact.
                    assert!(recovered
                        .iter()
                        .any(|(h, _)| h.frag_index as usize == missing));
                    let mut indices = std::collections::HashSet::new();
                    for (h, bytes) in recovered {
                        assert!(indices.insert(h.frag_index));
                        let i = h.frag_index as usize;
                        assert_eq!(
                            bytes,
                            data[i * SHARD_BYTES..((i + 1) * SHARD_BYTES).min(size)]
                        );
                        assert!(h.has(flags::KEYFRAME));
                    }
                    for p in parity {
                        assert!(receiver.on_parity(p, 3).is_empty());
                    }
                    for (i, shard) in data.chunks(SHARD_BYTES).enumerate() {
                        assert!(receiver
                            .on_data(&header(7, i, count, true), shard, 4)
                            .is_empty());
                    }
                }
            }
        }
    }

    #[test]
    fn two_losses_wait_until_an_original_arrives() {
        let data = payload(SHARD_BYTES * 8);
        let mut receiver = FecReceiver::default();
        for i in 2..8 {
            assert!(receiver
                .on_data(
                    &header(1, i, 8, false),
                    &data[i * SHARD_BYTES..(i + 1) * SHARD_BYTES],
                    0
                )
                .is_empty());
        }
        assert!(receiver
            .on_parity(Parity::from_frame(1, false, &data, 0).unwrap(), 1)
            .is_empty());
        let recovered = receiver.on_data(&header(1, 0, 8, false), &data[..SHARD_BYTES], 2);
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].0.frag_index, 1);
    }

    #[test]
    fn loss_without_parity_never_invents_a_shard() {
        let shard = payload(SHARD_BYTES);
        let mut receiver = FecReceiver::default();
        for index in 0..7 {
            assert!(receiver
                .on_data(&header(1, index, 8, false), &shard, 0)
                .is_empty());
        }
        receiver.expire(GROUP_IDLE_MS);
        assert!(receiver.frames[&1].parts.iter().all(Option::is_none));
    }

    #[test]
    fn wire_roundtrip_bounds_and_malformed_packets() {
        let parity = Parity::from_frame(42, true, &payload(SHARD_BYTES * 8), 0).unwrap();
        let wire = parity.encode();
        assert!(wire.len() + 16 + 16 <= 1200);
        assert_eq!(Parity::decode(&wire), Some(parity.clone()));
        for end in 0..wire.len() {
            assert!(Parity::decode(&wire[..end]).is_none());
        }
        for (offset, value) in [
            (0, 0),
            (8, 0),
            (9, 255),
            (10, 1),
            (12, 0),
            (12, 9),
            (13, 2),
            (14, 0),
            (15, 0),
        ] {
            let mut bad = wire.clone();
            bad[offset] = value;
            assert!(Parity::decode(&bad).is_none(), "offset {offset}");
        }
        let mut extra = wire.clone();
        extra.push(0);
        assert!(Parity::decode(&extra).is_none());
        assert!(Parity::from_frame(0, false, &[], 0).is_none());
        assert!(Parity::from_frame(0, false, &payload(SHARD_BYTES * 513), 0).is_none());
        assert!(Parity::from_frame(0, false, &payload(SHARD_BYTES * 9), 1).is_none());
    }

    #[test]
    fn conflicting_metadata_does_not_replace_cached_frame() {
        let data = payload(SHARD_BYTES * 2);
        let mut receiver = FecReceiver::default();
        receiver.on_data(&header(8, 0, 2, false), &data[..SHARD_BYTES], 0);
        assert!(receiver
            .on_parity(Parity::from_frame(8, true, &data, 0).unwrap(), 1)
            .is_empty());
        assert!(receiver
            .on_data(&header(8, 0, 3, false), &data[..SHARD_BYTES], 1)
            .is_empty());
        let recovered = receiver.on_parity(Parity::from_frame(8, false, &data, 0).unwrap(), 2);
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].1, data[SHARD_BYTES..]);
    }

    #[test]
    fn caches_expire_are_bounded_and_retirement_wraps() {
        let shard = payload(SHARD_BYTES);
        let mut receiver = FecReceiver::default();
        for id in 0..100 {
            receiver.on_data(&header(id, 0, 512, false), &shard, 0);
        }
        assert_eq!(receiver.frames.len(), MAX_FRAMES);
        assert!(receiver.frames.contains_key(&99));
        receiver.on_data(&header(0, 0, 512, false), &shard, 199);
        assert!(!receiver.frames.contains_key(&0));
        receiver.expire(200);
        assert!(receiver
            .frames
            .values()
            .all(|frame| frame.parts.iter().all(Option::is_none)));
        // A fresh session for serial-number wrap, independent of the frames
        // used above to exercise cache capacity and inactivity expiration.
        receiver = FecReceiver::default();
        receiver.retire(u32::MAX);
        assert!(receiver
            .on_parity(Parity::from_frame(u32::MAX, true, &shard, 0).unwrap(), 201)
            .is_empty());
        assert_eq!(
            receiver
                .on_parity(Parity::from_frame(0, true, &shard, 0).unwrap(), 201)
                .len(),
            1
        );
        receiver.retire(0);
        receiver.retire(u32::MAX);
        assert_eq!(receiver.retired, Some(0));
        assert!(receiver
            .on_parity(Parity::from_frame(0, true, &shard, 0).unwrap(), 202)
            .is_empty());
    }

    #[test]
    fn newer_keyframe_supersedes_and_old_parity_cannot_resurrect() {
        let shard = payload(SHARD_BYTES);
        let mut receiver = FecReceiver::default();
        receiver.on_data(&header(10, 0, 2, false), &shard, 0);
        receiver.on_data(&header(11, 0, 2, true), &shard, 1);
        assert!(!receiver.frames.contains_key(&10));
        assert!(receiver
            .on_parity(Parity::from_frame(10, false, &shard, 0).unwrap(), 2)
            .is_empty());
        assert_eq!(receiver.frames.len(), 1);
    }

    #[test]
    fn low_rate_group_repairs_after_two_hundred_ms_and_completes_reassembly() {
        use crate::reassembly::{Accepted, Reassembler};
        let data = payload(SHARD_BYTES * GROUP_SIZE);
        let mut receiver = FecReceiver::default();
        let mut reassembler = Reassembler::new();
        for (index, shard) in data.chunks(SHARD_BYTES).enumerate() {
            if index == 3 {
                continue;
            }
            let h = header(7, index, GROUP_SIZE, true);
            // 1152 encrypted bytes at 300 kbps take 30.72 ms.
            assert!(receiver.on_data(&h, shard, index as u64 * 31).is_empty());
            assert!(matches!(
                reassembler.push(&h, shard),
                Accepted::Partial { .. }
            ));
        }
        let repaired = receiver.on_parity(Parity::from_frame(7, true, &data, 0).unwrap(), 248);
        assert_eq!(repaired.len(), 1);
        assert_eq!(repaired[0].0.frag_index, 3);
        match reassembler.push(&repaired[0].0, &repaired[0].1) {
            Accepted::Complete { payload, .. } => assert_eq!(payload, data),
            result => panic!("paced repair must complete original reassembly: {result:?}"),
        }
    }

    #[test]
    fn duplicate_packets_cannot_keep_a_group_alive_or_restart_it() {
        let data = payload(SHARD_BYTES * 8);
        let mut receiver = FecReceiver::default();
        let parity = Parity::from_frame(9, false, &data, 0).unwrap();
        receiver.on_parity(parity.clone(), 0);
        receiver.on_data(&header(9, 0, 8, false), &data[..SHARD_BYTES], 0);
        for time in [50, 100, 150, 199] {
            assert!(receiver.on_parity(parity.clone(), time).is_empty());
            assert!(receiver
                .on_data(&header(9, 0, 8, false), &data[..SHARD_BYTES], time)
                .is_empty());
        }
        receiver.expire(200);
        let frame = &receiver.frames[&9];
        assert!(frame.group_expired[0]);
        assert!(frame.parts.iter().all(Option::is_none));
        assert!(frame.groups.iter().all(Option::is_none));
        receiver.on_parity(parity, 201);
        receiver.on_data(
            &header(9, 1, 8, false),
            &data[SHARD_BYTES..2 * SHARD_BYTES],
            201,
        );
        assert!(receiver.frames[&9].parts.iter().all(Option::is_none));
        assert!(receiver.frames[&9].groups.iter().all(Option::is_none));
    }

    #[test]
    fn progress_in_one_group_does_not_extend_another_groups_lifetime() {
        let shard = payload(SHARD_BYTES);
        let mut receiver = FecReceiver::default();
        receiver.on_data(&header(1, 0, 16, false), &shard, 0);
        receiver.on_data(&header(1, 8, 16, false), &shard, 100);
        receiver.on_data(&header(1, 9, 16, false), &shard, 199);
        receiver.expire(200);
        assert!(receiver.frames[&1].group_expired[0]);
        assert!(!receiver.frames[&1].group_expired[1]);
        assert!(receiver.frames[&1].parts[0].is_none());
        assert!(receiver.frames[&1].parts[8].is_some());
    }

    #[test]
    fn continuing_real_progress_cannot_exceed_hard_frame_lifetime() {
        let shard = payload(SHARD_BYTES);
        let mut receiver = FecReceiver::default();
        for index in 0..21 {
            receiver.on_data(&header(3, index, 64, false), &shard, index as u64 * 95);
        }
        assert!(!receiver.frames[&3].expired);
        assert!(receiver.frames[&3].parts[20].is_some());
        receiver.on_data(&header(3, 21, 64, false), &shard, FRAME_LIFETIME_MS);
        assert!(receiver.frames[&3].expired);
        assert!(receiver.frames[&3].parts.iter().all(Option::is_none));
        receiver.on_data(&header(3, 22, 64, false), &shard, FRAME_LIFETIME_MS + 1);
        assert!(receiver.frames[&3].parts.iter().all(Option::is_none));
    }
}
