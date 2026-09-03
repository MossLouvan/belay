// System-audio capture via ScreenCaptureKit — the driverless loopback path.
//
// STATUS: COMPILES (build-mac.sh, Swift 6 toolchain) BUT NOT RUNTIME-VERIFIED.
// Nobody has heard audio out of this stream yet; treat it as API-shape-correct
// until the runbook in docs/AUDIO.md produces sound on a phone.
//
// Why ScreenCaptureKit and not a virtual audio driver: `capturesAudio`
// (macOS 13+) taps the system mix directly and rides the SAME TCC grant the
// screen path already holds — the checkbox macOS names "Screen & System Audio
// Recording". No kernel extension, no HAL plug-in to install, no second
// permission prompt. BlackHole (the well-known HAL driver) is GPL-3 and cannot
// be linked or forked into this codebase; CoreAudio process taps
// (CATapDescription, macOS 14.2+) are the likely future path for the
// mic-to-host direction but need their own audio-capture TCC prompt, so for
// host-to-phone system audio SCK is strictly cheaper. See docs/AUDIO.md.
//
// Why a SEPARATE audio-only SCStream instead of `capturesAudio` on the
// DisplayStream in Capture.swift: audio must keep flowing when no JPEG capture
// is being polled, and the screen streams restart on resolution change /
// stall-healing (restartFrameSeconds) — every restart would be an audible
// dropout. A dedicated stream has neither problem, and leaves the shipping
// JPEG path byte-for-byte untouched. The cost is one extra SCStream, whose
// video side is configured to the minimum ScreenCaptureKit accepts and whose
// screen frames are simply never read.
//
// Output: 20 ms frames, 48 kHz interleaved stereo s16le, pushed as one
// `{"type":"audio","seq":…,"ts":…,"codec":"pcm16","data":<base64>}` line per
// frame (the shape server/src/audio.ts validates). PCM16 stereo is 192 KB/s —
// fine over the stdio pipe and the LAN interim socket, and the `codec` field
// is how Opus arrives later without a wire change: when a vendored libopus is
// linked (BELAY_HAVE_OPUS, the same vendoring pattern as libdatachannel),
// the accumulator below feeds opus_encode_float instead of Int16 conversion
// and the line says "opus".

import CoreMedia
import Foundation
import ScreenCaptureKit

/// One capture session of the whole system's audio output.
final class SystemAudioCapture: NSObject, SCStreamOutput, SCStreamDelegate {
    static let sampleRate = 48_000
    static let channels = 2
    /// 20 ms at 48 kHz — one wire frame, matching AUDIO_FRAME_MS everywhere.
    static let samplesPerFrame = 960
    private static let startTimeout: TimeInterval = 5
    private static let shareableContentTimeout: TimeInterval = 5

    private let replies: ReplyWriter
    private let queue = DispatchQueue(label: "belay.audio", qos: .userInitiated)

    // All mutable state below is touched only on `queue` (the SCStream sample
    // handler queue) or under `lock` from the command loop.
    private let lock = NSLock()
    private var stream: SCStream?
    private var stopReason: String?

    /// Interleaved samples waiting to fill the next 20 ms frame (on `queue`).
    private var pending: [Int16] = []
    /// u16 wire sequence number; wraps.
    private var seq: UInt16 = 0
    /// u32 sample timestamp at 48 kHz; wraps. The receiver's playout clock.
    private var timestamp: UInt32 = 0

    init(replies: ReplyWriter) {
        self.replies = replies
        super.init()
    }

    var isCapturing: Bool {
        lock.lock(); defer { lock.unlock() }
        return stream != nil
    }

    /// Starts the system-audio stream. Idempotent: starting while running is a
    /// no-op success, so a second listener does not restart capture underneath
    /// the first.
    func start() throws {
        try Permissions.require(.screenRecording)
        lock.lock()
        if stream != nil { lock.unlock(); return }
        lock.unlock()

        // Any display anchors the filter; the audio is the system mix either way.
        var displays: [SCDisplay] = []
        try runBlocking(timeout: Self.shareableContentTimeout, label: "enumerate shareable content for audio") { done in
            SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { content, error in
                if let content { displays = content.displays }
                done(error)
            }
        }
        guard let display = displays.first else {
            throw HostError(.capture, "no shareable display to anchor the audio stream")
        }

        let config = SCStreamConfiguration()
        config.capturesAudio = true
        // The helper must never hear itself: excluding our own process's audio
        // prevents a feedback loop if the host ever plays remote audio locally.
        config.excludesCurrentProcessAudio = true
        config.sampleRate = Self.sampleRate
        config.channelCount = Self.channels
        // The video side of this stream is never read; keep it as cheap as
        // ScreenCaptureKit allows.
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        config.queueDepth = 3

        let filter = SCContentFilter(display: display, excludingWindows: [])
        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        do {
            try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
        } catch {
            throw HostError(.capture, "could not attach audio output: \(error.localizedDescription)")
        }

        lock.lock()
        self.stream = stream
        self.stopReason = nil
        lock.unlock()
        queue.sync {
            self.pending = []
            // A fresh capture keeps growing seq/timestamp rather than resetting:
            // a same-session restart must not look like a brand-new stream to a
            // receiver mid-playout. (A helper restart naturally starts at 0.)
        }

        do {
            try runBlocking(timeout: Self.startTimeout, label: "start audio capture") { done in
                stream.startCapture { error in done(error) }
            }
        } catch {
            lock.lock(); self.stream = nil; lock.unlock()
            throw error
        }
    }

