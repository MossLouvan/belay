package expo.modules.belaypin

import android.app.Application
import android.content.Context
import com.facebook.react.modules.network.OkHttpClientFactory
import com.facebook.react.modules.network.OkHttpClientProvider
import expo.modules.core.interfaces.ApplicationLifecycleListener
import expo.modules.core.interfaces.Package

/**
 * Installs the pin hooks on React Native's shared OkHttpClient from
 * `Application.onCreate` (via Expo's ApplicationLifecycleDispatcher), which
 * is before NetworkingModule or WebSocketModule can have built a client.
 * The iOS counterpart is the `OnCreate` block in ios/BelayPinModule.swift.
 */
class BelayPinPackage : Package {
  override fun createApplicationLifecycleListeners(context: Context): List<ApplicationLifecycleListener> =
    listOf(object : ApplicationLifecycleListener {
      override fun onCreate(application: Application) {
        OkHttpClientProvider.setOkHttpClientFactory(OkHttpClientFactory {
          PinStore.install(OkHttpClientProvider.createClientBuilder(application)).build()
        })
      }
    })
}
