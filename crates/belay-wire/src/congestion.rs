//! Bitrate control: loss-based AIMD with an RTT-gradient guard.
//!
//! Ported from `app/src/stream/webrtc/congestion.ts`, deliberately keeping the
//! same control law rather than inventing one. The shape behaves on a lossy
//! cellular link:
//!
//! * real loss -> multiplicative DECREASE, proportional to severity, because
//!   loss means the bottleneck is already overrun;
//! * low loss but RTT climbing above its floor -> HOLD, because a growing queue
//!   is congestion arriving before loss does, and pushing harder makes exactly
//!   the latency this product exists to minimise worse;
//! * low loss and RTT near its floor -> additive INCREASE, probing for headroom
//!   in steps a single overshoot can cheaply give back.
//!
//! The one difference from the WebRTC version: the output here is the
//! transport's send budget AND the encoder's target bitrate at the same time,
//! rather than being translated through a separate ABR estimator. Owning both
//! ends of the pipe is one of the few concrete arguments for a custom
//! transport, so the protocol should actually take the benefit.
//!
//! Pure: `next` consumes a state and returns a new one, so a caller can keep a
//! history of setpoints for free and the law is testable with no link at all.

/// One feedback interval's link report.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LinkFeedback {
    /// Fraction of packets lost this interval, 0..=1.
    pub loss_ratio: f64,
    /// Smoothed round-trip time this interval, milliseconds.
    pub rtt_ms: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AbrConfig {
    pub min_bps: u64,
    pub max_bps: u64,
    /// Additive-increase step per interval, as a fraction of current bitrate.
    pub increase_fraction: f64,
    /// Loss at or below this counts as clean and permits an increase.
    pub loss_floor: f64,
    /// Loss at or above this triggers heavy multiplicative backoff.
    pub loss_ceiling: f64,
    /// RTT is "climbing" once it exceeds base_rtt * this + RTT_GRADIENT_SLACK_MS.
    pub rtt_gradient: f64,
}

/// Absolute slack added to the gradient test, so a link whose base RTT is a
/// fraction of a millisecond does not read every scheduling hiccup as a queue.
const RTT_GRADIENT_SLACK_MS: f64 = 20.0;

impl Default for AbrConfig {
    fn default() -> Self {
        AbrConfig {
            min_bps: 300_000,      // below this the picture is not worth sending
            max_bps: 20_000_000,   // generous ceiling for 1080p60
            increase_fraction: 0.08,
            loss_floor: 0.02,      // <=2% loss is tolerable, keep probing
            loss_ceiling: 0.10,    // >=10% loss is a real problem, cut hard
            rtt_gradient: 1.5,
        }
    }
}

/// Evolving controller state. `base_rtt_ms` is the running minimum RTT — the
/// empty-queue latency the gradient guard measures swelling against.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AbrState {
    pub bitrate_bps: u64,
    /// `None` until the first valid report; nothing is "climbing" before then.
    pub base_rtt_ms: Option<f64>,
}

impl AbrState {
    pub fn new(start_bps: u64, config: &AbrConfig) -> AbrState {
        AbrState {
            bitrate_bps: start_bps.clamp(config.min_bps, config.max_bps),
            base_rtt_ms: None,
        }
    }

    /// Compute the next state from one feedback report.
    ///
    /// Malformed feedback (non-finite, negative, zero RTT) is treated as *no
    /// information* and returns the state unchanged, rather than corrupting the
    /// setpoint. Feedback arrives from the peer, so it is exactly as untrusted
    /// as any other input.
    pub fn next(self, fb: LinkFeedback, config: &AbrConfig) -> AbrState {
        if !fb.loss_ratio.is_finite() || fb.loss_ratio < 0.0 {
            return self;
        }
        if !fb.rtt_ms.is_finite() || fb.rtt_ms <= 0.0 {
            return self;
        }

        let loss = fb.loss_ratio.min(1.0);
        let base_rtt = Some(match self.base_rtt_ms {
            Some(b) => b.min(fb.rtt_ms),
            None => fb.rtt_ms,
        });

        let current = self.bitrate_bps as f64;
        let next_bps = if loss >= config.loss_ceiling {
            // Heavy loss: multiplicative decrease scaled by severity. At the
            // ceiling that is roughly -10%, worsening to -50% as loss climbs.
            current * (1.0 - loss.min(0.5))
        } else if loss > config.loss_floor {
            // Moderate loss: a mild fixed backoff. Enough to relieve the link
            // without the sawtooth a full multiplicative cut causes down here.
            current * 0.85
        } else if rtt_is_climbing(fb.rtt_ms, base_rtt, config) {
            // Clean of loss but the queue is filling: hold, do not add to it.
            current
        } else {
            // Clean and drained: probe upward.
            current * (1.0 + config.increase_fraction)
        };

        AbrState {
            bitrate_bps: (next_bps.round().max(0.0) as u64).clamp(config.min_bps, config.max_bps),
            base_rtt_ms: base_rtt,
        }
    }
}

