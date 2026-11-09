package com.study.csehub.update

import android.app.Activity
import android.view.View
import android.widget.Button
import android.widget.TextView
import android.widget.Toast
import com.google.android.material.progressindicator.LinearProgressIndicator
import com.google.android.material.snackbar.Snackbar
import com.study.csehub.R

/**
 * All native update feedback, kept out of MainActivity:
 *  - slim progress line at the top while a download runs (page stays fully usable)
 *  - "Downloading Cse Hub update..." / "Cse Hub is up to date!" / "Update unavailable. Continuing with your current offline version."
 *  - full-screen first-installation / offline-install screen, only when the APK ships no website and none is installed yet
 */
class UpdateUi(
    private val activity: Activity,
    private val anchor: View,
    private val store: ReleaseStore,
    private val servingRoot: () -> ReleaseStore.Root,
    private val onApply: () -> Unit,
    private val onRetryInstall: () -> Unit
) {
    private val bar: LinearProgressIndicator = activity.findViewById(R.id.updateProgress)
    private val overlay: View = activity.findViewById(R.id.installOverlay)
    private val title: TextView = activity.findViewById(R.id.installTitle)
    private val message: TextView = activity.findViewById(R.id.installMessage)
    private val installBar: LinearProgressIndicator = activity.findViewById(R.id.installProgress)
    private val retry: Button = activity.findViewById(R.id.installRetry)

    private var toastShown = false
    private var announced: String? = null

    val firstInstallMode: Boolean get() = overlay.visibility == View.VISIBLE

    init { retry.setOnClickListener { showInstalling(); onRetryInstall() } }

    // ---------------------------------------------------------------- first-installation screen
    fun showInstalling() {
        overlay.visibility = View.VISIBLE
        title.setText(R.string.install_title)
        message.setText(R.string.install_message)
        installBar.isIndeterminate = true
        installBar.visibility = View.VISIBLE
        retry.visibility = View.GONE
    }

    private fun showInstallProblem(messageRes: Int) {
        overlay.visibility = View.VISIBLE
        title.setText(R.string.install_title)
        message.setText(messageRes)
        installBar.visibility = View.GONE
        retry.visibility = View.VISIBLE
    }

    fun hideInstallOverlay() { overlay.visibility = View.GONE }

    // ---------------------------------------------------------------- status stream from UpdateManager (main thread)
    fun onStatus(s: UpdateManager.Status) {
        if (activity.isFinishing || activity.isDestroyed) return
        when (s) {
            is UpdateManager.Status.Downloading -> {
                if (firstInstallMode) {
                    installBar.isIndeterminate = false
                    installBar.visibility = View.VISIBLE
                    installBar.setProgressCompat(s.percent, true)
                    message.setText(R.string.install_downloading)
                } else {
                    bar.visibility = View.VISIBLE
                    bar.isIndeterminate = false
                    bar.setProgressCompat(s.percent, true)
                    if (!toastShown) { toastShown = true; Toast.makeText(activity, R.string.update_downloading, Toast.LENGTH_SHORT).show() }
                }
            }
            is UpdateManager.Status.Verifying -> {
                if (firstInstallMode) installBar.isIndeterminate = true
                else { bar.visibility = View.VISIBLE; bar.isIndeterminate = true }
            }
            is UpdateManager.Status.Ready -> {
                bar.visibility = View.GONE
                toastShown = false
                if (firstInstallMode) { hideInstallOverlay(); onApply() }
                else if (store.pendingVersion(servingRoot()) != null && announced != s.version) {
                    announced = s.version
                    Snackbar.make(anchor, R.string.update_ready, Snackbar.LENGTH_LONG)
                        .setAction(R.string.update_reload) { onApply() }
                        .show()
                }
            }
            is UpdateManager.Status.UpToDate -> {
                bar.visibility = View.GONE; toastShown = false
                if (firstInstallMode) showInstallProblem(R.string.install_unavailable)
            }
            is UpdateManager.Status.Offline -> {
                bar.visibility = View.GONE; toastShown = false
                if (firstInstallMode) showInstallProblem(R.string.install_offline)   // normal case offline: stay silent otherwise
            }
            is UpdateManager.Status.Failed -> {
                bar.visibility = View.GONE; toastShown = false
                if (firstInstallMode) showInstallProblem(R.string.install_failed)
                else if (s.visible) Snackbar.make(anchor, R.string.update_failed, Snackbar.LENGTH_LONG).show()
            }
            UpdateManager.Status.Checking, UpdateManager.Status.Idle -> Unit
        }
    }
}
