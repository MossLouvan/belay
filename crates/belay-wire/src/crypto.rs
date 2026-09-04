//! Datagram encryption: ChaCha20-Poly1305 AEAD, keyed from the paired token.
//!
//! The protocol is custom; the cryptography is emphatically not. Primitives
//! come from RustCrypto, and the only decisions made here are the boring
//! structural ones that are nonetheless easy to get fatally wrong:
//!
//! * **Directional keys.** Host→client and client→host derive separate keys, so
//!   a datagram can never be replayed back at its sender and accepted.
//! * **Nonce discipline.** The nonce is a per-direction 32-bit sequence in a
//!   96-bit field with a 64-bit random-per-session salt. A nonce is never
//!   reused under one key, which for ChaCha20-Poly1305 is the one failure that
//!   destroys confidentiality outright rather than degrading it.
//! * **Header as associated data.** The header travels in the clear because the
//!   receiver must route on channel and reassemble on frame id before it can
//!   afford to decrypt. Authenticating it as AAD means an attacker can read it
//!   but cannot change it: flipping a channel or a fragment index fails the tag.
//! * **Replay window.** A 64-packet sliding window rejects duplicates and
//!   anything too old, so a captured datagram cannot be re-injected.
//!
//! The session key comes from the device token the pairing flow already
//! established, run through HKDF-SHA256. Pairing therefore remains the single
//! root of trust and no new secret is introduced.

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use hkdf::Hkdf;
use sha2::Sha256;

use crate::packet::{Header, HEADER_LEN};

/// Poly1305 tag length appended to every ciphertext.
pub const TAG_LEN: usize = 16;

/// Which end of the link a key is for. Keeping these distinct is what stops a
/// captured host→client datagram being replayed at the host.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    HostToClient,
    ClientToHost,
}

