//! Session ownership stays on one sender thread. Two credits cover the entire
//! pipeline: encoder submissions, one pending access unit, and one active send.
//! Backpressure is applied before capture/encode, never by dropping H.264 deltas.
#![cfg(windows)]

use std::collections::VecDeque;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use belay_encode::h264::CodedFrame;
use belay_net::{Event, Session};
use belay_wire::packet::Channel;

const PIPELINE_CREDITS: usize = 2;
const MAX_TIMING_SAMPLES: usize = 240;
const ENCODER_OUTPUT_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, Default)]
pub struct TransportStatus {
    pub bitrate: u64,
    pub media_bitrate: u64,
    pub rtt_ms: f64,
    pub fec: bool,
}

#[derive(Debug, Default)]
pub struct SendStats {
    pub frames: u64,
    pub bytes: u64,
    pub send_us: u128,
    pub queue_us: u128,
    pub output_latencies: Vec<u64>,
    pub status: TransportStatus,
}

#[derive(Debug, Default)]
pub struct Feedback {
    pub bitrate: Option<u64>,
    pub keyframe: bool,
}

struct Pending {
    frame: CodedFrame,
    queued: Instant,
}

#[derive(Default)]
struct State {
    pending: Option<Pending>,
    active: bool,
    encoding: VecDeque<Instant>,
    cursor: Option<[u8; 16]>,
    feedback: Feedback,
    stats: SendStats,
    error: Option<String>,
    draining: bool,
    finished: bool,
}

impl State {
    fn credits_used(&self) -> usize {
        self.encoding.len() + usize::from(self.active) + usize::from(self.pending.is_some())
    }
}

type Shared = Arc<(Mutex<State>, Condvar)>;

trait Transport: Send + 'static {
    fn poll(&mut self) -> Result<Vec<Event>, String>;
    fn send(&mut self, channel: Channel, payload: &[u8], keyframe: bool) -> Result<(), String>;
    fn status(&self) -> TransportStatus;
}

impl Transport for Session {
    fn poll(&mut self) -> Result<Vec<Event>, String> {
        Session::poll(self).map_err(|e| format!("session failed: {e:?}"))
    }
    fn send(&mut self, channel: Channel, payload: &[u8], keyframe: bool) -> Result<(), String> {
        self.send_frame(channel, payload, keyframe)
            .map_err(|e| format!("stream send failed: {e:?}"))
    }
    fn status(&self) -> TransportStatus {
        TransportStatus {
            bitrate: self.bitrate_bps(),
            media_bitrate: self.media_bitrate_bps(),
            rtt_ms: self.rtt_ms().unwrap_or(0.0),
            fec: self.fec_sending(),
        }
    }
}

