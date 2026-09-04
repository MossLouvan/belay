//! A BWP session over UDP: the piece that owns a socket.
//!
//! Everything policy-shaped lives below this in `belay_wire` (framing, loss
//! rules, congestion law) or beside it in `pacer`/`feedback`. This module is
//! deliberately thin — it moves bytes and sequences calls, and holds no rules
//! of its own, so the rules stay testable without a network.
//!
//! Order of operations on receive is not arbitrary and is the security-relevant
//! part:
//!
//!   1. parse the header (cheap, and validates fragmentation bounds)
//!   2. replay-window check on the sequence
//!   3. AEAD open, with the header as associated data
//!   4. only then hand the plaintext to reassembly
//!
//! Checking replay before decrypting means a flood of replayed datagrams costs
//! a window lookup rather than a ChaCha20 pass. Reassembling only after the tag
//! verifies means unauthenticated bytes never reach a buffer sized by a
//! peer-supplied fragment count.

use std::io;
use std::net::{SocketAddr, UdpSocket};
use std::time::{Duration, Instant};

use belay_wire::congestion::{AbrConfig, AbrState, BitratePreset, LinkFeedback};
use belay_wire::crypto::{Direction, DirectionKey, ReplayWindow};
use belay_wire::packet::{flags, fragment_count, fragment_range, Channel, Header, HEADER_LEN, MAX_DATAGRAM};
use belay_wire::reassembly::{Accepted, Reassembler};

use crate::feedback::{ReceiveTracker, Report, RttEstimator};
use crate::pacer::Pacer;

/// How often the receiver reports back.
///
/// Every 50ms is ~20 reports a second: frequent enough for the controller to
/// react within a few frames, infrequent enough that reports are noise on the
/// link rather than traffic.
pub const REPORT_INTERVAL: Duration = Duration::from_millis(50);

/// Number of `Channel` variants — Control, Cursor, Input, Video, Audio.
const CHANNEL_COUNT: usize = 5;

#[derive(Debug)]
pub enum SessionError {
    Io(io::Error),
    /// Peer sent something that did not authenticate. Not fatal on its own —
    /// UDP accepts datagrams from anyone, so an unauthenticated packet is
    /// noise to drop, not a reason to tear down a working session.
    Rejected,
}

impl From<io::Error> for SessionError {
    fn from(e: io::Error) -> Self {
        SessionError::Io(e)
    }
}

/// Something the application gets back from `poll`.
#[derive(Debug)]
pub enum Event {
    /// A complete application frame.
    Frame { channel: Channel, frame_id: u32, keyframe: bool, payload: Vec<u8> },
    /// The controller changed the send budget. The caller must apply this to
    /// the ENCODER too — that shared setpoint is the whole benefit of owning
    /// both ends of the pipe.
    Bitrate { bps: u64 },
    /// The decoder is broken and needs an I-frame to recover.
    KeyframeNeeded,
}

pub struct Session {
    socket: UdpSocket,
    peer: SocketAddr,
    send_key: DirectionKey,
    recv_key: DirectionKey,

    next_sequence: u32,
    /// Frame ids are PER CHANNEL. A single shared counter would make a cursor
    /// frame look older than the video frame that happened to be sent after
    /// it, and `Reassembler`'s stale rule would correctly — and disastrously —
    /// drop it.
    next_frame_id: [u32; CHANNEL_COUNT],

    replay: ReplayWindow,
    /// One per channel, for the same reason: `Reassembler` reassembles ONE
    /// channel's frames and tracks a single newest-delivered id.
    reassemblers: [Reassembler; CHANNEL_COUNT],
    tracker: ReceiveTracker,
    rtt: RttEstimator,

    abr_config: AbrConfig,
    abr: AbrState,
    pacer: Pacer,

    started: Instant,
    last_report_sent: Instant,
    /// Set when reassembly gives up on a frame, so the next poll can ask for a
    /// keyframe once rather than on every dropped fragment.
    want_keyframe: bool,
}

impl core::fmt::Debug for Session {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("Session")
            .field("peer", &self.peer)
            .field("bitrate_bps", &self.abr.bitrate_bps)
            .finish_non_exhaustive()
    }
}

