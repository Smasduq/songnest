package com.songnest.app

import android.os.Bundle
import android.util.Log
import androidx.activity.enableEdgeToEdge
import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // Start the embedded CPython interpreter before the in-process backend
    // can resolve streams through yt-dlp.
    try {
      if (!Python.isStarted()) Python.start(AndroidPlatform(this))
      val report = Python.getInstance().getModule("songnestpy").callAttr("probe").toString()
      Log.i("SongnestPy", "interpreter ready: $report")
    } catch (e: Exception) {
      Log.e("SongnestPy", "python init failed", e)
    }
  }
}
