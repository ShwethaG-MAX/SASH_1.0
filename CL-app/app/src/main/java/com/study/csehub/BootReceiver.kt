package com.study.csehub

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Re-arms the reminders after a reboot, an app update, or when the "exact alarms" permission changes. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        ReminderScheduler.rescheduleAll(context.applicationContext)
    }
}