fn rtt_is_climbing(rtt_ms: f64, base_rtt_ms: Option<f64>, config: &AbrConfig) -> bool {
    match base_rtt_ms {
        None => false,
        Some(base) => rtt_ms > base * config.rtt_gradient + RTT_GRADIENT_SLACK_MS,
    }
}

/// Bitrate presets a user can pick, plus `Auto`.
///
/// The product ask is "let the user select the bitrate". A raw bits-per-second
/// box is a bad control: most people do not know what 6_000_000 looks like, and
/// picking too high on a weak link makes things *worse*, not better. So the
/// choice is a small ladder of intents, and every fixed rung is still floored
/// by the congestion controller — the user picks a ceiling, never an
/// obligation to send more than the link can carry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BitratePreset {
    /// Controller decides, up to the configured maximum.
    Auto,
    /// ~1.5 Mbps. Cellular, or a link that keeps collapsing.
    DataSaver,
    /// ~4 Mbps. Good Wi-Fi.
    Balanced,
    /// ~10 Mbps. LAN or Tailscale-direct.
    HighQuality,
    /// ~20 Mbps. Wired LAN, quality over everything.
    Max,
}

impl BitratePreset {
    /// Ceiling in bits per second, or `None` for Auto.
    pub fn ceiling_bps(self) -> Option<u64> {
        match self {
            BitratePreset::Auto => None,
            BitratePreset::DataSaver => Some(1_500_000),
            BitratePreset::Balanced => Some(4_000_000),
            BitratePreset::HighQuality => Some(10_000_000),
            BitratePreset::Max => Some(20_000_000),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            BitratePreset::Auto => "auto",
            BitratePreset::DataSaver => "data-saver",
            BitratePreset::Balanced => "balanced",
            BitratePreset::HighQuality => "high",
            BitratePreset::Max => "max",
        }
    }

    pub fn parse(s: &str) -> Option<BitratePreset> {
        match s {
            "auto" => Some(BitratePreset::Auto),
            "data-saver" => Some(BitratePreset::DataSaver),
            "balanced" => Some(BitratePreset::Balanced),
            "high" => Some(BitratePreset::HighQuality),
            "max" => Some(BitratePreset::Max),
            _ => None,
        }
    }

