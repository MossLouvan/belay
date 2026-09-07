import ExpoModulesCore
import GameController
import CoreHaptics
import UIKit
import QuartzCore

public final class BelayGamepadModule: Module {
    private var sampler: ControllerSampler?
    public func definition() -> ModuleDefinition {
        Name("BelayGamepad")
        Events("onState", "onConnection")
        AsyncFunction("start") { () -> [String: Any] in
            if self.sampler == nil {
                self.sampler = ControllerSampler { [weak self] name, payload in self?.sendEvent(name, payload) }
            }
            self.sampler?.start()
            return self.sampler?.connection() ?? ["connected": false]
        }.runOnQueue(.main)
        AsyncFunction("stop") { self.sampler?.stop() }.runOnQueue(.main)
        AsyncFunction("rumble") { (low: Double, high: Double) in
            self.sampler?.rumble(low: low, high: high)
        }.runOnQueue(.main)
        OnDestroy {
            let sampler = self.sampler
            DispatchQueue.main.async { sampler?.stop() }
        }
    }
}

private final class ControllerSampler: NSObject {
    private let emit: (String, [String: Any]) -> Void
    private var controller: GCController?
    private var observers: [NSObjectProtocol] = []
    private var displayLink: CADisplayLink?
    private var dirty = true
    private var oldBackground = false
    private var oldIdleDisabled = false
    private var engines: [GCHapticsLocality: CHHapticEngine] = [:]
    private var players: [GCHapticsLocality: CHHapticAdvancedPatternPlayer] = [:]
    private var intensities: [GCHapticsLocality: Float] = [:]

    init(emit: @escaping (String, [String: Any]) -> Void) { self.emit = emit }
    func start() {
        guard displayLink == nil else { return }
        oldBackground = GCController.shouldMonitorBackgroundEvents
        GCController.shouldMonitorBackgroundEvents = true
        oldIdleDisabled = UIApplication.shared.isIdleTimerDisabled
        UIApplication.shared.isIdleTimerDisabled = true
        for name in [Notification.Name.GCControllerDidConnect, Notification.Name.GCControllerDidDisconnect] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                self?.selectController()
            })
        }
        selectController()
        let link = CADisplayLink(target: self, selector: #selector(sample))
        link.preferredFramesPerSecond = 120 // OS selects the supported display cadence
        link.add(to: .main, forMode: .common)
        displayLink = link
    }
    func stop() {
        guard displayLink != nil else { return }
        displayLink?.invalidate(); displayLink = nil
        observers.forEach { NotificationCenter.default.removeObserver($0) }; observers = []
        controller?.extendedGamepad?.valueChangedHandler = nil
        stopRumble(); controller = nil
        GCController.shouldMonitorBackgroundEvents = oldBackground
        UIApplication.shared.isIdleTimerDisabled = oldIdleDisabled
        emit("onConnection", connection())
    }
    func connection() -> [String: Any] {
        ["connected": controller != nil, "name": controller?.vendorName ?? "Controller"]
    }
    private func selectController() {
        let available = GCController.controllers().filter { $0.extendedGamepad != nil }
        if let selected = controller, available.contains(where: { $0 === selected }) { return }
        controller?.extendedGamepad?.valueChangedHandler = nil
        stopRumble()
        controller = available.first
        controller?.handlerQueue = .main
        controller?.extendedGamepad?.valueChangedHandler = { [weak self] _, _ in self?.dirty = true }
        dirty = true
        emit("onConnection", connection())
    }
    @objc private func sample() {
        guard dirty, let pad = controller?.extendedGamepad else { return }
        dirty = false
        var buttons = 0
        let values: [(GCControllerButtonInput?, Int)] = [
            (pad.dpad.up,1),(pad.dpad.down,2),(pad.dpad.left,4),(pad.dpad.right,8),
            (pad.buttonMenu,16),(pad.buttonOptions,32),(pad.leftThumbstickButton,64),(pad.rightThumbstickButton,128),
            (pad.leftShoulder,256),(pad.rightShoulder,512),
            (pad.buttonA,4096),(pad.buttonB,8192),(pad.buttonX,16384),(pad.buttonY,32768)
        ]
        for (button, mask) in values where button?.isPressed == true { buttons |= mask }
        emit("onState", ["buttons":buttons,"lt":pad.leftTrigger.value,"rt":pad.rightTrigger.value,
                         "lx":pad.leftThumbstick.xAxis.value,"ly":pad.leftThumbstick.yAxis.value,
                         "rx":pad.rightThumbstick.xAxis.value,"ry":pad.rightThumbstick.yAxis.value])
    }
    func rumble(low: Double, high: Double) {
        guard low.isFinite, high.isFinite, (0...1).contains(low), (0...1).contains(high),
              let haptics = controller?.haptics else { return }
        let localities = haptics.supportedLocalities
        if localities.contains(.leftHandle), localities.contains(.rightHandle) {
            play(haptics, .leftHandle, Float(low)); play(haptics, .rightHandle, Float(high))
        } else { play(haptics, .default, Float(max(low,high))) }
    }
    private func play(_ haptics: GCDeviceHaptics, _ locality: GCHapticsLocality, _ intensity: Float) {
        do {
            if intensities[locality] == intensity, players[locality] != nil { return }
            intensities[locality] = intensity
            if intensity == 0 { try players[locality]?.stop(atTime: CHHapticTimeImmediate); players[locality] = nil; return }
            let engine: CHHapticEngine
            if let existing = engines[locality] { engine = existing }
            else {
                guard let created = haptics.createEngine(withLocality: locality) else { return }
                engine = created; engines[locality] = engine
            }
            try engine.start()
            try players[locality]?.stop(atTime: CHHapticTimeImmediate)
            let event = CHHapticEvent(eventType: .hapticContinuous,
                parameters: [CHHapticEventParameter(parameterID: .hapticIntensity, value: intensity)], relativeTime: 0, duration: 1)
            let pattern = try CHHapticPattern(events: [event], parameters: [])
            let player = try engine.makeAdvancedPlayer(with: pattern)
            player.loopEnabled = true
            try player.start(atTime: CHHapticTimeImmediate)
            players[locality] = player
        } catch {
            // Haptics are optional; input keeps running after a motor/engine failure.
            players[locality] = nil; engines[locality] = nil
        }
    }
    private func stopRumble() {
        for player in players.values { try? player.stop(atTime: CHHapticTimeImmediate) }
        for engine in engines.values { engine.stop(completionHandler: nil) }
        players = [:]; engines = [:]; intensities = [:]
    }
}
