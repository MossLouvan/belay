import CoreMedia
import Foundation
import VideoToolbox

/// Turns the host's Annex-B H.264 into sample buffers a display layer can show.
///
/// This is the one genuinely fiddly piece of the client, and it is fiddly for a
/// specific reason: the wire carries Annex-B (NALs separated by `00 00 00 01`
/// start codes, which is what every encoder emits and what streams over a
/// network), while Core Media wants AVCC (each NAL prefixed by its 4-byte
/// length, with the SPS and PPS lifted out into a format description). They
/// carry the same bytes in a different frame. Feeding Annex-B straight to
/// VideoToolbox does not error — it produces nothing, which is the worst
/// possible failure mode because it looks exactly like a network problem.
///
/// So: split on start codes, keep SPS/PPS aside to build the format
/// description, and rewrite the rest with length prefixes.
final class H264Stream {
    private var formatDescription: CMVideoFormatDescription?
    private var sps: [UInt8]?
    private var pps: [UInt8]?
    /// Monotonic frame counter, used only to give each sample a distinct
    /// timestamp.
    private var frameIndex: Int64 = 0
    private let fps: Int32

    init(fps: Int32 = 60) {
        self.fps = max(1, fps)
    }

    /// True once an SPS and PPS have been seen and a decoder could start.
    var isReady: Bool { formatDescription != nil }

    /// Split an Annex-B buffer into its NAL units.
    ///
    /// Handles both 3-byte and 4-byte start codes: encoders mix them within a
    /// single access unit, and a parser that assumes one length silently
    /// swallows every NAL that used the other.
    static func nalUnits(in data: UnsafeRawBufferPointer) -> [Range<Int>] {
        var ranges: [Range<Int>] = []
        let n = data.count
        guard n >= 4 else { return ranges }

        func startCodeLength(at i: Int) -> Int? {
            guard i + 3 <= n else { return nil }
            if data[i] == 0 && data[i + 1] == 0 {
                if data[i + 2] == 1 { return 3 }
                if i + 4 <= n && data[i + 2] == 0 && data[i + 3] == 1 { return 4 }
            }
            return nil
        }

        var i = 0
        var currentStart: Int? = nil
        while i < n {
            if let len = startCodeLength(at: i) {
                if let start = currentStart, start < i {
                    ranges.append(start..<i)
                }
                i += len
                currentStart = i
            } else {
                i += 1
            }
        }
        if let start = currentStart, start < n {
            ranges.append(start..<n)
        }
        return ranges
    }

