// WebRTCSession.swift — the helper-side controller for the WebRTC media path:
// stdio `webrtc` verb ⇄ libdatachannel transport ⇄ VideoToolbox encoder.
//
// ┌─ STATUS: WRITTEN-BUT-HARDWARE-GATED ────────────────────────────────────┐
// │ Compiled ONLY under BELAY_WEBRTC_BUILD=1 (build-mac.sh adds the -D       │
// │ flag). Typechecked with swiftc against belay_transport.h; NOT run — it   │
// │ needs the vendored static libdatachannel and a GPU/phone (M4/M5). Do not │
// │ treat as working until the runbook produces a number.                    │
// └──────────────────────────────────────────────────────────────────────────┘
//
// Life of a session (the helper is the ICE callee — the phone offers):
//   1. Node relays a validated {kind:"offer", sessionId, sdp} as the `webrtc`
//      stdio verb → startSession(): create the transport, feed it the offer.
//   2. libdatachannel produces the answer + local candidates → the C callbacks
//      → pushed to Node as `type:"webrtc"` lines → bridge → phone.
//   3. On "connected": attach the capture push sink and start the encoder.
//      Every captured CVPixelBuffer → VideoEncoder → Annex-B access unit →
//      belay_transport_send_frame → RTP/SRTP.
//   4. Data channels: `input`/`cursor` carry injection events (same JSON shapes
//      as the stdio commands, validated the same way), `control` carries the
//      ABR setpoint, keyframe requests and latency pings.
//   5. {kind:"bye"} or a failed transport tears everything down; the JPEG pull
//      path is untouched throughout, so the fallback is always live.
//
// Threading: libdatachannel callbacks arrive on its internal threads and hop to
// `queue` before touching any state. Capture frames arrive on the SCStream
// sample queue and go straight into VideoEncoder (itself thread-safe) — media
// never waits on the control-plane queue.

#if BELAY_WEBRTC_BUILD

import CoreVideo
import Foundation

final class WebRTCVerb {
    private let replies: ReplyWriter
    private let capture: CaptureEngine
    private let input: InputController

    /// Serial control-plane queue: session lifecycle, signaling, channel
    /// message handling. Never on the media path.
    private let queue = DispatchQueue(label: "belay.webrtc.control", qos: .userInitiated)

    // Guarded by `queue` (except encoder/transport reads on the media path,
    // which are safe: both objects are internally synchronized and swapped
    // only via teardown on `queue`).
    private var transport: OpaquePointer?
    private var encoder: VideoEncoder?
    private var sessionId: String?
    private var codec: VideoCodec = .h264

    init(replies: ReplyWriter, capture: CaptureEngine, input: InputController) {
        self.replies = replies
        self.capture = capture
        self.input = input
    }

    // MARK: - The stdio verb

    /// Handles one `{cmd:"webrtc", signal:{...}}` command. The signal envelope
    /// was validated by relay.ts on the Node side, but this process trusts
    /// nothing that crosses its stdin: every field is re-checked here.
    func handle(_ command: Command) throws {
        guard let signal = try command.object("signal"),
              let kind = signal["kind"] as? String,
              let sid = signal["sessionId"] as? String, !sid.isEmpty else {
            throw HostError(.badArgument, "webrtc: missing or malformed signal")
        }
        switch kind {
        case "offer":
            guard let sdp = signal["sdp"] as? String, !sdp.isEmpty else {
                throw HostError(.badArgument, "webrtc offer: missing sdp")
            }
            try queue.sync { try self.startSession(sessionId: sid, offerSdp: sdp) }
        case "ice":
            guard let candidate = signal["candidate"] as? String, !candidate.isEmpty else {
                throw HostError(.badArgument, "webrtc ice: missing candidate")
            }
            queue.sync {
                guard sid == self.sessionId, let t = self.transport else { return }
                // The slice bundles one media section; libdatachannel resolves
                // an empty mid to it (relay.ts does not carry mids).
                belay_transport_add_remote_candidate(t, candidate, "")
            }
        case "bye":
            queue.sync {
                guard sid == self.sessionId else { return }
                self.teardown()
            }
        default:
            throw HostError(.badArgument, "webrtc: unknown signal kind '\(kind)'")
        }
        replies.ok(id: command.id)
    }

    /// Release everything on helper shutdown (stdin closed).
    func stop() {
        queue.sync { self.teardown() }
    }

    // MARK: - Session lifecycle (on `queue`)

