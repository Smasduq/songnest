package app.tauri.nativeaudio

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import androidx.media3.ui.PlayerNotificationManager
import java.util.concurrent.Executors

private const val NOTIFICATION_ID = 9501
private const val CHANNEL_ID_SUFFIX = ".native_audio"
private const val NOTIFICATION_ICON_NAME = "ic_notification"
// Songnest: tag for artwork-load failures (upstream had no logging here).
private const val ART_TAG = "songnest/artwork"
// Songnest: cap notification art at this size (covers are small; saves RAM).
private const val ARTWORK_MAX_SIDE_PX = 512

class NativeAudioService : MediaSessionService() {
    private var notificationManager: PlayerNotificationManager? = null
    private var appLargeIcon: Bitmap? = null
    // Songnest: track-artwork cache. The large icon is the song cover when
    // loaded, the app icon while loading / when a track has no artwork.
    private var cachedArtworkKey: String? = null
    private var cachedArtwork: Bitmap? = null
    private val artExecutor = Executors.newSingleThreadExecutor()

    override fun onCreate() {
        super.onCreate()
        NativeAudioRuntime.ensure(applicationContext)
        setupNotificationManager()
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? {
        return NativeAudioRuntime.mediaSession()
    }

    override fun onUpdateNotification(session: MediaSession, startInForegroundRequired: Boolean) {
        // PlayerNotificationManager is the single source for media controls in notification shade.
    }

    override fun onDestroy() {
        notificationManager?.setPlayer(null)
        notificationManager = null
        appLargeIcon?.recycle()
        appLargeIcon = null
        // Songnest: drop track art + stop background loads.
        cachedArtwork?.recycle()
        cachedArtwork = null
        cachedArtworkKey = null
        artExecutor.shutdown()
        super.onDestroy()
    }

    private fun setupNotificationManager() {
        val player = NativeAudioRuntime.mediaSessionPlayer() ?: return
        val mediaSession = NativeAudioRuntime.mediaSession() ?: return
        if (notificationManager != null) return

        ensureNotificationChannel()

        notificationManager = PlayerNotificationManager.Builder(this, NOTIFICATION_ID, channelId())
            .setMediaDescriptionAdapter(
                object : PlayerNotificationManager.MediaDescriptionAdapter {
                    override fun getCurrentContentTitle(player: androidx.media3.common.Player): CharSequence {
                        return player.mediaMetadata.title ?: appDisplayName()
                    }

                    override fun createCurrentContentIntent(player: androidx.media3.common.Player): PendingIntent? {
                        return mediaSession.sessionActivity
                    }

                    override fun getCurrentContentText(player: androidx.media3.common.Player): CharSequence? {
                        return player.mediaMetadata.artist
                    }

                    // Songnest: the song cover when available (loaded
                    // off-thread from mediaMetadata.artworkUri, which the
                    // app sets from the track coverUrl); app icon meanwhile.
                    override fun getCurrentLargeIcon(
                        player: androidx.media3.common.Player,
                        callback: PlayerNotificationManager.BitmapCallback,
                    ): Bitmap? {
                        if (appLargeIcon == null) {
                            val iconResId = resolveAppIconResId()
                            if (iconResId != 0) appLargeIcon = BitmapFactory.decodeResource(resources, iconResId)
                        }
                        val artwork = player.mediaMetadata.artworkUri
                        if (artwork == null) {
                            cachedArtworkKey = null
                            cachedArtwork?.recycle()
                            cachedArtwork = null
                            return appLargeIcon
                        }
                        val key = artwork.toString()
                        if (key == cachedArtworkKey) return cachedArtwork ?: appLargeIcon
                        cachedArtworkKey = key
                        cachedArtwork?.recycle()
                        cachedArtwork = null
                        artExecutor.execute {
                            val bmp = loadArtworkBitmap(artwork)
                            if (cachedArtworkKey == key && bmp != null) {
                                cachedArtwork = bmp
                                runCatching { callback.onBitmap(bmp) }
                            }
                        }
                        return appLargeIcon
                    }
                },
            )
            .setNotificationListener(
                object : PlayerNotificationManager.NotificationListener {
                    override fun onNotificationPosted(notificationId: Int, notification: Notification, ongoing: Boolean) {
                        if (ongoing) {
                            startForeground(notificationId, notification)
                        } else {
                            stopForegroundCompat(remove = false)
                        }
                    }

                    override fun onNotificationCancelled(notificationId: Int, dismissedByUser: Boolean) {
                        stopForegroundCompat(remove = true)
                        stopSelf()
                    }
                },
            )
            .build()
            .apply {
                setMediaSessionToken(mediaSession.platformToken)
                // Songnest: music-card layout — prev/play/next (compact too).
                // Rewind/ffwd are off; in-app seek bar covers seeking.
                setUsePlayPauseActions(true)
                setUsePreviousAction(true)
                setUseNextAction(true)
                setUseFastForwardAction(false)
                setUseRewindAction(false)
                setUsePreviousActionInCompactView(true)
                setUseNextActionInCompactView(true)
                setUseRewindActionInCompactView(false)
                setUseFastForwardActionInCompactView(false)
                setUseStopAction(false)
                setSmallIcon(resolveNotificationSmallIconResId())
                setPlayer(player)
            }
    }

    // Songnest: fetch + downsample the cover. content/file URIs go through
    // the ContentResolver, everything else (https CDN, http loopback proxy)
    // through a plain connection with timeouts. Runs off the main thread.
    private fun loadArtworkBitmap(uri: Uri): Bitmap? {
        return try {
            val stream = when (uri.scheme?.lowercase()) {
                "content", "file", "android.resource" ->
                    contentResolver.openInputStream(uri)
                else -> {
                    val conn = java.net.URL(uri.toString()).openConnection()
                        as java.net.HttpURLConnection
                    conn.connectTimeout = 8000
                    conn.readTimeout = 8000
                    conn.connect()
                    if (conn.responseCode in 200..299) conn.inputStream else null
                }
            } ?: return null
            stream.use { decodeDownsampledArtwork(it) }
        } catch (e: Exception) {
            Log.w(ART_TAG, "artwork load failed", e)
            null
        }
    }

    private fun decodeDownsampledArtwork(stream: java.io.InputStream): Bitmap? {
        val bytes = stream.readBytes()
        if (bytes.isEmpty()) return null
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        var sample = 1
        while (
            bounds.outWidth / sample > ARTWORK_MAX_SIDE_PX ||
            bounds.outHeight / sample > ARTWORK_MAX_SIDE_PX
        ) {
            sample *= 2
        }
        val opts = BitmapFactory.Options().apply { inSampleSize = sample }
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)
    }

