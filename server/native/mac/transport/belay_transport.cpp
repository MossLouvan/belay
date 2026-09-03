// belay_transport.cpp — libdatachannel implementation of the C ABI in
// belay_transport.h.
//
// ┌─ STATUS: WRITTEN-BUT-NOT-COMPILED (hardware-gated link) ────────────────┐
// │ Written against the real libdatachannel v0.23.1 headers and verified     │
// │ with `clang++ -fsyntax-only` against them (see docs/WEBRTC-SLICE.md,     │
// │ "Verify without hardware"). It has NOT been linked against the static    │
// │ library or exercised over a network — that needs the vendored            │
// │ libdatachannel build plus a GPU/phone (milestones M4/M5). Do not treat   │
// │ as working until the runbook produces a number.                          │
// └──────────────────────────────────────────────────────────────────────────┘
//
// Pipeline shape (the same encode → packetize → SRTP structure Sunshine/
// Moonlight use, but over libdatachannel's WebRTC stack instead of a custom
// RTSP/ENet protocol):
//
//   VideoEncoder (Annex-B access unit)
//     └─ belay_transport_send_frame
//          └─ rtc::H264RtpPacketizer / H265RtpPacketizer  (FU-A/AP fragmenting
//             at BELAY_MAX_FRAGMENT_SIZE — the same budget as the tested
//             server/src/webrtc/packetization.ts math)
//               ├─ rtc::RtcpSrReporter    (sender reports → receiver sync)
//               ├─ rtc::RtcpNackResponder (retransmit cache — NACK/RTX)
//               └─ rtc::PliHandler        (PLI → on_keyframe_request →
//                                          VideoEncoder.requestKeyframe)
//                    └─ SRTP/DTLS via the rtc::Track
//
// Loss/RTT feedback for the ABR does NOT come from this side: congestion.ts
// runs on the phone (the receiver), which observes loss directly and sends the
// bitrate setpoint back over the `control` data channel. on_link_feedback in
// the ABI stays for a future sender-side estimator and is not wired here.
//
// Threading: every callback fires on libdatachannel's internal threads. The
// Swift caller (WebRTCSession.swift) hops to its own serial queue before
// touching shared state; this file only guards its own pointers with a mutex.

#include "belay_transport.h"

#include <atomic>
#include <cstring>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <vector>

// The real build links libdatachannel; guarded so this file still parses (and
// the fallback path still builds) when the vendor tree is absent.
#if defined(BELAY_HAVE_LIBDATACHANNEL)
#include <rtc/rtc.hpp>
#endif

namespace {

// RTP payload budget per packet. Mirrors server/src/webrtc/packetization.ts
// (DEFAULT_MTU 1200 - RTP_HEADER_BYTES 12) so the tested fragmentation math and
// the native packetizer agree on packet counts.
constexpr size_t BELAY_MAX_FRAGMENT_SIZE = 1188;
constexpr int BELAY_VIDEO_PAYLOAD_TYPE = 96;
constexpr uint32_t BELAY_VIDEO_SSRC = 0x42454C41; // "BELA"

// Tolerant ICE-server list parse: accepts a JSON array of strings
// (["stun:host:3478", ...]) or a plain comma/whitespace-separated list. No JSON
// dependency; anything that does not look like a stun:/turn(s): URI is dropped
// (input crosses a process boundary — validate, never trust).
std::vector<std::string> parseIceServers(const char *raw) {
    std::vector<std::string> out;
    if (!raw) return out;
    std::string s(raw);
    std::string token;
    auto flush = [&] {
        if (token.rfind("stun:", 0) == 0 || token.rfind("stuns:", 0) == 0 ||
            token.rfind("turn:", 0) == 0 || token.rfind("turns:", 0) == 0) {
            out.push_back(token);
        }
        token.clear();
    };
    for (char c : s) {
        if (c == '[' || c == ']' || c == '"' || c == '\'' || c == ',' ||
            c == ' ' || c == '\n' || c == '\t') {
            flush();
        } else {
            token.push_back(c);
        }
    }
    flush();
    return out;
}

} // namespace

