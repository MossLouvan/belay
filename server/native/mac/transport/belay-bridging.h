/*
 * belay-bridging.h — Swift <-> C bridging header for the WebRTC transport.
 *
 * STATUS: WRITTEN-BUT-HARDWARE-GATED. Only pulled in by the opt-in
 * BELAY_WEBRTC_BUILD=1 path in build-mac.sh; it exposes the belay_transport C
 * ABI to Swift so VideoEncoder's NAL sink can call belay_transport_send_frame
 * and the helper can drive SDP/ICE. Not part of the shipping build.
 */
#include "belay_transport.h"
