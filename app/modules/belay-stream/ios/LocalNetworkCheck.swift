import Foundation
import Network

/// Reads iOS's Local Network permission, which has no public query API.
///
/// The technique is the Bonjour round trip Apple's DTS recommends: advertise
/// `_belay._tcp` from a throwaway listener and browse for the same type.
///
/// - Seeing any result (our own advert, at least) means multicast DNS works,
///   so the permission is **granted**.
/// - The browser parking in `.waiting(.dns(kDNSServiceErr_PolicyDenied))`
///   means it is **denied**.
/// - Neither before the deadline (no Wi-Fi, prompt still up) is **unknown**.
///
/// Starting the browse is also what makes iOS show the permission prompt the
/// first time, which is why `triggerLocalNetworkPrompt` is this same check with
/// a deadline long enough for a person to answer. The type must be listed in
/// NSBonjourServices (app.json) or the browse fails outright.
final class LocalNetworkCheck {
    static let serviceType = "_belay._tcp"
    /// kDNSServiceErr_PolicyDenied from dns_sd.h; spelled out to avoid `import dnssd`.
    private static let policyDenied: Int32 = -65570

    private let queue = DispatchQueue(label: "com.mosslouvan.belay.local-network")
    private var browser: NWBrowser?
    private var listener: NWListener?
    private var completion: ((String) -> Void)?

    /// Calls `completion` exactly once with "granted", "denied" or "unknown".
    /// The check keeps itself alive (its handlers hold it) until it finishes.
    static func run(timeout: TimeInterval, completion: @escaping (String) -> Void) {
        LocalNetworkCheck().start(timeout: timeout, completion: completion)
    }

    private func start(timeout: TimeInterval, completion: @escaping (String) -> Void) {
        queue.async { [self] in
            self.completion = completion

            if let listener = try? NWListener(using: .tcp) {
                listener.service = NWListener.Service(type: Self.serviceType)
                listener.newConnectionHandler = { $0.cancel() }
                listener.stateUpdateHandler = { _ in }
                listener.start(queue: queue)
                self.listener = listener
            }

            let browser = NWBrowser(for: .bonjour(type: Self.serviceType, domain: nil), using: NWParameters())
            browser.stateUpdateHandler = { [self] state in
                switch state {
                case .waiting(let error), .failed(let error):
                    if case .dns(let code) = error, code == Self.policyDenied {
                        finish("denied")
                    } else if case .failed = state {
                        finish("unknown")
                    }
                default:
                    break
                }
            }
            browser.browseResultsChangedHandler = { [self] results, _ in
                if !results.isEmpty { finish("granted") }
            }
            browser.start(queue: queue)
            self.browser = browser

            queue.asyncAfter(deadline: .now() + timeout) { [self] in finish("unknown") }
        }
    }

    /// Runs on `queue`. Cancelling drops the handlers, which releases `self`.
    private func finish(_ status: String) {
        guard let done = completion else { return }
        completion = nil
        browser?.cancel()
        listener?.cancel()
        browser = nil
        listener = nil
        done(status)
    }
}
