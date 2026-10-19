package com.songnest.installer

import android.app.Activity
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.PackageInstaller
import android.util.Log
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

@InvokeArg
class InstallArgs {
    lateinit var url: String
}

/**
 * In-place Android updates via `PackageInstaller.Session`.
 *
 * Android will not let an app silently replace itself: every install goes
 * through the system confirmation dialog, even for a trusted signer. The
 * session API gets us to that dialog in one tap — we download the APK,
 * stream it into a session, and the OS takes over. Doing this through the
 * browser instead just drops the file in Downloads and leaves the user to
 * find it.
 *
 * The final result arrives asynchronously in [InstallResultReceiver] because
 * the dialog can outlive this plugin: the user may take their time, or leave
 * the app entirely.
 */
@TauriPlugin
class InstallerPlugin(private val activity: Activity) : Plugin(activity) {
    private val executor = Executors.newSingleThreadExecutor()

    /** Can this device install an APK, and does the user still need to grant
     *  "install unknown apps"? Both are checked live — the grant can change
     *  while the app is running. */
    @Command
    fun canInstall(invoke: Invoke) {
        try {
            val result = JSObject()
            val canRequest = activity.packageManager
                .canRequestPackageInstalls()
            result.put("available", true)
            result.put("needsPermission", !canRequest)
            invoke.resolve(result)
        } catch (e: Exception) {
            invoke.reject(e.message ?: "Could not check install capability")
        }
    }

    /** Open the "Install unknown apps" settings screen for this app. Android
     *  opens it scoped to the calling package, so no extra permission is
     *  needed to show it. */
    @Command
    fun openInstallSettings(invoke: Invoke) {
        try {
            val intent = Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES)
                .setData(android.net.Uri.parse("package:${activity.packageName}"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            activity.startActivity(intent)
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject(e.message ?: "Could not open install settings")
        }
    }

    /**
     * Download the APK at `url` and hand it to the system installer.
     *
     * Resolves as soon as the session is committed and the confirmation
     * dialog is up — not when the install completes. The outcome is sent as
     * the `install-finished` event.
     */
    @Command
    fun install(invoke: Invoke) {
        val args = try {
            invoke.parseArgs(InstallArgs::class.java)
        } catch (e: Exception) {
            invoke.reject(e.message ?: "Invalid install arguments")
            return
        }

        // No point downloading if the user has not allowed installs from this
        // app: the session commit would be rejected afterwards.
        if (!activity.packageManager.canRequestPackageInstalls()) {
            invoke.reject("NEEDS_PERMISSION")
            return
        }

        // Return immediately; the download must not block the bridge thread.
        invoke.resolve()

        executor.execute {
            try {
                val apk = downloadApk(args.url)
                stageAndCommit(apk)
            } catch (e: Exception) {
                Log.e(TAG, "install failed", e)
                emitResult("failed", e.message ?: "Install failed")
            }
        }
    }

    /** Forward an install result to the `install-finished` event listener.
     *  Safe from any thread: the event bridge must run on the UI thread. */
    private fun emitResult(status: String, message: String?) {
        activity.runOnUiThread {
            trigger(
                "install-finished",
                JSObject().apply {
                    put("status", status)
                    if (message != null) put("message", message)
                },
            )
        }
    }

    /** Download to the app cache. A stale partial file from a failed attempt
     *  would otherwise be staged as a corrupt APK. */
    private fun downloadApk(url: String): File {
        val dir = File(activity.cacheDir, "updates").apply { mkdirs() }
        val target = File(dir, "songnest-update.apk")
        if (target.exists()) target.delete()

        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 20_000
            readTimeout = 120_000
            instanceFollowRedirects = true
        }
        try {
            if (connection.responseCode !in 200..299) {
                throw IllegalStateException("Download failed (${connection.responseCode})")
            }
            connection.inputStream.use { input ->
                target.outputStream().use { output -> input.copyTo(output, 256 * 1024) }
            }
        } finally {
            connection.disconnect()
        }

        if (target.length() <= 0L) {
            throw IllegalStateException("Downloaded file is empty")
        }
        return target
    }

    /** Open a full-install session, copy the bytes in, and commit it. */
    private fun stageAndCommit(apk: File) {
        // The receiver is instantiated by the system and cannot hold this
        // plugin, so it reports through a static listener. Set it BEFORE the
        // commit: a fast device can deliver the result (even STATUS_SUCCESS)
        // before commit() returns, and a listener assigned afterwards would
        // miss it. Cleared once the result arrives so we never hold the
        // Activity past the install.
        InstallResultReceiver.listener = { status, message ->
            InstallResultReceiver.listener = null
            emitResult(status, message)
        }

        val installer = activity.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(
            PackageInstaller.SessionParams.MODE_FULL_INSTALL,
        )
        val sessionId = installer.createSession(params)
        val session = installer.openSession(sessionId)
        try {
            apk.inputStream().use { input ->
                session.openWrite("songnest.apk", 0, apk.length()).use { output ->
                    input.copyTo(output, 256 * 1024)
                    session.fsync(output)
                }
            }

            val statusReceiver = PendingIntent.getBroadcast(
                activity,
                0,
                Intent(activity, InstallResultReceiver::class.java)
                    .setAction(InstallResultReceiver.ACTION_RESULT),
                // Mutable on Android 12+: commit() needs to add the install
                // confirmation intent. A targetSdk 35+ build throws
                // IllegalArgumentException for an immutable PendingIntent.
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
            ).intentSender

            session.commit(statusReceiver)
        } catch (e: Exception) {
            InstallResultReceiver.listener = null
            session.abandon()
            throw e
        } finally {
            session.close()
        }
    }

    companion object {
        private const val TAG = "SongnestInstaller"
    }
}
