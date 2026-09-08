import Foundation

// The controller wire session, owned by native code so the phone's JavaScript
// thread can stall (JPEG decode, React work, GC) without the host ever going
// quiet. The host closes the pad after 2 s of silence and neutralizes every
// held key, and an 8 ms JS setInterval routinely missed that window under the
// screen stream. Here the timer, the encoder and the socket all live on a
// background dispatch queue; JS only feeds state in and receives text messages.

/// One full controller sample. Mirrors GamepadState in app/src/gamepad/codec.ts.
struct GamepadSample: Equatable {
    var buttons: Int = 0
    var lt: Double = 0, rt: Double = 0
    var lx: Double = 0, ly: Double = 0, rx: Double = 0, ry: Double = 0
    static let neutral = GamepadSample()

    /// Builds a sample from a JS dictionary, refusing anything out of range so
    /// a bad value never reaches the wire (the host rejects malformed frames by
    /// closing the session, which would look like a dropped controller).
    init?(dictionary: [String: Any]) {
        guard let buttons = dictionary["buttons"] as? Int, (0...65535).contains(buttons) else { return nil }
        func axis(_ key: String, _ range: ClosedRange<Double>) -> Double? {
            guard let value = dictionary[key] as? Double, value.isFinite, range.contains(value) else { return nil }
            return value
        }
        guard let lt = axis("lt", 0...1), let rt = axis("rt", 0...1),
              let lx = axis("lx", -1...1), let ly = axis("ly", -1...1),
              let rx = axis("rx", -1...1), let ry = axis("ry", -1...1) else { return nil }
        self.init(buttons: buttons, lt: lt, rt: rt, lx: lx, ly: ly, rx: rx, ry: ry)
    }
    init(buttons: Int, lt: Double, rt: Double, lx: Double, ly: Double, rx: Double, ry: Double) {
        self.buttons = buttons; self.lt = lt; self.rt = rt
        self.lx = lx; self.ly = ly; self.rx = rx; self.ry = ry
    }
    init() {}
}

/// Byte-for-byte the encoder in app/src/gamepad/codec.ts (version 1, 17 bytes,
/// little endian). JavaScript's Math.round rounds halves toward +infinity, so
/// `floor(x + 0.5)` is used rather than Swift's `rounded()` (halves away from
/// zero) — the golden vector in codec.test.mjs pins both sides:
///   {buttons:0x1234, lt:0.5, rt:1, lx:-0.25, ly:0.75, rx:-1, ry:0, seq:0xDEADBEEF}
///   → 01 34 12 80 FF 00 E0 FF 5F 00 80 00 00 EF BE AD DE
enum GamepadWire {
    static let frameLength = 17
    static func encode(_ s: GamepadSample, seq: UInt32) -> Data {
        var out = Data(count: frameLength)
        let jsRound: (Double) -> Int = { Int((($0) + 0.5).rounded(.down)) }
        let axisWord: (Double) -> Int16 = { axis in
            Int16(clamping: jsRound(axis * (axis < 0 ? 32768 : 32767)))
        }
        out[0] = 1
        out[1] = UInt8(s.buttons & 0xff); out[2] = UInt8((s.buttons >> 8) & 0xff)
        out[3] = UInt8(clamping: jsRound(s.lt * 255)); out[4] = UInt8(clamping: jsRound(s.rt * 255))
        for (i, axis) in [s.lx, s.ly, s.rx, s.ry].enumerated() {
            let word = UInt16(bitPattern: axisWord(axis))
            out[5 + i * 2] = UInt8(word & 0xff); out[6 + i * 2] = UInt8(word >> 8)
        }
        for i in 0..<4 { out[13 + i] = UInt8((seq >> (8 * UInt32(i))) & 0xff) }
        return out
    }
}

/// The newest state from every source, readable from any queue. The sampler
/// (main thread) writes the physical pad, JS writes touch/mode/suppression,
/// and the session's timer reads whichever the policy selects.
final class GamepadStateStore {
    private let lock = NSLock()
    private var physical = GamepadSample.neutral
    private var touch = GamepadSample.neutral
    private var physicalConnected = false
    private var usePhysicalWhenConnected = true   // 'auto'; false = 'phone'
    private var suppressed = false

