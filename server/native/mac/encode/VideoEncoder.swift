// VideoToolbox H.264/HEVC low-latency encoder for the WebRTC slice.
//
// ┌─ STATUS: WRITTEN-BUT-HARDWARE-GATED ────────────────────────────────────┐
// │ Written to the VideoToolbox API shape and TYPECHECKED with swiftc (see   │
// │ docs/WEBRTC-SLICE.md, "Verify without hardware"), but it has NOT been    │
// │ run against a real GPU: no encode latency, no bitrate tracking, no       │
// │ decodability has been measured. Do NOT treat any of it as verified until │
// │ the runbook produces a glass-to-glass number (milestone M3). The         │
// │ encode-latency and bitrate numbers in the plan are TARGETS.              │
// └──────────────────────────────────────────────────────────────────────────┘
//
// Design: one long-lived VTCompressionSession fed the CVPixelBuffers that
// Capture.swift's SCStream already produces. Configured for interactive
// streaming, NOT file encoding:
//   - RealTime = true                 (favour latency over ratio)
//   - AllowFrameReordering = false    (no B-frames — one would add a whole
//                                       frame of latency waiting for the next)
//   - PrioritizeEncodingSpeedOverQuality = true (screen content at streaming
//                                       rates: speed is the quality)
//   - large MaxKeyFrameInterval + explicit forced keyframes on demand instead
//     of frequent periodic IDR (a full keyframe is a bandwidth spike that
//     stalls a constrained uplink)
//   - AverageBitRate + DataRateLimits driven by the congestion controller
//     (congestion.ts, relayed over the control data channel) so the encoder
//     tracks the ABR setpoint
//   - low-latency rate control on Apple silicon (H.264 AND HEVC there; on
//     Intel it is H.264-only, so the spec is arch-gated)
//
// Output NAL units are converted from AVCC (length-prefixed) to Annex-B
// (start-code framed) with the cached SPS/PPS (VPS/SPS/PPS for HEVC) prepended
// to every IDR, and handed to the transport with the capture timestamp
// attached — which is what latency.ts needs for glass-to-glass accounting.
// The Annex-B format and keyframe/parameter-set rules match the pure, tested
// reference implementation in server/src/webrtc/nal.ts.

import CoreMedia
import CoreVideo
import Foundation
import VideoToolbox

/// Callback receiving one encoded frame: the Annex-B bytes, whether it is a
/// keyframe, and the capture presentation timestamp for latency accounting.
typealias EncodedFrameHandler = (_ data: Data, _ isKeyframe: Bool, _ ptsMs: Double) -> Void

/// Callback for encoder-level failures (a dropped frame, a dying session).
/// The owner decides whether to rebuild the session or fall back to JPEG.
typealias EncoderErrorHandler = (_ message: String) -> Void

/// Which codec the session encodes. HEVC is offered only when the phone
/// advertises decode support in the SDP (better ratio for text/UI); H.264 is the
/// safe default every phone decodes in hardware.
enum VideoCodec {
    case h264
    case hevc

    var cmType: CMVideoCodecType {
        switch self {
        case .h264: return kCMVideoCodecType_H264
        case .hevc: return kCMVideoCodecType_HEVC
        }
    }
}

final class VideoEncoder {
    /// ABR setpoint clamps — mirror DEFAULT_CONFIG in congestion.ts (300 kbps
    /// floor, 20 Mbps ceiling) so a bad control-channel message can never
    /// configure a useless or link-flooding session.
    static let minBitrateBps = 300_000
    static let maxBitrateBps = 20_000_000

    private var session: VTCompressionSession?
    private let width: Int32
    private let height: Int32
    private let codec: VideoCodec
    private let fps: Int
    private let onFrame: EncodedFrameHandler
    private let onError: EncoderErrorHandler?

    /// Cached parameter sets (SPS/PPS for H.264; VPS/SPS/PPS for HEVC), read from
    /// each keyframe's format description and prepended, Annex-B framed, to
    /// every IDR so a decoder that joined late (or after loss) can resync.
    private var parameterSetsAnnexB: Data?

    /// Set by requestKeyframe(); consumed on the next encode() to force an IDR.
    private var forceKeyframeNext = false

    /// One lock for the tiny bits of state shared between the caller's thread
    /// and VideoToolbox's output callback thread.
    private let lock = NSLock()
    private var stopped = false

    init(width: Int32, height: Int32, codec: VideoCodec = .h264, fps: Int = 60,
         onFrame: @escaping EncodedFrameHandler, onError: EncoderErrorHandler? = nil) throws {
        self.width = width
        self.height = height
        self.codec = codec
        self.fps = fps
        self.onFrame = onFrame
        self.onError = onError
        try makeSession()
    }