    private func startSession(sessionId sid: String, offerSdp: String) throws {
        teardown() // a new offer replaces any existing session (stale or glare)

        // HEVC only when the phone's offer actually advertises an H265 payload;
        // H.264 is the safe default every phone decodes in hardware.
        codec = offerSdp.uppercased().contains("H265") ? .hevc : .h264

        var callbacks = belay_transport_callbacks()
        callbacks.ctx = Unmanaged.passUnretained(self).toOpaque()
        callbacks.on_local_description = { ctx, type, sdp in
            guard let ctx, let type, let sdp else { return }
            let me = Unmanaged<WebRTCVerb>.fromOpaque(ctx).takeUnretainedValue()
            me.onLocalDescription(type: String(cString: type), sdp: String(cString: sdp))
        }
        callbacks.on_local_candidate = { ctx, candidate, _ in
            guard let ctx, let candidate else { return }
            let me = Unmanaged<WebRTCVerb>.fromOpaque(ctx).takeUnretainedValue()
            me.onLocalCandidate(String(cString: candidate))
        }
        callbacks.on_channel_message = { ctx, channel, data, len in
            guard let ctx, let data, len > 0 else { return }
            let me = Unmanaged<WebRTCVerb>.fromOpaque(ctx).takeUnretainedValue()
            me.onChannelMessage(channel, Data(bytes: data, count: len))
        }
        callbacks.on_state = { ctx, state in
            guard let ctx, let state else { return }
            let me = Unmanaged<WebRTCVerb>.fromOpaque(ctx).takeUnretainedValue()
            me.onTransportState(String(cString: state))
        }
        callbacks.on_keyframe_request = { ctx in
            guard let ctx else { return }
            let me = Unmanaged<WebRTCVerb>.fromOpaque(ctx).takeUnretainedValue()
            me.encoder?.requestKeyframe()
        }
        callbacks.on_link_feedback = nil // ABR feedback rides the control channel

        let codecC = codec == .hevc ? BELAY_CODEC_HEVC : BELAY_CODEC_H264
        guard let t = belay_transport_create(codecC, nil /* LAN slice: no ICE servers */, callbacks) else {
            throw HostError(.capture, "webrtc: transport creation failed (libdatachannel)")
        }
        transport = t
        sessionId = sid
        belay_transport_set_remote_offer(t, offerSdp)
        // The answer + candidates now flow back via the callbacks above.
    }

    private func teardown() {
        capture.detachEncoderSinks()
        encoder?.stop()
        encoder = nil
        if let t = transport {
            transport = nil
            belay_transport_close(t)
        }
        sessionId = nil
    }

    // MARK: - Transport callbacks (hop to `queue`)

    private func onLocalDescription(type: String, sdp: String) {
        queue.async {
            guard let sid = self.sessionId else { return }
            // libdatachannel emits our side as "answer" (we are the callee).
            self.pushSignal(["kind": type, "sessionId": sid, "sdp": sdp])
        }
    }

    private func onLocalCandidate(_ candidate: String) {
        queue.async {
            guard let sid = self.sessionId else { return }
            self.pushSignal(["kind": "ice", "sessionId": sid, "candidate": candidate])
        }
    }

    private func onTransportState(_ state: String) {
        queue.async {
            switch state {
            case "connected", "Connected":
                self.startEncoderIfNeeded()
            case "failed", "Failed", "closed", "Closed":
                // The phone's own ICE state machine sees the same transition
                // and decides recoverable-vs-terminal (signaling.ts); here we
                // just stop burning GPU. The JPEG path is still serving.
                self.capture.detachEncoderSinks()
                self.encoder?.stop()
                self.encoder = nil
            default:
                break // gathering/connecting states need no action
            }
        }
    }

