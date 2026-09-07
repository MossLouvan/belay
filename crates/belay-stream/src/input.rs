//! Input reports arriving from the phone on BWP's Input channel.
//!
//! The streamer does not interpret them. It hands each one to the parent
//! process as a JSON line, and the parent feeds it to the same gamepad hub the
//! WebSocket path uses. Keeping the streamer ignorant of the report format
//! means the format can change in one place (`server/src/gamepad-codec.ts`)
//! without a Windows rebuild.
//!
//! Hex rather than base64: a 17-byte report is 34 characters either way that
//! matters, no dependency is needed, and a human reading the pipe can still
//! see the bytes.

/// Largest report forwarded, in bytes. Matches `BELAY_INPUT_MAX_LEN` in the
/// client; a report beyond this did not come from our client and is dropped.
pub const INPUT_MAX_LEN: usize = 64;

/// The JSON body (without the surrounding braces or the `type` field) for one
/// input report, or `None` when the payload is not a plausible report.
pub fn input_body(payload: &[u8]) -> Option<String> {
    if payload.is_empty() || payload.len() > INPUT_MAX_LEN {
        return None;
    }
    Some(format!("\"hex\":\"{}\"", hex(payload)))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_report_is_forwarded_as_lowercase_hex() {
        assert_eq!(input_body(&[0x01, 0xab, 0xff, 0x00]).as_deref(), Some("\"hex\":\"01abff00\""));
    }

    #[test]
    fn empty_and_oversized_payloads_are_dropped() {
        assert_eq!(input_body(&[]), None);
        assert_eq!(input_body(&[0u8; INPUT_MAX_LEN + 1]), None);
        assert!(input_body(&[0u8; INPUT_MAX_LEN]).is_some());
    }
}
