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

/// A receiver's report, sent back on the Control channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Report {
    /// Highest sequence the receiver has seen.
    pub highest_seq: u32,
    /// Datagrams actually received in this interval.
    pub received: u32,
    /// Sequence span this interval covered.
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
    /// Sequence at the start of the current interval.
    interval_start: Option<u32>,
    received_this_interval: u32,
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
        self.received_this_interval = self.received_this_interval.saturating_add(1);
        let newer = match self.highest {
            None => true,
            Some(h) => seq_newer(sequence, h),
        };
        if newer {
            self.highest = Some(sequence);
        }
        let newer_this_interval = match self.newest_this_interval {
            None => true,
            Some((_, _)) => newer,
        };
        if newer_this_interval {
            self.newest_this_interval = Some((send_us, recv_us));
        }
        if self.interval_start.is_none() {
            self.interval_start = Some(sequence);
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
        let (echo_send_us, arrived_us) = self.newest_this_interval.take()?;
        let delay_us = now_us.saturating_sub(arrived_us).min(u32::MAX as u64) as u32;
        let highest = self.highest?;
        let start = self.interval_start?;
        // Sequence SPAN, not arrival count: this is what makes an idle sender
        // look idle rather than look like total loss.
        let expected = highest.wrapping_sub(start).saturating_add(1);
        let report = Report {
            highest_seq: highest,
            received: self.received_this_interval,
            expected,
            echo_send_us,
            delay_us,
        };
        self.received_this_interval = 0;
        self.interval_start = Some(highest.wrapping_add(1));
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
        let r = Report { highest_seq: 0, received: 90, expected: 100, echo_send_us: 0, delay_us: 0 };
        assert!((r.loss_ratio() - 0.10).abs() < 1e-9);
    }

    #[test]
    fn a_lying_peer_cannot_produce_a_negative_or_absurd_loss_ratio() {
        // received > expected is impossible, but a peer can claim it, and a
        // negative ratio would drive the controller UP on a failing link.
        let r = Report { highest_seq: 0, received: 500, expected: 100, echo_send_us: 0, delay_us: 0 };
        assert_eq!(r.loss_ratio(), 0.0);

        let z = Report { highest_seq: 0, received: 0, expected: 0, echo_send_us: 0, delay_us: 0 };
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
        assert!(t.take_report(0).is_none(), "no traffic means no report, not 100% loss");
    }

    #[test]
    fn loss_is_measured_over_sequence_space() {
        let mut t = ReceiveTracker::new();
        // Sent 0..=9, but 3, 5 and 7 never arrived.
        for seq in [0u32, 1, 2, 4, 6, 8, 9] {
            t.on_datagram(seq, seq * 100, 0);
        }
        let r = t.take_report(0).unwrap();
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
        let r = t.take_report(0).unwrap();
        assert_eq!(r.highest_seq, 5);
        assert_eq!(r.received, 5);
    }

    #[test]
    fn rtt_smooths_and_keeps_a_separate_minimum() {
        let mut e = RttEstimator::new();
        let r = |echo| Report { highest_seq: 0, received: 1, expected: 1, echo_send_us: echo, delay_us: 0 };

        e.sample(20_000, &r(0)); // 20ms
        assert_eq!(e.min_ms(), Some(20.0));

        // A single 200ms spike must move the smoothed value only a little.
        e.sample(200_000, &r(0));
        let s = e.smoothed_ms().unwrap();
        assert!(s < 50.0, "one spike must not dominate, got {s}");
        assert_eq!(e.min_ms(), Some(20.0), "the floor is the minimum, not the average");

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
        let r = Report { highest_seq: 0, received: 1, expected: 1, echo_send_us: 0, delay_us: 40_000 };
        e.sample(50_000, &r);
        assert_eq!(e.smoothed_ms(), Some(10.0), "50ms round trip minus 40ms of holding");
    }

    #[test]
    fn a_stale_echo_is_ignored_rather_than_poisoning_the_estimate() {
        let mut e = RttEstimator::new();
        let good = Report { highest_seq: 0, received: 1, expected: 1, echo_send_us: 0, delay_us: 0 };
        e.sample(20_000, &good);
        let before = e.smoothed_ms();

        // Echo from the future / wrapped clock: an absurd interval.
        let stale = Report { highest_seq: 0, received: 1, expected: 1, echo_send_us: 900_000_000, delay_us: 0 };
        e.sample(1000, &stale);
        assert_eq!(e.smoothed_ms(), before, "an implausible sample must change nothing");
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
        assert_eq!(r.delay_us, 5_000, "45ms - the 40ms arrival, not the 10ms one");
    }
}
