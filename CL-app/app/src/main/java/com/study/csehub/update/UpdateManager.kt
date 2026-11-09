package com.study.csehub.update

import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import java.io.File
import java.io.IOException
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import javax.net.ssl.SSLException

/**
 * The whole update pipeline: fetch + verify manifest -> compare versions -> download -> SHA-256 -> safe extract ->
 * validate -> atomically install -> activate. Runs on a background thread; never touches the page that is on screen.
 */
class UpdateManager private constructor(private val app: Context) {

    sealed class Status {
        object Idle : Status()
        object Checking : Status()
        data class Downloading(val percent: Int, val version: String) : Status()
        data class Verifying(val version: String) : Status()
        data class Ready(val version: String) : Status()           // installed + activated for next launch / in-app switch
        object UpToDate : Status()
        object Offline : Status()
        /** [visible] = worth telling the user (a real download/verification failure), as opposed to config problems. */
        data class Failed(val reason: String, val visible: Boolean) : Status()
    }

    enum class Outcome { UP_TO_DATE, INSTALLED, OFFLINE, FAILED, REJECTED, BUSY }

    fun interface Listener { fun onStatus(status: Status) }

    val store: ReleaseStore = ReleaseStore.get(app)
    private val listeners = CopyOnWriteArrayList<Listener>()
    private val main = Handler(Looper.getMainLooper())
    private val running = AtomicBoolean(false)
    private val executor = Executors.newSingleThreadExecutor { r -> Thread(r, "cse-update").apply { isDaemon = true } }
    @Volatile private var lastStatus: Status = Status.Idle
    @Volatile private var lastFinishedAt = 0L
    @Volatile private var lastOutcome: Outcome? = null

    // ------------------------------------------------------------------ listeners (always called on the main thread)
    fun addListener(l: Listener, replayLast: Boolean = false) {
        listeners.addIfAbsent(l)
        if (replayLast) { val s = lastStatus; main.post { l.onStatus(s) } }
    }
    fun removeListener(l: Listener) { listeners.remove(l) }

    private fun emit(s: Status) {
        lastStatus = s
        main.post { for (l in listeners) l.onStatus(s) }
    }

    // ------------------------------------------------------------------ entry points
    /** Fire-and-forget check on the update thread (used by the foreground UI and the connectivity monitor). */
    fun checkAsync(reason: String) {
        val now = System.currentTimeMillis()
        val recentlyOk = (lastOutcome == Outcome.UP_TO_DATE || lastOutcome == Outcome.INSTALLED) && now - lastFinishedAt < 60_000
        if (reason == "network" && (recentlyOk || now - lastFinishedAt < 3_000)) return   // connectivity flaps: do not hammer the server
        executor.execute { checkNow(reason) }
    }

    /** Blocking. Safe to call from a WorkManager worker or any background thread. Only one run at a time. */
    fun checkNow(reason: String): Outcome {
        if (!running.compareAndSet(false, true)) return Outcome.BUSY
        try {
            Log.i(TAG, "Update check ($reason)")
            val o = doCheck()
            lastOutcome = o; lastFinishedAt = System.currentTimeMillis()
            if (o == Outcome.OFFLINE || o == Outcome.FAILED) UpdateScheduler.enqueueWhenOnline(app)   // retry as soon as connectivity returns
            return o
        } catch (t: Throwable) {
            Log.e(TAG, "Update check crashed", t)
            emit(Status.Failed("unexpected error", true))
            lastOutcome = Outcome.FAILED; lastFinishedAt = System.currentTimeMillis()
            return Outcome.FAILED
        } finally { running.set(false) }
    }

