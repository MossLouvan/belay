// The BWP client, over a C ABI. See crates/belay-client/src/lib.rs.
//
// Hand-written rather than generated: it is small, it changes rarely, and a
// generated header is one more build step between a Windows dev machine and a
// Mac that has to compile against it.

#ifndef BELAY_CLIENT_H
#define BELAY_CLIENT_H

#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

#define BELAY_OK            0
#define BELAY_ERR_ARGS     -1
#define BELAY_ERR_BIND     -2
#define BELAY_ERR_SESSION  -3
#define BELAY_ERR_IO       -4

#define BELAY_FRAME_NONE     0
#define BELAY_FRAME_VIDEO    1
#define BELAY_FRAME_CURSOR   2
#define BELAY_FRAME_BITRATE  3

// Filled in by belay_client_next_frame. `data` is owned by the handle and is
// valid only until the next call on that handle.
typedef struct {
    int         kind;
    const uint8_t *data;
    size_t      len;
    int         keyframe;
    int32_t     cursor_x;
    int32_t     cursor_y;
    int         cursor_visible;
    uint64_t    bitrate_bps;
} BelayFrame;

// Returns an opaque handle, or NULL on any failure.
//
// A handle is NOT thread-safe: call into one handle from one thread, or
// serialise the calls yourself.
void *belay_client_open(const char *bind,
                        const char *peer,
                        const char *key_hex,
                        const char *salt_hex,
                        const char *preset);

// The bound local UDP port, which the host needs in order to send. 0 if unknown.
uint16_t belay_client_local_port(void *handle);

// Pull the next event. Never blocks. Returns a BELAY_FRAME_* value, or a
// negative BELAY_ERR_* code. BELAY_FRAME_NONE means nothing was ready, which is
// the normal case between frames and not an error.
int belay_client_next_frame(void *handle, BelayFrame *out);

// The bitrate the congestion controller has settled on, for display.
uint64_t belay_client_bitrate(void *handle);

// Ask the host for a keyframe. For the decoder to call when it cannot
// continue (display layer failed, delta frame with no reference). Sent on the
// next belay_client_next_frame; repeated calls before then cost one datagram.
// Returns BELAY_OK or BELAY_ERR_ARGS.
/* Block until a datagram is waiting or `timeout_ms` passes. Returns 1 when
 * something is waiting, 0 on timeout, or a negative error code. Call instead
 * of sleeping between empty `belay_client_next_frame` calls. */
int belay_client_wait(void *handle, uint32_t timeout_ms);

int belay_client_request_keyframe(void *handle);

// Send one input report (a gamepad frame, at most BELAY_INPUT_MAX_LEN bytes)
// to the host on the Input channel — the highest priority the transport has,
// ahead of any queued video. Returns BELAY_OK, BELAY_ERR_ARGS for a null
// handle, null data or a bad length, BELAY_ERR_IO if the socket refused it.
#define BELAY_INPUT_MAX_LEN 64
int belay_client_send_input(void *handle, const uint8_t *data, size_t len);

// Smoothed round-trip time to the host in milliseconds, or negative while it
// is not yet known.
double belay_client_rtt_ms(void *handle);

// Release the handle. Safe with NULL. Calling twice is not safe.
void belay_client_close(void *handle);

// ---- tunnel (crates/belay-client/src/tunnel.rs) -----------------------------
//
// Reach the host from anywhere: an iroh endpoint whose bi-streams are piped to
// the host's TLS port. Unlike the stream handle, a tunnel handle IS
// thread-safe.

typedef struct {
    int    connected;   // non-zero while a QUIC connection to that host is open
    double rtt_ms;      // smoothed RTT, 0 when not connected
    int    direct;      // non-zero when the selected path is direct (not relayed)
} BelayTunnelStats;

// Start a tunnel endpoint with this phone's 32-byte iroh secret key (64 hex
// chars, kept in the Keychain). `relay_urls` is comma-separated; NULL or empty
// means n0's public relays (development only). NULL on failure.
void *belay_tunnel_start(const char *secret_hex, const char *relay_urls);

// This phone's node id (64 lowercase hex) for POST /devices. Writes a
// NUL-terminated string into `out` (cap must be >= 65) and returns its length,
// or BELAY_ERR_ARGS.
int belay_tunnel_node_id(void *handle, char *out, size_t cap);

// A 127.0.0.1 TCP port forwarding to the host with that node id; the app
// connects to https://127.0.0.1:<port> with the host's pinned certificate.
// Returns the port, or a negative BELAY_ERR_* code. Idempotent per node id.
int belay_tunnel_dial(void *handle, const char *node_id);

// Stats for the forwarder to `node_id`. BELAY_OK, BELAY_ERR_ARGS, or
// BELAY_ERR_SESSION when that node id was never dialed.
int belay_tunnel_stats(void *handle, const char *node_id, BelayTunnelStats *out);

// Close every forwarder and the endpoint. Safe with NULL. Not twice.
void belay_tunnel_close(void *handle);

#ifdef __cplusplus
}
#endif

#endif // BELAY_CLIENT_H