    func stop() {
        lock.lock()
        let running = stream
        stream = nil
        lock.unlock()
        running?.stopCapture(completionHandler: { _ in })
        queue.sync { self.pending = [] }
    }

    var lastStopReason: String? {
        lock.lock(); defer { lock.unlock() }
        return stopReason
    }

    // MARK: - SCStreamOutput (called on `queue`)

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, CMSampleBufferIsValid(sampleBuffer) else { return }
        guard let format = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee
        else { return }

        // ScreenCaptureKit delivers float32, one AudioBuffer per channel
        // (non-interleaved) at the configured rate. Anything else is skipped
        // rather than guessed at — a wrong-format frame played as s16 is a
        // deafening burst of noise.
        guard asbd.mFormatID == kAudioFormatLinearPCM,
              asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0,
              Int(asbd.mSampleRate) == Self.sampleRate
        else { return }

        try? sampleBuffer.withAudioBufferList { audioBufferList, _ in
            let buffers = Array(audioBufferList)
            if ProcessInfo.processInfo.environment["BELAY_AUDIO_DEBUG"] != nil {
                let peek = buffers.first?.mData?.assumingMemoryBound(to: Float32.self)
                let sample = peek.map { String($0[0]) } ?? "nil"
                FileHandle.standardError.write(Data("audio buf: n=\(buffers.count) ch=\(asbd.mChannelsPerFrame) flags=\(asbd.mFormatFlags) bytes=\(buffers.first?.mDataByteSize ?? 0) s0=\(sample)\n".utf8))
            }
            guard let first = buffers.first, let firstData = first.mData else { return }
            let frameCount = Int(first.mDataByteSize) / MemoryLayout<Float32>.size

            // Interleave to stereo. Mono duplicates; >2ch takes the first two.
            var interleaved = [Int16](repeating: 0, count: frameCount * Self.channels)
            let left = firstData.assumingMemoryBound(to: Float32.self)
            let right: UnsafeMutablePointer<Float32>
            if buffers.count >= 2, let secondData = buffers[1].mData {
                right = secondData.assumingMemoryBound(to: Float32.self)
            } else {
                right = left
            }
            for i in 0..<frameCount {
                interleaved[i * 2] = Self.clampToInt16(left[i])
                interleaved[i * 2 + 1] = Self.clampToInt16(right[i])
            }
            self.pending.append(contentsOf: interleaved)
        }

        emitCompleteFrames()
    }

    // MARK: - SCStreamDelegate

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        lock.lock()
        stopReason = error.localizedDescription
        self.stream = nil
        lock.unlock()
        // Node learns capture died from `audiostatus` (and silence); pushing an
        // error line here would race the reply protocol for no benefit.
    }

    // MARK: - Framing (on `queue`)

    private func emitCompleteFrames() {
        let samplesPerWireFrame = Self.samplesPerFrame * Self.channels
        while pending.count >= samplesPerWireFrame {
            let frame = Array(pending.prefix(samplesPerWireFrame))
            pending.removeFirst(samplesPerWireFrame)

            // s16le regardless of host endianness (every Apple platform is
            // little-endian, but the wire contract says little-endian, not
            // "host order").
            var data = Data(capacity: frame.count * 2)
            for sample in frame {
                let le = UInt16(bitPattern: sample).littleEndian
                data.append(UInt8(truncatingIfNeeded: le))
                data.append(UInt8(truncatingIfNeeded: le >> 8))
            }

            replies.push([
                "type": "audio",
                "seq": Int(seq),
                "ts": Int(timestamp),
                "codec": "pcm16",
                "sr": Self.sampleRate,
                "ch": Self.channels,
                "data": data.base64EncodedString(),
            ])
            seq &+= 1
            timestamp &+= UInt32(Self.samplesPerFrame)
        }
    }

    private static func clampToInt16(_ value: Float32) -> Int16 {
        let scaled = value * 32767.0
        if scaled >= 32767.0 { return 32767 }
        if scaled <= -32768.0 { return -32768 }
        return Int16(scaled)
    }
}
