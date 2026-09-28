import CommonCrypto
import ExpoModulesCore
import Foundation
import ObjectiveC.runtime
import Security

/// TLS certificate pinning for everything React Native sends to the host.
///
/// The host serves the LAN with a self-signed certificate (server/src/tls-cert.ts)
/// whose SHA-256 the phone learned at pairing. Stock `fetch` and `WebSocket`
/// cannot pin from JS, and the two native stacks they sit on need different
/// hooks, so this module installs both at startup and reads one table:
///
/// - **fetch / Image / XHR** go through React's `RCTHTTPRequestHandler`, an
///   `NSURLSession` delegate that implements no authentication-challenge
///   method. `URLSession(_:didReceive:completionHandler:)` is added to that
///   class at runtime; the session then asks it about every server trust.
/// - **WebSocket** is SocketRocket. It pins by exact DER when the request
///   carries `SR_SSLPinnedCertificates`, read through a category getter on
///   `NSURLRequest`. That getter is swapped for one that returns the leaf
///   certificate cached from the HTTP handshake to the same host, so the
///   socket refuses anything but the certificate the fetch just verified.
/// - **WKWebView** (the PDF viewer) has react-native-webview's own
///   `customCertificatesForHost`, which is fed the same cached leaf.
///
/// Nothing here relaxes trust for hosts that are not pinned: those get the
/// system's default evaluation, exactly as before.
public final class BelayPinModule: Module {
    public func definition() -> ModuleDefinition {
        Name("BelayPin")

        OnCreate {
            PinStore.shared.installHooks()
        }

        Function("pin") { (host: String, port: Int, fingerprint: String) in
            PinStore.shared.pin(host: host, port: port, fingerprint: fingerprint)
        }

        Function("unpin") { (host: String, port: Int) in
            PinStore.shared.unpin(host: host, port: port)
        }

        /// The SHA-256 of the leaf certificate `url` presents. Nothing is
        /// trusted and no request body is sent: the handshake is completed
        /// only far enough to read the certificate, then cancelled.
        AsyncFunction("probeFingerprint") { (url: String, promise: Promise) in
            guard let target = URL(string: url), target.scheme?.lowercased() == "https" else {
                promise.reject("ERR_BAD_URL", "probeFingerprint needs an https URL")
                return
            }
            CertificateProbe.run(target) { result in
                switch result {
                case .success(let hex): promise.resolve(hex)
                case .failure(let error): promise.reject("ERR_PROBE", error.localizedDescription)
                }
            }
        }

        Function("randomHex") { (bytes: Int) -> String in
            var buffer = [UInt8](repeating: 0, count: max(0, min(bytes, 1024)))
            let status = SecRandomCopyBytes(kSecRandomDefault, buffer.count, &buffer)
            precondition(status == errSecSuccess, "SecRandomCopyBytes failed")
            return buffer.map { String(format: "%02x", $0) }.joined()
        }
    }
}

// MARK: - Pin table + trust evaluation

final class PinStore {
    static let shared = PinStore()

    private let lock = NSLock()
    /// host:port → 64 lowercase hex.
    private var pins: [String: String] = [:]
    /// host:port → the leaf certificate seen on a successful pinned handshake.
    private var leaves: [String: SecCertificate] = [:]
    private var hooksInstalled = false

    static func key(_ host: String, _ port: Int) -> String {
        "\(host.lowercased()):\(port)"
    }

    func pin(host: String, port: Int, fingerprint: String) {
        let hex = fingerprint.lowercased().filter { $0.isHexDigit }
        guard hex.count == 64 else { return }
        lock.lock(); defer { lock.unlock() }
        pins[Self.key(host, port)] = hex
        leaves.removeValue(forKey: Self.key(host, port))
    }

    func unpin(host: String, port: Int) {
        lock.lock(); defer { lock.unlock() }
        pins.removeValue(forKey: Self.key(host, port))
        leaves.removeValue(forKey: Self.key(host, port))
        publishWebViewCertificates()
    }

    func pinnedFingerprint(host: String, port: Int) -> String? {
        lock.lock(); defer { lock.unlock() }
        return pins[Self.key(host, port)]
    }

    func cachedLeaf(host: String, port: Int) -> SecCertificate? {
        lock.lock(); defer { lock.unlock() }
        return leaves[Self.key(host, port)]
    }

    /// Whether `trust` presents the pinned leaf for host:port. `nil` when the
    /// host is not pinned at all (caller falls back to system trust).
    func evaluate(_ trust: SecTrust, host: String, port: Int) -> Bool? {
        guard let expected = pinnedFingerprint(host: host, port: port) else { return nil }
        guard let leaf = Self.leafCertificate(trust) else { return false }
        let actual = Self.sha256Hex(SecCertificateCopyData(leaf) as Data)
        guard actual == expected else { return false }
        lock.lock()
        leaves[Self.key(host, port)] = leaf
        lock.unlock()
        publishWebViewCertificates()
        return true
    }

