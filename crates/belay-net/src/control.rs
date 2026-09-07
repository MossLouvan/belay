//! Messages on the Control channel.
//!
//! Until now the only control message was the receiver's `Report`, and it was
//! recognised by being exactly 20 bytes long. A keyframe request needs to ride
//! the same channel — it is the one message where the receiver tells the
//! sender something about the *decoder* rather than the link — so the channel
//! grows a tiny envelope.
//!
//! Compatibility is kept by length: a 20-byte body is still a bare report, as
//! every deployed peer sends it. Anything else starts with a kind byte. A peer
//! that predates this module ignores the new message (its decoder returns
//! `None` for a short body) and keeps working; it just never sends keyframes
//! on request, which is exactly its behaviour today.

use crate::feedback::Report;

/// Kind byte for a keyframe request. Chosen to be an unlikely first byte of
/// a report's `highest_seq` at session start (which is 0).
pub const KIND_KEYFRAME_REQUEST: u8 = 0x4B;

/// A decoded control message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ControlMessage {
    /// The receiver's periodic link report.
    Report(Report),
    /// The receiver's decoder cannot continue without an I-frame.
    KeyframeRequest,
}

impl ControlMessage {
    /// The largest encoded control message.
    pub const MAX_WIRE_LEN: usize = Report::WIRE_LEN;

    /// Encode into `out`, returning the number of bytes written.
    ///
    /// Panics if `out` is shorter than `MAX_WIRE_LEN`; callers hand in a
    /// fixed buffer.
    pub fn encode(&self, out: &mut [u8]) -> usize {
        match self {
            ControlMessage::Report(report) => report.encode(out),
            ControlMessage::KeyframeRequest => {
                assert!(!out.is_empty());
                out[0] = KIND_KEYFRAME_REQUEST;
                1
            }
        }
    }

    /// Decode a control body. `None` for anything unrecognised — the caller
    /// drops it, as it drops every other malformed datagram.
    pub fn decode(buf: &[u8]) -> Option<ControlMessage> {
        if buf.len() == Report::WIRE_LEN {
            return Report::decode(buf).map(ControlMessage::Report);
        }
        match buf {
            [KIND_KEYFRAME_REQUEST] => Some(ControlMessage::KeyframeRequest),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_report_round_trips_as_a_bare_20_byte_body() {
        let report = Report {
            highest_seq: 77,
            received: 70,
            expected: 77,
            echo_send_us: 123_456,
            delay_us: 900,
        };
        let mut buf = [0u8; ControlMessage::MAX_WIRE_LEN];
        let n = ControlMessage::Report(report.clone()).encode(&mut buf);
        assert_eq!(n, Report::WIRE_LEN);
        assert_eq!(ControlMessage::decode(&buf[..n]), Some(ControlMessage::Report(report)));
    }

    #[test]
    fn a_keyframe_request_is_one_byte_and_round_trips() {
        let mut buf = [0u8; ControlMessage::MAX_WIRE_LEN];
        let n = ControlMessage::KeyframeRequest.encode(&mut buf);
        assert_eq!(n, 1);
        assert_eq!(ControlMessage::decode(&buf[..n]), Some(ControlMessage::KeyframeRequest));
    }

    #[test]
    fn garbage_decodes_to_nothing() {
        assert_eq!(ControlMessage::decode(&[]), None);
        assert_eq!(ControlMessage::decode(&[0x00]), None);
        assert_eq!(ControlMessage::decode(&[KIND_KEYFRAME_REQUEST, 0x01]), None);
        assert_eq!(ControlMessage::decode(&[0u8; 19]), None);
        assert_eq!(ControlMessage::decode(&[0u8; 21]), None);
    }
}
