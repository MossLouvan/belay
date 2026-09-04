//! Send pacing — spreading a frame's datagrams over time instead of dumping
//! them at line rate.
//!
//! This is not an optimisation, it is the difference between a congestion
//! controller that works and one that lies to itself. A 1080p keyframe is
//! ~250 KB, or roughly 210 datagrams. Handed to the socket in one go they leave
//! the NIC back-to-back at whatever the local link can do — a gigabit burst
//! aimed at a Wi-Fi hop that can carry a fraction of it. The bottleneck queue
//! absorbs what it can and drops the rest, so the controller sees loss that its
//! own send pattern caused and backs off from a bitrate the link would actually
//! have carried. Pacing removes that self-inflicted signal.
//!
//! A token bucket, and deliberately a small one. The burst allowance exists to
//! absorb scheduler jitter, not to let a frame escape unpaced: too large and it
//! is no longer pacing, just a delayed dump.

use std::time::Duration;

/// How much send budget may accumulate while idle, as seconds of bitrate.
///
/// 10 ms is about half a 60fps frame interval — enough that a late wakeup does
/// not stall the stream, small enough that a burst cannot swallow a keyframe.
const MAX_BURST_SECONDS: f64 = 0.010;

#[derive(Debug, Clone)]
pub struct Pacer {
    bitrate_bps: u64,
    /// Bytes currently permitted to send.
    tokens: f64,
    /// Microseconds since the epoch this pacer was created with.
    last_us: u64,
}

impl Pacer {
    pub fn new(bitrate_bps: u64, now_us: u64) -> Pacer {
        Pacer {
            bitrate_bps: bitrate_bps.max(1),
            // Start with a full burst so the first frame is not delayed
            // waiting for tokens that have not accrued yet.
            tokens: Self::burst_bytes(bitrate_bps.max(1)),
            last_us: now_us,
        }
    }

    fn burst_bytes(bitrate_bps: u64) -> f64 {
        (bitrate_bps as f64 / 8.0) * MAX_BURST_SECONDS
    }

    /// Retarget. The congestion controller's setpoint lands here and at the
    /// encoder simultaneously, so the transport and the encoder never disagree
    /// about how much the link can carry.
    pub fn set_bitrate(&mut self, bitrate_bps: u64) {
        self.bitrate_bps = bitrate_bps.max(1);
        // Do not let a stale large allowance survive a cut to the bitrate: the
        // whole point of backing off is to stop sending that fast immediately.
        let cap = Self::burst_bytes(self.bitrate_bps);
        if self.tokens > cap {
            self.tokens = cap;
        }
    }

    pub fn bitrate_bps(&self) -> u64 {
        self.bitrate_bps
    }

    fn accrue(&mut self, now_us: u64) {
        // saturating_sub: a clock that goes backwards must not mint tokens.
        let elapsed_us = now_us.saturating_sub(self.last_us);
        if elapsed_us == 0 {
            return;
        }
        self.last_us = now_us;
        let bytes_per_us = self.bitrate_bps as f64 / 8.0 / 1_000_000.0;
        self.tokens = (self.tokens + elapsed_us as f64 * bytes_per_us)
            .min(Self::burst_bytes(self.bitrate_bps));
    }

    /// May a datagram of `len` bytes go now? Consumes budget when it may.
    pub fn try_send(&mut self, len: usize, now_us: u64) -> bool {
        self.accrue(now_us);
        if self.tokens >= len as f64 {
            self.tokens -= len as f64;
            true
        } else {
            false
        }
    }

