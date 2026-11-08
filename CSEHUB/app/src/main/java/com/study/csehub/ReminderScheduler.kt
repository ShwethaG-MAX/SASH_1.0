package com.study.csehub

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * Schedules class / task / calendar reminders with AlarmManager, so they fire while the app is closed.
 * The website decides WHAT to remind about; this object decides WHEN Android wakes up.
 * Weekly items (classes) re-arm themselves every week, so they keep working even if the app is not opened.
 */
object ReminderScheduler {
    private const val WEEK = 7L * 24 * 60 * 60 * 1000
    private const val ACTION = "com.study.csehub.REMINDER"

    fun canExact(ctx: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
        val am = ctx.getSystemService(AlarmManager::class.java) ?: return false
        return am.canScheduleExactAlarms()
    }

    private fun pending(ctx: Context, id: String): PendingIntent {
        val i = Intent(ctx, AlarmReceiver::class.java).apply {
            action = ACTION
            data = Uri.parse("csehub://reminder/" + Uri.encode(id))
            putExtra("id", id)
        }
        return PendingIntent.getBroadcast(
            ctx, id.hashCode(), i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
    }

    private fun cancel(ctx: Context, id: String) {
        val am = ctx.getSystemService(AlarmManager::class.java) ?: return
        am.cancel(pending(ctx, id))
    }

    private fun schedule(ctx: Context, id: String, at: Long) {
        val am = ctx.getSystemService(AlarmManager::class.java) ?: return
        val pi = pending(ctx, id)
        try {
            if (canExact(ctx)) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
            else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
        } catch (e: SecurityException) {
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
        }
    }

    private fun istDate(t: Long): String {
        val f = SimpleDateFormat("yyyy-MM-dd", Locale.US)
        f.timeZone = TimeZone.getTimeZone("Asia/Kolkata")
        return f.format(Date(t))
    }

    /** Called by the website with the complete, current list. Replaces everything scheduled before. */
    @Synchronized
    fun sync(ctx: Context, payload: String) {
        val o = JSONObject(payload)
        val fresh = o.getJSONArray("items")
        NotifStore.saveSkip(ctx, o.optJSONArray("skip") ?: JSONArray())

        val old = NotifStore.items(ctx)
        for (i in 0 until old.length()) cancel(ctx, old.getJSONObject(i).getString("id"))

        val now = System.currentTimeMillis()
        val keep = JSONArray()
        for (i in 0 until fresh.length()) {
            val it = fresh.getJSONObject(i)
            var at = it.getLong("at")
            if (it.optBoolean("weekly")) {
                while (at <= now) at += WEEK
                it.put("at", at)
            } else if (at <= now) continue
            keep.put(it)
            schedule(ctx, it.getString("id"), at)
        }
        NotifStore.saveItems(ctx, keep)
    }

    /** After reboot / app update / exact-alarm permission change: Android forgets alarms, so set them again. */
    @Synchronized
    fun rescheduleAll(ctx: Context) {
        val items = NotifStore.items(ctx)
        val now = System.currentTimeMillis()
        val keep = JSONArray()
        for (i in 0 until items.length()) {
            val it = items.getJSONObject(i)
            var at = it.getLong("at")
            if (it.optBoolean("weekly")) {
                while (at <= now) at += WEEK
                it.put("at", at)
            } else if (at <= now) continue
            keep.put(it)
            schedule(ctx, it.getString("id"), at)
        }
        NotifStore.saveItems(ctx, keep)
    }

    /** An alarm went off. */
    @Synchronized
    fun onFire(ctx: Context, id: String) {
        val arr = NotifStore.items(ctx)
        var idx = -1
        for (i in 0 until arr.length()) if (arr.getJSONObject(i).getString("id") == id) { idx = i; break }
        if (idx < 0) return                                  // deleted / completed / changed → nothing to show

        val it = arr.getJSONObject(idx)
        val at = it.getLong("at")
        val now = System.currentTimeMillis()
        val weekly = it.optBoolean("weekly")
        val cat = it.optString("cat")

        val tooLate = now - at > 30 * 60 * 1000L             // phone was off / asleep: don't announce a class that is over
        val holiday = weekly && cat == "class" && NotifStore.skip(ctx).contains(istDate(at))

        if (!tooLate && !holiday) {
            val e = Entry(
                id = "$id@$at",                              // unique per occurrence → no duplicates, but every week still shows
                title = it.optString("title"),
                body = it.optString("body"),
                cat = cat,
                channel = it.optString("ch", Notifs.IMPORTANT),
                route = it.optString("route"),
                ref = it.optString("ref"),
                sub = "",
                ts = now
            )
            if (NotifStore.addPending(ctx, e)) {
                Notifs.show(ctx, e)
                AppState.onHistoryChanged?.invoke()
            }
        }

        if (weekly) {
            var next = at + WEEK
            while (next <= now) next += WEEK
            it.put("at", next)
            arr.put(idx, it)
            schedule(ctx, id, next)
        } else {
            arr.remove(idx)
        }
        NotifStore.saveItems(ctx, arr)
    }
}
