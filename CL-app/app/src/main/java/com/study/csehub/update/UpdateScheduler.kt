package com.study.csehub.update

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequest
import androidx.work.PeriodicWorkRequest
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

/** Background update check (WorkManager). Runs even when the app is closed, only with a network connection. */
class UpdateWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        return when (UpdateManager.get(applicationContext).checkNow("worker")) {
            UpdateManager.Outcome.OFFLINE, UpdateManager.Outcome.FAILED, UpdateManager.Outcome.BUSY ->
                if (runAttemptCount < 5) Result.retry() else Result.success()   // the periodic job tries again later anyway
            else -> Result.success()
        }
    }
}

object UpdateScheduler {
    private const val PERIODIC = "cse_web_update_periodic"
    private const val WHEN_ONLINE = "cse_web_update_when_online"

    private fun connected() = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    /** Every few hours while a network is available. Call on every app start (idempotent). */
    fun schedulePeriodic(context: Context) {
        val req = PeriodicWorkRequest.Builder(UpdateWorker::class.java, UpdateConfig.PERIODIC_CHECK_HOURS, TimeUnit.HOURS)
            .setConstraints(connected())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 1, TimeUnit.MINUTES)
            .build()
        WorkManager.getInstance(context.applicationContext)
            .enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.UPDATE, req)
    }

    /** One check as soon as connectivity is back (queued while offline; survives app/process death and reboots). */
    fun enqueueWhenOnline(context: Context) {
        try {
            val req = OneTimeWorkRequest.Builder(UpdateWorker::class.java)
                .setConstraints(connected())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(context.applicationContext)
                .enqueueUniqueWork(WHEN_ONLINE, ExistingWorkPolicy.KEEP, req)
        } catch (e: Exception) { /* WorkManager unavailable: the periodic job and app-start checks still cover us */ }
    }
}

/**
 * Foreground connectivity monitor. [onOnline] is called when a network becomes available - including once right after
 * [start] if the device is already online, which doubles as the "check on app start" trigger.
 */
class NetworkMonitor(context: Context, private val onOnline: () -> Unit) {
    private val cm = context.applicationContext.getSystemService(ConnectivityManager::class.java)
    private var callback: ConnectivityManager.NetworkCallback? = null

    fun start() {
        if (callback != null || cm == null) return
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) { onOnline() }
        }
        try { cm.registerDefaultNetworkCallback(cb); callback = cb } catch (e: Exception) { /* missing permission or OEM quirk */ }
    }

    fun stop() {
        val cb = callback ?: return
        try { cm?.unregisterNetworkCallback(cb) } catch (e: Exception) { }
        callback = null
    }
}