pub struct Sender {
    shared: Shared,
    cancelled: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl Sender {
    pub fn start(mut session: Session) -> Result<Self, String> {
        let cancelled = Arc::new(AtomicBool::new(false));
        session.set_cancellation(cancelled.clone());
        Self::start_transport(session, cancelled)
    }

    fn start_transport<T: Transport>(
        transport: T,
        cancelled: Arc<AtomicBool>,
    ) -> Result<Self, String> {
        let state = State {
            stats: SendStats {
                status: transport.status(),
                ..Default::default()
            },
            ..Default::default()
        };
        let shared = Arc::new((Mutex::new(state), Condvar::new()));
        let worker_shared = shared.clone();
        let worker_cancelled = cancelled.clone();
        let worker = thread::Builder::new()
            .name("belay-sender".into())
            .spawn(move || {
                let result = catch_unwind(AssertUnwindSafe(|| {
                    run_worker(transport, &worker_shared, &worker_cancelled)
                }))
                .unwrap_or_else(|_| Err("sender thread panicked".into()));
                let mut state = worker_shared
                    .0
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if let Err(error) = result {
                    state.error = Some(error);
                }
                state.pending = None;
                state.cursor = None;
                state.active = false;
                state.finished = true;
                worker_shared.1.notify_all();
            })
            .map_err(|e| format!("cannot start sender: {e}"))?;
        Ok(Self {
            shared,
            cancelled,
            worker: Some(worker),
        })
    }

    /// Reserve before capture. Cancel when capture has no changed pixels.
    pub fn try_reserve(&self) -> Result<bool, String> {
        let mut state = self.shared.0.lock().unwrap();
        check(&state)?;
        if state.draining || state.credits_used() >= PIPELINE_CREDITS {
            return Ok(false);
        }
        state.encoding.push_back(Instant::now());
        Ok(true)
    }

    pub fn cancel_reservation(&self) {
        let mut state = self.shared.0.lock().unwrap();
        assert!(
            state.encoding.pop_back().is_some(),
            "reservation must exist"
        );
        self.shared.1.notify_all();
    }

    /// Every output consumes one previously reserved encoder submission.
    /// With two credits a full pending slot implies no active send; this wait
    /// only hands that slot to the worker, never queues a third access unit.
    pub fn submit(&self, frame: CodedFrame) -> Result<(), String> {
        let mut state = self.shared.0.lock().unwrap();
        check(&state)?;
        if state.encoding.is_empty() {
            return Err("encoder emitted an unreserved access unit".into());
        }
        while state.pending.is_some() {
            state = self
                .shared
                .1
                .wait_timeout(state, Duration::from_millis(10))
                .unwrap()
                .0;
            check(&state)?;
        }
        state.encoding.pop_front();
        state.pending = Some(Pending {
            frame,
            queued: Instant::now(),
        });
        self.shared.1.notify_all();
        Ok(())
    }

    pub fn cursor(&self, sample: [u8; 16]) {
        self.shared.0.lock().unwrap().cursor = Some(sample);
        self.shared.1.notify_all();
    }

    pub fn take_feedback(&self) -> Result<Feedback, String> {
        let mut state = self.shared.0.lock().unwrap();
        check(&state)?;
        Ok(std::mem::take(&mut state.feedback))
    }

    pub fn take_stats(&self) -> Result<SendStats, String> {
        let mut state = self.shared.0.lock().unwrap();
        check(&state)?;
        let status = state.stats.status;
        let stats = std::mem::take(&mut state.stats);
        state.stats.status = status;
        Ok(stats)
    }

    /// Finish only after all encoder outputs have been submitted. Used by
    /// bounded sources/tests; normal error cleanup cancels instead of draining.
    #[allow(dead_code)]
    pub fn finish(mut self) -> Result<SendStats, String> {
        {
            let mut state = self.shared.0.lock().unwrap();
            if !state.encoding.is_empty() {
                return Err("encoder still owns pipeline credits".into());
            }
            state.draining = true;
            self.shared.1.notify_all();
        }
        if self.worker.take().unwrap().join().is_err() {
            return Err("sender thread panicked".into());
        }
        let mut state = self.shared.0.lock().unwrap();
        if let Some(error) = &state.error {
            return Err(error.clone());
        }
        Ok(std::mem::take(&mut state.stats))
    }
}

impl Drop for Sender {
    fn drop(&mut self) {
        self.cancelled.store(true, Ordering::Release);
        self.shared.1.notify_all();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn check(state: &State) -> Result<(), String> {
    check_at(state, Instant::now())
}

fn check_at(state: &State, now: Instant) -> Result<(), String> {
    if let Some(error) = &state.error {
        return Err(error.clone());
    }
    if state.finished {
        return Err("sender stopped".into());
    }
    if state.encoding.front().is_some_and(|&submitted| {
        now.saturating_duration_since(submitted) >= ENCODER_OUTPUT_TIMEOUT
    }) {
        return Err("encoder produced no output within 2 seconds".into());
    }
    Ok(())
}

fn run_worker<T: Transport>(
    mut transport: T,
    shared: &Shared,
    cancelled: &AtomicBool,
) -> Result<(), String> {
    loop {
        if cancelled.load(Ordering::Acquire) {
            return Ok(());
        }
        let events = transport.poll()?;
        let status = transport.status();
        let (cursor, pending) = {
            let mut state = shared.0.lock().unwrap();
            for event in events {
                match event {
                    Event::Bitrate { bps } => state.feedback.bitrate = Some(bps),
                    Event::KeyframeNeeded => state.feedback.keyframe = true,
                    Event::Frame { .. } => {}
                }
            }
            state.stats.status = status;
            let cursor = state.cursor.take();
            let pending = state.pending.take();
            state.active = pending.is_some();
            shared.1.notify_all();
            if cursor.is_none() && pending.is_none() {
                if state.draining {
                    return Ok(());
                }
                let _ = shared
                    .1
                    .wait_timeout(state, Duration::from_millis(1))
                    .unwrap();
                continue;
            }
            (cursor, pending)
        };
        // Cursor is newest-wins and precedes the next AU. It cannot preempt a
        // currently paced send_frame; input already uses a separate channel.
        if let Some(cursor) = cursor {
            transport.send(Channel::Cursor, &cursor, false)?;
        }
        if let Some(pending) = pending {
            let queue_us = pending.queued.elapsed().as_micros();
            let start = Instant::now();
            transport.send(Channel::Video, &pending.frame.data, pending.frame.keyframe)?;
            let status = transport.status();
            let mut state = shared.0.lock().unwrap();
            state.active = false;
            state.stats.frames += 1;
            state.stats.bytes += pending.frame.data.len() as u64;
            state.stats.send_us += start.elapsed().as_micros();
            state.stats.queue_us += queue_us;
            if let Some(latency) = pending.frame.output_latency_us {
                if state.stats.output_latencies.len() < MAX_TIMING_SAMPLES {
                    state.stats.output_latencies.push(latency);
                }
            }
            state.stats.status = status;
            shared.1.notify_all();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct FakeState {
        entered: usize,
        released: bool,
        sent: Vec<Vec<u8>>,
        fail: bool,
        panic: bool,
        events: Vec<Event>,
    }
    struct Fake {
        state: Arc<(Mutex<FakeState>, Condvar)>,
        cancelled: Arc<AtomicBool>,
    }
    impl Transport for Fake {
        fn poll(&mut self) -> Result<Vec<Event>, String> {
            Ok(std::mem::take(&mut self.state.0.lock().unwrap().events))
        }
        fn status(&self) -> TransportStatus {
            TransportStatus::default()
        }
        fn send(&mut self, _: Channel, payload: &[u8], _: bool) -> Result<(), String> {
            let mut state = self.state.0.lock().unwrap();
            state.entered += 1;
            self.state.1.notify_all();
            while !state.released && !self.cancelled.load(Ordering::Acquire) {
                state = self
                    .state
                    .1
                    .wait_timeout(state, Duration::from_millis(1))
                    .unwrap()
                    .0;
            }
            if self.cancelled.load(Ordering::Acquire) {
                return Err("cancelled".into());
            }
            if state.panic {
                drop(state);
                panic!("injected transport panic");
            }
            if state.fail {
                return Err("injected send error".into());
            }
            state.sent.push(payload.to_vec());
            Ok(())
        }
    }
    fn setup() -> (Sender, Arc<(Mutex<FakeState>, Condvar)>) {
        let state = Arc::new((Mutex::new(FakeState::default()), Condvar::new()));
        let cancelled = Arc::new(AtomicBool::new(false));
        let sender = Sender::start_transport(
            Fake {
                state: state.clone(),
                cancelled: cancelled.clone(),
            },
            cancelled,
        )
        .unwrap();
        (sender, state)
    }
    fn frame(byte: u8) -> CodedFrame {
        CodedFrame {
            data: vec![byte],
            keyframe: byte == 0,
            timestamp_hns: 0,
            output_latency_us: Some(3),
        }
    }
    fn await_active(state: &Arc<(Mutex<FakeState>, Condvar)>) {
        let start = Instant::now();
        let mut guard = state.0.lock().unwrap();
        while guard.entered == 0 {
            assert!(start.elapsed() < Duration::from_secs(2));
            guard = state
                .1
                .wait_timeout(guard, Duration::from_millis(10))
                .unwrap()
                .0;
        }
    }

    #[test]
    fn slow_sender_bounds_entire_pipeline_and_drain_preserves_order() {
        let (sender, state) = setup();
        assert!(sender.try_reserve().unwrap());
        sender.submit(frame(0)).unwrap();
        await_active(&state);
        assert!(sender.try_reserve().unwrap());
        sender.submit(frame(1)).unwrap();
        assert!(!sender.try_reserve().unwrap());
        assert_eq!(sender.shared.0.lock().unwrap().credits_used(), 2);
        state.0.lock().unwrap().released = true;
        state.1.notify_all();
        let stats = sender.finish().unwrap();
        assert_eq!(stats.frames, 2);
        assert_eq!(state.0.lock().unwrap().sent, vec![vec![0], vec![1]]);
    }

    #[test]
    fn encoder_reservations_are_bounded_before_any_output_exists() {
        let (sender, _) = setup();
        assert!(sender.try_reserve().unwrap());
        assert!(sender.try_reserve().unwrap());
        assert!(!sender.try_reserve().unwrap());
        sender.cancel_reservation();
        assert!(sender.try_reserve().unwrap());
        sender.cancel_reservation();
        sender.cancel_reservation();
        assert_eq!(sender.finish().unwrap().frames, 0);
    }

    #[test]
    fn send_failure_reaches_owner_and_does_not_send_pending_delta() {
        let (sender, state) = setup();
        sender.try_reserve().unwrap();
        sender.submit(frame(0)).unwrap();
        await_active(&state);
        sender.try_reserve().unwrap();
        sender.submit(frame(1)).unwrap();
        {
            let mut state = state.0.lock().unwrap();
            state.fail = true;
            state.released = true;
        }
        state.1.notify_all();
        assert_eq!(sender.finish().unwrap_err(), "injected send error");
        assert!(state.0.lock().unwrap().sent.is_empty());
    }

    #[test]
    fn drop_cancels_active_send_and_releases_worker() {
        let (sender, state) = setup();
        sender.try_reserve().unwrap();
        sender.submit(frame(0)).unwrap();
        await_active(&state);
        let start = Instant::now();
        drop(sender);
        assert!(start.elapsed() < Duration::from_secs(1));
        assert!(state.0.lock().unwrap().sent.is_empty());
    }

    #[test]
    fn cursor_mailbox_keeps_latest_sample_ahead_of_pending_video() {
        let (sender, state) = setup();
        sender.try_reserve().unwrap();
        sender.submit(frame(0)).unwrap();
        await_active(&state);
        sender.try_reserve().unwrap();
        sender.submit(frame(1)).unwrap();
        sender.cursor([7; 16]);
        sender.cursor([9; 16]);
        state.0.lock().unwrap().released = true;
        state.1.notify_all();
        sender.finish().unwrap();
        assert_eq!(
            state.0.lock().unwrap().sent,
            vec![vec![0], vec![9; 16], vec![1]]
        );
    }

    #[test]
    fn feedback_is_coalesced_to_latest_bitrate_and_one_recovery_request() {
        let (sender, state) = setup();
        state.0.lock().unwrap().events = vec![
            Event::Bitrate { bps: 1_000_000 },
            Event::KeyframeNeeded,
            Event::Bitrate { bps: 2_000_000 },
            Event::KeyframeNeeded,
        ];
        let deadline = Instant::now() + Duration::from_secs(2);
        while sender.shared.0.lock().unwrap().feedback.bitrate.is_none() {
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(1));
        }
        let feedback = sender.take_feedback().unwrap();
        assert_eq!(feedback.bitrate, Some(2_000_000));
        assert!(feedback.keyframe);
        let empty = sender.take_feedback().unwrap();
        assert!(empty.bitrate.is_none() && !empty.keyframe);
        sender.finish().unwrap();
    }

    #[test]
    fn oldest_outstanding_encoder_submission_has_its_own_deadline() {
        let start = Instant::now();
        let mut state = State::default();
        state.encoding.push_back(start);
        state.encoding.push_back(start + Duration::from_secs(1));
        assert!(check_at(
            &state,
            start + ENCODER_OUTPUT_TIMEOUT - Duration::from_micros(1)
        )
        .is_ok());
        assert_eq!(
            check_at(&state, start + ENCODER_OUTPUT_TIMEOUT).unwrap_err(),
            "encoder produced no output within 2 seconds"
        );
        // Receiving the first output advances to the second submission's
        // actual deadline, rather than retaining or arbitrarily resetting it.
        state.encoding.pop_front();
        assert!(check_at(&state, start + ENCODER_OUTPUT_TIMEOUT).is_ok());
        assert!(check_at(&state, start + Duration::from_secs(3)).is_err());
        state.encoding.clear();
        state.active = true;
        assert!(
            check_at(&state, start + Duration::from_secs(60)).is_ok(),
            "network pacing is not an encoder-output timeout"
        );
    }

    #[test]
    fn encoder_timeout_reaches_owner_and_cleanup_cancels_active_network_send() {
        let (sender, state) = setup();
        sender.try_reserve().unwrap();
        sender.submit(frame(0)).unwrap();
        await_active(&state);
        sender.try_reserve().unwrap();
        sender.shared.0.lock().unwrap().encoding[0] = Instant::now() - ENCODER_OUTPUT_TIMEOUT;
        assert_eq!(
            sender.take_feedback().unwrap_err(),
            "encoder produced no output within 2 seconds"
        );
        let start = Instant::now();
        drop(sender);
        assert!(start.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn worker_panic_becomes_owner_error_and_wakes_waiters() {
        let (sender, state) = setup();
        sender.try_reserve().unwrap();
        sender.submit(frame(0)).unwrap();
        await_active(&state);
        {
            let mut fake = state.0.lock().unwrap();
            fake.panic = true;
            fake.released = true;
        }
        state.1.notify_all();
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            match sender.take_feedback() {
                Err(error) => {
                    assert_eq!(error, "sender thread panicked");
                    break;
                }
                Ok(_) => {
                    assert!(
                        Instant::now() < deadline,
                        "panic must not leave the owner waiting forever"
                    );
                    thread::sleep(Duration::from_millis(1));
                }
            }
        }
        assert_eq!(sender.finish().unwrap_err(), "sender thread panicked");
    }
}
