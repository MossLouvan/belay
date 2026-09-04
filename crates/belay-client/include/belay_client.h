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

// Release the handle. Safe with NULL. Calling twice is not safe.
void belay_client_close(void *handle);

#ifdef __cplusplus
}
#endif

#endif // BELAY_CLIENT_H
