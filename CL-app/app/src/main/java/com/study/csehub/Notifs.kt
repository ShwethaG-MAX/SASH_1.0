package com.study.csehub

import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/** Tracks whether the app is on screen, and lets the activity hear about new history. */
object AppState {
    @Volatile var foreground = false
    @Volatile var onHistoryChanged: (() -> Unit)? = null
}

/** Notification channels + the one place that builds and shows a notification. */
object Notifs {
    const val CLASS_PERIODS = "class_periods"
    const val TASKS = "tasks"
    const val COMMUNITY = "community"
    const val ACADEMIC_CALENDAR = "academic_calendar"
    const val LINKLEARN = "linklearn"
    const val STUDY_RESOURCES = "study_resources"
    const val ANNOUNCEMENTS = "announcements"
    const val IMPORTANT = "important"
    const val QUIZ = "quiz"                 // Daily Quiz reminders + results (FCM pushes name this channel)

    private class Ch(val id: String, val name: String, val desc: String, val importance: Int)

    private val channels = listOf(
        Ch(CLASS_PERIODS, "Class & Periods", "Reminders before each class", NotificationManager.IMPORTANCE_HIGH),
        Ch(TASKS, "Tasks & Assignments", "Task and assignment deadlines", NotificationManager.IMPORTANCE_HIGH),
        Ch(COMMUNITY, "Community", "New messages in the community chat", NotificationManager.IMPORTANCE_DEFAULT),
        Ch(ACADEMIC_CALENDAR, "Academic Calendar", "Holidays, exams and academic dates", NotificationManager.IMPORTANCE_DEFAULT),
        Ch(LINKLEARN, "LinkLearn", "New learning links", NotificationManager.IMPORTANCE_DEFAULT),
        Ch(STUDY_RESOURCES, "Study Resources", "New study material", NotificationManager.IMPORTANCE_DEFAULT),
        Ch(ANNOUNCEMENTS, "Announcements", "Class announcements", NotificationManager.IMPORTANCE_HIGH),
        Ch(IMPORTANT, "Important Updates", "Urgent changes and notices", NotificationManager.IMPORTANCE_HIGH),
        Ch(QUIZ, "Daily Quiz", "Quiz reminders, results and leaderboard", NotificationManager.IMPORTANCE_HIGH)
    )

    fun createChannels(ctx: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = ctx.getSystemService(NotificationManager::class.java) ?: return
        for (c in channels) {
            val ch = NotificationChannel(c.id, c.name, c.importance)
            ch.description = c.desc
            nm.createNotificationChannel(ch)
        }
    }

    private fun isHigh(channel: String) =
        channel == CLASS_PERIODS || channel == TASKS || channel == ANNOUNCEMENTS || channel == IMPORTANT || channel == QUIZ

    /**
     * collapse = true → repeated notifications of that channel replace each other
     * (so a busy chat can never flood the status bar). The website history still keeps every one.
     */
    @SuppressLint("MissingPermission")
    fun show(ctx: Context, e: Entry, collapse: Boolean = false) {
        createChannels(ctx)
        val nmc = NotificationManagerCompat.from(ctx)
        if (!nmc.areNotificationsEnabled()) return

        val tap = Intent(ctx, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra("route", e.route)
            putExtra("ref", e.ref)
            putExtra("sub", e.sub)
            putExtra("nid", e.id)
        }
        val nid = if (collapse) ("grp_" + e.channel).hashCode() else e.id.hashCode()
        val pi = PendingIntent.getActivity(
            ctx, nid, tap, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val n = NotificationCompat.Builder(ctx, e.channel)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(e.title)
            .setContentText(e.body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(e.body))
            .setContentIntent(pi)
            .setAutoCancel(true)
            .setWhen(e.ts)
            .setPriority(if (isHigh(e.channel)) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT)
            .build()
        nmc.notify(nid, n)
    }
}