    static func leafCertificate(_ trust: SecTrust) -> SecCertificate? {
        if #available(iOS 15.0, *) {
            return (SecTrustCopyCertificateChain(trust) as? [SecCertificate])?.first
        }
        return SecTrustGetCertificateAtIndex(trust, 0)
    }

    static func sha256Hex(_ data: Data) -> String {
        var digest = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
        data.withUnsafeBytes { _ = CC_SHA256($0.baseAddress, CC_LONG(data.count), &digest) }
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    /// react-native-webview keys its table by bare host, so every cached leaf
    /// is handed over under its hostname. Best effort: the class is optional.
    private func publishWebViewCertificates() {
        guard let webView = NSClassFromString("RNCWebViewImpl") as? NSObject.Type else { return }
        let selector = NSSelectorFromString("setCustomCertificatesForHost:")
        guard webView.responds(to: selector) else { return }
        lock.lock()
        var byHost: [String: SecCertificate] = [:]
        for (key, cert) in leaves {
            if let host = key.split(separator: ":").first { byHost[String(host)] = cert }
        }
        lock.unlock()
        _ = webView.perform(selector, with: byHost as NSDictionary)
    }

    // MARK: hooks

    func installHooks() {
        lock.lock()
        let already = hooksInstalled
        hooksInstalled = true
        lock.unlock()
        if already { return }
        installHTTPChallengeHandler()
        installSocketRocketPins()
    }

    /// Add `URLSession:didReceiveChallenge:completionHandler:` to React's HTTP
    /// handler. Session-level, so it covers every task the handler runs.
    private func installHTTPChallengeHandler() {
        guard let handler = NSClassFromString("RCTHTTPRequestHandler") else { return }
        let selector = NSSelectorFromString("URLSession:didReceiveChallenge:completionHandler:")
        if class_getInstanceMethod(handler, selector) != nil { return }

        typealias Completion = @convention(block) (Int, URLCredential?) -> Void
        let block: @convention(block) (AnyObject, URLSession, URLAuthenticationChallenge, @escaping Completion) -> Void = { _, _, challenge, complete in
            let space = challenge.protectionSpace
            guard space.authenticationMethod == NSURLAuthenticationMethodServerTrust, let trust = space.serverTrust else {
                complete(URLSession.AuthChallengeDisposition.performDefaultHandling.rawValue, nil)
                return
            }
            switch PinStore.shared.evaluate(trust, host: space.host, port: space.port) {
            case .some(true): complete(URLSession.AuthChallengeDisposition.useCredential.rawValue, URLCredential(trust: trust))
            case .some(false): complete(URLSession.AuthChallengeDisposition.cancelAuthenticationChallenge.rawValue, nil)
            case .none: complete(URLSession.AuthChallengeDisposition.performDefaultHandling.rawValue, nil)
            }
        }
        let imp = imp_implementationWithBlock(unsafeBitCast(block, to: AnyObject.self))
        class_addMethod(handler, selector, imp, "v@:@@@?")
    }

    /// Replace SocketRocket's `-[NSURLRequest SR_SSLPinnedCertificates]` so a
    /// request to a pinned host pins the cached leaf. SocketRocket then
    /// disables chain validation and compares DER byte for byte; a pinned host
    /// with no cached leaf yet gets an empty list, which SocketRocket refuses
    /// — fail closed, never open.
    private func installSocketRocketPins() {
        let selector = NSSelectorFromString("SR_SSLPinnedCertificates")
        guard let original = class_getInstanceMethod(NSURLRequest.self, selector) else { return }
        let originalImp = method_getImplementation(original)
        typealias Original = @convention(c) (AnyObject, Selector) -> NSArray?
        let callOriginal = unsafeBitCast(originalImp, to: Original.self)

        let block: @convention(block) (NSURLRequest) -> NSArray? = { request in
            if let url = request.url, let host = url.host {
                let port = url.port ?? 443
                if PinStore.shared.pinnedFingerprint(host: host, port: port) != nil {
                    if let leaf = PinStore.shared.cachedLeaf(host: host, port: port) { return [leaf] as NSArray }
                    return [] as NSArray
                }
            }
            return callOriginal(request, selector)
        }
        method_setImplementation(original, imp_implementationWithBlock(unsafeBitCast(block, to: AnyObject.self)))
    }
}

// MARK: - Fingerprint probe (typed pairing)

/// Completes a TLS handshake to read the leaf certificate, trusting nothing.
private final class CertificateProbe: NSObject, URLSessionDelegate, URLSessionTaskDelegate {
    private var seen: String?
    private var done: ((Result<String, Error>) -> Void)?

    static func run(_ url: URL, completion: @escaping (Result<String, Error>) -> Void) {
        let probe = CertificateProbe()
        probe.done = completion
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 8
        let session = URLSession(configuration: config, delegate: probe, delegateQueue: nil)
        var request = URLRequest(url: url)
        request.httpMethod = "HEAD"
        session.dataTask(with: request) { _, _, error in
            probe.finish(error: error)
            session.invalidateAndCancel()
        }.resume()
    }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
           let trust = challenge.protectionSpace.serverTrust,
           let leaf = PinStore.leafCertificate(trust) {
            seen = PinStore.sha256Hex(SecCertificateCopyData(leaf) as Data)
        }
        // The fingerprint is all that was wanted; do not send the request.
        completionHandler(.cancelAuthenticationChallenge, nil)
    }

    private func finish(error: Error?) {
        guard let done else { return }
        self.done = nil
        if let seen { done(.success(seen)); return }
        done(.failure(error ?? NSError(domain: "BelayPin", code: 1,
                                          userInfo: [NSLocalizedDescriptionKey: "no certificate was presented"])))
    }
}