    /// Apply this preset to a config by lowering its ceiling.
    ///
    /// Only ever lowers `max_bps`: a preset is the user's cap, and it must not
    /// be able to raise the link above what the controller has learned is safe,
    /// nor push `min_bps` above the new ceiling.
    pub fn apply(self, base: &AbrConfig) -> AbrConfig {
        match self.ceiling_bps() {
            None => *base,
            Some(cap) => {
                let max_bps = cap.min(base.max_bps);
                AbrConfig { max_bps, min_bps: base.min_bps.min(max_bps), ..*base }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> AbrConfig {
        AbrConfig::default()
    }

    #[test]
    fn clean_link_probes_upward() {
        let c = cfg();
        let s = AbrState::new(1_000_000, &c);
        let s1 = s.next(LinkFeedback { loss_ratio: 0.0, rtt_ms: 20.0 }, &c);
        assert_eq!(s1.bitrate_bps, 1_080_000, "+8% additive increase");
    }

    #[test]
    fn heavy_loss_backs_off_hard_and_proportionally() {
        let c = cfg();
        let s = AbrState::new(10_000_000, &c);
        let mild = s.next(LinkFeedback { loss_ratio: 0.10, rtt_ms: 20.0 }, &c);
        let severe = s.next(LinkFeedback { loss_ratio: 0.50, rtt_ms: 20.0 }, &c);
        assert_eq!(mild.bitrate_bps, 9_000_000);
        assert_eq!(severe.bitrate_bps, 5_000_000, "worse loss cuts more");
        assert!(severe.bitrate_bps < mild.bitrate_bps);
    }

    #[test]
    fn moderate_loss_takes_a_mild_fixed_backoff() {
        let c = cfg();
        let s = AbrState::new(1_000_000, &c);
        let s1 = s.next(LinkFeedback { loss_ratio: 0.05, rtt_ms: 20.0 }, &c);
        assert_eq!(s1.bitrate_bps, 850_000);
    }

    /// The gradient guard is the reason this law suits a latency product: it
    /// stops adding to a queue that is already building, before loss appears.
    #[test]
    fn climbing_rtt_holds_even_with_no_loss() {
        let c = cfg();
        let s = AbrState::new(2_000_000, &c);
        // Establish a 20ms floor.
        let s1 = s.next(LinkFeedback { loss_ratio: 0.0, rtt_ms: 20.0 }, &c);
        assert_eq!(s1.base_rtt_ms, Some(20.0));
        // 20*1.5 + 20 = 50ms threshold; 90ms is well past it.
        let s2 = s1.next(LinkFeedback { loss_ratio: 0.0, rtt_ms: 90.0 }, &c);
        assert_eq!(s2.bitrate_bps, s1.bitrate_bps, "hold, do not add to the queue");
        assert_eq!(s2.base_rtt_ms, Some(20.0), "floor is the running minimum");
    }

    #[test]
    fn nothing_is_climbing_before_a_floor_is_known() {
        let c = cfg();
        let s = AbrState::new(1_000_000, &c);
        // Very first report, huge RTT: with no floor yet this must not be read
        // as a queue, or the controller would never start.
        let s1 = s.next(LinkFeedback { loss_ratio: 0.0, rtt_ms: 500.0 }, &c);
        assert_eq!(s1.bitrate_bps, 1_080_000);
    }

    #[test]
    fn malformed_feedback_is_ignored_not_obeyed() {
        let c = cfg();
        let s = AbrState::new(5_000_000, &c);
        for bad in [
            LinkFeedback { loss_ratio: f64::NAN, rtt_ms: 20.0 },
            LinkFeedback { loss_ratio: -1.0, rtt_ms: 20.0 },
            LinkFeedback { loss_ratio: 0.0, rtt_ms: 0.0 },
            LinkFeedback { loss_ratio: 0.0, rtt_ms: -5.0 },
            LinkFeedback { loss_ratio: 0.0, rtt_ms: f64::INFINITY },
        ] {
            assert_eq!(s.next(bad, &c), s, "malformed feedback must change nothing");
        }
    }

    #[test]
    fn bitrate_stays_inside_the_band() {
        let c = cfg();
        // Cannot be driven below the floor however bad the link gets.
        let mut s = AbrState::new(c.min_bps, &c);
        for _ in 0..50 {
            s = s.next(LinkFeedback { loss_ratio: 0.9, rtt_ms: 500.0 }, &c);
        }
        assert_eq!(s.bitrate_bps, c.min_bps);

        // Nor above the ceiling however good it gets.
        let mut s = AbrState::new(c.max_bps, &c);
        for _ in 0..50 {
            s = s.next(LinkFeedback { loss_ratio: 0.0, rtt_ms: 5.0 }, &c);
        }
        assert_eq!(s.bitrate_bps, c.max_bps);
    }

    #[test]
    fn presets_cap_but_never_raise() {
        let base = cfg();
        let saver = BitratePreset::DataSaver.apply(&base);
        assert_eq!(saver.max_bps, 1_500_000);
        assert!(saver.min_bps <= saver.max_bps, "floor must not exceed the cap");

        // A preset above the configured maximum must not raise it.
        let tight = AbrConfig { max_bps: 2_000_000, ..base };
        assert_eq!(BitratePreset::Max.apply(&tight).max_bps, 2_000_000);

        assert_eq!(BitratePreset::Auto.apply(&base), base);
    }

    #[test]
    fn a_capped_link_settles_at_the_cap_not_above_it() {
        let c = BitratePreset::Balanced.apply(&cfg());
        let mut s = AbrState::new(c.min_bps, &c);
        for _ in 0..200 {
            s = s.next(LinkFeedback { loss_ratio: 0.0, rtt_ms: 10.0 }, &c);
        }
        assert_eq!(s.bitrate_bps, 4_000_000);
    }

    #[test]
    fn preset_names_round_trip() {
        for p in [
            BitratePreset::Auto,
            BitratePreset::DataSaver,
            BitratePreset::Balanced,
            BitratePreset::HighQuality,
            BitratePreset::Max,
        ] {
            assert_eq!(BitratePreset::parse(p.as_str()), Some(p));
        }
        assert_eq!(BitratePreset::parse("nonsense"), None);
    }
}
