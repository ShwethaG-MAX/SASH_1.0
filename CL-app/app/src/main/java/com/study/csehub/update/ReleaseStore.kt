package com.study.csehub.update

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException

/** What the APK itself ships in assets/ (the seed copy of the website). */
class BundledInfo(val version: Semver)

/**
 * App-private storage of downloaded website releases.
 *
 *   <filesDir>/webreleases/releases/<version>/   verified, ready-to-serve releases
 *   <filesDir>/webreleases/staging/              downloads + extraction in progress (never served)
 *   <filesDir>/webreleases/state.json            the ONLY pointer: which release is active (atomic rename = commit point)
 *
 * A release becomes visible to the app only through [commit], after it was verified and moved into place,
 * so the app can never be left on a half-installed website.
 */
class ReleaseStore(val baseDir: File) {

    data class State(
        val active: String? = null,           // null = use the website bundled in the APK
        val previous: String? = null,         // known-good fallback (null = bundled)
        val confirmed: Boolean = true,        // has the ACTIVE release proven it starts correctly?
        val attempts: Int = 0,                // launches of the active release while still unconfirmed
        val blocked: List<String> = emptyList() // versions that failed and must not be re-installed automatically
    )

    sealed class Root {
        data class Local(val version: String, val dir: File) : Root()
        object Bundled : Root()
        object None : Root()          // nothing to show: first-install screen
    }

    val releasesDir = File(baseDir, "releases")
    val stagingDir = File(baseDir, "staging")
    private val stateFile = File(baseDir, "state.json")

    init { releasesDir.mkdirs(); stagingDir.mkdirs() }

    // ------------------------------------------------------------------ state persistence
    @Synchronized fun state(): State = readState()

    private fun readState(): State {
        return try {
            if (!stateFile.isFile) return State()
            val j = JSONObject(stateFile.readText(Charsets.UTF_8))
            val blocked = ArrayList<String>()
            j.optJSONArray("blocked")?.let { a ->
                for (i in 0 until a.length()) {
                    val v = a.optString(i)
                    if (v.isNotEmpty()) blocked.add(v)
                }
            }
            State(
                active = j.optString("active").ifEmpty { null }?.takeIf { Semver.parseOrNull(it) != null },
                previous = j.optString("previous").ifEmpty { null }?.takeIf { Semver.parseOrNull(it) != null },
                confirmed = j.optBoolean("confirmed", true),
                attempts = j.optInt("attempts", 0),
                blocked = blocked
            )
        } catch (e: Exception) {
            Log.w(TAG, "state.json unreadable, falling back to bundled site", e)
            State()
        }
    }

    private fun writeState(s: State) {
        val j = JSONObject()
            .put("active", s.active ?: "")
            .put("previous", s.previous ?: "")
            .put("confirmed", s.confirmed)
            .put("attempts", s.attempts)
            .put("blocked", JSONArray(s.blocked))
        val tmp = File(baseDir, "state.json.tmp")
        FileOutputStream(tmp).use { it.write(j.toString().toByteArray(Charsets.UTF_8)); it.flush(); it.fd.sync() }
        if (!tmp.renameTo(stateFile)) throw IOException("cannot update state.json")   // atomic replace
    }

    // ------------------------------------------------------------------ launch
    /**
     * Decides what the WebView serves for THIS session and counts the launch.
     * Handles: newer bundled site after an app update, crash-loop rollback, on-disk corruption.
     */
    @Synchronized fun launchRoot(bundled: BundledInfo?): Root {
        var s = readState()
        try {
            val activeV = s.active?.let { Semver.parseOrNull(it) }
            if (s.active != null && (activeV == null || (bundled != null && bundled.version > activeV))) {
                Log.i(TAG, "Dropping downloaded release ${s.active}: the installed app ships a newer/equal bundled site")
                s = s.copy(active = null, previous = null, confirmed = true, attempts = 0)
                writeState(s)
            }
            if (s.active != null && !s.confirmed && s.attempts >= UpdateConfig.MAX_UNCONFIRMED_LAUNCHES) {
                Log.w(TAG, "Release ${s.active} never confirmed healthy after ${s.attempts} launches -> rollback")
                s = rollbackLocked(s, block = true)
            }
            while (s.active != null && !isQuickValid(s.active!!)) {
                Log.w(TAG, "Release ${s.active} failed integrity check -> rollback")
                s = rollbackLocked(s, block = false)
            }
            if (s.active != null && !s.confirmed) { s = s.copy(attempts = s.attempts + 1); writeState(s) }
        } catch (e: Exception) {
            Log.e(TAG, "launchRoot failed, using bundled site", e)
            s = State()
        }
        val a = s.active
        return when {
            a != null -> Root.Local(a, File(releasesDir, a))
            bundled != null -> Root.Bundled
            else -> Root.None
        }
    }

