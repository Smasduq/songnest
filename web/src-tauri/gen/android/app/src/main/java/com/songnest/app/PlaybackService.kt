package com.songnest.app

import android.app.PendingIntent
import android.content.Intent
import android.net.Uri
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.ResolvingDataSource
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONObject

class PlaybackService : MediaSessionService() {
    private var player: ExoPlayer? = null
    private var mediaSession: MediaSession? = null

    override fun onCreate() {
        super.onCreate()
        val audioAttributes = AudioAttributes.Builder()
            .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
            .setUsage(C.USAGE_MEDIA)
            .build()
        val dataSourceFactory = ResolvingDataSource.Factory(
            DefaultDataSource.Factory(this),
        ) { dataSpec ->
            val uri = dataSpec.uri
            if (uri.scheme != "songnest") {
                dataSpec
            } else {
                val deezerId = uri.lastPathSegment?.toLongOrNull()
                    ?: throw IOException("Invalid Songnest track identifier")
                val server = uri.getQueryParameter("server")?.trimEnd('/')
                    ?: throw IOException("Missing Songnest server URL")
                val serverUri = Uri.parse(server)
                if (serverUri.scheme != "http" && serverUri.scheme != "https") {
                    throw IOException("Unsupported Songnest server URL")
                }
                val connection = URL("$server/api/resolve?dz=$deezerId")
                    .openConnection() as HttpURLConnection
                try {
                    connection.requestMethod = "GET"
                    connection.connectTimeout = 15_000
                    connection.readTimeout = 120_000
                    if (connection.responseCode !in 200..299) {
                        throw IOException("Track resolution failed (${connection.responseCode})")
                    }
                    val stream = connection.inputStream.bufferedReader().use {
                        JSONObject(it.readText()).getString("stream")
                    }
                    val resolvedUri = Uri.parse(URL(URL(server), stream).toString())
                    if (resolvedUri.scheme != "http" && resolvedUri.scheme != "https") {
                        throw IOException("Track resolver returned an unsupported URL")
                    }
                    dataSpec.withUri(resolvedUri)
                } finally {
                    connection.disconnect()
                }
            }
        }
        player = ExoPlayer.Builder(this)
            .setMediaSourceFactory(
                DefaultMediaSourceFactory(this).setDataSourceFactory(dataSourceFactory),
            )
            .build()
            .apply {
                setAudioAttributes(audioAttributes, true)
                setHandleAudioBecomingNoisy(true)
                setWakeMode(C.WAKE_MODE_NETWORK)
            }
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        val sessionActivity = launchIntent?.let {
            PendingIntent.getActivity(
                this,
                0,
                it,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        }
        mediaSession = MediaSession.Builder(this, requireNotNull(player))
            .apply { if (sessionActivity != null) setSessionActivity(sessionActivity) }
            .build()
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? =
        mediaSession

    override fun onTaskRemoved(rootIntent: Intent?) {
        val currentPlayer = player
        if (currentPlayer == null || !currentPlayer.isPlaying || currentPlayer.mediaItemCount == 0) {
            stopSelf()
        }
    }

    override fun onDestroy() {
        mediaSession?.release()
        mediaSession = null
        player?.release()
        player = null
        super.onDestroy()
    }
}