    /// Feed one received frame. Returns a sample buffer to display, or nil when
    /// the frame carried only parameter sets, or when no format description has
    /// been established yet.
    ///
    /// Returning nil for a frame that arrives before the first SPS is correct
    /// and expected: a client that joins mid-stream must wait for a keyframe,
    /// and the host sends one on request.
    func decode(_ payload: UnsafeRawBufferPointer) -> CMSampleBuffer? {
        let units = Self.nalUnits(in: payload)
        guard !units.isEmpty else { return nil }

        var vcl: [[UInt8]] = []
        var sawNewParameterSet = false

        for range in units {
            guard range.count > 0 else { continue }
            let type = payload[range.lowerBound] & 0x1F
            let bytes = [UInt8](UnsafeRawBufferPointer(rebasing: payload[range]))
            switch type {
            case 7: // SPS
                if sps != bytes { sps = bytes; sawNewParameterSet = true }
            case 8: // PPS
                if pps != bytes { pps = bytes; sawNewParameterSet = true }
            case 9, 12: // access unit delimiter, filler — carry no picture
                continue
            default:
                vcl.append(bytes)
            }
        }

        // Rebuild the format description whenever the parameter sets change.
        // The host can change resolution mid-session (a virtual display being
        // created), and keeping a stale description shows a torn picture rather
        // than failing visibly.
        if sawNewParameterSet, let sps, let pps {
            formatDescription = Self.makeFormatDescription(sps: sps, pps: pps)
        }

        guard let formatDescription, !vcl.isEmpty else { return nil }

        // AVCC: each NAL prefixed by its big-endian 4-byte length.
        var avcc: [UInt8] = []
        avcc.reserveCapacity(vcl.reduce(0) { $0 + $1.count + 4 })
        for nal in vcl {
            let len = UInt32(nal.count).bigEndian
            withUnsafeBytes(of: len) { avcc.append(contentsOf: $0) }
            avcc.append(contentsOf: nal)
        }

        var blockBuffer: CMBlockBuffer?
        let status = avcc.withUnsafeMutableBytes { raw -> OSStatus in
            CMBlockBufferCreateWithMemoryBlock(
                allocator: kCFAllocatorDefault,
                memoryBlock: raw.baseAddress,
                blockLength: raw.count,
                blockAllocator: kCFAllocatorNull, // we copy below; do not free ours
                customBlockSource: nil,
                offsetToData: 0,
                dataLength: raw.count,
                flags: 0,
                blockBufferOut: &blockBuffer
            )
        }
        guard status == noErr, let blockBuffer else { return nil }

        // The block buffer above points at `avcc`, which is about to go out of
        // scope. Copy the bytes into the buffer so the sample owns them —
        // without this the layer reads freed memory, intermittently, under
        // load.
        var owned: CMBlockBuffer?
        guard CMBlockBufferCreateContiguous(
            allocator: kCFAllocatorDefault,
            sourceBuffer: blockBuffer,
            blockAllocator: kCFAllocatorDefault,
            customBlockSource: nil,
            offsetToData: 0,
            dataLength: 0,
            flags: kCMBlockBufferAlwaysCopyDataFlag,
            blockBufferOut: &owned
        ) == noErr, let owned else { return nil }

        var timing = CMSampleTimingInfo(
            duration: CMTimeMake(value: 1, timescale: fps),
            presentationTimeStamp: CMTimeMake(value: frameIndex, timescale: fps),
            decodeTimeStamp: .invalid
        )
        frameIndex += 1

        var sampleSize = CMBlockBufferGetDataLength(owned)
        var sampleBuffer: CMSampleBuffer?
        guard CMSampleBufferCreateReady(
            allocator: kCFAllocatorDefault,
            dataBuffer: owned,
            formatDescription: formatDescription,
            sampleCount: 1,
            sampleTimingEntryCount: 1,
            sampleTimingArray: &timing,
            sampleSizeEntryCount: 1,
            sampleSizeArray: &sampleSize,
            sampleBufferOut: &sampleBuffer
        ) == noErr, let sampleBuffer else { return nil }

        // Display immediately. The default is to schedule against a clock we
        // are not driving, which on a live stream shows up as growing latency
        // that never recovers.
        if let attachments = CMSampleBufferGetSampleAttachmentsArray(
            sampleBuffer, createIfNecessary: true
        ) {
            let dict = unsafeBitCast(
                CFArrayGetValueAtIndex(attachments, 0),
                to: CFMutableDictionary.self
            )
            CFDictionarySetValue(
                dict,
                Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(),
                Unmanaged.passUnretained(kCFBooleanTrue).toOpaque()
            )
        }
        return sampleBuffer
    }

    private static func makeFormatDescription(sps: [UInt8], pps: [UInt8]) -> CMVideoFormatDescription? {
        var description: CMVideoFormatDescription?
        let result = sps.withUnsafeBufferPointer { spsPtr in
            pps.withUnsafeBufferPointer { ppsPtr -> OSStatus in
                let pointers = [spsPtr.baseAddress!, ppsPtr.baseAddress!]
                let sizes = [sps.count, pps.count]
                return pointers.withUnsafeBufferPointer { p in
                    sizes.withUnsafeBufferPointer { s in
                        CMVideoFormatDescriptionCreateFromH264ParameterSets(
                            allocator: kCFAllocatorDefault,
                            parameterSetCount: 2,
                            parameterSetPointers: p.baseAddress!,
                            parameterSetSizes: s.baseAddress!,
                            nalUnitHeaderLength: 4,
                            formatDescriptionOut: &description
                        )
                    }
                }
            }
        }
        return result == noErr ? description : nil
    }
}
