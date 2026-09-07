//! Link measurement: what the receiver tells the sender, and how the sender
//! turns it into loss and RTT.
//!
//! The congestion controller in `belay_wire::congestion` is only as good as the
//! numbers fed to it, and both of these are easy to compute wrongly in ways
//! that are invisible until the link degrades:
//!
//! * **Loss must be measured over sequence SPACE, not by counting arrivals.**
//!   Counting "how many did I get this interval" cannot distinguish loss from
//!   the sender simply having sent less — an idle desktop would look like 100%
//!   loss and collapse the bitrate exactly when nothing was wrong.
//! * **RTT must be smoothed, and the minimum kept separately.** A single
//!   spike is noise; the running minimum is the empty-queue floor the gradient
//!   guard measures swelling against.

use belay_wire::packet::seq_newer;
use std::collections::VecDeque;

// Include ordinary scheduling jitter as well as packet reordering. This delays
// only loss accounting, never delivery; feedback still runs every 50 ms.
const LOSS_SETTLE_US: u64 = 25_000;
const MAX_UNSETTLED: usize = 4096;

/// A receiver's report, sent back on the Control channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Report {
    /// Highest sequence the receiver has seen.
    pub highest_seq: u32,
    /// Received datagrams in the sequence range finalized for this report.
    pub received: u32,
    /// Size of the finalized sequence range. This may trail highest_seq while
    /// recent holes are given time to arrive out of order.
    pub expected: u32,
    /// Echo of the newest `send_us` seen, so the sender can compute RTT
    /// without the two clocks ever having to agree on an absolute time.
    pub echo_send_us: u32,
    /// Microseconds the receiver held the report before sending, subtracted so
    /// its own scheduling delay is not charged to the network.
    pub delay_us: u32,
}

impl Report {
    pub const WIRE_LEN: usize = 20;

    pub fn encode(&self, out: &mut [u8]) -> usize {
        assert!(out.len() >= Self::WIRE_LEN);
        out[0..4].copy_from_slice(&self.highest_seq.to_le_bytes());
        out[4..8].copy_from_slice(&self.received.to_le_bytes());
        out[8..12].copy_from_slice(&self.expected.to_le_bytes());
        out[12..16].copy_from_slice(&self.echo_send_us.to_le_bytes());
        out[16..20].copy_from_slice(&self.delay_us.to_le_bytes());
        Self::WIRE_LEN
    }

    pub fn decode(buf: &[u8]) -> Option<Report> {
        if buf.len() < Self::WIRE_LEN {
            return None;
        }
        let u32_at = |o: usize| u32::from_le_bytes([buf[o], buf[o + 1], buf[o + 2], buf[o + 3]]);
        Some(Report {
            highest_seq: u32_at(0),
            received: u32_at(4),
            expected: u32_at(8),
            echo_send_us: u32_at(12),
            delay_us: u32_at(16),
        })
    }

    /// Loss over the interval, 0..=1.
    ///
    /// Clamped rather than trusted: `received > expected` is arithmetically
    /// impossible but a peer can claim it, and a negative loss ratio would send
    /// the controller upward on a link that is failing.
    pub fn loss_ratio(&self) -> f64 {
        if self.expected == 0 {
            return 0.0;
        }
        let lost = self.expected.saturating_sub(self.received) as f64;
        (lost / self.expected as f64).clamp(0.0, 1.0)
    }
}

/// Receiver side: watches arriving sequences and builds reports.
#[derive(Debug, Default)]
pub struct ReceiveTracker {
    highest: Option<u32>,
    pending_start: Option<u32>,
    // Each slot represents one sequence number, including holes. The time is
    // when that number first became observable, not when it was later filled.
    pending: VecDeque<(bool, u64)>,
    finalized_any: bool,
    finalized_received: u32,
    finalized_expected: u32,
    /// Send-stamp of the newest datagram received IN THIS INTERVAL, and when it
    /// arrived. Both reset each interval: echoing a stamp from an earlier
    /// interval would report the time since the sender went quiet as network
    /// RTT, and the gradient guard would cut the bitrate on an idle link.
    newest_this_interval: Option<(u32, u64)>,
}