    /// How long until `len` bytes can be sent. `Duration::ZERO` means now.
    ///
    /// The caller sleeps this rather than spinning; at 8 Mbps a 1200-byte
    /// datagram is ~1.2 ms apart, which is a sleep, not a busy-wait.
    pub fn wait_for(&self, len: usize, now_us: u64) -> Duration {
        let mut probe = self.clone();
        probe.accrue(now_us);
        let deficit = len as f64 - probe.tokens;
        if deficit <= 0.0 {
            return Duration::ZERO;
        }
        let bytes_per_sec = self.bitrate_bps as f64 / 8.0;
        Duration::from_secs_f64(deficit / bytes_per_sec)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fresh_pacer_can_send_immediately() {
        let mut p = Pacer::new(8_000_000, 0);
        assert!(p.try_send(1200, 0), "the first datagram must not be delayed");
    }

    /// The property that matters: over a long run the pacer must not let more
    /// bytes out than the bitrate allows.
    #[test]
    fn sustained_output_tracks_the_configured_bitrate() {
        let bitrate = 8_000_000u64; // 1 MB/s
        let mut p = Pacer::new(bitrate, 0);
        let mut sent = 0usize;
        // One second, stepping 100us at a time.
        for step in 0..10_000u64 {
            let now = step * 100;
            while p.try_send(1200, now) {
                sent += 1200;
            }
        }
        let expected = bitrate as f64 / 8.0;
        let ratio = sent as f64 / expected;
        assert!(
            (0.95..=1.05).contains(&ratio),
            "sent {sent} bytes in 1s against a {expected} budget (ratio {ratio:.3})"
        );
    }

    /// Without this, a keyframe leaves as a single line-rate burst and the loss
    /// it induces is read by the controller as the link being worse than it is.
    #[test]
    fn a_burst_is_capped_rather_than_released_all_at_once() {
        let mut p = Pacer::new(8_000_000, 0);
        // Idle for a full second: tokens must NOT accumulate to a megabyte.
        let mut sent = 0usize;
        while p.try_send(1200, 1_000_000) {
            sent += 1200;
        }
        let cap = (8_000_000f64 / 8.0) * MAX_BURST_SECONDS;
        assert!(
            sent as f64 <= cap + 1200.0,
            "released {sent} bytes at once against a {cap} cap"
        );
    }

    #[test]
    fn cutting_the_bitrate_takes_effect_immediately() {
        let mut p = Pacer::new(80_000_000, 0);
        // Accrue a large allowance at the high rate.
        p.try_send(0, 1_000_000);
        p.set_bitrate(1_000_000);
        // The old allowance must not survive the cut, or backing off would not
        // actually slow anything down for the next several frames.
        let cap = (1_000_000f64 / 8.0) * MAX_BURST_SECONDS;
        let mut sent = 0usize;
        while p.try_send(100, 1_000_000) {
            sent += 100;
        }
        assert!(sent as f64 <= cap + 100.0, "sent {sent} against a {cap} cap after a cut");
    }

    #[test]
    fn wait_for_reports_zero_when_budget_is_available_and_a_delay_otherwise() {
        let mut p = Pacer::new(8_000_000, 0);
        assert_eq!(p.wait_for(1200, 0), Duration::ZERO);
        while p.try_send(1200, 0) {}
        let wait = p.wait_for(1200, 0);
        assert!(wait > Duration::ZERO, "must report a real delay once drained");
        // 1200 bytes at 1 MB/s is ~1.2ms; allow slack but reject nonsense.
        assert!(wait < Duration::from_millis(10), "implausible wait {wait:?}");
    }

    #[test]
    fn wait_for_does_not_consume_budget() {
        let p = Pacer::new(8_000_000, 0);
        let before = p.tokens;
        let _ = p.wait_for(1200, 0);
        assert_eq!(p.tokens, before, "wait_for must be a query, not a withdrawal");
    }

    /// Clocks go backwards — NTP steps, VM migration, suspend. Minting tokens
    /// from a negative interval would let a burst escape unpaced.
    #[test]
    fn a_clock_going_backwards_does_not_mint_budget() {
        let mut p = Pacer::new(8_000_000, 1_000_000);
        while p.try_send(1200, 1_000_000) {}
        assert!(!p.try_send(1200, 500_000), "time travel must not create budget");
    }

    #[test]
    fn a_zero_bitrate_is_clamped_rather_than_dividing_by_zero() {
        let mut p = Pacer::new(0, 0);
        assert_eq!(p.bitrate_bps(), 1);
        let _ = p.wait_for(1200, 0);
        p.set_bitrate(0);
        assert_eq!(p.bitrate_bps(), 1);
    }
}
