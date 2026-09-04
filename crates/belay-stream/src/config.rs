//! Startup configuration, read as one JSON line on stdin.
//!
//! On stdin rather than argv for one reason that is not negotiable: the pairing
//! token is a credential, and argv is world-readable on Windows — any process
//! on the machine can read another's command line. A token in argv is a token
//! leaked to every program the user runs.
//!
//! Hand-parsed rather than pulled in with serde. The input is one flat object
//! written by our own server, the parser is ~80 lines, and the alternative is a
//! proc-macro dependency tree in a binary whose whole job is to be small and
//! start fast.

use std::net::SocketAddr;

use belay_wire::congestion::BitratePreset;

#[derive(Debug, Clone)]
pub struct Config {
    /// Where to listen. Port 0 lets the OS choose and we report it back.
    pub bind: SocketAddr,
    /// The client's UDP endpoint.
    pub peer: SocketAddr,
    /// The paired device token, used to derive the session keys.
    pub token: Vec<u8>,
    /// Session salt, freshly random per session, agreed out of band.
    pub salt: [u8; 8],
    pub preset: BitratePreset,
    pub fps: u32,
    pub monitor: u32,
    /// Seconds between forced keyframes.
    pub keyframe_interval_s: u32,
    /// Where pixels come from.
    pub source: Source,
}

/// The frame source.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    /// Desktop Duplication — what a real session uses.
    Desktop,
    /// Generated frames, for testing the encode and transport path without a
    /// live desktop.
    ///
    /// This exists because Desktop Duplication legitimately produces nothing
    /// when the screen is not changing — an idle or sleeping display yields
    /// only timeouts, which is correct behaviour and makes the rest of the
    /// pipeline untestable at exactly the times CI and overnight runs happen.
    Synthetic,
}

#[derive(Debug)]
pub struct ConfigError(pub String);

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

fn err<T>(msg: impl Into<String>) -> Result<T, ConfigError> {
    Err(ConfigError(msg.into()))
}

/// Pull one `"key": value` out of a flat JSON object.
///
/// Deliberately not a general JSON parser: it handles exactly the shape our
/// server writes, and anything else is rejected rather than guessed at.
fn field<'a>(json: &'a str, key: &str) -> Option<&'a str> {
    let needle = format!("\"{key}\"");
    let start = json.find(&needle)? + needle.len();
    let rest = json[start..].trim_start();
    let rest = rest.strip_prefix(':')?.trim_start();
    if let Some(s) = rest.strip_prefix('"') {
        let end = s.find('"')?;
        Some(&s[..end])
    } else {
        let end = rest
            .find(|c: char| c == ',' || c == '}' || c.is_whitespace())
            .unwrap_or(rest.len());
        Some(&rest[..end])
    }
}

fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

impl Config {
    pub fn parse(json: &str) -> Result<Config, ConfigError> {
        let Some(peer) = field(json, "peer") else { return err("missing peer") };
        let Ok(peer) = peer.parse::<SocketAddr>() else {
            return err(format!("peer is not an address: {peer}"));
        };

        let bind = field(json, "bind").unwrap_or("0.0.0.0:0");
        let Ok(bind) = bind.parse::<SocketAddr>() else {
            return err(format!("bind is not an address: {bind}"));
        };

        let Some(token_hex) = field(json, "token") else { return err("missing token") };
        let Some(token) = hex_decode(token_hex) else {
            return err("token must be hex");
        };
        // A short token means short keys, and the whole session's
        // confidentiality rests on it. Refuse rather than derive weak keys from
        // a placeholder someone left in a config.
        if token.len() < 16 {
            return err("token must be at least 16 bytes");
        }

        let Some(salt_hex) = field(json, "salt") else { return err("missing salt") };
        let Some(salt_vec) = hex_decode(salt_hex) else { return err("salt must be hex") };
        let Ok(salt) = <[u8; 8]>::try_from(salt_vec.as_slice()) else {
            return err("salt must be exactly 8 bytes");
        };

        let preset = field(json, "preset")
            .and_then(BitratePreset::parse)
            .unwrap_or(BitratePreset::Auto);

        // Clamped, not trusted. These arrive from a server that parses a client
        // request, and an unclamped fps is how a capture loop becomes a spin
        // loop — the same bug the TypeScript stream params already guard.
        let fps = field(json, "fps").and_then(|v| v.parse::<u32>().ok()).unwrap_or(60).clamp(1, 120);
        let monitor = field(json, "monitor").and_then(|v| v.parse::<u32>().ok()).unwrap_or(0);
        let keyframe_interval_s = field(json, "keyframeInterval")
            .and_then(|v| v.parse::<u32>().ok())
            .unwrap_or(4)
            .clamp(1, 30);

        let source = match field(json, "source") {
            Some("synthetic") => Source::Synthetic,
            _ => Source::Desktop,
        };

        Ok(Config { bind, peer, token, salt, preset, fps, monitor, keyframe_interval_s, source })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOOD: &str = r#"{"peer":"192.168.1.20:41234","bind":"0.0.0.0:0",
        "token":"00112233445566778899aabbccddeeff","salt":"0102030405060708",
        "preset":"high","fps":"60","monitor":"0"}"#;

