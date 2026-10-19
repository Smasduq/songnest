package com.songnest.installer

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.util.Log

/**
 * Receives the `PackageInstaller` session verdict and forwards it to the
 * `install-finished` plugin event.
 *
 * Two jobs:
 *  - `STATUS_PENDING_USER_ACTION`: the system confirmation dialog must be
 *    launched via the intent attached to the broadcast. A receiver cannot
 *    start an activity from the background, so this is started as a new task.
 *  - any terminal status: map it to installed / cancelled / failed.
 *
 * The receiver is created by the system, so it has no reference to the
 * running plugin. [bridge] is set by the plugin while an install is in
 * flight; if it is null (process restarted, or install was cancelled after
 * the app was killed) the result is simply logged — the UI re-checks on next
 * launch anyway.
 */
class InstallResultReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_RESULT) return

        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, -1)
        when (status) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                // PackageInstaller hands us the confirmation dialog as an
                // EXTRA_INTENT. It must be started, not shown, and a
                // background receiver needs NEW_TASK.
                val confirmation = confirmationIntent(intent)
                if (confirmation == null) {
                    report("failed", "Installer did not provide a confirmation dialog")
                    return
                }
                confirmation.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                try {
                    context.startActivity(confirmation)
                } catch (e: Exception) {
                    Log.e(TAG, "could not show install dialog", e)
                    report("failed", e.message ?: "Could not show the install dialog")
                }
            }
            PackageInstaller.STATUS_SUCCESS -> report("installed", null)
            PackageInstaller.STATUS_FAILURE_ABORTED ->
                report("cancelled", "Install cancelled")
            PackageInstaller.STATUS_FAILURE_BLOCKED ->
                report("failed", "Install blocked by the device")
            PackageInstaller.STATUS_FAILURE_CONFLICT ->
                report("failed", "This update conflicts with the installed app")
            PackageInstaller.STATUS_FAILURE_INCOMPATIBLE ->
                report("failed", "This update is incompatible with the installed app")
            PackageInstaller.STATUS_FAILURE_INVALID ->
                report("failed", "The downloaded file is not a valid app package")
            PackageInstaller.STATUS_FAILURE_STORAGE ->
                report("failed", "Not enough storage to install the update")
            else -> {
                val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
                report("failed", message ?: "Install failed ($status)")
            }
        }
    }

    private fun report(status: String, message: String?) {
        val listener = listener
        if (listener == null) {
            Log.w(TAG, "install $status with no listener attached: $message")
            return
        }
        listener(status, message)
    }

    @Suppress("DEPRECATION")
    private fun confirmationIntent(intent: Intent): Intent? =
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
        } else {
            intent.getParcelableExtra(Intent.EXTRA_INTENT) as? Intent
        }

    companion object {
        const val ACTION_RESULT = "com.songnest.installer.SESSION_RESULT"
        private const val TAG = "SongnestInstaller"

        /**
         * Set by [InstallerPlugin] while an install is in flight. A single
         * install can happen at a time, so one slot is enough.
         */
        @Volatile
        var listener: ((status: String, message: String?) -> Unit)? = null
    }
}
