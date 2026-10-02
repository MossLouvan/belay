package expo.modules.belaypin

import android.net.Uri
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.security.SecureRandom

private const val PROBE_TIMEOUT_MS = 8_000

/** Same JS surface as ios/BelayPinModule.swift; app/src/devices/pinning.ts does not branch. */
class BelayPinModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("BelayPin")

    Function("pin") { host: String, port: Int, fingerprint: String ->
      PinStore.pin(host, port, fingerprint)
    }

    Function("unpin") { host: String, port: Int ->
      PinStore.unpin(host, port)
    }

    // AsyncFunction runs off the main thread, so the blocking handshake is allowed here.
    AsyncFunction("probeFingerprint") { url: String, promise: Promise ->
      val target = Uri.parse(url)
      val host = target.host
      if (!target.scheme.equals("https", ignoreCase = true) || host.isNullOrEmpty()) {
        promise.reject("ERR_BAD_URL", "probeFingerprint needs an https URL", null)
        return@AsyncFunction
      }
      val port = if (target.port > 0) target.port else 443
      try {
        promise.resolve(PinStore.probeFingerprint(host, port, PROBE_TIMEOUT_MS))
      } catch (e: Exception) {
        promise.reject("ERR_PROBE", e.message ?: e.javaClass.simpleName, e)
      }
    }

    Function("randomHex") { bytes: Int ->
      val buffer = ByteArray(bytes.coerceIn(0, 1024))
      SecureRandom().nextBytes(buffer)
      buffer.joinToString("") { "%02x".format(it) }
    }
  }
}
