//! Datagram framing: the 16-byte BWP header and its wire encoding.
//!
//! Decoding is the protocol's outermost trust boundary. Every field that is
//! used to size or index anything is validated here, once, so no later stage
//! has to wonder whether `frag_count` is sane. A malformed datagram is an
//! `Err`, never a panic — this code runs on bytes an attacker chooses.

use core::convert::TryInto;

/// Wire format version. Bumped when the header layout changes incompatibly.
pub const VERSION: u8 = 1;

/// First byte of every datagram. Cheap rejection of anything that is not ours
/// before spending effort on it.
pub const MAGIC: u8 = 0xB1;

/// Header size in bytes.
pub const HEADER_LEN: usize = 16;

/// Conservative payload budget per datagram.
///
/// 1200 bytes total is the figure WebRTC settled on for a reason: it survives
/// PPPoE, common VPN encapsulation and IPv6 tunnels without fragmenting at the
/// IP layer, and IP-layer fragmentation is disastrous here because losing one
/// IP fragment silently destroys the whole datagram.
pub const MAX_DATAGRAM: usize = 1200;

/// Payload bytes available once the header is accounted for.
pub const MAX_PAYLOAD: usize = MAX_DATAGRAM - HEADER_LEN;

/// Logical streams, in strict priority order — lowest number wins the link.
///
/// `Cursor` sitting above `Video` is the single most visible latency decision
/// in the protocol. See docs/WIRE-PROTOCOL.md.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(u8)]
pub enum Channel {
    Control = 0,
    Cursor = 1,
    Input = 2,
    Video = 3,
    Audio = 4,
}

impl Channel {
    pub fn from_u8(v: u8) -> Option<Channel> {
        match v {
            0 => Some(Channel::Control),
            1 => Some(Channel::Cursor),
            2 => Some(Channel::Input),
            3 => Some(Channel::Video),
            4 => Some(Channel::Audio),
            _ => None,
        }
    }

    /// Whether loss on this channel is ever worth repairing.
    ///
    /// Cursor and audio are newest-wins: the repair for a lost sample is the
    /// next sample, which is already on its way and is more current than the
    /// one that was lost. Retransmitting them spends the link to deliver
    /// something stale.
    pub fn repairable(self) -> bool {
        matches!(self, Channel::Control | Channel::Input | Channel::Video)
    }

    /// Whether the channel requires in-order delivery to the application.
    pub fn ordered(self) -> bool {
        matches!(self, Channel::Control | Channel::Input)
    }
}

