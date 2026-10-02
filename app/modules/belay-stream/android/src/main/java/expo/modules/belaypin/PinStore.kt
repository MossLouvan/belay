package expo.modules.belaypin

import java.net.Socket
import java.security.KeyStore
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLEngine
import javax.net.ssl.SSLSession
import javax.net.ssl.SSLSocket
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509ExtendedTrustManager
import javax.net.ssl.X509TrustManager
import okhttp3.OkHttpClient
import javax.net.ssl.HttpsURLConnection

/**
 * The Android half of iOS's `PinStore` (ios/BelayPinModule.swift): host:port
 * -> SHA-256 of the leaf certificate the phone learned at pairing.
 *
 * React Native on Android does every fetch, XHR, Image and WebSocket through
 * ONE OkHttpClient from `OkHttpClientProvider` (WebSocketModule derives its
 * client from it with `newBuilder()`, which keeps the TLS settings), so
 * pinning is two hooks on that client, installed by [BelayPinPackage] before
 * the first request:
 *
 * - [trustManager] accepts a chain whose leaf hashes to ANY pinned value and
 *   hands everything else to the system trust store — which refuses the
 *   host's self-signed certificate, so an unpinned host fails closed.
 * - [hostnameVerifier] binds that leaf to the address: a pinned host:port
 *   must present exactly its pin, and a pinned certificate reaching an
 *   address it was not pinned for is refused. Unpinned hosts get OkHttp's
 *   normal hostname check.
 *
 * The trust manager alone cannot know the port, which is why identity is
 * split across the two: JSSE calls the trust manager before OkHttp knows
 * which host it is talking to, and the hostname verifier runs on the
 * finished handshake, where the peer host AND port are known.
 */
object PinStore {
  private val lock = Any()

  /** host:port -> 64 lowercase hex. */
  private val pins = HashMap<String, String>()

  /** Brackets stripped so a JS `[v6]` host and OkHttp's bare `v6` key the same pin. */
  fun key(host: String, port: Int): String = "${host.trim('[', ']').lowercase()}:$port"

  fun pin(host: String, port: Int, fingerprint: String) {
    val hex = fingerprint.lowercase().filter { it in '0'..'9' || it in 'a'..'f' }
    if (hex.length != 64) return
    synchronized(lock) { pins[key(host, port)] = hex }
  }

  fun unpin(host: String, port: Int) {
    synchronized(lock) { pins.remove(key(host, port)) }
  }

  fun pinnedFingerprint(host: String, port: Int): String? =
    synchronized(lock) { pins[key(host, port)] }

  private fun isPinnedAnywhere(hex: String): Boolean =
    synchronized(lock) { pins.containsValue(hex) }

  fun sha256Hex(cert: X509Certificate): String =
    MessageDigest.getInstance("SHA-256").digest(cert.encoded).joinToString("") { "%02x".format(it) }

  private val systemTrust: X509TrustManager by lazy {
    val factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
    factory.init(null as KeyStore?)
    factory.trustManagers.filterIsInstance<X509TrustManager>().first()
  }

  /** Pinned leaf: trusted. Anything else: whatever the system says. */
  val trustManager: X509ExtendedTrustManager = object : X509ExtendedTrustManager() {
    private fun check(chain: Array<out X509Certificate>?, authType: String?) {
      val leaf = chain?.firstOrNull() ?: throw CertificateException("no certificate presented")
      if (isPinnedAnywhere(sha256Hex(leaf))) return
      systemTrust.checkServerTrusted(chain, authType)
    }

    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) = check(chain, authType)
    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?, socket: Socket?) = check(chain, authType)
    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?, engine: SSLEngine?) = check(chain, authType)

    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = systemTrust.checkClientTrusted(chain, authType)
    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?, socket: Socket?) = checkClientTrusted(chain, authType)
    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?, engine: SSLEngine?) = checkClientTrusted(chain, authType)

    override fun getAcceptedIssuers(): Array<X509Certificate> = systemTrust.acceptedIssuers
  }

  /** The leaf for host:port must be its pin; a pin never passes elsewhere. */
  val hostnameVerifier = HostnameVerifier { host, session: SSLSession ->
    // peerCertificates throws when the peer was not verified: fail closed.
    val leaf = runCatching { session.peerCertificates.firstOrNull() as? X509Certificate }.getOrNull()
    if (leaf == null) {
      false
    } else {
      val actual = sha256Hex(leaf)
      val expected = pinnedFingerprint(host, session.peerPort)
      when {
        expected != null -> actual == expected
        isPinnedAnywhere(actual) -> false
        else -> HttpsURLConnection.getDefaultHostnameVerifier().verify(host, session)
      }
    }
  }

  fun install(builder: OkHttpClient.Builder): OkHttpClient.Builder {
    val context = SSLContext.getInstance("TLS")
    context.init(null, arrayOf(trustManager), null)
    return builder.sslSocketFactory(context.socketFactory, trustManager).hostnameVerifier(hostnameVerifier)
  }

  /**
   * The SHA-256 of the leaf `host:port` presents. Nothing is trusted and no
   * request is sent: the handshake is completed only to read the
   * certificate, then the socket is closed.
   */
  fun probeFingerprint(host: String, port: Int, timeoutMs: Int): String {
    val trustNothing = object : X509TrustManager {
      override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
      override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
      override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    }
    val context = SSLContext.getInstance("TLS")
    context.init(null, arrayOf(trustNothing), null)
    val socket = context.socketFactory.createSocket() as SSLSocket
    socket.use {
      it.connect(java.net.InetSocketAddress(host.trim('[', ']'), port), timeoutMs)
      it.soTimeout = timeoutMs
      it.startHandshake()
      val leaf = it.session.peerCertificates.firstOrNull() as? X509Certificate
        ?: throw CertificateException("no certificate was presented")
      return sha256Hex(leaf)
    }
  }
}