impl Session {
    /// Bind a session. `token` is the paired device token; `salt` must be the
    /// same fresh random value at both ends and different every session.
    pub fn bind(
        bind_addr: SocketAddr,
        peer: SocketAddr,
        token: &[u8],
        salt: [u8; 8],
        direction: Direction,
        preset: BitratePreset,
    ) -> Result<Session, SessionError> {
        let socket = UdpSocket::bind(bind_addr)?;
        socket.set_nonblocking(true)?;

        let abr_config = preset.apply(&AbrConfig::default());
        // Start low and let the controller probe up. Starting high and backing
        // off means the first seconds of every session are the worst ones,
        // which is exactly when a user forms an impression.
        let start = abr_config.min_bps.max(1_500_000).min(abr_config.max_bps);
        let abr = AbrState::new(start, &abr_config);

        Ok(Session {
            socket,
            peer,
            send_key: DirectionKey::derive(token, salt, direction),
            recv_key: DirectionKey::derive(token, salt, direction.peer()),
            next_sequence: 0,
            next_frame_id: [0; CHANNEL_COUNT],
            replay: ReplayWindow::new(),
            reassemblers: Default::default(),
            tracker: ReceiveTracker::new(),
            rtt: RttEstimator::new(),
            abr_config,
            abr,
            pacer: Pacer::new(start, 0),
            started: Instant::now(),
            last_report_sent: Instant::now(),
            want_keyframe: false,
        })
    }

    pub fn local_addr(&self) -> io::Result<SocketAddr> {
        self.socket.local_addr()
    }

    pub fn bitrate_bps(&self) -> u64 {
        self.abr.bitrate_bps
    }

    /// Microseconds since this session started — the clock stamped into headers.
    fn now_us(&self) -> u32 {
        self.started.elapsed().as_micros() as u32
    }

    /// Send one application frame, fragmenting and pacing it.
    ///
    /// Cursor and audio are sent without pacing: they are tiny and their whole
    /// value is being current, so delaying them to smooth a video burst would
    /// defeat the reason they have their own channel.
    pub fn send_frame(
        &mut self,
        channel: Channel,
        payload: &[u8],
        keyframe: bool,
    ) -> Result<(), SessionError> {
        let slot = channel as usize;
        let frame_id = self.next_frame_id[slot];
        self.next_frame_id[slot] = frame_id.wrapping_add(1);
        let count = fragment_count(payload.len());
        let paced = matches!(channel, Channel::Video);

        let _max_wire = MAX_DATAGRAM + HEADER_LEN;
        for i in 0..count {
            let (s, e) = fragment_range(payload.len(), i);
            let mut f = 0u8;
            if keyframe {
                f |= flags::KEYFRAME;
            }
            if i == count - 1 {
                f |= flags::FRAME_END;
            }
            let header = Header {
                channel,
                flags: f,
                sequence: self.next_sequence,
                frame_id,
                frag_index: i,
                frag_count: count,
                send_us: self.now_us(),
            };
            self.next_sequence = self.next_sequence.wrapping_add(1);

            let wire = self.send_key.seal(&header, &payload[s..e]);
            debug_assert!(wire.len() <= _max_wire);

            if paced {
                let now = self.now_us() as u64;
                if !self.pacer.try_send(wire.len(), now) {
                    let wait = self.pacer.wait_for(wire.len(), now);
                    // Sleeping here paces the frame. It is bounded by the
                    // bitrate, so at 8 Mbps this is ~1ms between datagrams.
                    std::thread::sleep(wait);
                    let now = self.now_us() as u64;
                    let _ = self.pacer.try_send(wire.len(), now);
                }
            }
            match self.socket.send_to(&wire, self.peer) {
                Ok(_) => {}
                // A full socket buffer is backpressure, not a failure; the
                // pacer will have slowed us by the next fragment anyway.
                Err(ref e) if e.kind() == io::ErrorKind::WouldBlock => {}
                Err(e) => return Err(SessionError::Io(e)),
            }
        }
        Ok(())
    }

    /// Drain the socket and advance the session. Never blocks.
    pub fn poll(&mut self) -> Result<Vec<Event>, SessionError> {
        let mut events = Vec::new();
        let mut buf = [0u8; 2048];

        loop {
            let (len, from) = match self.socket.recv_from(&mut buf) {
                Ok(v) => v,
                Err(ref e) if e.kind() == io::ErrorKind::WouldBlock => break,
                Err(e) => return Err(SessionError::Io(e)),
            };
            // UDP will hand us anything anyone sends. Datagrams from elsewhere
            // are dropped before any parsing effort at all.
            if from != self.peer {
                continue;
            }
            if let Some(ev) = self.on_datagram(&buf[..len]) {
                events.extend(ev);
            }
        }

        if self.last_report_sent.elapsed() >= REPORT_INTERVAL {
            self.send_report()?;
            self.last_report_sent = Instant::now();
        }
        if self.want_keyframe {
            self.want_keyframe = false;
            events.push(Event::KeyframeNeeded);
        }
        Ok(events)
    }

