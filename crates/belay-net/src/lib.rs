//! The I/O half of the Belay Wire Protocol: UDP sessions, send pacing, and the
//! feedback loop that drives the congestion controller.
//!
//! `belay-wire` holds the rules — framing, loss policy, congestion law, AEAD —
//! and is deliberately free of I/O so those rules can be tested exhaustively
//! without a network. This crate is what makes them move bytes, and holds no
//! rules of its own.
//!
//! ```no_run
//! use belay_net::{random_salt, Session, Event};
//! use belay_wire::{congestion::BitratePreset, crypto::Direction, packet::Channel};
//!
//! let mut s = Session::bind(
//!     "0.0.0.0:0".parse().unwrap(),
//!     "192.168.1.20:41234".parse().unwrap(),
//!     b"paired-device-token",
//!     random_salt(),
//!     Direction::HostToClient,
//!     BitratePreset::Auto,
//! ).unwrap();
//!
//! s.send_frame(Channel::Video, &[0u8; 4096], true).unwrap();
//! for event in s.poll().unwrap() {
//!     if let Event::Bitrate { bps } = event {
//!         // Apply to the encoder too: one setpoint, both ends.
//!         let _ = bps;
//!     }
//! }
//! ```

pub mod feedback;
pub mod pacer;
pub mod session;

pub use feedback::{ReceiveTracker, Report, RttEstimator};
pub use pacer::Pacer;
pub use session::{random_salt, Event, Session, SessionError, REPORT_INTERVAL};
