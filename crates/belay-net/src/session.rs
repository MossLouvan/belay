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
use std::collections::VecDeque;
use std::net::{SocketAddr, UdpSocket};
use std::time::{Duration, Instant};
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};

use belay_wire::congestion::{AbrConfig, AbrState, BitratePreset, LinkFeedback};
use belay_wire::crypto::{Direction, DirectionKey, ReplayWindow, TAG_LEN};
use belay_wire::packet::{flags, Channel, Header, HEADER_LEN, MAX_DATAGRAM};
use belay_wire::fec::{FecReceiver, Parity, SHARD_BYTES, GROUP_SIZE};
use belay_wire::reassembly::{Accepted, DropReason, Reassembler};

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
const FEC_DATA: u8 = 1 << 4;
const FEC_PARITY: u8 = 1 << 5;
const VIDEO_REORDER_GRACE: Duration = Duration::from_millis(8);

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
    /// Encoder picture budget, after reserving negotiated repair overhead.
    /// The packet pacer separately enforces the total wire budget.
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
    /// How many times the OS has told us the peer was unreachable.
    ///
    /// Counted rather than ignored silently: a session where this only ever
    /// climbs is one where nothing is listening at the other end, and that is
    /// worth being able to see. It is not itself an error.
    unreachable_reports: u64,
    deferred_events: Vec<Event>,
    sent_stamps: VecDeque<(u32, u32)>,
    last_report_sequence: Option<u32>,
    last_video_frame: Option<u32>,
    video_waiting_keyframe: bool,
    last_recovery_request: Option<Instant>,
    is_host: bool,
    fec_allowed: bool,
    fec_send: bool,
    fec_receive: bool,
    fec_last_probe: Option<Instant>,
    fec_receiver: FecReceiver,
    reordered_video: Vec<(Instant, u32, Vec<u8>)>,
    cancellation: Option<Arc<AtomicBool>>,
    video_fps: u32,
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
            unreachable_reports: 0,
            deferred_events: Vec::new(),
            sent_stamps: VecDeque::new(),
            last_report_sequence: None,
            last_video_frame: None,
            video_waiting_keyframe: false,
            last_recovery_request: None,
            is_host: direction == Direction::HostToClient,
            fec_allowed: true,
            fec_send: false,
            fec_receive: false,
            fec_last_probe: None,
            fec_receiver: FecReceiver::default(),
            reordered_video: Vec::new(),
            cancellation: None,
            video_fps: 60,
        })
    }

    pub fn local_addr(&self) -> io::Result<SocketAddr> {
        self.socket.local_addr()
    }

    pub fn bitrate_bps(&self) -> u64 {
        self.abr.bitrate_bps
    }

    pub fn rtt_ms(&self) -> Option<f64> { self.rtt.smoothed_ms() }

    /// Configure before streaming. Older peers never acknowledge the extension.
    pub fn set_fec_allowed(&mut self, allowed: bool) { self.fec_allowed = allowed; }
    pub fn set_video_fps(&mut self, fps: u32) { self.video_fps = fps.clamp(1, 120); }
    pub fn fec_sending(&self) -> bool { self.fec_send }
    /// A worker may cancel an in-progress paced send during shutdown.
    pub fn set_cancellation(&mut self, cancellation: Arc<AtomicBool>) {
        self.cancellation = Some(cancellation);
    }
    fn check_cancelled(&self) -> Result<(), SessionError> {
        if self.cancellation.as_ref().is_some_and(|flag| flag.load(Ordering::Relaxed)) {
            return Err(io::Error::new(io::ErrorKind::Interrupted, "session cancelled").into());
        }
        Ok(())
    }
    pub fn media_bitrate_bps(&self) -> u64 {
        if !self.fec_send { return self.abr.bitrate_bps; }
        // Bound full-group overhead plus one partial-group allowance per frame.
        // The pacer still enforces the total wire budget, including parity.
        let overhead = (SHARD_BYTES as u64 + 62) * self.video_fps as u64 * 8;
        let data = (SHARD_BYTES * GROUP_SIZE) as u64;
        let wire = data + SHARD_BYTES as u64 + 32 * GROUP_SIZE as u64 + 62;
        self.abr.bitrate_bps.saturating_sub(overhead).saturating_mul(data)
            .checked_div(wire).unwrap_or(0).max(64_000).min(self.abr.bitrate_bps)
    }

    fn remember_sent(&mut self, sequence: u32) {
        if self.sent_stamps.len() == 8192 { self.sent_stamps.pop_front(); }
        self.sent_stamps.push_back((sequence, self.now_us()));
    }

    /// Service control traffic while waiting; preserve application events.
    pub fn service(&mut self) -> Result<(), SessionError> {
        let events = self.poll()?;
        self.deferred_events.extend(events);
        Ok(())
    }

    /// How many times the OS has reported the peer unreachable.
    ///
    /// A number that climbs while nothing is received means the far end is not
    /// listening — the difference between "the network is bad" and "no one is
    /// there", which are worth telling apart.
    pub fn unreachable_reports(&self) -> u64 {
        self.unreachable_reports
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
        // Negotiation can complete during a pacing wait: freeze mode per AU.
        let protected = channel == Channel::Video && self.fec_send;
        let parity_packet = channel == Channel::Control && payload.starts_with(b"FEC1");
        let shard_bytes = if protected { SHARD_BYTES } else { MAX_DATAGRAM - HEADER_LEN - TAG_LEN };
        let fragments = payload.len().max(1).div_ceil(shard_bytes);
        if fragments > belay_wire::reassembly::MAX_FRAGMENTS as usize {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "frame exceeds fragment limit").into());
        }
        let count = fragments as u16;
        let paced = channel == Channel::Video || parity_packet;

        for i in 0..count {
            self.check_cancelled()?;
            let s = i as usize * shard_bytes;
            let e = (s + shard_bytes).min(payload.len());
            if paced {
                let wire_len = HEADER_LEN + TAG_LEN + e - s;
                while !self.pacer.try_send(wire_len, self.started.elapsed().as_micros() as u64) {
                    self.check_cancelled()?;
                    // A large access unit must not prevent feedback processing:
                    // that delay otherwise masquerades as network RTT and holds
                    // ABR down, making the next frame block even longer.
                    self.service()?;
                    let wait = self.pacer.wait_for(wire_len, self.started.elapsed().as_micros() as u64);
                    std::thread::sleep(wait.min(Duration::from_millis(1)));
                }
            }
            let mut f = 0u8;
            if protected { f |= FEC_DATA; }
            if parity_packet { f |= FEC_PARITY; }
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
            debug_assert!(wire.len() <= MAX_DATAGRAM);

            match self.socket.send_to(&wire, self.peer) {
                Ok(_) => self.remember_sent(header.sequence),
                // A full socket buffer is backpressure, not a failure; the
                // pacer will have slowed us by the next fragment anyway.
                Err(ref e) if e.kind() == io::ErrorKind::WouldBlock => {}
                Err(e) => return Err(SessionError::Io(e)),
            }
            if protected && ((i as usize + 1) % GROUP_SIZE == 0 || i + 1 == count) {
                let first = (i as usize / GROUP_SIZE * GROUP_SIZE) as u16;
                if let Some(parity) = Parity::from_frame(frame_id, keyframe, payload, first) {
                    self.send_frame(Channel::Control, &parity.encode(), false)?;
                }
            }
        }
        Ok(())
    }

    /// Drain the socket and advance the session. Never blocks.
    pub fn request_keyframe(&mut self) -> Result<(), SessionError> {
        self.send_frame(Channel::Control, b"IDR1", false)
    }

    pub fn poll(&mut self) -> Result<Vec<Event>, SessionError> {
        self.check_cancelled()?;
        let mut events = core::mem::take(&mut self.deferred_events);
        self.fec_receiver.expire(self.started.elapsed().as_millis() as u64);
        if self.is_host && self.fec_allowed && !self.fec_send && self.fec_last_probe
            .is_none_or(|last| last.elapsed() >= Duration::from_secs(1)) {
            self.send_frame(Channel::Control, b"FEC?", false)?;
            self.fec_last_probe = Some(Instant::now());
        }
        let mut buf = [0u8; 2048];

        loop {
            self.check_cancelled()?;
            let (len, from) = match self.socket.recv_from(&mut buf) {
                Ok(v) => v,
                Err(ref e) if e.kind() == io::ErrorKind::WouldBlock => break,
                // Windows reports a previous datagram's ICMP Port Unreachable
                // as an error on the NEXT recv, not on the send that caused it.
                // The socket is fine; the peer simply was not listening yet.
                //
                // Treating this as fatal kills the host stream every time the
                // phone is backgrounded, restarts, or is a moment slow to bind
                // — which is most of the time at session start. UDP is
                // connectionless and there is nothing here to reset.
                Err(ref e)
                    if matches!(
                        e.kind(),
                        io::ErrorKind::ConnectionReset | io::ErrorKind::ConnectionRefused
                    ) =>
                {
                    self.unreachable_reports = self.unreachable_reports.saturating_add(1);
                    continue;
                }
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

        if self.reordered_video.iter().any(|(at, _, _)| at.elapsed() >= VIDEO_REORDER_GRACE) {
            self.reordered_video.clear();
            self.video_waiting_keyframe = true;
            self.want_keyframe = true;
        }
        if self.last_report_sent.elapsed() >= REPORT_INTERVAL {
            self.send_report()?;
            self.last_report_sent = Instant::now();
        }
        if (self.want_keyframe || self.video_waiting_keyframe)
            && self.last_recovery_request.is_none_or(|last| last.elapsed() >= Duration::from_millis(250)) {
            self.want_keyframe = false;
            self.request_keyframe()?;
            self.last_recovery_request = Some(Instant::now());
            events.push(Event::KeyframeNeeded);
        }
        Ok(events)
    }

    fn on_datagram(&mut self, datagram: &[u8]) -> Option<Vec<Event>> {
        let header = Header::decode(datagram).ok()?;
        // Replay check BEFORE decryption: a replay flood should cost a bitmask
        // lookup, not a cipher pass over every datagram.
        let mut replay = self.replay.clone();
        if replay.accept(header.sequence).is_err() {
            return None;
        }
        let plaintext = self.recv_key.open(datagram, &header).ok()?;
        self.replay = replay;

        self.tracker.on_datagram(header.sequence, header.send_us, self.started.elapsed().as_micros() as u64);

        if header.channel == Channel::Control {
            if plaintext.starts_with(b"FEC1") {
                if !self.fec_receive || header.flags & FEC_PARITY == 0 { return None; }
                let parity = Parity::decode(&plaintext)?;
                let repaired = self.fec_receiver.on_parity(parity, self.started.elapsed().as_millis() as u64);
                let mut events = Vec::new();
                for (header, data) in repaired { events.extend(self.accept_fragment(&header, &data).unwrap_or_default()); }
                return (!events.is_empty()).then_some(events);
            }
            return self.on_control(&plaintext).map(|e| vec![e]);
        }

        let repaired = if self.fec_receive && header.channel == Channel::Video && header.flags & FEC_DATA != 0 {
            self.fec_receiver.on_data(&header, &plaintext, self.started.elapsed().as_millis() as u64)
        } else { Vec::new() };
        let mut events = self.accept_fragment(&header, &plaintext).unwrap_or_default();
        for (header, data) in repaired { events.extend(self.accept_fragment(&header, &data).unwrap_or_default()); }
        (!events.is_empty()).then_some(events)
    }

    fn accept_fragment(&mut self, header: &Header, plaintext: &[u8]) -> Option<Vec<Event>> {
        let ordered = self.fec_receive && header.channel == Channel::Video;
        let accepted = if ordered {
            self.reassemblers[header.channel as usize].push_for_ordered_delivery(header, plaintext)
        } else { self.reassemblers[header.channel as usize].push(header, plaintext) };
        match accepted {
            Accepted::Complete { frame_id, keyframe, payload } => {
                if header.channel == Channel::Video {
                    if ordered && !keyframe && !self.video_waiting_keyframe
                        && self.last_video_frame.is_some_and(|last| frame_id != last.wrapping_add(1)) {
                        if self.reordered_video.iter().any(|(_, id, _)| *id == frame_id) { return None; }
                        if self.reordered_video.len() < 3 {
                            self.reordered_video.push((Instant::now(), frame_id, payload));
                            return None;
                        }
                        self.video_waiting_keyframe = true;
                    }
                    self.reassemblers[Channel::Video as usize].commit_delivery(frame_id);
                    self.fec_receiver.retire(frame_id);
                    if keyframe {
                        self.reordered_video.clear();
                        self.video_waiting_keyframe = false;
                        self.want_keyframe = false;
                    } else if self.video_waiting_keyframe || self.last_video_frame
                        .is_none_or(|last| frame_id != last.wrapping_add(1)) {
                        // A complete P-frame is not independently decodable.
                        // This also detects an entirely missing access unit,
                        // which reassembly cannot see from partial fragments.
                        self.video_waiting_keyframe = true;
                        self.want_keyframe = true;
                        return None;
                    }
                    self.last_video_frame = Some(frame_id);
                    let mut events = vec![Event::Frame { channel: Channel::Video, frame_id, keyframe, payload }];
                    while let Some(index) = self.reordered_video.iter().position(|(_, id, _)|
                        Some(*id) == self.last_video_frame.map(|last| last.wrapping_add(1))) {
                        let (_, id, payload) = self.reordered_video.remove(index);
                        self.last_video_frame = Some(id);
                        self.reassemblers[Channel::Video as usize].commit_delivery(id);
                        self.fec_receiver.retire(id);
                        events.push(Event::Frame { channel: Channel::Video, frame_id: id, keyframe: false, payload });
                    }
                    return Some(events);
                }
                Some(vec![Event::Frame {
                channel: header.channel,
                frame_id,
                keyframe,
                payload,
            }])
            },
            Accepted::Dropped(reason) => {
                // A frame we gave up on means the decoder is broken. Ask for a
                // keyframe on evidence rather than emitting them on a timer.
                if header.channel == Channel::Video && !matches!(reason, DropReason::Stale | DropReason::Duplicate) {
                    self.want_keyframe = true;
                    self.video_waiting_keyframe = true;
                }
                None
            }
            Accepted::Partial { .. } => None,
        }
    }

    fn on_control(&mut self, plaintext: &[u8]) -> Option<Event> {
        if plaintext == b"FEC?" {
            if !self.is_host && self.fec_allowed {
                self.fec_receive = true;
                let _ = self.send_frame(Channel::Control, b"FEC!", false);
            }
            return None;
        }
        if plaintext == b"FEC!" {
            if self.is_host && self.fec_allowed && self.fec_last_probe.is_some() && !self.fec_send {
                self.fec_send = true;
                return Some(Event::Bitrate { bps:self.media_bitrate_bps() });
            }
            return None;
        }
        if plaintext == b"IDR1" { return Some(Event::KeyframeNeeded); }
        if plaintext.len() != Report::WIRE_LEN { return None; }
        let mut report = Report::decode(plaintext)?;
        if self.last_report_sequence.is_some_and(|last| !belay_wire::packet::seq_newer(report.highest_seq, last)) {
            return None;
        }
        // V1's 16-byte header never serialized send_us. Correlate the peer's
        // authenticated sequence acknowledgement with our bounded send history
        // instead, preserving the existing wire format and client compatibility.
        report.echo_send_us = self.sent_stamps.iter().rev()
            .find(|(seq, _)| *seq == report.highest_seq)?.1;
        self.last_report_sequence = Some(report.highest_seq);
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
            return Some(Event::Bitrate { bps: self.media_bitrate_bps() });
        }
        None
    }

    fn send_report(&mut self) -> Result<(), SessionError> {
        let Some(report) = self.tracker.take_report(self.started.elapsed().as_micros() as u64) else { return Ok(()) };
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
            Ok(_) => { self.remember_sent(header.sequence); Ok(()) },
            Err(_) => Ok(()), // a lost report is repaired by the next one
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
    #[test]
    fn unauthenticated_sequence_cannot_poison_video_replay_window() {
        let (host, mut client) = pair(BitratePreset::Max);
        let mut forged = video_packet(&host, 10_000, 0, 0, 1, true);
        *forged.last_mut().unwrap() ^= 1;
        assert!(client.on_datagram(&forged).is_none());
        assert!(client.on_datagram(&video_packet(&host, 0, 0, 0, 1, true)).is_some());
    }
    fn video_packet(host: &Session, sequence: u32, frame_id: u32, index: u16, count: u16, keyframe: bool) -> Vec<u8> {
        host.send_key.seal(&Header { channel: Channel::Video, sequence, frame_id,
            frag_index: index, frag_count: count, flags: if keyframe { flags::KEYFRAME } else { 0 }, send_us: 0 }, b"pixels")
    }

    #[test]
    fn missing_reference_frame_suppresses_deltas_until_a_complete_keyframe() {
        let (mut host, mut client) = pair(BitratePreset::Max);
        assert!(client.on_datagram(&video_packet(&host,0,0,0,1,true)).is_some());
        // Frame 1 loses its second fragment. Frame 2 completes first.
        assert!(client.on_datagram(&video_packet(&host,1,1,0,2,false)).is_none());
        assert!(client.on_datagram(&video_packet(&host,3,2,0,1,false)).is_none());
        assert!(client.video_waiting_keyframe);
        client.poll().unwrap();
        assert!(drain(&mut host).iter().any(|e| matches!(e, Event::KeyframeNeeded)));
        // A delayed fragment and more deltas cannot repair the dependency gap.
        assert!(client.on_datagram(&video_packet(&host,2,1,1,2,false)).is_none());
        assert!(client.on_datagram(&video_packet(&host,4,3,0,1,false)).is_none());
        client.poll().unwrap();
        assert!(!drain(&mut host).iter().any(|e| matches!(e, Event::KeyframeNeeded)));
        assert!(client.on_datagram(&video_packet(&host,5,4,0,2,true)).is_none());
        assert!(client.on_datagram(&video_packet(&host,6,4,1,2,true)).is_some());
        assert!(!client.video_waiting_keyframe);
        assert!(client.on_datagram(&video_packet(&host,7,5,0,1,false)).is_some());
    }

    #[test]
    fn entire_missing_frame_and_lost_recovery_request_are_detected() {
        let (mut host, mut client) = pair(BitratePreset::Max);
        client.on_datagram(&video_packet(&host,0,0,0,1,true));
        assert!(client.on_datagram(&video_packet(&host,2,2,0,1,false)).is_none());
        client.poll().unwrap();drain(&mut host); // Ignore the first request.
        client.last_recovery_request = Some(Instant::now() - Duration::from_millis(251));
        client.poll().unwrap();
        assert!(drain(&mut host).iter().any(|e| matches!(e, Event::KeyframeNeeded)));
    }

    #[test]
    fn duplicate_and_reordered_fragments_do_not_trigger_recovery() {
        let (host, mut client) = pair(BitratePreset::Max);
        assert!(client.on_datagram(&video_packet(&host,1,u32::MAX,1,2,true)).is_none());
        assert!(client.on_datagram(&video_packet(&host,2,u32::MAX,1,2,true)).is_none());
        assert!(!client.want_keyframe);
        assert!(client.on_datagram(&video_packet(&host,0,u32::MAX,0,2,true)).is_some());
        assert!(client.on_datagram(&video_packet(&host,3,0,0,1,false)).is_some());
        assert!(client.on_datagram(&video_packet(&host,4,u32::MAX,0,2,true)).is_none());
        assert!(!client.want_keyframe);
        assert!(!client.video_waiting_keyframe);
    }

    #[test]
    fn v1_reports_measure_packet_round_trip_instead_of_session_age() {
        let (mut host, _) = pair(BitratePreset::Max);
        host.started -= Duration::from_secs(5);
        host.send_frame(Channel::Cursor, b"cursor", false).unwrap();
        let report = Report { highest_seq: 0, received: 1, expected: 1, echo_send_us: 0, delay_us: 0 };
        let mut bytes = [0; Report::WIRE_LEN];
        report.encode(&mut bytes);
        host.on_control(&bytes);
        assert!(host.rtt_ms().unwrap() < 100.0, "session age must not masquerade as RTT");
        let before = host.rtt_ms();
        assert!(host.on_control(&bytes).is_none());
        assert_eq!(host.rtt_ms(), before, "non-advancing acknowledgements have no fresh timing");
    }

    #[test]
    fn serviced_events_are_delivered_once_to_application() {
        let (mut host, mut client) = pair(BitratePreset::Max);
        client.request_keyframe().unwrap();
        std::thread::sleep(Duration::from_millis(5));
        host.service().unwrap(); host.service().unwrap();
        assert_eq!(host.poll().unwrap().iter().filter(|e| matches!(e, Event::KeyframeNeeded)).count(), 1);
        assert!(!host.poll().unwrap().iter().any(|e| matches!(e, Event::KeyframeNeeded)));
    }

    #[test]
    fn receiver_keyframe_request_reaches_encoder_peer() {
        let (mut host, mut client) = pair(BitratePreset::Max);
        client.request_keyframe().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        assert!(host.poll().unwrap().iter().any(|e| matches!(e, Event::KeyframeNeeded)));
    }
    use super::*;
    use std::net::{IpAddr, Ipv4Addr};

    fn local(port: u16) -> SocketAddr {
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port)
    }

    /// Two real sessions over real loopback UDP.
    fn pair(preset: BitratePreset) -> (Session, Session) {
        let token = b"paired-device-token";
        let salt = [9u8; 8];

        // Bind each live socket once; reserving then dropping ephemeral ports
        // races with other concurrent tests on Windows.
        let mut a = Session::bind(local(0), local(1), token, salt, Direction::HostToClient, preset).unwrap();
        let b = Session::bind(local(0), a.local_addr().unwrap(), token, salt, Direction::ClientToHost, preset).unwrap();
        a.peer = b.local_addr().unwrap();
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

        let mut good =
            Session::bind(local(0), local(1), token_a, salt, Direction::HostToClient, BitratePreset::Max).unwrap();
        let mut impostor =
            Session::bind(local(0), good.local_addr().unwrap(), token_b, salt, Direction::ClientToHost, BitratePreset::Max).unwrap();
        good.peer = impostor.local_addr().unwrap();

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

    /// Windows reports a previous send's ICMP Port Unreachable on the next
    /// recv. Treating that as fatal killed the host stream every time the
    /// client was a moment slow to bind — which is most session starts.
    #[test]
    fn a_peer_that_is_not_listening_does_not_kill_the_session() {
        let token = b"paired-device-token";
        let salt = [4u8; 8];
        let sock = UdpSocket::bind(local(0)).unwrap();
        let addr = sock.local_addr().unwrap();
        drop(sock);

        // Reserve a port and free it, so nothing is listening there.
        let dead = UdpSocket::bind(local(0)).unwrap();
        let dead_addr = dead.local_addr().unwrap();
        drop(dead);

        let mut host =
            Session::bind(addr, dead_addr, token, salt, Direction::HostToClient, BitratePreset::Max)
                .unwrap();

        // Send into the void repeatedly, polling between sends. On Windows this
        // is what produces the reset; elsewhere it is simply a no-op.
        for _ in 0..20 {
            host.send_frame(Channel::Video, &[1u8; 900], false).unwrap();
            std::thread::sleep(Duration::from_millis(5));
            let events = host
                .poll()
                .expect("an unreachable peer must never fail the session");
            assert!(events.iter().all(|e| !matches!(e, Event::Frame { .. })));
        }
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

    fn negotiate_fec(host: &mut Session, client: &mut Session) {
        host.poll().unwrap();
        drain(client);
        drain(host);
        assert!(host.fec_sending());
        assert!(client.fec_receive);
        assert!(host.media_bitrate_bps() < host.bitrate_bps());
    }

    fn queued_packets(client: &Session) -> Vec<Vec<u8>> {
        let mut packets = Vec::new();
        let mut buf = [0u8; 2048];
        loop {
            match client.socket.recv_from(&mut buf) {
                Ok((n, _)) => packets.push(buf[..n].to_vec()),
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
                Err(e) => panic!("receive failed: {e}"),
            }
        }
        packets
    }

    #[test]
    fn fec_repairs_one_missing_fragment_with_authenticated_wire_packets() {
        for parity_first in [false, true] {
            let (mut host, mut client) = pair(BitratePreset::Max);
            negotiate_fec(&mut host, &mut client);
            let payload: Vec<u8> = (0..9001).map(|i| (i % 251) as u8).collect();
            host.send_frame(Channel::Video, &payload, true).unwrap();
            let mut packets = queued_packets(&client);
            assert!(packets.iter().all(|p| p.len() <= MAX_DATAGRAM));
            packets.retain(|p| {
                let h = Header::decode(p).unwrap();
                !(h.channel == Channel::Video && h.frag_index == 2)
            });
            if parity_first {
                packets.sort_by_key(|p| Header::decode(p).unwrap().flags & FEC_PARITY == 0);
            }
            let mut frames = Vec::new();
            for packet in packets.iter().chain(packets.iter()) {
                for event in client.on_datagram(packet).unwrap_or_default() {
                    if let Event::Frame { payload, .. } = event { frames.push(payload); }
                }
            }
            assert_eq!(frames, vec![payload], "repair and replay must deliver exactly once");
            assert!(!client.want_keyframe);
        }
    }

    #[test]
    fn fec_requires_capability_ack_and_preserves_unextended_peer_delivery() {
        let (mut host, mut client) = pair(BitratePreset::Max);
        host.on_control(b"FEC!");
        assert!(!host.fec_sending(), "unsolicited acknowledgement is ignored");
        client.set_fec_allowed(false);
        host.poll().unwrap();
        drain(&mut client);
        drain(&mut host);
        assert!(!host.fec_sending());
        let payload = vec![42; 5000];
        host.send_frame(Channel::Video, &payload, true).unwrap();
        let packets = queued_packets(&client);
        assert!(packets.iter().all(|p| p.len() <= MAX_DATAGRAM));
        let mut frames = Vec::new();
        for packet in packets {
            assert_eq!(Header::decode(&packet).unwrap().flags & (FEC_DATA | FEC_PARITY), 0);
            for event in client.on_datagram(&packet).unwrap_or_default() {
                if let Event::Frame { payload, .. } = event { frames.push(payload); }
            }
        }
        assert_eq!(frames, vec![payload]);
    }

    #[test]
    fn unrecoverable_fec_loss_suppresses_dependencies_until_keyframe() {
        // Either two original shards, or one shard and its parity, are lost.
        for lose_parity in [false, true] {
            let (mut host, mut client) = pair(BitratePreset::Max);
            negotiate_fec(&mut host, &mut client);
            host.send_frame(Channel::Video, b"initial", true).unwrap();
            assert!(drain(&mut client).iter().any(|e| matches!(e, Event::Frame { .. })));
            host.send_frame(Channel::Video, &vec![7; 4000], false).unwrap();
            for packet in queued_packets(&client) {
                let h = Header::decode(&packet).unwrap();
                let drop = (h.channel == Channel::Video && h.frag_index == 0)
                    || (lose_parity && h.flags & FEC_PARITY != 0)
                    || (!lose_parity && h.channel == Channel::Video && h.frag_index == 1);
                if !drop {
                    assert!(!client.on_datagram(&packet).unwrap_or_default().iter()
                        .any(|e| matches!(e, Event::Frame { .. })));
                }
            }
            host.send_frame(Channel::Video, b"dependent", false).unwrap();
            assert!(!drain(&mut client).iter().any(|e| matches!(e, Event::Frame { .. })));
            for (at, _, _) in &mut client.reordered_video { *at -= VIDEO_REORDER_GRACE; }
            client.poll().unwrap();
            assert!(client.video_waiting_keyframe);
            host.send_frame(Channel::Video, b"recovery", true).unwrap();
            assert!(drain(&mut client).iter().any(|e|
                matches!(e, Event::Frame { keyframe: true, payload, .. } if payload == b"recovery")));
            assert!(!client.video_waiting_keyframe);
        }
    }

    #[test]
    fn late_parity_releases_repaired_frame_before_queued_dependency() {
        let (mut host, mut client) = pair(BitratePreset::Max);
        negotiate_fec(&mut host, &mut client);
        host.send_frame(Channel::Video, b"initial", true).unwrap();
        drain(&mut client);
        let missing = vec![7; 4000];
        host.send_frame(Channel::Video, &missing, false).unwrap();
        let mut parity = Vec::new();
        for packet in queued_packets(&client) {
            let h = Header::decode(&packet).unwrap();
            if h.flags & FEC_PARITY != 0 { parity.push(packet); }
            else if h.channel != Channel::Video || h.frag_index != 1 {
                client.on_datagram(&packet);
            }
        }
        host.send_frame(Channel::Video, b"dependent", false).unwrap();
        for packet in queued_packets(&client) {
            assert!(!client.on_datagram(&packet).unwrap_or_default().iter()
                .any(|e| matches!(e, Event::Frame { .. })));
        }
        assert_eq!(client.reordered_video.len(), 1);
        let frames: Vec<_> = parity.iter().flat_map(|p| client.on_datagram(p).unwrap_or_default())
            .filter_map(|e| if let Event::Frame { payload, .. } = e { Some(payload) } else { None }).collect();
        assert_eq!(frames, vec![missing, b"dependent".to_vec()]);
        assert!(!client.video_waiting_keyframe);
        assert!(client.reordered_video.is_empty());
    }

    #[test]
    fn capability_retries_survive_lost_request_and_acknowledgement() {
        let (mut host, mut client) = pair(BitratePreset::Max);
        host.poll().unwrap();
        queued_packets(&client); // Lost first request.
        assert!(!host.fec_sending());
        host.fec_last_probe = Some(Instant::now() - Duration::from_secs(1));
        host.poll().unwrap();
        drain(&mut client);
        queued_packets(&host); // Lost acknowledgement.
        assert!(!host.fec_sending());
        host.fec_last_probe = Some(Instant::now() - Duration::from_secs(1));
        host.poll().unwrap();
        drain(&mut client);
        drain(&mut host);
        assert!(host.fec_sending());
    }

    #[test]
    fn legacy_full_size_encrypted_fragment_still_decodes() {
        let (host, mut client) = pair(BitratePreset::Max);
        let payload = vec![17; belay_wire::packet::MAX_PAYLOAD];
        let packet = host.send_key.seal(&Header { channel: Channel::Video,
            sequence: 0, frame_id: 0, frag_index: 0, frag_count: 1,
            flags: flags::KEYFRAME | flags::FRAME_END, send_us: 0 }, &payload);
        assert_eq!(packet.len(), 1216, "legacy senders omitted tag from MTU budget");
        assert!(client.on_datagram(&packet).unwrap().iter().any(|event|
            matches!(event, Event::Frame { payload: received, .. } if *received == payload)));
    }

    #[test]
    fn cancellation_interrupts_a_paced_access_unit() {
        let (mut host, _client) = pair(BitratePreset::DataSaver);
        let flag = Arc::new(AtomicBool::new(false));
        host.set_cancellation(flag.clone());
        let started = Instant::now();
        let worker = std::thread::spawn(move || host.send_frame(Channel::Video, &vec![7; 400_000], true));
        std::thread::sleep(Duration::from_millis(10));
        flag.store(true, Ordering::Relaxed);
        assert!(matches!(worker.join().unwrap(), Err(SessionError::Io(error)) if error.kind() == io::ErrorKind::Interrupted));
        assert!(started.elapsed() < Duration::from_secs(1), "shutdown must interrupt pacing");
    }
}
