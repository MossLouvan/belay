// VideoToolbox H.264/HEVC low-latency encoder for the WebRTC slice.
//
// ┌─ STATUS: WRITTEN-BUT-HARDWARE-GATED ────────────────────────────────────┐
// │ This is written to the correct VideoToolbox API shape but has NOT been   │
// │ compiled or measured — it needs a real Mac GPU and the libdatachannel    │
// │ transport (server/native/mac/transport/) it feeds. Do NOT treat any of   │
// │ it as verified until the runbook in docs/WEBRTC-SLICE.md produces a       │
// │ glass-to-glass number (milestone M3). The encode-latency and             │
// │ bitrate-tracking numbers in the plan are TARGETS, not measurements.      │
// └──────────────────────────────────────────────────────────────────────────┘
//
// Design: one long-lived VTCompressionSession fed the CVPixelBuffers that
// Capture.swift's SCStream already produces. Configured for interactive
// streaming, NOT file encoding:
//   - RealTime = true                 (favour latency over ratio)
//   - AllowFrameReordering = false    (no B-frames — one would add a whole
//                                       frame of latency waiting for the next)
//   - large MaxKeyFrameInterval + explicit forced keyframes on demand instead
//     of frequent periodic IDR (a full keyframe is a bandwidth spike that
//     stalls a constrained uplink)
//   - AverageBitRate + DataRateLimits driven by the congestion controller
//     (congestion.ts) so the encoder tracks the ABR setpoint
//   - low-latency rate control on Apple silicon when available
//
// Output NAL units are converted to Annex-B (start-code framed) with the cached
// SPS/PPS (or VPS/SPS/PPS for HEVC) prepended to every IDR, and handed to the
// transport with the capture timestamp attached — which is what latency.ts needs
// for glass-to-glass accounting.

import CoreMedia
import CoreVideo
import Foundation
import VideoToolbox

/// Callback receiving one encoded frame: the Annex-B bytes, whether it is a
/// keyframe, and the capture presentation timestamp for latency accounting.
typealias EncodedFrameHandler = (_ data: Data, _ isKeyframe: Bool, _ ptsMs: Double) -> Void

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
    private var session: VTCompressionSession?
    private let width: Int32
    private let height: Int32
    private let codec: VideoCodec
    private let onFrame: EncodedFrameHandler

    /// Cached parameter sets (SPS/PPS for H.264; VPS/SPS/PPS for HEVC), read from
    /// the first keyframe's format description and prepended, Annex-B framed, to
    /// every IDR so a decoder that joined late (or after loss) can resync.
    private var parameterSetsAnnexB: Data?

    /// Set by requestKeyframe(); consumed on the next encode() to force an IDR.
    private var forceKeyframeNext = false
    private let lock = NSLock()

    init(width: Int32, height: Int32, codec: VideoCodec = .h264, onFrame: @escaping EncodedFrameHandler) throws {
        self.width = width
        self.height = height
        self.codec = codec
        self.onFrame = onFrame
        try makeSession()
    }

    private func makeSession() throws {
        var encoderSpec: CFDictionary?
        #if arch(arm64)
        // Apple silicon: ask for the low-latency rate controller — it is the one
        // that actually hits the interactive-streaming latency band.
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
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
        let profile = codec == .hevc ? kVTProfileLevel_HEVC_Main_AutoLevel : kVTProfileLevel_H264_Main_AutoLevel
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ProfileLevel, value: profile)
        // Large interval: we drive IDRs explicitly (join / unrecoverable loss)
        // rather than paying a periodic full-frame spike.
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: 600 as CFNumber)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, value: 5 as CFNumber)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: 60 as CFNumber)

        VTCompressionSessionPrepareToEncodeFrames(session)
        self.session = session
    }

    /// Apply an adaptive-bitrate setpoint (bits/sec) from the congestion
    /// controller. AverageBitRate is the target; DataRateLimits caps the burst
    /// so a single interval cannot blow the uplink budget (bytes-per-window).
    func setBitrate(_ bitsPerSecond: Int) {
        guard let session, bitsPerSecond > 0 else { return }
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AverageBitRate, value: bitsPerSecond as CFNumber)
        // Cap the peak at ~1.5x average over a one-second window.
        let bytesPerWindow = Int(Double(bitsPerSecond) * 1.5 / 8.0)
        let limits = [bytesPerWindow, 1] as CFArray // [bytes, seconds]
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_DataRateLimits, value: limits)
    }

    /// Encode one captured frame. `ptsMs` is the host capture time in ms; it
    /// rides through to the encoded-frame handler for glass-to-glass timing.
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

        VTCompressionSessionEncodeFrame(
            session, imageBuffer: pixelBuffer, presentationTimeStamp: pts,
            duration: .invalid, frameProperties: frameProperties, infoFlagsOut: nil
        ) { [weak self] status, _, sampleBuffer in
            guard status == noErr, let sampleBuffer, let self else { return }
            self.emit(sampleBuffer, ptsMs: ptsMs)
        }
    }

    /// Force the next frame to be an IDR — used on a new client join or a
    /// decoder-reported loss (PLI/FIR) the FEC/NACK could not repair.
    func requestKeyframe() {
        lock.lock()
        forceKeyframeNext = true
        lock.unlock()
    }

    // ── NAL extraction: AVCC (length-prefixed) -> Annex-B (start codes) ───────

    private static let startCode = Data([0x00, 0x00, 0x00, 0x01])

    private func emit(_ sampleBuffer: CMSampleBuffer, ptsMs: Double) {
        let isKeyframe = Self.isKeyframe(sampleBuffer)

        // On a keyframe, (re)read and cache the parameter sets from the format
        // description so every IDR carries them for late/lossy decoders.
        if isKeyframe, let fmt = CMSampleBufferGetFormatDescription(sampleBuffer) {
            parameterSetsAnnexB = Self.parameterSetsAnnexB(from: fmt, codec: codec)
        }

        guard let block = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }
        var totalLength = 0
        var pointer: UnsafeMutablePointer<Int8>?
        guard CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil,
                                          totalLengthOut: &totalLength, dataPointerOut: &pointer) == noErr,
              let pointer else { return }

        var annexB = Data()
        if isKeyframe, let params = parameterSetsAnnexB {
            annexB.append(params)
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
            guard len > 0, offset + len <= totalLength else { break }
            annexB.append(Self.startCode)
            annexB.append(Data(bytes: bytes + offset, count: len))
            offset += len
        }

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
        if let session { VTCompressionSessionInvalidate(session) }
    }
}