    #[test]
    fn parses_a_well_formed_config() {
        let c = Config::parse(GOOD).unwrap();
        assert_eq!(c.peer.port(), 41234);
        assert_eq!(c.token.len(), 16);
        assert_eq!(c.salt, [1, 2, 3, 4, 5, 6, 7, 8]);
        assert_eq!(c.preset, BitratePreset::HighQuality);
        assert_eq!(c.fps, 60);
    }

    #[test]
    fn numeric_json_values_parse_too() {
        let c = Config::parse(
            r#"{"peer":"10.0.0.1:5000","token":"00112233445566778899aabbccddeeff",
                "salt":"0102030405060708","fps":30,"monitor":1}"#,
        )
        .unwrap();
        assert_eq!(c.fps, 30);
        assert_eq!(c.monitor, 1);
    }

    /// An unclamped fps turns the capture loop into a spin loop — the same bug
    /// the TypeScript stream params already exist to prevent.
    #[test]
    fn fps_is_clamped_rather_than_trusted() {
        let mk = |fps: &str| {
            format!(
                r#"{{"peer":"10.0.0.1:1","token":"00112233445566778899aabbccddeeff",
                    "salt":"0102030405060708","fps":{fps}}}"#
            )
        };
        assert_eq!(Config::parse(&mk("100000")).unwrap().fps, 120);
        assert_eq!(Config::parse(&mk("0")).unwrap().fps, 1);
        assert_eq!(Config::parse(&mk("\"abc\"")).unwrap().fps, 60, "garbage falls back");
    }

    /// The whole session's confidentiality rests on the token. A placeholder
    /// left in a config must fail loudly, not derive weak keys in silence.
    #[test]
    fn a_short_token_is_refused() {
        let json = r#"{"peer":"10.0.0.1:1","token":"aabb","salt":"0102030405060708"}"#;
        assert!(Config::parse(json).is_err());
    }

    #[test]
    fn a_wrong_length_salt_is_refused() {
        let json = r#"{"peer":"10.0.0.1:1","token":"00112233445566778899aabbccddeeff","salt":"0102"}"#;
        assert!(Config::parse(json).is_err());
    }

    #[test]
    fn missing_required_fields_are_refused_not_defaulted() {
        assert!(Config::parse(r#"{"token":"00112233445566778899aabbccddeeff"}"#).is_err());
        assert!(Config::parse(r#"{"peer":"10.0.0.1:1"}"#).is_err());
        assert!(Config::parse("{}").is_err());
        assert!(Config::parse("not json at all").is_err());
    }

    #[test]
    fn the_source_defaults_to_the_real_desktop() {
        assert_eq!(Config::parse(GOOD).unwrap().source, Source::Desktop);
        let synth = GOOD.replace("\"preset\"", "\"source\":\"synthetic\",\"preset\"");
        assert_eq!(Config::parse(&synth).unwrap().source, Source::Synthetic);
        // Anything unrecognised must mean the real desktop, never the test
        // source — a typo that silently streams a test pattern to a user is a
        // far worse failure than one that errors.
        let junk = GOOD.replace("\"preset\"", "\"source\":\"whatever\",\"preset\"");
        assert_eq!(Config::parse(&junk).unwrap().source, Source::Desktop);
    }

    #[test]
    fn an_unknown_preset_falls_back_to_auto_rather_than_failing() {
        let json = r#"{"peer":"10.0.0.1:1","token":"00112233445566778899aabbccddeeff",
            "salt":"0102030405060708","preset":"ludicrous"}"#;
        assert_eq!(Config::parse(json).unwrap().preset, BitratePreset::Auto);
    }
}