impl ReceiveTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// `recv_us` is the local clock at arrival, used only to measure how long
    /// this side held the report before sending it.
    pub fn on_datagram(&mut self, sequence: u32, send_us: u32, recv_us: u64) {
        self.settle(recv_us);
        let start = *self.pending_start.get_or_insert(sequence);
        // Before the first finalized range, earlier reordered arrivals may
        // establish its true start. After finalization, they are already late.
        if seq_newer(start, sequence) && !self.finalized_any {
            let earlier = start.wrapping_sub(sequence) as usize;
            if earlier <= MAX_UNSETTLED.saturating_sub(self.pending.len()) {
                for _ in 0..earlier {
                    self.pending.push_front((false, recv_us));
                }
                self.pending_start = Some(sequence);
            }
        }
        let start = self.pending_start.unwrap();
        let offset = sequence.wrapping_sub(start);
        if offset < 0x8000_0000 {
            let needed = offset as usize + 1;
            if needed > MAX_UNSETTLED {
                // Bound hostile or enormous jumps without allocating a slot
                // per missing packet. Only the oldest range loses its grace.
                let discard = needed - MAX_UNSETTLED;
                let held = discard.min(self.pending.len());
                for _ in 0..held {
                    self.finalize_front();
                }
                let holes = discard - held;
                if holes > 0 {
                    self.finalized_expected = self.finalized_expected.saturating_add(holes as u32);
                    self.finalized_any = true;
                    self.pending_start =
                        Some(self.pending_start.unwrap().wrapping_add(holes as u32));
                }
            }
            let index = sequence.wrapping_sub(self.pending_start.unwrap()) as usize;
            while self.pending.len() <= index {
                self.pending.push_back((false, recv_us));
            }
            self.pending[index].0 = true;
        }
        let newer = match self.highest {
            None => true,
            Some(h) => seq_newer(sequence, h),
        };
        if newer {
            self.highest = Some(sequence);
            self.newest_this_interval = Some((send_us, recv_us));
        }
    }

    fn finalize_front(&mut self) {
        if let Some((received, _)) = self.pending.pop_front() {
            self.finalized_expected = self.finalized_expected.saturating_add(1);
            self.finalized_received = self.finalized_received.saturating_add(u32::from(received));
            self.finalized_any = true;
            self.pending_start = self.pending_start.map(|start| start.wrapping_add(1));
        }
    }

    fn settle(&mut self, now_us: u64) {
        while self
            .pending
            .front()
            .is_some_and(|&(_, observed)| now_us.saturating_sub(observed) >= LOSS_SETTLE_US)
        {
            self.finalize_front();
        }
    }

    /// Close the interval and produce a report, or None if nothing arrived
    /// during it.
    ///
    /// Silence produces no report at all. Reporting on an interval with no
    /// arrivals is the trap: it either looks like total loss, or carries a
    /// stale echo that reads as enormous RTT — both of which make a healthy
    /// idle link look like a failing one.
    pub fn take_report(&mut self, now_us: u64) -> Option<Report> {
        self.settle(now_us);
        let (echo_send_us, arrived_us) = self.newest_this_interval.take()?;
        let delay_us = now_us.saturating_sub(arrived_us).min(u32::MAX as u64) as u32;
        let highest = self.highest?;
        let report = Report {
            highest_seq: highest,
            received: self.finalized_received,
            expected: self.finalized_expected,
            echo_send_us,
            delay_us,
        };
        self.finalized_received = 0;
        self.finalized_expected = 0;
        Some(report)
    }
}

/// Sender side: turns reports into the smoothed RTT the controller wants.
#[derive(Debug, Default)]
pub struct RttEstimator {
    smoothed_ms: Option<f64>,
    min_ms: Option<f64>,
}

/// Standard exponential smoothing weight for a new RTT sample (RFC 6298 uses
/// 1/8 for the same reason: fast enough to track, slow enough to ignore noise).
const RTT_ALPHA: f64 = 0.125;

impl RttEstimator {
    pub fn new() -> Self {
        Self::default()
    }

    /// Fold in one measurement. `now_us` and the report's echo are on the
    /// SENDER's clock, so the two ends never need synchronised time.
    pub fn sample(&mut self, now_us: u32, report: &Report) -> Option<f64> {
        let raw_us = now_us.wrapping_sub(report.echo_send_us);
        // A wrapped or absurd interval means the echo was stale; ignore it
        // rather than poison the estimate.
        if raw_us > 10_000_000 {
            return self.smoothed_ms;
        }
        // The receiver's own delay is not the network's fault.
        let net_us = raw_us.saturating_sub(report.delay_us);
        let sample_ms = net_us as f64 / 1000.0;

        self.smoothed_ms = Some(match self.smoothed_ms {
            None => sample_ms,
            Some(prev) => prev * (1.0 - RTT_ALPHA) + sample_ms * RTT_ALPHA,
        });
        self.min_ms = Some(match self.min_ms {
            None => sample_ms,
            Some(m) => m.min(sample_ms),
        });
        self.smoothed_ms
    }