    // ------------------------------------------------------------------ the pipeline
    private fun doCheck(): Outcome {
        emit(Status.Checking)
        store.cleanup()

        if (UpdateConfig.TRUSTED_PUBLIC_KEYS.isEmpty()) {
            Log.w(TAG, "No trusted signing key in UpdateConfig -> updates disabled (run: node tools/release/release.mjs init)")
            emit(Status.Failed("updates not configured", false)); return Outcome.REJECTED
        }

        // 1) manifest (cache-busting query + no-cache headers)
        val url = UpdateConfig.BASE_URL + UpdateConfig.MANIFEST_PATH + "?t=" + System.currentTimeMillis()
        val body = try { ReleaseInstaller.httpGet(url, UpdateConfig.MAX_MANIFEST_BYTES) }
        catch (e: HttpStatusException) {
            if (e.code == 404) { emit(Status.UpToDate); return Outcome.UP_TO_DATE }   // nothing published yet
            Log.w(TAG, "manifest HTTP ${e.code}"); emit(Status.Failed("server error ${e.code}", false)); return Outcome.FAILED
        } catch (e: ReleaseException) {
            Log.w(TAG, "manifest rejected: ${e.message}"); emit(Status.Failed("manifest rejected", false)); return Outcome.REJECTED
        } catch (e: IOException) {
            Log.i(TAG, "offline: ${e.javaClass.simpleName}"); emit(Status.Offline); return Outcome.OFFLINE
        }

        // 2) strict parse + signature
        val m = try { ReleaseManifest.parse(body) }
        catch (e: ManifestException) { Log.w(TAG, "malformed manifest: ${e.message}"); emit(Status.Failed("malformed manifest", false)); return Outcome.REJECTED }
        if (!ManifestVerifier.verify(m.signedPayload(), m.signature, UpdateConfig.TRUSTED_PUBLIC_KEYS)) {
            Log.e(TAG, "manifest signature INVALID - ignoring"); emit(Status.Failed("bad signature", false)); return Outcome.REJECTED
        }

        // 3) does this APK support the release?
        if (m.minimumAppVersion > appVersionCode()) {
            Log.i(TAG, "release ${m.versionString} needs app versionCode >= ${m.minimumAppVersion}"); emit(Status.UpToDate); return Outcome.REJECTED
        }

        // 4) semantic comparison against what is in use (downloaded release or bundled site, whichever is newer)
        val st = store.state()
        val activeV = st.active?.let { Semver.parseOrNull(it) }
        val bundledV = bundledInfo(app)?.version
        val current = listOfNotNull(activeV, bundledV).maxOrNull()
        val cmp = if (current == null) 1 else m.version.compareTo(current)
        if (cmp == 0) { emit(Status.UpToDate); return Outcome.UP_TO_DATE }
        if (cmp < 0) {
            if (!m.rollback) { Log.i(TAG, "ignoring older release ${m.versionString} (in use: $current)"); emit(Status.UpToDate); return Outcome.UP_TO_DATE }
            if (activeV != null && m.version == activeV) { emit(Status.UpToDate); return Outcome.UP_TO_DATE }
            if (bundledV != null && m.version < bundledV) { Log.w(TAG, "rollback below the bundled site is not possible"); emit(Status.UpToDate); return Outcome.REJECTED }
            Log.w(TAG, "explicit rollback to ${m.versionString}")
        } else if (m.versionString in st.blocked) {
            Log.w(TAG, "release ${m.versionString} previously failed on this device, skipping"); emit(Status.UpToDate); return Outcome.REJECTED
        }

        val v = m.versionString

        // 5) already downloaded earlier (e.g. verified but never switched)?
        if (store.isInstalled(v)) { store.commit(v); emit(Status.Ready(v)); return Outcome.INSTALLED }

        // 6) download -> verify -> extract -> validate -> install -> activate
        if (store.baseDir.usableSpace < m.size * 4 + 32L * 1024 * 1024) {
            emit(Status.Failed("not enough storage space", true)); return Outcome.FAILED
        }
        val part = File(store.stagingDir, "$v-${m.sha256.take(16)}.zip.part")
        val xdir = File(store.stagingDir, "x-$v")
        xdir.deleteRecursively()
        try {
            emit(Status.Downloading(0, v))
            var lastPct = -1
            ReleaseInstaller.download(m.releaseUrl, part, m.size) { done, total ->
                val pct = (done * 100 / total).toInt()
                if (pct != lastPct) { lastPct = pct; emit(Status.Downloading(pct, v)) }
            }
            emit(Status.Verifying(v))
            if (ReleaseInstaller.sha256(part) != m.sha256) { part.delete(); throw ReleaseException("checksum mismatch") }
            ReleaseInstaller.extract(part, xdir)
            ReleaseInstaller.validateRelease(xdir, v, full = true)
            store.install(v, xdir)
            store.commit(v)
            part.delete()
            Log.i(TAG, "Release $v installed and activated")
            emit(Status.Ready(v))
            return Outcome.INSTALLED
        } catch (e: ReleaseException) {
            Log.e(TAG, "release $v rejected: ${e.message}")
            xdir.deleteRecursively()
            emit(Status.Failed(e.message ?: "invalid release", true))
            return Outcome.FAILED
        } catch (e: IOException) {
            xdir.deleteRecursively()                       // the .part file is kept so the download can resume
            return if (isNetworkError(e)) { emit(Status.Offline); Outcome.OFFLINE }
            else { Log.w(TAG, "install failed", e); emit(Status.Failed(e.message ?: "I/O error", true)); Outcome.FAILED }
        }
    }

    private fun isNetworkError(e: IOException) =
        e is UnknownHostException || e is ConnectException || e is SocketTimeoutException || e is NoRouteToHostException ||
            e is SocketException || e is SSLException

    private fun appVersionCode(): Int = try {
        val pi = app.packageManager.getPackageInfo(app.packageName, 0)
        if (Build.VERSION.SDK_INT >= 28) pi.longVersionCode.toInt() else @Suppress("DEPRECATION") pi.versionCode
    } catch (e: Exception) { 1 }

    companion object {
        private const val TAG = "CseUpdate"
        @Volatile private var instance: UpdateManager? = null
        fun get(context: Context): UpdateManager =
            instance ?: synchronized(this) { instance ?: UpdateManager(context.applicationContext).also { instance = it } }

        /** null = this APK ships no website (first-install screen). Version comes from assets/release.json (0.0.0 if absent). */
        fun bundledInfo(context: Context): BundledInfo? {
            val am = context.assets
            try { am.open("index.html").close() } catch (e: IOException) { return null }
            val v = try {
                val text = am.open("release.json").use { it.readBytes().toString(Charsets.UTF_8) }
                Semver.parseOrNull(org.json.JSONObject(text).optString("version"))
            } catch (e: Exception) { null }
            return BundledInfo(v ?: Semver.parse("0.0.0"))
        }
    }
}
