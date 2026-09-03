/*
 * belay_transport.h — C ABI over libdatachannel for the WebRTC media transport.
 *
 * ┌─ STATUS: WRITTEN-BUT-HARDWARE-GATED ────────────────────────────────────┐
 * │ This is the intended C ABI the Swift side calls; the implementation in   │
 * │ belay_transport.cpp is written to the libdatachannel API shape but is    │
 * │ NOT compiled or linked yet — it needs libdatachannel (+ libjuice/        │
 * │ usrsctp/srtp) statically linked into the helper (see build-mac.sh) and a │
 * │ real GPU/phone to exercise (milestones M4/M5). Do not treat it as        │
 * │ working until docs/WEBRTC-SLICE.md's runbook produces a number.          │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Design: the native helper is the WebRTC peer (the ICE callee). It owns the
 * rtc::PeerConnection and one SRTP video track whose RTP source is the encoder's
 * NAL sink (VideoEncoder.swift -> belay_transport_send_frame). The three data
 * channels from app/src/stream/webrtc/channels.ts (input/cursor/control) are
 * created by the PHONE (the offerer, createPeerAdapter) and received here via
 * onDataChannel — the callee never creates its own.
 *
 * Node never sees media: SDP/ICE cross the C ABI as strings, are handed to Node
 * over the existing stdio protocol (native.ts webrtc verbs), and Node relays
 * them to the phone over the authenticated WS. The helper never talks to the
 * phone directly.
 *
 * All callbacks are invoked on libdatachannel's threads; the Swift side must
 * hop to its own queue before touching shared state.
 */

#ifndef BELAY_TRANSPORT_H
#define BELAY_TRANSPORT_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct belay_transport belay_transport;

/* Which data channel a message arrived on / is sent on — mirrors channels.ts. */
typedef enum {
    BELAY_CH_INPUT = 0,   /* reliable, ordered   */
    BELAY_CH_CURSOR = 1,  /* unreliable, unordered (maxRetransmits: 0) */
    BELAY_CH_CONTROL = 2  /* reliable, ordered   */
} belay_channel;

/* Emitted by the peer connection, to be relayed to the phone via Node. */
typedef void (*belay_on_local_description)(void *ctx, const char *type, const char *sdp);
typedef void (*belay_on_local_candidate)(void *ctx, const char *candidate, const char *mid);
/* A data-channel message from the phone (input/cursor/control), to inject. */
typedef void (*belay_on_channel_message)(void *ctx, belay_channel ch, const uint8_t *data, size_t len);
/* The peer connection's aggregate state changed: "connected"/"failed"/... */
typedef void (*belay_on_state)(void *ctx, const char *state);
/* The decoder asked for a keyframe (RTCP PLI/FIR) -> VideoEncoder.requestKeyframe. */
typedef void (*belay_on_keyframe_request)(void *ctx);
/* One transport-cc / RTCP feedback interval, for congestion.ts. */
typedef void (*belay_on_link_feedback)(void *ctx, double loss_ratio, double rtt_ms);

typedef struct {
    void *ctx;
    belay_on_local_description on_local_description;
    belay_on_local_candidate on_local_candidate;
    belay_on_channel_message on_channel_message;
    belay_on_state on_state;
    belay_on_keyframe_request on_keyframe_request;
    belay_on_link_feedback on_link_feedback;
} belay_transport_callbacks;

typedef enum { BELAY_CODEC_H264 = 0, BELAY_CODEC_HEVC = 1 } belay_codec;

/* Create the peer (the callee): sets up the video track and receives the
 * phone-created data channels.
 * Returns NULL on failure. `ice_servers_json` may be NULL for LAN-only. */
belay_transport *belay_transport_create(belay_codec codec,
                                        const char *ice_servers_json,
                                        belay_transport_callbacks callbacks);

/* Feed a remote offer / ICE candidate that Node relayed from the phone. The
 * local answer / local candidates come back via the callbacks. */
void belay_transport_set_remote_offer(belay_transport *t, const char *sdp);
void belay_transport_add_remote_candidate(belay_transport *t, const char *candidate, const char *mid);

/* Push one encoded Annex-B access unit from VideoEncoder onto the SRTP track.
 * `pts_ms` is the capture timestamp for glass-to-glass accounting. */
void belay_transport_send_frame(belay_transport *t, const uint8_t *annexb, size_t len,
                                int is_keyframe, double pts_ms);

/* Send a control-plane message (e.g. ABR feedback ack, latency pong) back to
 * the phone on a data channel. */
void belay_transport_send_on(belay_transport *t, belay_channel ch, const uint8_t *data, size_t len);

/* Tear down the peer connection and free the transport. */
void belay_transport_close(belay_transport *t);

#ifdef __cplusplus
}
#endif

#endif /* BELAY_TRANSPORT_H */
