//! The tunnel half of the C ABI: `belay_tunnel_*`.
//!
//! The phone keeps its iroh secret key in the Keychain and hands it in as hex.
//! `belay_tunnel_dial` gives back a 127.0.0.1 TCP port; the app then talks to
//! `https://127.0.0.1:<port>` exactly as it talks to the host on the LAN, with
//! the same pinned certificate, because every byte on that port is one QUIC
//! bi-stream straight to the host's TLS listener.
//!
//! A tunnel handle IS thread-safe (unlike the stream handle): the Expo module
//! calls it from whichever queue the promise lands on.

use std::collections::HashMap;
use std::ffi::{c_char, c_int, c_void};
use std::sync::{Mutex, OnceLock};

use belay_net_tunnel::iroh::{Endpoint, EndpointAddr, EndpointId, RelayUrl, SecretKey};
use belay_net_tunnel::{relay_mode, Forwarder};
use tokio::runtime::Runtime;

use crate::{cstr, hex_decode, BELAY_ERR_ARGS, BELAY_ERR_BIND, BELAY_ERR_IO, BELAY_ERR_SESSION, BELAY_OK};

/// One runtime for every tunnel in the process; iroh wants tokio and the
/// phone has exactly one app.
fn runtime() -> Option<&'static Runtime> {
    static RT: OnceLock<Option<Runtime>> = OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .thread_name("belay-tunnel")
            .build()
            .ok()
    })
    .as_ref()
}

pub struct BelayTunnel {
    endpoint: Endpoint,
    relays: Vec<RelayUrl>,
    forwarders: Mutex<HashMap<EndpointId, Forwarder>>,
}

/// What `belay_tunnel_stats` fills in.
#[repr(C)]
#[derive(Default)]
pub struct BelayTunnelStats {
    /// Non-zero while a QUIC connection to that host is open.
    pub connected: c_int,
    /// Smoothed RTT in milliseconds, 0 when not connected.
    pub rtt_ms: f64,
    /// Non-zero when the selected path is direct (UDP), zero when relayed.
    pub direct: c_int,
}

fn parse_relays(csv: Option<&str>) -> Vec<RelayUrl> {
    csv.unwrap_or("")
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .filter_map(|s| s.parse().ok())
        .collect()
}

/// Start a tunnel endpoint. `secret_hex` is the phone's 32-byte iroh secret
/// key as 64 hex chars; `relay_urls` is comma-separated (null/empty = no relay
/// at all, never n0's public ones). Returns an opaque handle or NULL.
///
/// # Safety
/// Pointer arguments must be null or valid NUL-terminated C strings.
#[no_mangle]
pub unsafe extern "C" fn belay_tunnel_start(secret_hex: *const c_char, relay_urls: *const c_char) -> *mut c_void {
    let Some(secret_hex) = cstr(secret_hex) else { return std::ptr::null_mut() };
    let Some(bytes) = hex_decode(secret_hex) else { return std::ptr::null_mut() };
    let Ok(bytes) = <[u8; 32]>::try_from(bytes.as_slice()) else { return std::ptr::null_mut() };
    let relays = parse_relays(cstr(relay_urls));
    let Some(rt) = runtime() else { return std::ptr::null_mut() };
    let Ok(endpoint) = rt.block_on(belay_net_tunnel::bind(SecretKey::from_bytes(&bytes), relay_mode(&relays))) else {
        return std::ptr::null_mut();
    };
    Box::into_raw(Box::new(BelayTunnel { endpoint, relays, forwarders: Mutex::new(HashMap::new()) })) as *mut c_void
}

/// This phone's node id (64 lowercase hex), the value to register with
/// POST /devices. Writes a NUL-terminated string into `out` and returns its
/// length, or BELAY_ERR_ARGS when `cap` is too small (needs 65).
///
/// # Safety
/// `handle` must be live; `out` must point at `cap` writable bytes.
#[no_mangle]
pub unsafe extern "C" fn belay_tunnel_node_id(handle: *mut c_void, out: *mut c_char, cap: usize) -> c_int {
    let Some(t) = (handle as *const BelayTunnel).as_ref() else { return BELAY_ERR_ARGS };
    let id = t.endpoint.id().to_string();
    if out.is_null() || cap <= id.len() {
        return BELAY_ERR_ARGS;
    }
    std::ptr::copy_nonoverlapping(id.as_ptr(), out as *mut u8, id.len());
    *out.add(id.len()) = 0;
    id.len() as c_int
}

/// Open (or reuse) a forwarder to `node_id`: a 127.0.0.1 TCP listener whose
/// connections become bi-streams to that host. Returns the local port, or a
/// negative BELAY_ERR_* code. The QUIC connection itself is dialed lazily on
/// the first TCP connection and redialed when it drops.
///
/// # Safety
/// `handle` must be live; `node_id` a valid C string.
#[no_mangle]
pub unsafe extern "C" fn belay_tunnel_dial(handle: *mut c_void, node_id: *const c_char) -> c_int {
    let Some(t) = (handle as *const BelayTunnel).as_ref() else { return BELAY_ERR_ARGS };
    let Some(id) = cstr(node_id).and_then(|s| s.trim().parse::<EndpointId>().ok()) else {
        return BELAY_ERR_ARGS;
    };
    let Ok(mut map) = t.forwarders.lock() else { return BELAY_ERR_SESSION };
    if let Some(f) = map.get(&id) {
        return c_int::from(f.local_port);
    }
    // Address hint: the first configured relay, where the host also homes.
    // With no relay configured, iroh resolves the id through n0's DNS.
    let mut addr = EndpointAddr::new(id);
    if let Some(r) = t.relays.first() {
        addr = addr.with_relay_url(r.clone());
    }
    let Some(rt) = runtime() else { return BELAY_ERR_IO };
    match rt.block_on(Forwarder::start(t.endpoint.clone(), addr)) {
        Ok(f) => {
            let port = f.local_port;
            map.insert(id, f);
            c_int::from(port)
        }
        Err(_) => BELAY_ERR_BIND,
    }
}

