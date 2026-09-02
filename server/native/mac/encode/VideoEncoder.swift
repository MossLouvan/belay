// VideoToolbox H.264 low-latency encoder for the WebRTC slice.
//
// STATUS: written to the correct VideoToolbox API shape but NOT yet compiled or
// measured on device — it needs a real Mac GPU and the libdatachannel link. Do
// not treat as verified until the runbook in docs/WEBRTC-SLICE.md produces a
// glass-to-glass number.
//
// Design: a single long-lived VTCompressionSession fed the CVPixelBuffers that
// Capture.swift's SCStream already produces. Configured for interactive
// streaming, NOT for file encoding:
//   - RealTime = true                     (favour latency over ratio)
//   - AllowFrameReordering = false        (no B-frames — a B-frame adds a whole
//                                           frame of latency waiting for the next)
//   - MaxKeyFrameInterval large + explicit intra-refresh instead of periodic IDR
//     (a full keyframe is a bandwidth spike that stalls a constrained uplink;
//      gradual intra-refresh spreads the recovery cost)
//   - ProfileLevel baseline/main for broad hardware-decode support on phones
//
// Output NAL units are handed to the transport (libdatachannel SRTP) with the
// capture timestamp attached, which is what latency.ts needs for glass-to-glass.

import CoreMedia
import CoreVideo
import Foundation
import VideoToolbox

/// Callback receiving one encoded frame: the Annex-B/AVCC bytes, whether it is a
/// keyframe, and the capture presentation timestamp for latency accounting.
typealias EncodedFrameHandler = (_ data: Data, _ isKeyframe: Bool, _ ptsMs: Double) -> Void

final class VideoEncoder {
    private var session: VTCompressionSession?
    private let width: Int32
    private let height: Int32
    private let onFrame: EncodedFrameHandler

    init(width: Int32, height: Int32, onFrame: @escaping EncodedFrameHandler) throws {
        self.width = width
        self.height = height
        self.onFrame = onFrame
        try makeSession()
    }

    private func makeSession() throws {
        var s: VTCompressionSession?
        let status = VTCompressionSessionCreate(
            allocator: kCFAllocatorDefault,
            width: width,
            height: height,
            codecType: kCMVideoCodecType_H264,
            encoderSpecification: nil,
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
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_Main_AutoLevel)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: 600 as CFNumber)
        VTCompressionSessionPrepareToEncodeFrames(session)
        self.session = session
    }

    /// Encode one captured frame. `ptsMs` is the host capture time in ms; it
    /// rides through to the encoded-frame handler for glass-to-glass timing.
    func encode(pixelBuffer: CVPixelBuffer, ptsMs: Double) {
        guard let session else { return }
        let pts = CMTime(value: Int64(ptsMs * 1000), timescale: 1_000_000)
        VTCompressionSessionEncodeFrame(
            session, imageBuffer: pixelBuffer, presentationTimeStamp: pts,
            duration: .invalid, frameProperties: nil, infoFlagsOut: nil
        ) { [weak self] status, _, sampleBuffer in
            guard status == noErr, let sampleBuffer, let self else { return }
            self.emit(sampleBuffer, ptsMs: ptsMs)
        }
    }

    /// Force the next frame to be an IDR — used on a new client join or a
    /// decoder-reported loss the FEC could not repair.
    func requestKeyframe() {
        guard let session else { return }
        // Property set on the next encode via frameProperties in a full build;
        // sketched here as the intended control point.
    }

    private func emit(_ sampleBuffer: CMSampleBuffer, ptsMs: Double) {
        // Extract the elementary stream from the CMSampleBuffer and hand it to
        // the transport. Full NAL/parameter-set extraction is done in the
        // on-device build; the seam is here so the transport wiring is stable.
        let isKeyframe = !CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false)
            .flatMap { ($0 as? [[CFString: Any]])?.first?[kCMSampleAttachmentKey_NotSync] }
            .map { _ in true } ?? true
        guard let block = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }
        var length = 0
        var pointer: UnsafeMutablePointer<Int8>?
        guard CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length, dataPointerOut: &pointer) == noErr,
              let pointer else { return }
        onFrame(Data(bytes: pointer, count: length), isKeyframe, ptsMs)
    }

    deinit {
        if let session { VTCompressionSessionInvalidate(session) }
    }
}