pub mod flags {
    /// This frame is independently decodable (I-frame).
    pub const KEYFRAME: u8 = 1 << 0;
    /// This fragment is the last of its frame.
    pub const FRAME_END: u8 = 1 << 1;
    /// This datagram is a repair of one previously sent.
    pub const RETRANSMIT: u8 = 1 << 2;
    /// Sender requests an immediate feedback report.
    pub const ACK_REQ: u8 = 1 << 3;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Header {
    pub channel: Channel,
    pub flags: u8,
    /// Per-connection datagram counter. Wraps; comparisons use `seq_newer`.
    pub sequence: u32,
    /// Groups fragments of one application frame.
    pub frame_id: u32,
    pub frag_index: u16,
    pub frag_count: u16,
    /// Sender clock in microseconds, for RTT and jitter estimation.
    pub send_us: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecodeError {
    /// Fewer bytes than a header.
    TooShort,
    /// First byte was not MAGIC.
    BadMagic,
    /// Version this build does not speak.
    BadVersion(u8),
    /// Channel id outside the known set.
    BadChannel(u8),
    /// frag_count == 0, or frag_index >= frag_count. Either would let a peer
    /// drive an out-of-range index into a reassembly buffer.
    BadFragmentation { index: u16, count: u16 },
    /// Payload larger than the protocol permits.
    Oversize(usize),
}

impl Header {
    /// Serialise into `out`, returning bytes written. `out` must be at least
    /// HEADER_LEN.
    pub fn encode(&self, out: &mut [u8]) -> usize {
        assert!(out.len() >= HEADER_LEN, "header buffer too small");
        out[0] = MAGIC;
        // Version in the high nibble, channel in the low nibble. Both are
        // small and fixed, and packing them keeps the header at 16 bytes.
        out[1] = (VERSION << 4) | (self.channel as u8 & 0x0F);
        out[2] = self.flags;
        out[3] = 0; // reserved; must be zero so it can become a field later
        out[4..8].copy_from_slice(&self.sequence.to_le_bytes());
        out[8..12].copy_from_slice(&self.frame_id.to_le_bytes());
        out[12..14].copy_from_slice(&self.frag_index.to_le_bytes());
        out[14..16].copy_from_slice(&self.frag_count.to_le_bytes());
        HEADER_LEN
    }

    pub fn decode(buf: &[u8]) -> Result<Header, DecodeError> {
        if buf.len() < HEADER_LEN {
            return Err(DecodeError::TooShort);
        }
        if buf[0] != MAGIC {
            return Err(DecodeError::BadMagic);
        }
        let version = buf[1] >> 4;
        if version != VERSION {
            return Err(DecodeError::BadVersion(version));
        }
        let channel = Channel::from_u8(buf[1] & 0x0F).ok_or(DecodeError::BadChannel(buf[1] & 0x0F))?;

        let frag_index = u16::from_le_bytes(buf[12..14].try_into().unwrap());
        let frag_count = u16::from_le_bytes(buf[14..16].try_into().unwrap());
        // Validated HERE so reassembly can index without re-checking. A count
        // of zero, or an index past the end, is how a peer would try to walk
        // off a buffer.
        if frag_count == 0 || frag_index >= frag_count {
            return Err(DecodeError::BadFragmentation { index: frag_index, count: frag_count });
        }

        Ok(Header {
            channel,
            flags: buf[2],
            sequence: u32::from_le_bytes(buf[4..8].try_into().unwrap()),
            frame_id: u32::from_le_bytes(buf[8..12].try_into().unwrap()),
            frag_index,
            frag_count,
            send_us: 0,
        })
    }

    pub fn has(&self, flag: u8) -> bool {
        self.flags & flag != 0
    }
}

/// True when `a` is newer than `b` in a wrapping u32 sequence space.
///
/// Plain `a > b` breaks at wrap: sequence 0 is newer than 0xFFFF_FFFF, not
/// older. This is the standard serial-number comparison (RFC 1982), and every
/// staleness decision in the protocol goes through it.
pub fn seq_newer(a: u32, b: u32) -> bool {
    a != b && a.wrapping_sub(b) < 0x8000_0000
}

/// Split a frame into datagram-sized fragments.
///
/// Returns the number of fragments a payload of `len` bytes needs. A zero-byte
/// frame still occupies one fragment: it carries flags that matter.
pub fn fragment_count(len: usize) -> u16 {
    if len == 0 {
        return 1;
    }
    let n = (len + MAX_PAYLOAD - 1) / MAX_PAYLOAD;
    debug_assert!(n <= u16::MAX as usize);
    n as u16
}

/// Byte range of fragment `index` within a frame of `len` bytes.
pub fn fragment_range(len: usize, index: u16) -> (usize, usize) {
    let start = index as usize * MAX_PAYLOAD;
    let end = core::cmp::min(start + MAX_PAYLOAD, len);
    (start, end)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hdr() -> Header {
        Header {
            channel: Channel::Video,
            flags: flags::KEYFRAME | flags::FRAME_END,
            sequence: 0x1234_5678,
            frame_id: 42,
            frag_index: 0,
            frag_count: 1,
            send_us: 0,
        }
    }

    #[test]
    fn header_round_trips() {
        let mut buf = [0u8; HEADER_LEN];
        hdr().encode(&mut buf);
        let got = Header::decode(&buf).expect("decodes");
        assert_eq!(got.channel, Channel::Video);
        assert_eq!(got.sequence, 0x1234_5678);
        assert_eq!(got.frame_id, 42);
        assert!(got.has(flags::KEYFRAME));
        assert!(got.has(flags::FRAME_END));
    }

    #[test]
    fn rejects_short_bad_magic_and_bad_version() {
        assert_eq!(Header::decode(&[0u8; 4]), Err(DecodeError::TooShort));

        let mut buf = [0u8; HEADER_LEN];
        hdr().encode(&mut buf);
        buf[0] = 0x00;
        assert_eq!(Header::decode(&buf), Err(DecodeError::BadMagic));

        hdr().encode(&mut buf);
        buf[1] = (9 << 4) | 3;
        assert_eq!(Header::decode(&buf), Err(DecodeError::BadVersion(9)));
    }

    #[test]
    fn rejects_unknown_channel() {
        let mut buf = [0u8; HEADER_LEN];
        hdr().encode(&mut buf);
        buf[1] = (VERSION << 4) | 0x0F;
        assert_eq!(Header::decode(&buf), Err(DecodeError::BadChannel(0x0F)));
    }

    /// The important one: a hostile peer must not be able to name a fragment
    /// index outside the frame it claims.
    #[test]
    fn rejects_impossible_fragmentation() {
        let mut buf = [0u8; HEADER_LEN];
        hdr().encode(&mut buf);
        buf[14..16].copy_from_slice(&0u16.to_le_bytes()); // count = 0
        assert!(matches!(Header::decode(&buf), Err(DecodeError::BadFragmentation { .. })));

        hdr().encode(&mut buf);
        buf[12..14].copy_from_slice(&5u16.to_le_bytes()); // index 5
        buf[14..16].copy_from_slice(&5u16.to_le_bytes()); // of 5 -> out of range
        assert!(matches!(Header::decode(&buf), Err(DecodeError::BadFragmentation { .. })));
    }

    #[test]
    fn sequence_comparison_survives_wrap() {
        assert!(seq_newer(5, 4));
        assert!(!seq_newer(4, 5));
        assert!(!seq_newer(4, 4));
        // The case plain `>` gets wrong.
        assert!(seq_newer(0, u32::MAX));
        assert!(!seq_newer(u32::MAX, 0));
    }

    #[test]
    fn fragmentation_covers_the_payload_exactly() {
        assert_eq!(fragment_count(0), 1, "an empty frame still carries flags");
        assert_eq!(fragment_count(1), 1);
        assert_eq!(fragment_count(MAX_PAYLOAD), 1);
        assert_eq!(fragment_count(MAX_PAYLOAD + 1), 2);

        let len = MAX_PAYLOAD * 2 + 7;
        let n = fragment_count(len);
        assert_eq!(n, 3);
        let mut covered = 0;
        for i in 0..n {
            let (s, e) = fragment_range(len, i);
            assert_eq!(s, covered, "fragments must be contiguous");
            covered = e;
        }
        assert_eq!(covered, len, "fragments must cover the frame exactly");
    }

    #[test]
    fn channel_policy_matches_the_design() {
        assert!(!Channel::Cursor.repairable(), "the next sample is the repair");
        assert!(!Channel::Audio.repairable());
        assert!(Channel::Input.repairable(), "a dropped keystroke is unacceptable");
        assert!(Channel::Video.repairable());
        assert!(Channel::Input.ordered());
        assert!(!Channel::Video.ordered());
        // Strict priority: cursor must outrank video.
        assert!(Channel::Cursor < Channel::Video);
    }
}