    func setPhysical(_ sample: GamepadSample) { lock.lock(); physical = sample; lock.unlock() }
    func setTouch(_ sample: GamepadSample) { lock.lock(); touch = sample; lock.unlock() }
    func setPhysicalConnected(_ connected: Bool) {
        lock.lock(); physicalConnected = connected; if !connected { physical = .neutral }; lock.unlock()
    }
    /// Mirrors usesPhysicalController in app/src/gamepad/session-policy.ts.
    func setInputMode(_ mode: String) {
        lock.lock(); usePhysicalWhenConnected = mode != "phone"; physical = .neutral; touch = .neutral; lock.unlock()
    }
    func setSuppressed(_ value: Bool) { lock.lock(); suppressed = value; lock.unlock() }
    func resetInputs() { lock.lock(); physical = .neutral; touch = .neutral; lock.unlock() }

    /// What goes on the wire this tick.
    func selected() -> GamepadSample {
        lock.lock(); defer { lock.unlock() }
        if suppressed { return .neutral }
        return usePhysicalWhenConnected && physicalConnected ? physical : touch
    }
}

/// One WebSocket to /ws/gamepad plus the 8 ms send loop. Everything happens on
/// `queue`; the two callbacks are invoked there too, and the module hops them
/// to JS.
final class GamepadSession {
    private static let tickInterval: DispatchTimeInterval = .milliseconds(8)
    /// Sends still waiting on URLSession. The host reads at 4 ms, so a backlog
    /// means the link is stalling; sending more would only queue stale state.
    private static let maxInFlight = 2

    private let queue = DispatchQueue(label: "belay.gamepad.session", qos: .userInteractive)
    private let store: GamepadStateStore
    private let onMessage: (String) -> Void
    private let onClose: (Int, String) -> Void
    private var task: URLSessionWebSocketTask?
    private var timer: DispatchSourceTimer?
    private var seq: UInt32 = 0
    private var inFlight = 0
    private var closed = false

    init(store: GamepadStateStore, onMessage: @escaping (String) -> Void, onClose: @escaping (Int, String) -> Void) {
        self.store = store; self.onMessage = onMessage; self.onClose = onClose
    }

    func start(url: URL) {
        queue.async {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.waitsForConnectivity = false
            let session = URLSession(configuration: configuration)
            let task = session.webSocketTask(with: url)
            task.maximumMessageSize = 64 * 1024
            self.task = task
            task.resume()
            self.receive(task)
            let timer = DispatchSource.makeTimerSource(queue: self.queue)
            timer.schedule(deadline: .now(), repeating: GamepadSession.tickInterval, leeway: .milliseconds(1))
            timer.setEventHandler { [weak self] in self?.tick() }
            timer.resume()
            self.timer = timer
        }
    }

    /// A last neutral frame so the host releases every key, then a clean close.
    func stop() {
        queue.async {
            guard !self.closed else { return }
            self.closed = true
            self.timer?.cancel(); self.timer = nil
            guard let task = self.task else { return }
            task.send(.data(GamepadWire.encode(.neutral, seq: self.seq))) { _ in
                task.cancel(with: .normalClosure, reason: nil)
            }
            self.task = nil
        }
    }

    private func tick() {
        guard !closed, let task = task, task.state == .running, inFlight < GamepadSession.maxInFlight else { return }
        let frame = GamepadWire.encode(store.selected(), seq: seq)
        seq &+= 1
        inFlight += 1
        task.send(.data(frame)) { [weak self] error in
            guard let self = self else { return }
            self.queue.async {
                self.inFlight -= 1
                if error != nil { self.finish(task, code: 1006, reason: "send failed") }
            }
        }
    }

    private func receive(_ task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            guard let self = self else { return }
            self.queue.async {
                guard !self.closed, self.task === task else { return }
                switch result {
                case .success(.string(let text)):
                    self.onMessage(text)
                    self.receive(task)
                case .success:
                    // The host never sends binary to the phone; ignore and keep listening.
                    self.receive(task)
                case .failure:
                    let code = task.closeCode == .invalid ? 1006 : task.closeCode.rawValue
                    let reason = task.closeReason.flatMap { String(data: $0, encoding: .utf8) } ?? ""
                    self.finish(task, code: code, reason: reason)
                }
            }
        }
    }

    private func finish(_ task: URLSessionWebSocketTask, code: Int, reason: String) {
        guard !closed else { return }
        closed = true
        timer?.cancel(); timer = nil
        task.cancel(with: .abnormalClosure, reason: nil)
        self.task = nil
        onClose(code, reason)
    }
}
