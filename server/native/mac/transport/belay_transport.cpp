// belay_transport.cpp — libdatachannel implementation of the C ABI in
// belay_transport.h.
//
// ┌─ STATUS: WRITTEN-BUT-HARDWARE-GATED ────────────────────────────────────┐
// │ Written to the libdatachannel API shape but NOT compiled or linked. It   │
// │ needs libdatachannel (+ libjuice/usrsctp/srtp) statically linked into    │
// │ the helper (build-mac.sh) and a real GPU/phone to exercise (M4/M5). The  │
// │ RTP packetization details (STAP-A/FU-A for H.264, the HEVC equivalents), │
// │ the transport-cc feedback plumbing and the exact libdatachannel struct   │
// │ field names must be reconciled against the linked headers when it is     │
// │ actually built. Do not treat as working. │
// └──────────────────────────────────────────────────────────────────────────┘

#include "belay_transport.h"

#include <memory>
#include <string>

// The real build links these; guarded so this file at least parses without the
// dependency present in the tree.
#if defined(BELAY_HAVE_LIBDATACHANNEL)
#include <rtc/rtc.hpp>
#endif

struct belay_transport {
    belay_transport_callbacks cb{};
    belay_codec codec{BELAY_CODEC_H264};
#if defined(BELAY_HAVE_LIBDATACHANNEL)
    std::shared_ptr<rtc::PeerConnection> pc;
    std::shared_ptr<rtc::Track> video;
    std::shared_ptr<rtc::DataChannel> input;
    std::shared_ptr<rtc::DataChannel> cursor;
    std::shared_ptr<rtc::DataChannel> control;
    std::shared_ptr<rtc::RtpPacketizationConfig> rtpConfig;
    uint32_t timestamp{0};
#endif
};

extern "C" {

belay_transport *belay_transport_create(belay_codec codec,
                                        const char *ice_servers_json,
                                        belay_transport_callbacks callbacks) {
    auto *t = new belay_transport();
    t->cb = callbacks;
    t->codec = codec;

#if defined(BELAY_HAVE_LIBDATACHANNEL)
    rtc::Configuration config;
    (void)ice_servers_json; // parse into config.iceServers in the full build
    // LAN slice: no STUN/TURN. Add reflexive/relay servers here for WAN (M7).

    t->pc = std::make_shared<rtc::PeerConnection>(config);

    // Local SDP (our answer) -> relay to the phone via Node.
    t->pc->onLocalDescription([t](rtc::Description desc) {
        if (t->cb.on_local_description)
            t->cb.on_local_description(t->cb.ctx, desc.typeString().c_str(),
                                       std::string(desc).c_str());
    });
    t->pc->onLocalCandidate([t](rtc::Candidate cand) {
        if (t->cb.on_local_candidate)
            t->cb.on_local_candidate(t->cb.ctx, std::string(cand).c_str(),
                                     cand.mid().c_str());
    });
    t->pc->onStateChange([t](rtc::PeerConnection::State state) {
        if (t->cb.on_state) {
            std::ostringstream os; os << state;
            t->cb.on_state(t->cb.ctx, os.str().c_str());
        }
    });

    // One H.264/HEVC video track — the encoder's NAL sink is its RTP source.
    rtc::Description::Video media("video", rtc::Description::Direction::SendOnly);
    const int payloadType = 96;
    if (codec == BELAY_CODEC_HEVC) media.addH265Codec(payloadType);
    else media.addH264Codec(payloadType);
    t->video = t->pc->addTrack(media);

    auto ssrc = static_cast<uint32_t>(42);
    t->rtpConfig = std::make_shared<rtc::RtpPacketizationConfig>(
        ssrc, "video", payloadType,
        codec == BELAY_CODEC_HEVC ? rtc::H265RtpPacketizer::defaultClockRate
                                  : rtc::H264RtpPacketizer::defaultClockRate);
    // Attach the matching packetizer + NACK/PLI handlers; PLI -> keyframe request.
    // (Exact handler wiring reconciled against the linked headers in the build.)

    // The three data channels from channels.ts, each with its reliability.
    t->input = t->pc->createDataChannel("input");   // reliable, ordered
    rtc::DataChannelInit cursorInit;
    cursorInit.reliability.unordered = true;
    cursorInit.reliability.maxRetransmits = 0;       // unreliable, newest-wins
    t->cursor = t->pc->createDataChannel("cursor", cursorInit);
    t->control = t->pc->createDataChannel("control"); // reliable, ordered

    auto bind = [t](std::shared_ptr<rtc::DataChannel> dc, belay_channel ch) {
        dc->onMessage([t, ch](rtc::message_variant msg) {
            if (!std::holds_alternative<rtc::binary>(msg) || !t->cb.on_channel_message) return;
            auto &bin = std::get<rtc::binary>(msg);
            t->cb.on_channel_message(t->cb.ctx, ch,
                reinterpret_cast<const uint8_t *>(bin.data()), bin.size());
        });
    };
    bind(t->input, BELAY_CH_INPUT);
    bind(t->cursor, BELAY_CH_CURSOR);
    bind(t->control, BELAY_CH_CONTROL);
#else
    (void)ice_servers_json;
#endif
    return t;
}

void belay_transport_set_remote_offer(belay_transport *t, const char *sdp) {
    if (!t || !sdp) return;
#if defined(BELAY_HAVE_LIBDATACHANNEL)
    t->pc->setRemoteDescription(rtc::Description(sdp, "offer"));
    // Answer is produced automatically and surfaced via onLocalDescription.
#else
    (void)t; (void)sdp;
#endif
}

void belay_transport_add_remote_candidate(belay_transport *t, const char *candidate, const char *mid) {
    if (!t || !candidate) return;
#if defined(BELAY_HAVE_LIBDATACHANNEL)
    t->pc->addRemoteCandidate(rtc::Candidate(candidate, mid ? mid : ""));
#else
    (void)t; (void)candidate; (void)mid;
#endif
}

void belay_transport_send_frame(belay_transport *t, const uint8_t *annexb, size_t len,
                                int is_keyframe, double pts_ms) {
    if (!t || !annexb || len == 0) return;
#if defined(BELAY_HAVE_LIBDATACHANNEL)
    (void)is_keyframe;
    // Advance the RTP timestamp by the frame delta derived from pts_ms, then
    // packetize the Annex-B access unit and send on the video track. The
    // packetizer fragments into FU-A / aggregates into STAP-A as needed.
    t->rtpConfig->timestamp = static_cast<uint32_t>(pts_ms * 90.0); // 90kHz clock
    if (t->video && t->video->isOpen()) {
        t->video->send(reinterpret_cast<const std::byte *>(annexb), len);
    }
#else
    (void)t; (void)annexb; (void)len; (void)is_keyframe; (void)pts_ms;
#endif
}

void belay_transport_send_on(belay_transport *t, belay_channel ch, const uint8_t *data, size_t len) {
    if (!t || !data) return;
#if defined(BELAY_HAVE_LIBDATACHANNEL)
    auto dc = ch == BELAY_CH_INPUT ? t->input : ch == BELAY_CH_CURSOR ? t->cursor : t->control;
    if (dc && dc->isOpen())
        dc->send(reinterpret_cast<const std::byte *>(data), len);
#else
    (void)t; (void)ch; (void)data; (void)len;
#endif
}

void belay_transport_close(belay_transport *t) {
    if (!t) return;
#if defined(BELAY_HAVE_LIBDATACHANNEL)
    if (t->pc) t->pc->close();
#endif
    delete t;
}

} // extern "C"