    private fun channelId(): String {
        return "${packageName}${CHANNEL_ID_SUFFIX}"
    }

    private fun appDisplayName(): String {
        return applicationInfo.loadLabel(packageManager)?.toString().orEmpty().ifBlank { "Audio app" }
    }

    private fun resolveNotificationSmallIconResId(): Int {
        val notificationIcon = resources.getIdentifier(NOTIFICATION_ICON_NAME, "drawable", packageName)
        if (notificationIcon != 0) return notificationIcon
        return android.R.drawable.ic_media_play
    }

    private fun resolveAppIconResId(): Int {
        val appIcon = applicationInfo.icon
        return if (appIcon != 0) appIcon else android.R.drawable.sym_def_app_icon
    }

    private fun stopForegroundCompat(remove: Boolean) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(if (remove) Service.STOP_FOREGROUND_REMOVE else Service.STOP_FOREGROUND_DETACH)
            return
        }
        @Suppress("DEPRECATION")
        stopForeground(remove)
    }

    private fun ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (manager.getNotificationChannel(channelId()) != null) return
        val channel = NotificationChannel(channelId(), appDisplayName(), NotificationManager.IMPORTANCE_LOW).apply {
            description = "Audio playback controls"
            setShowBadge(false)
        }
        manager.createNotificationChannel(channel)
    }
}