struct belay_transport {
    belay_transport_callbacks cb{};
    belay_codec codec{BELAY_CODEC_H264};
    std::mutex mutex; // guards the pointers below against close() races
    std::atomic<bool> closed{false};
    // Self-reference that owns this object's lifetime. Every libdatachannel
    // callback captures a std::weak_ptr to it and locks it before touching any
    // field, so the struct outlives every in-flight callback and is freed only
    // once the last one releases — instead of being `delete`d out from under a
    // callback still running on a datachannel thread (the use-after-free this
    // pattern replaces). close() drops this reference to start teardown.
    std::shared_ptr<belay_transport> self;
#if defined(BELAY_HAVE_LIBDATACHANNEL)
    std::shared_ptr<rtc::PeerConnection> pc;
    std::shared_ptr<rtc::Track> video;
    std::shared_ptr<rtc::DataChannel> input;
    std::shared_ptr<rtc::DataChannel> cursor;
    std::shared_ptr<rtc::DataChannel> control;
    std::shared_ptr<rtc::RtpPacketizationConfig> rtpConfig;
    double basePtsMs{-1.0}; // first frame's capture pts → RTP timestamp origin
#endif
};

extern "C" {

belay_transport *belay_transport_create(belay_codec codec,
                                        const char *ice_servers_json,
                                        belay_transport_callbacks callbacks) {
    auto *t = new (std::nothrow) belay_transport();
    if (!t) return nullptr;
    // Hand ownership to a shared_ptr and keep a self-reference so callbacks can
    // hold a weak_ptr; `t` stays a raw view for the existing code below.
    std::shared_ptr<belay_transport> owner(t);
    t->self = owner;
    t->cb = callbacks;
    t->codec = codec;

#if defined(BELAY_HAVE_LIBDATACHANNEL)
    try {
        rtc::Configuration config;
        for (auto &uri : parseIceServers(ice_servers_json)) {
            config.iceServers.emplace_back(uri);
        }
        // LAN slice default: the list is empty — host candidates only.

        t->pc = std::make_shared<rtc::PeerConnection>(config);

        // Local SDP (our answer — the helper is the callee) → relay to the
        // phone via Node's type:"webrtc" push line.
        t->pc->onLocalDescription([wp = std::weak_ptr<belay_transport>(t->self)](rtc::Description desc) {
            auto t = wp.lock();
            if (!t || t->closed.load()) return;
            if (t->cb.on_local_description) {
                const std::string type = desc.typeString();
                const std::string sdp = std::string(desc);
                t->cb.on_local_description(t->cb.ctx, type.c_str(), sdp.c_str());
            }
        });
        t->pc->onLocalCandidate([wp = std::weak_ptr<belay_transport>(t->self)](rtc::Candidate cand) {
            auto t = wp.lock();
            if (!t || t->closed.load()) return;
            if (t->cb.on_local_candidate) {
                const std::string c = std::string(cand);
                const std::string mid = cand.mid();
                t->cb.on_local_candidate(t->cb.ctx, c.c_str(), mid.c_str());
            }
        });
        t->pc->onStateChange([wp = std::weak_ptr<belay_transport>(t->self)](rtc::PeerConnection::State state) {
            auto t = wp.lock();
            if (!t || t->closed.load()) return;
            if (t->cb.on_state) {
                std::ostringstream os;
                os << state; // "connected" / "failed" / "closed" / ...
                const std::string s = os.str();
                t->cb.on_state(t->cb.ctx, s.c_str());
            }
        });

        // ── One send-only video track; the encoder's NAL sink is its source ──
        rtc::Description::Video media("video", rtc::Description::Direction::SendOnly);
        if (codec == BELAY_CODEC_HEVC) media.addH265Codec(BELAY_VIDEO_PAYLOAD_TYPE);
        else media.addH264Codec(BELAY_VIDEO_PAYLOAD_TYPE);
        media.addSSRC(BELAY_VIDEO_SSRC, "belay-video", "belay-stream", "belay-video");
        t->video = t->pc->addTrack(media);

        t->rtpConfig = std::make_shared<rtc::RtpPacketizationConfig>(
            BELAY_VIDEO_SSRC, "belay-video", BELAY_VIDEO_PAYLOAD_TYPE,
            rtc::H264RtpPacketizer::ClockRate); // 90 kHz for H.264 and H.265 alike

        // Media-handler chain: packetize → SR reports → NACK cache → PLI.
        std::shared_ptr<rtc::MediaHandler> packetizer;
        if (codec == BELAY_CODEC_HEVC) {
            packetizer = std::make_shared<rtc::H265RtpPacketizer>(
                rtc::H265RtpPacketizer::Separator::LongStartSequence, t->rtpConfig,
                BELAY_MAX_FRAGMENT_SIZE);
        } else {
            packetizer = std::make_shared<rtc::H264RtpPacketizer>(
                rtc::H264RtpPacketizer::Separator::LongStartSequence, t->rtpConfig,
                BELAY_MAX_FRAGMENT_SIZE);
        }
        packetizer->addToChain(std::make_shared<rtc::RtcpSrReporter>(t->rtpConfig));
        packetizer->addToChain(std::make_shared<rtc::RtcpNackResponder>());
        packetizer->addToChain(std::make_shared<rtc::PliHandler>([wp = std::weak_ptr<belay_transport>(t->self)] {
            // Receiver's decoder lost its reference chain → force an IDR.
            auto t = wp.lock();
            if (t && !t->closed.load() && t->cb.on_keyframe_request)
                t->cb.on_keyframe_request(t->cb.ctx);
        }));
        t->video->setMediaHandler(packetizer);

        // ── The three data channels from channels.ts ────────────────────────
        // The PHONE is the offerer and creates all three up front
        // (createPeerAdapter in peer-adapter.ts), so the callee side must
        // RECEIVE them here — creating our own would duplicate every label
        // with a second in-band-negotiated channel. Reliability (ordered /
        // maxRetransmits:0) is a property of the creating side's init and
        // rides in the DCEP open message; nothing to configure here.
        t->pc->onDataChannel([wp = std::weak_ptr<belay_transport>(t->self)](std::shared_ptr<rtc::DataChannel> dc) {
            auto t = wp.lock();
            if (!t || t->closed.load()) return;
            const std::string label = dc->label();
            belay_channel ch;
            if (label == "input") ch = BELAY_CH_INPUT;
            else if (label == "cursor") ch = BELAY_CH_CURSOR;
            else if (label == "control") ch = BELAY_CH_CONTROL;
            else return; // unknown label: ignore, never crash on a peer quirk

            dc->onMessage([wp = std::weak_ptr<belay_transport>(t->self), ch](rtc::message_variant msg) {
                auto t = wp.lock();
                if (!t || t->closed.load() || !t->cb.on_channel_message) return;
                if (std::holds_alternative<rtc::binary>(msg)) {
                    auto &bin = std::get<rtc::binary>(msg);
                    t->cb.on_channel_message(t->cb.ctx, ch,
                        reinterpret_cast<const uint8_t *>(bin.data()), bin.size());
                } else {
                    // Strings arrive from JSON-speaking clients; hand the bytes
                    // through unchanged — the Swift side parses and validates.
                    auto &str = std::get<std::string>(msg);
                    t->cb.on_channel_message(t->cb.ctx, ch,
                        reinterpret_cast<const uint8_t *>(str.data()), str.size());
                }
            });

            std::lock_guard<std::mutex> lock(t->mutex);
            if (ch == BELAY_CH_INPUT) t->input = std::move(dc);
            else if (ch == BELAY_CH_CURSOR) t->cursor = std::move(dc);
            else t->control = std::move(dc);
        });
    } catch (const std::exception &e) {
        // Creation failed (bad config, library init): report and fail cleanly
        // so the caller falls back to JPEG instead of crashing the helper.
        if (t->cb.on_state) {
            const std::string msg = std::string("create-failed: ") + e.what();
            t->cb.on_state(t->cb.ctx, msg.c_str());
        }
        t->self.reset(); // `owner` frees it on return; never double-delete
        return nullptr;
    }
#else
    (void)ice_servers_json;
#endif
    return t;
}

void belay_transport_set_remote_offer(belay_transport *t, const char *sdp) {
    if (!t || !sdp || t->closed.load()) return;
#if defined(BELAY_HAVE_LIBDATACHANNEL)
    try {
        // The callee path: accepting the remote offer makes libdatachannel
        // produce the answer automatically, surfaced via onLocalDescription.
        t->pc->setRemoteDescription(rtc::Description(sdp, "offer"));
    } catch (const std::exception &e) {
        if (t->cb.on_state) {
            const std::string msg = std::string("offer-rejected: ") + e.what();
            t->cb.on_state(t->cb.ctx, msg.c_str());
        }
    }
#else
    (void)t; (void)sdp;
#endif
}

void belay_transport_add_remote_candidate(belay_transport *t, const char *candidate, const char *mid) {
    if (!t || !candidate || t->closed.load()) return;
#if defined(BELAY_HAVE_LIBDATACHANNEL)
    try {
        t->pc->addRemoteCandidate(rtc::Candidate(candidate, mid ? mid : ""));
    } catch (const std::exception &) {
        // A malformed candidate is not fatal: ICE proceeds on the others.
    }
#else
    (void)t; (void)candidate; (void)mid;
#endif
}

void belay_transport_send_frame(belay_transport *t, const uint8_t *annexb, size_t len,
                                int is_keyframe, double pts_ms) {
    if (!t || !annexb || len == 0 || t->closed.load()) return;
#if defined(BELAY_HAVE_LIBDATACHANNEL)
    (void)is_keyframe; // the packetizer needs no flag; IDRs carry their own NAL type
    std::lock_guard<std::mutex> lock(t->mutex);
    if (!t->video || !t->video->isOpen()) return;
    // RTP timestamp: 90 kHz clock, anchored at the first frame's capture pts so
    // one clock (the capture clock) drives both RTP timing and glass-to-glass
    // accounting. Matches ptsMsToRtpTimestamp in packetization.ts.
    if (t->basePtsMs < 0) t->basePtsMs = pts_ms;
    const double elapsedSec = (pts_ms - t->basePtsMs) / 1000.0;
    t->rtpConfig->timestamp =
        t->rtpConfig->startTimestamp + t->rtpConfig->secondsToTimestamp(elapsedSec);
    try {
        t->video->send(reinterpret_cast<const std::byte *>(annexb), len);
    } catch (const std::exception &) {
        // A send on a closing track can throw; the state callback already
        // reports the disconnect — dropping this frame is the right outcome.
    }
#else
    (void)t; (void)annexb; (void)len; (void)is_keyframe; (void)pts_ms;
#endif
}

void belay_transport_send_on(belay_transport *t, belay_channel ch, const uint8_t *data, size_t len) {
    if (!t || !data || len == 0 || t->closed.load()) return;
#if defined(BELAY_HAVE_LIBDATACHANNEL)
    std::lock_guard<std::mutex> lock(t->mutex);
    auto dc = ch == BELAY_CH_INPUT ? t->input : ch == BELAY_CH_CURSOR ? t->cursor : t->control;
    if (!dc || !dc->isOpen()) return;
    try {
        dc->send(reinterpret_cast<const std::byte *>(data), len);
    } catch (const std::exception &) {
        // Same rationale as the frame path: a racing close loses one message.
    }
#else
    (void)t; (void)ch; (void)data; (void)len;
#endif
}

void belay_transport_close(belay_transport *t) {
    if (!t) return;
    t->closed.store(true);
    // Hold the object alive across teardown, then drop the self-cycle: it frees
    // once `keep` here and every in-flight callback's weak-lock have all
    // released — no `delete` under a live callback thread.
    std::shared_ptr<belay_transport> keep = t->self;
    t->self.reset();
#if defined(BELAY_HAVE_LIBDATACHANNEL)
    // Reset the channels under the mutex (onDataChannel writes them there), but
    // close/destroy the peer connection WITHOUT holding the mutex — ~PeerConnection
    // joins its callback threads, and one may be blocked acquiring this mutex.
    {
        std::lock_guard<std::mutex> lock(t->mutex);
        t->video.reset();
        t->input.reset();
        t->cursor.reset();
        t->control.reset();
    }
    if (t->pc) {
        try { t->pc->close(); } catch (const std::exception &) {}
    }
    t->pc.reset();
#endif
    // keep drops here.
}

} // extern "C"