    pub fn smoothed_ms(&self) -> Option<f64> {
        self.smoothed_ms
    }

    /// The empty-queue floor the RTT-gradient guard measures against.
    pub fn min_ms(&self) -> Option<f64> {
        self.min_ms
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interval_boundary_reordering_does_not_report_fictitious_loss() {
        use belay_wire::congestion::{AbrConfig, AbrState, LinkFeedback};
        let mut tracker = ReceiveTracker::new();
        // Send sequence 0 at 0 ms, 1 at 26 ms and 2 at 28 ms. Network
        // delays are all within 20..25 ms; every packet eventually arrives.
        tracker.on_datagram(0, 0, 20_000);
        tracker.on_datagram(2, 28_000, 48_000);
        let report = tracker.take_report(50_000).unwrap();
        assert_eq!((report.received, report.expected), (1, 1));
        assert_eq!(report.loss_ratio(), 0.0);
        let config = AbrConfig::default();
        let before = AbrState::new(1_500_000, &config);
        let after = before.next(
            LinkFeedback {
                loss_ratio: report.loss_ratio(),
                rtt_ms: 45.0,
            },
            &config,
        );
        assert!(after.bitrate_bps >= before.bitrate_bps);
        tracker.on_datagram(1, 26_000, 51_000);
        assert!(
            tracker.take_report(100_000).is_none(),
            "late-only arrivals have no fresh RTT echo"
        );
        tracker.on_datagram(3, 110_000, 130_000);
        let next = tracker.take_report(130_000 + LOSS_SETTLE_US).unwrap();
        assert_eq!((next.received, next.expected), (3, 3));
    }

    #[test]
    fn seeded_zero_loss_jitter_never_causes_spurious_interval_backoffs() {
        use belay_wire::congestion::{AbrConfig, AbrState, LinkFeedback};
        let mut rng = 0x51a7_u32;
        let mut arrivals = Vec::new();
        for seq in 0..10_000_u32 {
            rng = rng.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let sent = seq as u64 * 1000;
            // Five milliseconds network jitter plus up to twelve milliseconds
            // timer lateness observed in the Windows proxy measurement.
            arrivals.push((sent + 20_000 + (rng % 17_001) as u64, seq, sent as u32));
        }
        arrivals.sort_unstable();
        let mut tracker = ReceiveTracker::new();
        let config = AbrConfig::default();
        let mut abr = AbrState::new(config.max_bps, &config);
        let (mut index, mut lossy_reports, mut backoffs) = (0, 0, 0);
        let mut worst_loss = 0.0_f64;
        for report_time in (50_000..=10_050_000).step_by(50_000) {
            while index < arrivals.len() && arrivals[index].0 <= report_time {
                let (arrived, seq, sent) = arrivals[index];
                tracker.on_datagram(seq, sent, arrived);
                index += 1;
            }
            if let Some(report) = tracker.take_report(report_time) {
                let loss = report.loss_ratio();
                worst_loss = worst_loss.max(loss);
                lossy_reports += usize::from(loss > 0.0);
                let next = abr.next(
                    LinkFeedback {
                        loss_ratio: loss,
                        rtt_ms: 45.0,
                    },
                    &config,
                );
                backoffs += usize::from(next.bitrate_bps < abr.bitrate_bps);
                abr = next;
            }
        }
        assert_eq!(index, arrivals.len(), "all 10,000 packets arrived");
        assert_eq!(lossy_reports, 0);
        assert_eq!(backoffs, 0);
        eprintln!("zero-loss network and scheduler jitter: {lossy_reports} false-loss reports, {backoffs} ABR decreases, worst loss {worst_loss:.4}, final bitrate {}", abr.bitrate_bps);
    }

    #[test]
    fn actual_loss_is_finalized_once_and_very_late_original_does_not_change_next_range() {
        let mut tracker = ReceiveTracker::new();
        tracker.on_datagram(0, 0, 0);
        tracker.on_datagram(2, 2, 1_000);
        let lost = tracker.take_report(1_000 + LOSS_SETTLE_US).unwrap();
        assert_eq!((lost.received, lost.expected), (2, 3));
        assert!((lost.loss_ratio() - 1.0 / 3.0).abs() < 1e-9);
        tracker.on_datagram(1, 1, 2_000 + LOSS_SETTLE_US);
        assert!(tracker.take_report(2_000 + LOSS_SETTLE_US).is_none());
        tracker.on_datagram(3, 3, 3_000 + LOSS_SETTLE_US);
        tracker.on_datagram(3, 3, 4_000 + LOSS_SETTLE_US); // Duplicates cannot inflate counts.
        let next = tracker.take_report(3_000 + 2 * LOSS_SETTLE_US).unwrap();
        assert_eq!((next.received, next.expected), (1, 1));
        assert!(tracker.take_report(100_000).is_none());
    }

    #[test]
    fn settlement_wraps_and_rtt_echo_stays_aligned_with_highest_sequence() {
        let mut tracker = ReceiveTracker::new();
        tracker.on_datagram(u32::MAX - 1, 11, 1_000);
        tracker.on_datagram(0, 22, 3_000);
        tracker.on_datagram(u32::MAX, 33, 4_000);
        let report = tracker.take_report(5_000 + LOSS_SETTLE_US).unwrap();
        assert_eq!((report.received, report.expected), (3, 3));
        assert_eq!(report.highest_seq, 0);
        assert_eq!(report.echo_send_us, 22);
        assert_eq!(report.delay_us, (2_000 + LOSS_SETTLE_US) as u32);
        tracker.on_datagram(1, 44, 6_000 + LOSS_SETTLE_US);
        assert_eq!(tracker.take_report(6_000 + 2 * LOSS_SETTLE_US).unwrap().expected, 1);
    }

    #[test]
    fn huge_sequence_jump_has_bounded_state_and_does_not_hide_loss() {
        let mut tracker = ReceiveTracker::new();
        tracker.on_datagram(0, 0, 0);
        tracker.on_datagram(100_000, 1, 1);
        assert_eq!(tracker.pending.len(), MAX_UNSETTLED);
        let report = tracker.take_report(1 + LOSS_SETTLE_US).unwrap();
        assert_eq!((report.received, report.expected), (2, 100_001));
        assert!(tracker.pending.is_empty());
        tracker.on_datagram(100_001, 2, 2 + LOSS_SETTLE_US);
        assert_eq!(tracker.pending.len(), 1);
        assert_eq!(tracker.take_report(2 + 2 * LOSS_SETTLE_US).unwrap().loss_ratio(), 0.0);
    }

    #[test]
    fn report_round_trips() {
        let r = Report {
            highest_seq: 4242,
            received: 90,
            expected: 100,
            echo_send_us: 777,
            delay_us: 12,
        };
        let mut buf = [0u8; Report::WIRE_LEN];
        r.encode(&mut buf);
        assert_eq!(Report::decode(&buf), Some(r));
        assert_eq!(Report::decode(&buf[..4]), None);
    }

    #[test]
    fn loss_ratio_is_the_gap_between_expected_and_received() {
        let r = Report {
            highest_seq: 0,
            received: 90,
            expected: 100,
            echo_send_us: 0,
            delay_us: 0,
        };
        assert!((r.loss_ratio() - 0.10).abs() < 1e-9);
    }

    #[test]
    fn a_lying_peer_cannot_produce_a_negative_or_absurd_loss_ratio() {
        // received > expected is impossible, but a peer can claim it, and a
        // negative ratio would drive the controller UP on a failing link.
        let r = Report {
            highest_seq: 0,
            received: 500,
            expected: 100,
            echo_send_us: 0,
            delay_us: 0,
        };
        assert_eq!(r.loss_ratio(), 0.0);

        let z = Report {
            highest_seq: 0,
            received: 0,
            expected: 0,
            echo_send_us: 0,
            delay_us: 0,
        };
        assert_eq!(z.loss_ratio(), 0.0, "an empty interval is not total loss");
    }

    /// The bug this design exists to avoid: measuring loss by counting
    /// arrivals makes an idle sender look like a link that has failed, and a
    /// stale echo makes an idle link look slow.
    #[test]
    fn an_idle_sender_does_not_look_like_total_loss() {
        let mut t = ReceiveTracker::new();
        for seq in 0..10u32 {
            t.on_datagram(seq, seq * 100, 0);
        }
        let full = t.take_report(0).unwrap();
        assert_eq!(full.loss_ratio(), 0.0);

        // Next interval: the sender had nothing to send at all.
        assert!(
            t.take_report(0).is_none(),
            "no traffic means no report, not 100% loss"
        );
    }

    #[test]
    fn loss_is_measured_over_sequence_space() {
        let mut t = ReceiveTracker::new();
        // Sent 0..=9, but 3, 5 and 7 never arrived.
        for seq in [0u32, 1, 2, 4, 6, 8, 9] {
            t.on_datagram(seq, seq * 100, 0);
        }
        let r = t.take_report(LOSS_SETTLE_US).unwrap();
        assert_eq!(r.expected, 10);
        assert_eq!(r.received, 7);
        assert!((r.loss_ratio() - 0.3).abs() < 1e-9);
    }

    #[test]
    fn reordered_arrivals_do_not_inflate_the_span() {
        let mut t = ReceiveTracker::new();
        for seq in [5u32, 3, 4, 1, 2] {
            t.on_datagram(seq, 0, 0);
        }
        let r = t.take_report(LOSS_SETTLE_US).unwrap();
        assert_eq!(r.highest_seq, 5);
        assert_eq!(r.received, 5);
    }

    #[test]
    fn rtt_smooths_and_keeps_a_separate_minimum() {
        let mut e = RttEstimator::new();
        let r = |echo| Report {
            highest_seq: 0,
            received: 1,
            expected: 1,
            echo_send_us: echo,
            delay_us: 0,
        };

        e.sample(20_000, &r(0)); // 20ms
        assert_eq!(e.min_ms(), Some(20.0));

        // A single 200ms spike must move the smoothed value only a little.
        e.sample(200_000, &r(0));
        let s = e.smoothed_ms().unwrap();
        assert!(s < 50.0, "one spike must not dominate, got {s}");
        assert_eq!(
            e.min_ms(),
            Some(20.0),
            "the floor is the minimum, not the average"
        );

        // A genuinely faster path lowers the floor.
        e.sample(5_000, &r(0));
        assert_eq!(e.min_ms(), Some(5.0));
    }

    /// The receiver sitting on a report for 40ms is not the network's fault,
    /// and charging it to RTT would make the gradient guard hold on a link
    /// that is perfectly healthy.
    #[test]
    fn receiver_delay_is_not_charged_to_the_network() {
        let mut e = RttEstimator::new();
        let r = Report {
            highest_seq: 0,
            received: 1,
            expected: 1,
            echo_send_us: 0,
            delay_us: 40_000,
        };
        e.sample(50_000, &r);
        assert_eq!(
            e.smoothed_ms(),
            Some(10.0),
            "50ms round trip minus 40ms of holding"
        );
    }

    #[test]
    fn a_stale_echo_is_ignored_rather_than_poisoning_the_estimate() {
        let mut e = RttEstimator::new();
        let good = Report {
            highest_seq: 0,
            received: 1,
            expected: 1,
            echo_send_us: 0,
            delay_us: 0,
        };
        e.sample(20_000, &good);
        let before = e.smoothed_ms();

        // Echo from the future / wrapped clock: an absurd interval.
        let stale = Report {
            highest_seq: 0,
            received: 1,
            expected: 1,
            echo_send_us: 900_000_000,
            delay_us: 0,
        };
        e.sample(1000, &stale);
        assert_eq!(
            e.smoothed_ms(),
            before,
            "an implausible sample must change nothing"
        );
    }
}

#[cfg(test)]
mod interval_tests {
    use super::*;

    /// A report must never echo a stamp from an earlier interval. If it does,
    /// the time the SENDER spent idle is reported back as network RTT and the
    /// gradient guard cuts the bitrate on a perfectly healthy link.
    #[test]
    fn an_echo_never_comes_from_an_earlier_interval() {
        let mut t = ReceiveTracker::new();
        t.on_datagram(0, 1_000, 5_000);
        let first = t.take_report(6_000).unwrap();
        assert_eq!(first.echo_send_us, 1_000);

        // A long silence, then one fresh datagram.
        t.on_datagram(1, 900_000, 950_000);
        let second = t.take_report(951_000).unwrap();
        assert_eq!(second.echo_send_us, 900_000, "must echo the FRESH datagram");
        assert_eq!(second.delay_us, 1_000, "only the 1ms of holding is ours");
    }

    #[test]
    fn holding_time_is_measured_from_the_newest_arrival() {
        let mut t = ReceiveTracker::new();
        t.on_datagram(0, 0, 10_000);
        t.on_datagram(1, 500, 40_000);
        let r = t.take_report(45_000).unwrap();
        assert_eq!(
            r.delay_us, 5_000,
            "45ms - the 40ms arrival, not the 10ms one"
        );
    }
}
