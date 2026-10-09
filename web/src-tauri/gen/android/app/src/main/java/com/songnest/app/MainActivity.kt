package com.songnest.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform

class MainActivity : TauriActivity() {
  private var appView: WebView? = null
  private var transportReceiver: BroadcastReceiver? = null

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    appView = webView
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // SongnestPy: start the embedded CPython interpreter. The Rust backend
    // reaches it over JNI (com.chaquo.python.Python) — this must run first,
    // on the UI thread, with the Activity context.
    try {
      if (!Python.isStarted()) Python.start(AndroidPlatform(this))
      val report = Python.getInstance().getModule("songnestpy").callAttr("probe").toString()
      Log.i("SongnestPy", "interpreter ready: $report")
    } catch (e: Exception) {
      Log.e("SongnestPy", "python init failed", e)
    }
    // Background player: the native notification's prev/next buttons can't
    // seek the one-item ExoPlayer timeline, so the player service broadcasts
    // here and we relay into the app store (queue/repeat/shuffle owner).
    // Guarded JS: a no-op until the WebView has booted the bridge.
    transportReceiver = object : BroadcastReceiver() {
      override fun onReceive(context: Context, intent: Intent) {
        val js = when (intent.action) {
          "$packageName.SONGNEST_TRANSPORT_NEXT" ->
            "window.__songnestTransport&&window.__songnestTransport.next()"
          "$packageName.SONGNEST_TRANSPORT_PREV" ->
            "window.__songnestTransport&&window.__songnestTransport.prev()"
          else -> null
        }
        if (js != null) {
          Log.i("SongnestTransport", "relaying ${intent.action}")
          appView?.evaluateJavascript(js, null)
        }
      }
    }
    val filter = IntentFilter().apply {
      addAction("$packageName.SONGNEST_TRANSPORT_NEXT")
      addAction("$packageName.SONGNEST_TRANSPORT_PREV")
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      registerReceiver(transportReceiver, filter, RECEIVER_NOT_EXPORTED)
    } else {
      @Suppress("UnspecifiedRegisterReceiverFlag")
      registerReceiver(transportReceiver, filter)
    }
  }

  override fun onDestroy() {
    transportReceiver?.let { runCatching { unregisterReceiver(it) } }
    transportReceiver = null
    appView = null
    super.onDestroy()
  }
}