impl Direction {
    fn label(self) -> &'static [u8] {
        match self {
            Direction::HostToClient => b"belay-bwp-v1 host->client",
            Direction::ClientToHost => b"belay-bwp-v1 client->host",
        }
    }

    pub fn peer(self) -> Direction {
        match self {
            Direction::HostToClient => Direction::ClientToHost,
            Direction::ClientToHost => Direction::HostToClient,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CryptoError {
    /// Ciphertext shorter than the authentication tag.
    TooShort,
    /// Tag did not verify: forged, corrupted, or the wrong key.
    BadTag,
    /// Sequence already seen, or older than the replay window.
    Replay,
}

/// One direction's sealing/opening key.
pub struct DirectionKey {
    cipher: ChaCha20Poly1305,
    /// Per-session random, mixed into every nonce so two sessions that happen
    /// to reuse a sequence number still never reuse a nonce.
    salt: [u8; 8],
}

impl core::fmt::Debug for DirectionKey {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        // Never print key material, not even its length.
        f.write_str("DirectionKey(<redacted>)")
    }
}

impl DirectionKey {
    /// Derive from the paired device token.
    ///
    /// `session_salt` must be fresh per session (both ends agree on it during
    /// the handshake); it is what keeps nonces unique across reconnects that
    /// restart the sequence counter at zero.
    pub fn derive(token: &[u8], session_salt: [u8; 8], direction: Direction) -> DirectionKey {
        let hk = Hkdf::<Sha256>::new(Some(&session_salt), token);
        let mut key = [0u8; 32];
        hk.expand(direction.label(), &mut key)
            .expect("32 bytes is a valid HKDF output length");
        let cipher = ChaCha20Poly1305::new(Key::from_slice(&key));
        // Best-effort scrub of the stack copy; the cipher owns its own.
        key.fill(0);
        DirectionKey { cipher, salt: session_salt }
    }

    /// 96-bit nonce: 8-byte session salt then the 4-byte sequence.
    ///
    /// Unique per (key, sequence), and the sequence is never reused within a
    /// session because it is the datagram counter.
    fn nonce(&self, sequence: u32) -> Nonce {
        let mut n = [0u8; 12];
        n[0..8].copy_from_slice(&self.salt);
        n[8..12].copy_from_slice(&sequence.to_le_bytes());
        *Nonce::from_slice(&n)
    }

    /// Encrypt `plaintext`, authenticating `header` as associated data.
    ///
    /// Returns header bytes followed by ciphertext+tag: exactly what goes on
    /// the wire.
    pub fn seal(&self, header: &Header, plaintext: &[u8]) -> Vec<u8> {
        let mut hdr = [0u8; HEADER_LEN];
        header.encode(&mut hdr);
        let ct = self
            .cipher
            .encrypt(&self.nonce(header.sequence), Payload { msg: plaintext, aad: &hdr })
            .expect("ChaCha20Poly1305 encryption is infallible for in-memory buffers");
        let mut out = Vec::with_capacity(HEADER_LEN + ct.len());
        out.extend_from_slice(&hdr);
        out.extend_from_slice(&ct);
        out
    }

    /// Verify and decrypt. `datagram` is header + ciphertext as received.
    pub fn open(&self, datagram: &[u8], header: &Header) -> Result<Vec<u8>, CryptoError> {
        if datagram.len() < HEADER_LEN + TAG_LEN {
            return Err(CryptoError::TooShort);
        }
        let (hdr, ct) = datagram.split_at(HEADER_LEN);
        self.cipher
            .decrypt(&self.nonce(header.sequence), Payload { msg: ct, aad: hdr })
            .map_err(|_| CryptoError::BadTag)
    }
}

/// Sliding replay window over a wrapping sequence space.
///
/// Authentication alone does not stop replay: a captured datagram is perfectly
/// authentic. For an input channel that means a recorded keystroke could be
/// re-injected, so this is a security control, not an optimisation.
#[derive(Debug)]
pub struct ReplayWindow {
    highest: Option<u32>,
    /// Bit i set means (highest - i) has been seen.
    seen: u64,
}

impl Default for ReplayWindow {
    fn default() -> Self {
        ReplayWindow { highest: None, seen: 0 }
    }
}

impl ReplayWindow {
    pub const WIDTH: u32 = 64;

    pub fn new() -> Self {
        Self::default()
    }

    /// Accept `sequence` if it is fresh. Returns Err(Replay) for a duplicate or
    /// anything older than the window.
    pub fn accept(&mut self, sequence: u32) -> Result<(), CryptoError> {
        let highest = match self.highest {
            None => {
                self.highest = Some(sequence);
                self.seen = 1;
                return Ok(());
            }
            Some(h) => h,
        };

        if crate::packet::seq_newer(sequence, highest) {
            let shift = sequence.wrapping_sub(highest);
            self.seen = if shift >= Self::WIDTH { 1 } else { (self.seen << shift) | 1 };
            self.highest = Some(sequence);
            return Ok(());
        }

        let behind = highest.wrapping_sub(sequence);
        if behind == 0 || behind >= Self::WIDTH {
            // Duplicate of the newest, or so old the window cannot vouch for it.
            return Err(CryptoError::Replay);
        }
        let bit = 1u64 << behind;
        if self.seen & bit != 0 {
            return Err(CryptoError::Replay);
        }
        self.seen |= bit;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::packet::{flags, Channel};

    fn header(seq: u32) -> Header {
        Header {
            channel: Channel::Video,
            flags: flags::KEYFRAME,
            sequence: seq,
            frame_id: 9,
            frag_index: 0,
            frag_count: 1,
            send_us: 0,
        }
    }

    fn keys() -> (DirectionKey, DirectionKey) {
        let token = b"a-paired-device-token";
        let salt = [7u8; 8];
        (
            DirectionKey::derive(token, salt, Direction::HostToClient),
            DirectionKey::derive(token, salt, Direction::HostToClient),
        )
    }

    #[test]
    fn seal_then_open_round_trips() {
        let (send, recv) = keys();
        let h = header(1);
        let wire = send.seal(&h, b"frame bytes");
        assert_eq!(&wire[..HEADER_LEN], {
            let mut e = [0u8; HEADER_LEN];
            h.encode(&mut e);
            &e.to_vec()[..]
        });
        assert_eq!(recv.open(&wire, &h).unwrap(), b"frame bytes");
    }

    #[test]
    fn ciphertext_does_not_contain_the_plaintext() {
        let (send, _) = keys();
        let wire = send.seal(&header(1), b"SECRETSECRET");
        assert!(
            !wire.windows(12).any(|w| w == b"SECRETSECRET"),
            "payload must not appear on the wire in the clear"
        );
    }

    #[test]
    fn a_flipped_payload_bit_fails_the_tag() {
        let (send, recv) = keys();
        let h = header(1);
        let mut wire = send.seal(&h, b"frame bytes");
        let last = wire.len() - 1;
        wire[last] ^= 0x01;
        assert_eq!(recv.open(&wire, &h), Err(CryptoError::BadTag));
    }

    /// The header is readable but not malleable: routing fields are AAD, so
    /// rewriting a channel or fragment index is detected.
    #[test]
    fn tampering_with_the_cleartext_header_fails_the_tag() {
        let (send, recv) = keys();
        let h = header(1);
        let mut wire = send.seal(&h, b"payload");
        wire[1] = (crate::packet::VERSION << 4) | Channel::Input as u8; // re-route it
        assert_eq!(recv.open(&wire, &h), Err(CryptoError::BadTag));
    }

    /// Without this, a captured host->client datagram could be replayed at the
    /// host and accepted as client input.
    #[test]
    fn the_two_directions_cannot_decrypt_each_other() {
        let token = b"tok";
        let salt = [1u8; 8];
        let h2c = DirectionKey::derive(token, salt, Direction::HostToClient);
        let c2h = DirectionKey::derive(token, salt, Direction::ClientToHost);
        let h = header(1);
        let wire = h2c.seal(&h, b"secret");
        assert_eq!(c2h.open(&wire, &h), Err(CryptoError::BadTag));
    }

    #[test]
    fn a_different_token_cannot_decrypt() {
        let salt = [2u8; 8];
        let a = DirectionKey::derive(b"token-a", salt, Direction::HostToClient);
        let b = DirectionKey::derive(b"token-b", salt, Direction::HostToClient);
        let h = header(1);
        assert_eq!(b.open(&a.seal(&h, b"x"), &h), Err(CryptoError::BadTag));
    }

    /// Reconnects restart the sequence at zero. Without a per-session salt that
    /// would reuse (key, nonce) pairs, which is the one ChaCha20-Poly1305
    /// failure that is catastrophic rather than merely bad.
    #[test]
    fn a_new_session_salt_changes_the_keystream_for_the_same_sequence() {
        let token = b"tok";
        let s1 = DirectionKey::derive(token, [1u8; 8], Direction::HostToClient);
        let s2 = DirectionKey::derive(token, [2u8; 8], Direction::HostToClient);
        let h = header(0);
        assert_ne!(s1.seal(&h, b"same plaintext"), s2.seal(&h, b"same plaintext"));
    }

    #[test]
    fn truncated_datagrams_are_rejected_before_decryption() {
        let (_, recv) = keys();
        assert_eq!(recv.open(&[0u8; HEADER_LEN], &header(1)), Err(CryptoError::TooShort));
        assert_eq!(recv.open(&[], &header(1)), Err(CryptoError::TooShort));
    }

    #[test]
    fn replay_window_rejects_duplicates_and_ancient_sequences() {
        let mut w = ReplayWindow::new();
        assert!(w.accept(100).is_ok());
        assert_eq!(w.accept(100), Err(CryptoError::Replay), "exact duplicate");

        assert!(w.accept(101).is_ok());
        assert!(w.accept(99).is_ok(), "mild reordering is legitimate on UDP");
        assert_eq!(w.accept(99), Err(CryptoError::Replay), "but only once");

        assert_eq!(w.accept(101 - ReplayWindow::WIDTH), Err(CryptoError::Replay), "too old");
    }

    #[test]
    fn replay_window_survives_sequence_wrap() {
        let mut w = ReplayWindow::new();
        assert!(w.accept(u32::MAX - 1).is_ok());
        assert!(w.accept(u32::MAX).is_ok());
        assert!(w.accept(0).is_ok(), "0 follows u32::MAX");
        assert_eq!(w.accept(u32::MAX), Err(CryptoError::Replay));
    }

    #[test]
    fn a_big_forward_jump_resets_the_window_without_accepting_the_past() {
        let mut w = ReplayWindow::new();
        assert!(w.accept(10).is_ok());
        assert!(w.accept(10_000).is_ok());
        assert_eq!(w.accept(10), Err(CryptoError::Replay), "far behind the new window");
        assert_eq!(w.accept(10_000), Err(CryptoError::Replay));
    }

    #[test]
    fn keys_never_print_their_material() {
        let (k, _) = keys();
        assert_eq!(format!("{k:?}"), "DirectionKey(<redacted>)");
    }
}
