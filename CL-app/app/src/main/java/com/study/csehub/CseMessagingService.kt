package com.study.csehub

import android.os.Handler
import android.os.Looper
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import java.util.UUID

/**
 * Receives FCM pushes while the app is ON SCREEN (when the app is closed / in the background, Android shows the push itself and this class is not called).
 *
 * - Shows the push in the status bar (same channels, same tap routing as every other notification) and adds it to the in-app history.
 * - Stays silent for pushes whose content the open page already shows as its own banner / toast (chat, LinkLearn, Study Chat, Connect),
 *   so nothing appears twice.
 * - onNewToken: a new FCM token means the old topic subscriptions are gone, so they are re-made. The page re-uploads the token to
 *   deviceTokens/{uid} through requestFcmToken the next time it starts or signs in.
 */
class CseMessagingService : FirebaseMessagingService() {

    override fun onMessageReceived(m: RemoteMessage) {
        try {
            val ctx = applicationContext
            val n = m.notification
            val title = n?.title ?: m.data["title"] ?: return
            val body = n?.body ?: m.data["body"] ?: ""
            val route = m.data["route"] ?: ""
            val channel = n?.channelId ?: m.data["channel"] ?: Notifs.COMMUNITY

            if (AppState.foreground && route in IN_APP_COVERED) return

            val e = Entry(
                id = m.messageId ?: UUID.randomUUID().toString(),
                title = title,
                body = body,
                cat = catFor(channel),
                channel = channel,
                route = route,
                ref = m.data["ref"] ?: "",
                sub = m.data["sub"] ?: "",
                ts = System.currentTimeMillis()
            )
            if (NotifStore.addPending(ctx, e)) {          // false = already seen (duplicate delivery)
                Handler(Looper.getMainLooper()).post { AppState.onHistoryChanged?.invoke() }
                Notifs.show(ctx, e, collapse = channel == Notifs.COMMUNITY)   // a busy chat replaces itself instead of flooding the status bar
            }
        } catch (x: Exception) { }
    }

    override fun onNewToken(token: String) {
        try {
            NotifStore.clearSubscribed(applicationContext)
            Push.syncTopics(applicationContext)
        } catch (x: Exception) { }
    }

    private fun catFor(channel: String): String = when (channel) {
        Notifs.COMMUNITY, Notifs.LINKLEARN, Notifs.ANNOUNCEMENTS, Notifs.IMPORTANT -> channel
        Notifs.STUDY_RESOURCES -> "resources"
        else -> "important"            // quiz, connections & teams: shown in the history like an important notice
    }

    private companion object {
        /** Routes the open page already announces itself (in-app banners / toasts). */
        val IN_APP_COVERED = setOf("chat", "linklearn", "examchat", "connect")
    }
}
