package com.songnest.player

import android.Manifest
import android.app.Activity
import android.content.ComponentName
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.google.common.util.concurrent.ListenableFuture

@InvokeArg
class PlayerTrack {
    lateinit var id: String
    lateinit var url: String
    lateinit var title: String
    lateinit var artist: String
    var artwork: String? = null
}

@InvokeArg
class SetQueueArgs {
    lateinit var tracks: ArrayList<PlayerTrack>
    var startIndex: Int = 0
    var preservePosition: Boolean = false
}

@InvokeArg
class SeekArgs {
    var positionMs: Long = 0
}

@TauriPlugin
class PlayerPlugin(private val activity: Activity) : Plugin(activity) {
    private var controllerFuture: ListenableFuture<MediaController>? = null
    private var controller: MediaController? = null
    private var permissionRequested = false
    private val playerListener = object : androidx.media3.common.Player.Listener {
        override fun onMediaItemTransition(
            mediaItem: androidx.media3.common.MediaItem?,
            reason: Int,
        ) {
            val player = controller ?: return
            val payload = JSObject().apply {
                put("id", mediaItem?.mediaId ?: "")
                put("index", player.currentMediaItemIndex)
            }
            trigger("track-changed", payload)
        }

        override fun onIsPlayingChanged(isPlaying: Boolean) {
            trigger("playing-changed", JSObject().apply { put("playing", isPlaying) })
        }

        override fun onPlaybackStateChanged(playbackState: Int) {
            if (playbackState == androidx.media3.common.Player.STATE_ENDED) {
                trigger("playing-changed", JSObject().apply { put("playing", false) })
            }
        }

        override fun onPlayerError(error: androidx.media3.common.PlaybackException) {
            trigger(
                "playback-error",
                JSObject().apply { put("message", error.message ?: "Playback failed") },
            )
            val player = controller ?: return
            if (player.hasNextMediaItem()) {
                player.seekToNextMediaItem()
                player.prepare()
                player.play()
            }
        }
    }

    override fun load(webView: android.webkit.WebView) {
        super.load(webView)
        requestNotificationPermission()
        val token = SessionToken(
            activity,
            ComponentName(activity.packageName, "com.songnest.app.PlaybackService"),
        )
        val future = MediaController.Builder(activity, token).buildAsync()
        controllerFuture = future
        future.addListener(
            {
                try {
                    controller = future.get().also { it.addListener(playerListener) }
                } catch (error: Exception) {
                    trigger(
                        "playback-error",
                        JSObject().apply { put("message", error.message ?: "Unable to connect to playback service") },
                    )
                }
            },
            ContextCompat.getMainExecutor(activity),
        )
    }

    @Command
    fun setQueue(invoke: Invoke) {
        val args = try {
            invoke.parseArgs(SetQueueArgs::class.java)
        } catch (error: Exception) {
            invoke.reject(error.message ?: "Invalid playback queue")
            return
        }
        withController(invoke) { player ->
            if (args.tracks.isEmpty()) {
                player.pause()
                player.clearMediaItems()
                invoke.resolve()
                return@withController
            }
            if (args.startIndex !in args.tracks.indices) {
                invoke.reject("startIndex must be valid")
                return@withController
            }
            val items = args.tracks.map(::mediaItem)
            val oldId = player.currentMediaItem?.mediaId
            val oldPosition = player.currentPosition
            val wasPlaying = player.playWhenReady
            val preservedIndex = if (args.preservePosition && oldId != null) {
                args.tracks.indexOfFirst { it.id == oldId }.takeIf { it >= 0 }
            } else {
                null
            }
            val index = preservedIndex ?: args.startIndex
            val position = if (preservedIndex != null) oldPosition else 0L
            player.setMediaItems(items, index, position)
            player.prepare()
            if (args.preservePosition) {
                if (wasPlaying) player.play() else player.pause()
            }
            invoke.resolve()
        }
    }

    @Command
    fun play(invoke: Invoke) = withController(invoke) { player ->
        player.play()
        invoke.resolve()
    }

    @Command
    fun pause(invoke: Invoke) = withController(invoke) { player ->
        player.pause()
        invoke.resolve()
    }

    @Command
    fun next(invoke: Invoke) = withController(invoke) { player ->
        player.seekToNextMediaItem()
        invoke.resolve()
    }

    @Command
    fun prev(invoke: Invoke) = withController(invoke) { player ->
        player.seekToPreviousMediaItem()
        invoke.resolve()
    }

    @Command
    fun seekTo(invoke: Invoke) {
        val args = try {
            invoke.parseArgs(SeekArgs::class.java)
        } catch (error: Exception) {
            invoke.reject(error.message ?: "Invalid seek position")
            return
        }
        withController(invoke) { player ->
            player.seekTo(args.positionMs.coerceAtLeast(0L))
            invoke.resolve()
        }
    }

    @Command
    fun getState(invoke: Invoke) = withController(invoke) { player ->
        val payload = JSObject().apply {
            put("position", player.currentPosition.coerceAtLeast(0L))
            put("duration", player.duration.takeIf { it >= 0L } ?: 0L)
            put("playing", player.isPlaying)
            put("currentIndex", player.currentMediaItemIndex)
            put("currentId", player.currentMediaItem?.mediaId ?: "")
        }
        invoke.resolve(payload)
    }

    override fun onDestroy() {
        controller?.removeListener(playerListener)
        controllerFuture?.let { MediaController.releaseFuture(it) }
        controller = null
        controllerFuture = null
        super.onDestroy()
    }

    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT < 33 || permissionRequested) return
        permissionRequested = true
        if (ContextCompat.checkSelfPermission(
                activity,
                Manifest.permission.POST_NOTIFICATIONS,
            ) != PackageManager.PERMISSION_GRANTED
        ) {
            ActivityCompat.requestPermissions(
                activity,
                arrayOf(Manifest.permission.POST_NOTIFICATIONS),
                7641,
            )
        }
    }

    private fun withController(invoke: Invoke, action: (MediaController) -> Unit) {
        activity.runOnUiThread {
            fun run(player: MediaController) {
                    try {
                        action(player)
                    } catch (error: Exception) {
                        invoke.reject(error.message ?: "Playback command failed")
                    }
            }
            controller?.let {
                    run(it)
                    return@runOnUiThread
            }
            val future = controllerFuture
            if (future == null) {
                    invoke.reject("Playback service is not connected")
            } else {
                    future.addListener(
                        {
                            try {
                                run(future.get())
                            } catch (error: Exception) {
                                invoke.reject(error.message ?: "Playback service connection failed")
                            }
                        },
                        ContextCompat.getMainExecutor(activity),
                    )
            }
        }
    }

    private fun mediaItem(track: PlayerTrack): MediaItem {
        val metadata = MediaMetadata.Builder()
            .setTitle(track.title)
            .setArtist(track.artist)
            .apply {
                    track.artwork?.takeIf(String::isNotBlank)?.let {
                        setArtworkUri(android.net.Uri.parse(it))
                    }
            }
            .build()
        return MediaItem.Builder()
            .setMediaId(track.id)
            .setUri(android.net.Uri.parse(track.url))
            .setMediaMetadata(metadata)
            .build()
    }
}