/// Fill `out` for the forwarder to `node_id`. BELAY_OK, or BELAY_ERR_ARGS for a
/// bad handle/id/pointer, BELAY_ERR_SESSION when nothing was dialed.
///
/// # Safety
/// `handle` must be live; `node_id` a valid C string; `out` writable.
#[no_mangle]
pub unsafe extern "C" fn belay_tunnel_stats(
    handle: *mut c_void,
    node_id: *const c_char,
    out: *mut BelayTunnelStats,
) -> c_int {
    let Some(t) = (handle as *const BelayTunnel).as_ref() else { return BELAY_ERR_ARGS };
    if out.is_null() {
        return BELAY_ERR_ARGS;
    }
    *out = BelayTunnelStats::default();
    let Some(id) = cstr(node_id).and_then(|s| s.trim().parse::<EndpointId>().ok()) else {
        return BELAY_ERR_ARGS;
    };
    let Ok(map) = t.forwarders.lock() else { return BELAY_ERR_SESSION };
    let Some(f) = map.get(&id) else { return BELAY_ERR_SESSION };
    let Some(rt) = runtime() else { return BELAY_ERR_IO };
    let s = rt.block_on(f.stats());
    *out = BelayTunnelStats { connected: c_int::from(s.connected), rtt_ms: s.rtt_ms, direct: c_int::from(s.direct) };
    BELAY_OK
}

/// Close every forwarder and the endpoint. Safe with NULL; not twice.
///
/// # Safety
/// `handle` must be null or a live handle from `belay_tunnel_start`.
#[no_mangle]
pub unsafe extern "C" fn belay_tunnel_close(handle: *mut c_void) {
    if handle.is_null() {
        return;
    }
    let t = Box::from_raw(handle as *mut BelayTunnel);
    let Some(rt) = runtime() else { return };
    let forwarders: Vec<Forwarder> = t.forwarders.lock().map(|mut m| m.drain().map(|(_, f)| f).collect()).unwrap_or_default();
    rt.block_on(async move {
        for f in forwarders {
            f.close().await;
        }
        t.endpoint.close().await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CString;

    #[test]
    fn start_requires_a_32_byte_hex_key() {
        let short = CString::new("abcd").unwrap();
        assert!(unsafe { belay_tunnel_start(short.as_ptr(), std::ptr::null()) }.is_null());
        assert!(unsafe { belay_tunnel_start(std::ptr::null(), std::ptr::null()) }.is_null());
    }

    #[test]
    fn empty_relay_list_means_no_relay() {
        use belay_net_tunnel::iroh::RelayMode;
        for csv in [None, Some(""), Some(" , bogus")] {
            assert_eq!(relay_mode(&parse_relays(csv)), RelayMode::Disabled, "{csv:?}");
        }
    }

    #[test]
    fn start_dial_stats_close_round_trip() {
        let key = SecretKey::generate();
        let hex: String = key.to_bytes().iter().map(|b| format!("{b:02x}")).collect();
        let hex = CString::new(hex).unwrap();
        let relays = CString::new("https://relay.example.invalid, ,bogus").unwrap();
        let h = unsafe { belay_tunnel_start(hex.as_ptr(), relays.as_ptr()) };
        assert!(!h.is_null());

        let mut buf = [0 as c_char; 65];
        let n = unsafe { belay_tunnel_node_id(h, buf.as_mut_ptr(), buf.len()) };
        assert_eq!(n, 64);
        let id = unsafe { std::ffi::CStr::from_ptr(buf.as_ptr()) }.to_str().unwrap();
        assert_eq!(id, key.public().to_string());
        assert_eq!(unsafe { belay_tunnel_node_id(h, buf.as_mut_ptr(), 10) }, BELAY_ERR_ARGS);

        let bad = CString::new("not a node id").unwrap();
        assert_eq!(unsafe { belay_tunnel_dial(h, bad.as_ptr()) }, BELAY_ERR_ARGS);

        let peer = CString::new(SecretKey::generate().public().to_string()).unwrap();
        let port = unsafe { belay_tunnel_dial(h, peer.as_ptr()) };
        assert!(port > 1024, "{port}");
        assert_eq!(unsafe { belay_tunnel_dial(h, peer.as_ptr()) }, port, "dial is idempotent per node id");

        let mut st = BelayTunnelStats::default();
        assert_eq!(unsafe { belay_tunnel_stats(h, peer.as_ptr(), &mut st) }, BELAY_OK);
        assert_eq!(st.connected, 0, "nothing connected before the first TCP client");
        let other = CString::new(SecretKey::generate().public().to_string()).unwrap();
        assert_eq!(unsafe { belay_tunnel_stats(h, other.as_ptr(), &mut st) }, BELAY_ERR_SESSION);

        unsafe { belay_tunnel_close(h) };
        unsafe { belay_tunnel_close(std::ptr::null_mut()) };
    }
}