    private func makeSession() throws {
        var encoderSpec: CFDictionary?
        #if arch(arm64)
        // Apple silicon: the low-latency rate controller is the one that
        // actually hits the interactive band, and it supports H.264 AND HEVC
        // there (Intel supports it for H.264 only, hence the arch gate).
        encoderSpec = [
            kVTVideoEncoderSpecification_EnableLowLatencyRateControl: kCFBooleanTrue as Any
        ] as CFDictionary
        #endif

        var s: VTCompressionSession?
        let status = VTCompressionSessionCreate(
            allocator: kCFAllocatorDefault,
            width: width,
            height: height,
            codecType: codec.cmType,
            encoderSpecification: encoderSpec,
            imageBufferAttributes: nil,
            compressedDataAllocator: nil,
            outputCallback: nil,
            refcon: nil,
            compressionSessionOut: &s
        )
        guard status == noErr, let session = s else {
            throw HostError(.capture, "VTCompressionSessionCreate failed: \(status)")
        }

        // Interactive-streaming properties — the whole point of this encoder.
        // Property failures are non-fatal individually (an encoder that ignores
        // a hint still encodes), but are surfaced so a misconfigured session is
        // visible instead of silently slow.
        setProperty(session, kVTCompressionPropertyKey_RealTime, kCFBooleanTrue)
        setProperty(session, kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse)
        setProperty(session, kVTCompressionPropertyKey_PrioritizeEncodingSpeedOverQuality, kCFBooleanTrue)
        let profile = codec == .hevc ? kVTProfileLevel_HEVC_Main_AutoLevel : kVTProfileLevel_H264_Main_AutoLevel
        setProperty(session, kVTCompressionPropertyKey_ProfileLevel, profile)
        // Large interval: we drive IDRs explicitly (join / unrecoverable loss)
        // rather than paying a periodic full-frame spike.
        setProperty(session, kVTCompressionPropertyKey_MaxKeyFrameInterval, 600 as CFNumber)
        setProperty(session, kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, 5 as CFNumber)
        setProperty(session, kVTCompressionPropertyKey_ExpectedFrameRate, fps as CFNumber)
        // Never let the encoder queue frames internally: output must follow
        // input with no pipeline depth, or every queued frame is added latency.
        setProperty(session, kVTCompressionPropertyKey_MaxFrameDelayCount, 0 as CFNumber)

        VTCompressionSessionPrepareToEncodeFrames(session)
        self.session = session
    }

    private func setProperty(_ session: VTCompressionSession, _ key: CFString, _ value: CFTypeRef) {
        let status = VTSessionSetProperty(session, key: key, value: value)
        if status != noErr {
            onError?("VTSessionSetProperty(\(key)) failed: \(status)")
        }
    }

    /// Apply an adaptive-bitrate setpoint (bits/sec) from the congestion
    /// controller (phone-side congestion.ts, over the control channel).
    /// AverageBitRate is the target; DataRateLimits caps the burst so a single
    /// interval cannot blow the uplink budget (bytes-per-window).
    func setBitrate(_ bitsPerSecond: Int) {
        guard let session else { return }
        let clamped = min(max(bitsPerSecond, Self.minBitrateBps), Self.maxBitrateBps)
        setProperty(session, kVTCompressionPropertyKey_AverageBitRate, clamped as CFNumber)
        // Cap the peak at ~1.5x average over a one-second window.
        let bytesPerWindow = Int(Double(clamped) * 1.5 / 8.0)
        let limits = [bytesPerWindow as CFNumber, 1 as CFNumber] as CFArray // [bytes, seconds]
        setProperty(session, kVTCompressionPropertyKey_DataRateLimits, limits)
    }

    /// Encode one captured frame. `ptsMs` is the host capture time in ms
    /// (SCStream's sample timestamp); it rides through to the encoded-frame
    /// handler for glass-to-glass timing.
    func encode(pixelBuffer: CVPixelBuffer, ptsMs: Double) {
        guard let session else { return }
        let pts = CMTime(value: Int64(ptsMs * 1000), timescale: 1_000_000)

        var frameProperties: CFDictionary?
        lock.lock()
        if forceKeyframeNext {
            forceKeyframeNext = false
            frameProperties = [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue] as CFDictionary
        }
        lock.unlock()

        let status = VTCompressionSessionEncodeFrame(
            session, imageBuffer: pixelBuffer, presentationTimeStamp: pts,
            duration: .invalid, frameProperties: frameProperties, infoFlagsOut: nil
        ) { [weak self] status, infoFlags, sampleBuffer in
            guard let self else { return }
            if status != noErr {
                self.onError?("encode callback failed: \(status)")
                return
            }
            if infoFlags.contains(.frameDropped) {
                // The rate controller shed this frame — expected under a hard
                // bitrate squeeze; the next frame simply covers more delta.
                return
            }
            guard let sampleBuffer else { return }
            self.emit(sampleBuffer, ptsMs: ptsMs)
        }
        if status != noErr {
            onError?("VTCompressionSessionEncodeFrame failed: \(status)")
        }
    }