    /** The release is running fine: stop counting launches and free disk space. */
    @Synchronized fun confirmHealthy(version: String) {
        val s = readState()
        if (s.active == version && !s.confirmed) {
            writeState(s.copy(confirmed = true, attempts = 0))
            Log.i(TAG, "Release $version confirmed healthy")
        }
        cleanupLocked()
    }

    /** Rolls back from the active release to the previous known-good one (or the bundled site). */
    @Synchronized fun rollback(block: Boolean = true) {
        val s = readState()
        if (s.active == null) return
        writeState(rollbackLocked(s, block))
    }

    private fun rollbackLocked(s: State, block: Boolean): State {
        val bad = s.active
        val blocked = if (block && bad != null) (s.blocked + bad).distinct().takeLast(10) else s.blocked
        val next = State(active = s.previous, previous = null, confirmed = true, attempts = 0, blocked = blocked)
        writeState(next)
        if (bad != null) File(releasesDir, bad).deleteRecursively()
        return next
    }

    // ------------------------------------------------------------------ install / activate
    fun isInstalled(version: String): Boolean = isQuickValid(version)

    private fun isQuickValid(version: String): Boolean = try {
        ReleaseInstaller.validateRelease(File(releasesDir, version), version, full = false); true
    } catch (e: Exception) { false }

    /** Moves a fully verified staging folder into releases/<version> (atomic rename on the same file system). */
    @Synchronized fun install(version: String, verifiedStaging: File) {
        val target = File(releasesDir, version)
        if (target.exists() && !target.deleteRecursively()) throw IOException("cannot replace $version")
        if (!verifiedStaging.renameTo(target)) throw IOException("cannot move release into place")
    }

    /** Makes an installed release the active one for the NEXT launch (or an explicit in-app switch). */
    @Synchronized fun commit(version: String) {
        val s = readState()
        if (s.active == version) return
        // Only a confirmed release may serve as rollback target; skip an unconfirmed one.
        val fallback = if (s.confirmed) s.active else s.previous
        writeState(State(active = version, previous = fallback, confirmed = false, attempts = 0, blocked = s.blocked - version))
        Log.i(TAG, "Activated release $version (previous: ${fallback ?: "bundled"})")
    }

    /** Version that the NEXT launch will use, if it differs from what the running session serves. */
    @Synchronized fun pendingVersion(serving: Root): String? {
        val a = readState().active ?: return null
        return if (serving is Root.Local && serving.version == a) null else a
    }

    // ------------------------------------------------------------------ cleanup
    @Synchronized fun cleanup() = cleanupLocked()

    private fun cleanupLocked() {
        val s = readState()
        val keep = setOfNotNull(s.active, s.previous)
        releasesDir.listFiles()?.forEach { if (it.name !in keep) it.deleteRecursively() }
        val cutoff = System.currentTimeMillis() - 24L * 3600 * 1000
        stagingDir.listFiles()?.forEach { if (it.lastModified() < cutoff) it.deleteRecursively() }
        File(baseDir, "state.json.tmp").delete()
    }

    companion object {
        private const val TAG = "CseUpdate"
        @Volatile private var instance: ReleaseStore? = null
        fun get(context: android.content.Context): ReleaseStore =
            instance ?: synchronized(this) {
                instance ?: ReleaseStore(File(context.applicationContext.filesDir, "webreleases")).also { instance = it }
            }
    }
}