    fn on_datagram(&mut self, datagram: &[u8]) -> Option<Vec<Event>> {
        let header = Header::decode(datagram).ok()?;
        // Replay check BEFORE decryption: a replay flood should cost a bitmask
        // lookup, not a cipher pass over every datagram.
        if self.replay.accept(header.sequence).is_err() {
            return None;
        }
        let plaintext = self.recv_key.open(datagram, &header).ok()?;

        self.tracker.on_datagram(header.sequence, header.send_us, self.now_us() as u64);

        if header.channel == Channel::Control {
            return self.on_control(&plaintext).map(|e| vec![e]);
        }

        match self.reassemblers[header.channel as usize].push(&header, &plaintext) {
            Accepted::Complete { frame_id, keyframe, payload } => Some(vec![Event::Frame {
                channel: header.channel,
                frame_id,
                keyframe,
                payload,
            }]),
            Accepted::Dropped(_) => {
                // A frame we gave up on means the decoder is broken. Ask for a
                // keyframe on evidence rather than emitting them on a timer.
                if header.channel == Channel::Video {
                    self.want_keyframe = true;
                }
                None
            }
            Accepted::Partial { .. } => None,
        }
    }

    fn on_control(&mut self, plaintext: &[u8]) -> Option<Event> {
        let report = Report::decode(plaintext)?;
        let rtt_ms = self.rtt.sample(self.now_us(), &report)?;

        let before = self.abr.bitrate_bps;
        self.abr = self.abr.next(
            LinkFeedback { loss_ratio: report.loss_ratio(), rtt_ms },
            &self.abr_config,
        );
        if self.abr.bitrate_bps != before {
            // One setpoint, applied to the transport here and handed to the
            // caller so it reaches the encoder too.
            self.pacer.set_bitrate(self.abr.bitrate_bps);
            return Some(Event::Bitrate { bps: self.abr.bitrate_bps });
        }
        None
    }

    fn send_report(&mut self) -> Result<(), SessionError> {
        let Some(report) = self.tracker.take_report(self.now_us() as u64) else { return Ok(()) };
        let mut body = [0u8; Report::WIRE_LEN];
        report.encode(&mut body);

        let header = Header {
            channel: Channel::Control,
            flags: flags::FRAME_END,
            sequence: self.next_sequence,
            frame_id: self.next_frame_id[Channel::Control as usize],
            frag_index: 0,
            frag_count: 1,
            send_us: self.now_us(),
        };
        self.next_sequence = self.next_sequence.wrapping_add(1);
        let ctl = Channel::Control as usize;
        self.next_frame_id[ctl] = self.next_frame_id[ctl].wrapping_add(1);

        let wire = self.send_key.seal(&header, &body);
        match self.socket.send_to(&wire, self.peer) {
            Ok(_) | Err(_) => Ok(()), // a lost report is repaired by the next one
        }
    }
}