    /// Force the next frame to be an IDR — used on a new client join or a
    /// decoder-reported loss (RTCP PLI via the transport's on_keyframe_request)
    /// that FEC/NACK could not repair.
    func requestKeyframe() {
        lock.lock()
        forceKeyframeNext = true
        lock.unlock()
    }

    /// Flush and tear down. Safe to call more than once; encode() after stop()
    /// is a no-op. Must be called before releasing the last reference from a
    /// live pipeline so in-flight frames drain instead of racing deinit.
    func stop() {
        lock.lock()
        let alreadyStopped = stopped
        stopped = true
        lock.unlock()
        guard !alreadyStopped, let session else { return }
        VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
        VTCompressionSessionInvalidate(session)
        self.session = nil
    }

    // ── NAL extraction: AVCC (length-prefixed) -> Annex-B (start codes) ───────
    // The pure reference for this logic (with unit tests) is
    // server/src/webrtc/nal.ts: avccToAnnexB + summarizeAccessUnit.

    private static let startCode = Data([0x00, 0x00, 0x00, 0x01])

    private func emit(_ sampleBuffer: CMSampleBuffer, ptsMs: Double) {
        let isKeyframe = Self.isKeyframe(sampleBuffer)

        // On a keyframe, (re)read and cache the parameter sets from the format
        // description so every IDR carries them for late/lossy decoders — and
        // so a mid-stream resolution change (new SPS) propagates.
        if isKeyframe, let fmt = CMSampleBufferGetFormatDescription(sampleBuffer) {
            let params = Self.parameterSetsAnnexB(from: fmt, codec: codec)
            lock.lock()
            parameterSetsAnnexB = params
            lock.unlock()
        }

        guard let block = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }
        var totalLength = 0
        var pointer: UnsafeMutablePointer<Int8>?
        guard CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil,
                                          totalLengthOut: &totalLength, dataPointerOut: &pointer) == noErr,
              let pointer else {
            onError?("CMBlockBufferGetDataPointer failed")
            return
        }

        var annexB = Data(capacity: totalLength + 128)
        if isKeyframe {
            lock.lock()
            let params = parameterSetsAnnexB
            lock.unlock()
            if let params { annexB.append(params) }
        }

        // Walk the AVCC buffer: [4-byte big-endian length][NAL] repeated.
        var offset = 0
        let bytes = UnsafeRawPointer(pointer)
        while offset + 4 <= totalLength {
            var nalLength: UInt32 = 0
            memcpy(&nalLength, bytes + offset, 4)
            nalLength = CFSwapInt32BigToHost(nalLength)
            offset += 4
            let len = Int(nalLength)
            guard len > 0, offset + len <= totalLength else {
                onError?("malformed AVCC buffer (nal len \(len) at \(offset)/\(totalLength))")
                break
            }
            annexB.append(Self.startCode)
            annexB.append(Data(bytes: bytes + offset, count: len))
            offset += len
        }

        guard !annexB.isEmpty else { return }
        onFrame(annexB, isKeyframe, ptsMs)
    }

    private static func isKeyframe(_ sampleBuffer: CMSampleBuffer) -> Bool {
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false)
            as? [[CFString: Any]], let first = attachments.first else {
            return true // no attachments -> treat as sync (keyframe)
        }
        // NotSync present and true means a P-frame; absent/false means an IDR.
        if let notSync = first[kCMSampleAttachmentKey_NotSync] as? Bool { return !notSync }
        return true
    }

    /// Read the codec's parameter sets from the format description and return
    /// them Annex-B framed (each start-code prefixed), ready to prepend to an IDR.
    private static func parameterSetsAnnexB(from fmt: CMFormatDescription, codec: VideoCodec) -> Data {
        var out = Data()
        var count = 0
        // First call learns the parameter-set count.
        if codec == .hevc {
            CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(fmt, parameterSetIndex: 0,
                parameterSetPointerOut: nil, parameterSetSizeOut: nil,
                parameterSetCountOut: &count, nalUnitHeaderLengthOut: nil)
        } else {
            CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, parameterSetIndex: 0,
                parameterSetPointerOut: nil, parameterSetSizeOut: nil,
                parameterSetCountOut: &count, nalUnitHeaderLengthOut: nil)
        }
        for i in 0..<count {
            var ptr: UnsafePointer<UInt8>?
            var size = 0
            let status: OSStatus = codec == .hevc
                ? CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(fmt, parameterSetIndex: i,
                    parameterSetPointerOut: &ptr, parameterSetSizeOut: &size,
                    parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil)
                : CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, parameterSetIndex: i,
                    parameterSetPointerOut: &ptr, parameterSetSizeOut: &size,
                    parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil)
            guard status == noErr, let ptr else { continue }
            out.append(startCode)
            out.append(Data(bytes: ptr, count: size))
        }
        return out
    }

    deinit {
        stop()
    }
}