    /// On `queue`. Builds the encoder sized to the captured display and attaches
    /// the capture push sink. Failure is pushed as a bye so the phone falls back
    /// to JPEG instead of waiting on a track that will never flow.
    private func startEncoderIfNeeded() {
        guard encoder == nil, let t = transport, let sid = sessionId else { return }
        do {
            var pendingSink: ((CVPixelBuffer, Double) -> Void)?
            let geometry = try capture.attachEncoderSink(screen: nil) { pixelBuffer, ptsMs in
                pendingSink?(pixelBuffer, ptsMs)
            }
            let enc = try VideoEncoder(
                width: Int32(geometry.pixelWidth),
                height: Int32(geometry.pixelHeight),
                codec: codec,
                fps: 60,
                onFrame: { [weak self] data, isKeyframe, ptsMs in
                    // Media path: SCStream/VT thread straight into the
                    // transport — never through the control queue.
                    guard let self, let t = self.transport else { return }
                    data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
                        guard let base = raw.bindMemory(to: UInt8.self).baseAddress else { return }
                        belay_transport_send_frame(t, base, raw.count, isKeyframe ? 1 : 0, ptsMs)
                    }
                },
                onError: { [weak self] message in
                    self?.sendControl(["t": "encoder-error", "message": message])
                }
            )
            pendingSink = { [weak enc] pixelBuffer, ptsMs in
                enc?.encode(pixelBuffer: pixelBuffer, ptsMs: ptsMs)
            }
            encoder = enc
            enc.requestKeyframe() // first frame a joining decoder sees must be an IDR
            _ = t // silence unused warning paranoia; transport stays owned above
        } catch {
            let reason = "encoder-start-failed: \(HostError.wrap(error).message)"
            pushSignal(["kind": "bye", "sessionId": sid, "reason": reason])
            teardown()
        }
    }

    // MARK: - Data channels

    private func onChannelMessage(_ channel: belay_channel, _ data: Data) {
        queue.async {
            guard let json = try? JSONSerialization.jsonObject(with: data),
                  let msg = json as? [String: Any] else {
                self.sendControl(["t": "error", "message": "channel message is not a JSON object"])
                return
            }
            switch channel {
            case BELAY_CH_INPUT, BELAY_CH_CURSOR:
                self.inject(msg)
            case BELAY_CH_CONTROL:
                self.handleControl(msg)
            default:
                break
            }
        }
    }

    /// Control-plane messages from the phone (channels.ts routes these onto the
    /// reliable `control` channel).
    private func handleControl(_ msg: [String: Any]) {
        switch msg["t"] as? String {
        case "bitrate":
            // The ABR setpoint from congestion.ts. VideoEncoder clamps it.
            if let bps = msg["bps"] as? NSNumber { encoder?.setBitrate(bps.intValue) }
        case "keyframe":
            encoder?.requestKeyframe()
        case "ping":
            // latency.ts clock-offset probe: echo with the host receive time.
            var pong = msg
            pong["t"] = "pong"
            pong["tHost"] = Date().timeIntervalSince1970 * 1000.0
            sendControl(pong)
        default:
            sendControl(["t": "error", "message": "unknown control message"])
        }
    }

    /// Injects one input event. Same JSON shapes as the stdio commands so the
    /// phone's existing event encoding works on either path; key-up integrity
    /// is guaranteed by channels.ts routing (key events only ever arrive on the
    /// reliable `input` channel).
    private func inject(_ msg: [String: Any]) {
        do {
            let line = try JSONSerialization.data(withJSONObject: mergedCmd(msg))
            let command = try Command.parse(line: String(decoding: line, as: UTF8.self))
            switch command.name {
            case "move":
                try input.move(normalizedX: try command.double("x") ?? 0,
                               normalizedY: try command.double("y") ?? 0,
                               screen: try command.int("screen"), window: nil)
            case "down":
                try input.press(MouseButton.parse(try command.string("button")), at: nil)
            case "up":
                try input.release(MouseButton.parse(try command.string("button")), at: nil)
            case "scroll":
                try input.scroll(deltaY: try command.double("dy") ?? 0,
                                 deltaX: try command.double("dx") ?? 0)
            case "key":
                try input.key(try command.int("vk"), modifiers: try command.intArray("mods"))
            case "text":
                try input.type(try command.string("text") ?? "")
            default:
                sendControl(["t": "error", "message": "unknown input cmd"])
            }
        } catch {
            // Never silently drop a failed injection: the phone needs to know a
            // key event failed (a lost key-up is a stuck key).
            sendControl(["t": "error", "message": HostError.wrap(error).message])
        }
    }

    /// Channel messages carry the same fields as stdio commands but no `id`;
    /// Command.parse requires `cmd`, which these already have.
    private func mergedCmd(_ msg: [String: Any]) -> [String: Any] {
        var out = msg
        out["id"] = 0
        return out
    }

    // MARK: - Outbound

    private func pushSignal(_ signal: [String: Any]) {
        replies.push(type: "webrtc", ["signal": signal])
    }

    private func sendControl(_ msg: [String: Any]) {
        guard let t = transport,
              let data = try? JSONSerialization.data(withJSONObject: msg) else { return }
        data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            guard let base = raw.bindMemory(to: UInt8.self).baseAddress else { return }
            belay_transport_send_on(t, BELAY_CH_CONTROL, base, raw.count)
        }
    }
}

#endif // BELAY_WEBRTC_BUILD