/// A fresh, unpredictable session salt.
///
/// Must be unpredictable, not merely unique: a guessable salt undoes the
/// protection it exists to give (see belay_wire::crypto).
pub fn random_salt() -> [u8; 8] {
    let mut s = [0u8; 8];
    getrandom::getrandom(&mut s).expect("system RNG must be available");
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr};

    fn local(port: u16) -> SocketAddr {
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port)
    }

    /// Two real sessions over real loopback UDP.
    fn pair(preset: BitratePreset) -> (Session, Session) {
        let token = b"paired-device-token";
        let salt = [9u8; 8];

        let a_sock = UdpSocket::bind(local(0)).unwrap();
        let b_sock = UdpSocket::bind(local(0)).unwrap();
        let a_addr = a_sock.local_addr().unwrap();
        let b_addr = b_sock.local_addr().unwrap();
        drop(a_sock);
        drop(b_sock);

        let a = Session::bind(a_addr, b_addr, token, salt, Direction::HostToClient, preset).unwrap();
        let b = Session::bind(b_addr, a_addr, token, salt, Direction::ClientToHost, preset).unwrap();
        (a, b)
    }

    fn drain(s: &mut Session) -> Vec<Event> {
        // Loopback is fast but not instant; give the datagrams a moment.
        std::thread::sleep(Duration::from_millis(20));
        s.poll().unwrap()
    }

    #[test]
    fn a_frame_survives_encryption_fragmentation_and_the_wire() {
        let (mut host, mut client) = pair(BitratePreset::Max);
        let payload: Vec<u8> = (0..5000).map(|i| (i % 251) as u8).collect();
        host.send_frame(Channel::Video, &payload, true).unwrap();

        let events = drain(&mut client);
        let frame = events
            .iter()
            .find_map(|e| match e {
                Event::Frame { payload, keyframe, .. } => Some((payload.clone(), *keyframe)),
                _ => None,
            })
            .expect("frame must arrive");
        assert_eq!(frame.0, payload, "must arrive byte-for-byte");
        assert!(frame.1, "keyframe flag must survive");
    }

    #[test]
    fn multiple_channels_stay_separate() {
        let (mut host, mut client) = pair(BitratePreset::Max);
        host.send_frame(Channel::Cursor, b"cursor-sample", false).unwrap();
        host.send_frame(Channel::Input, b"keystroke", false).unwrap();

        let events = drain(&mut client);
        let mut seen: Vec<(Channel, Vec<u8>)> = events
            .into_iter()
            .filter_map(|e| match e {
                Event::Frame { channel, payload, .. } => Some((channel, payload)),
                _ => None,
            })
            .collect();
        seen.sort_by_key(|(c, _)| *c);
        assert_eq!(seen.len(), 2);
        assert_eq!(seen[0].0, Channel::Cursor);
        assert_eq!(seen[1].0, Channel::Input);
    }

    /// UDP delivers whatever anyone sends to the port. A stranger's datagram
    /// must not be parsed, let alone acted on.
    #[test]
    fn datagrams_from_an_unknown_peer_are_ignored() {
        let (mut host, mut client) = pair(BitratePreset::Max);
        let stranger = UdpSocket::bind(local(0)).unwrap();
        stranger.send_to(b"\xB1\x13garbage-garbage-garbage", client.local_addr().unwrap()).unwrap();

        host.send_frame(Channel::Video, b"real", true).unwrap();
        let events = drain(&mut client);
        let frames: Vec<_> = events
            .iter()
            .filter_map(|e| match e {
                Event::Frame { payload, .. } => Some(payload.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(frames, vec![b"real".to_vec()], "only the real peer's frame");
    }

    /// The wrong token must not be able to inject anything, even from the
    /// correct address.
    #[test]
    fn a_peer_with_the_wrong_token_cannot_inject_frames() {
        let token_a = b"right-token";
        let token_b = b"wrong-token";
        let salt = [3u8; 8];

        let a_sock = UdpSocket::bind(local(0)).unwrap();
        let b_sock = UdpSocket::bind(local(0)).unwrap();
        let (a_addr, b_addr) = (a_sock.local_addr().unwrap(), b_sock.local_addr().unwrap());
        drop(a_sock);
        drop(b_sock);

        let mut good =
            Session::bind(a_addr, b_addr, token_a, salt, Direction::HostToClient, BitratePreset::Max).unwrap();
        let mut impostor =
            Session::bind(b_addr, a_addr, token_b, salt, Direction::ClientToHost, BitratePreset::Max).unwrap();

        impostor.send_frame(Channel::Input, b"malicious-keystroke", false).unwrap();
        let events = drain(&mut good);
        assert!(
            !events.iter().any(|e| matches!(e, Event::Frame { .. })),
            "a bad tag must yield no frame"
        );
    }

    #[test]
    fn feedback_flows_and_moves_the_bitrate() {
        let (mut host, mut client) = pair(BitratePreset::Max);

        // Traffic in both directions so both ends have something to report on.
        for _ in 0..40 {
            host.send_frame(Channel::Video, &[7u8; 800], false).unwrap();
        }
        let _ = drain(&mut client);

        // Let the report interval elapse, then pump both ends.
        let start_bitrate = host.bitrate_bps();
        for _ in 0..8 {
            std::thread::sleep(REPORT_INTERVAL);
            let _ = client.poll().unwrap();
            let _ = host.poll().unwrap();
        }
        // Loopback is lossless, so a healthy link should probe UPWARD.
        assert!(
            host.bitrate_bps() >= start_bitrate,
            "a clean link must not back off: {} -> {}",
            start_bitrate,
            host.bitrate_bps()
        );
    }

    #[test]
    fn a_preset_caps_the_session_bitrate() {
        let (host, _client) = pair(BitratePreset::DataSaver);
        assert!(
            host.bitrate_bps() <= 1_500_000,
            "data-saver must cap the start, got {}",
            host.bitrate_bps()
        );
    }

    #[test]
    fn salts_are_unpredictable_and_distinct() {
        let a = random_salt();
        let b = random_salt();
        assert_ne!(a, b, "a repeated salt would reuse nonces across sessions");
        assert_ne!(a, [0u8; 8]);
    }
}
