package com.study.csehub.update

import org.json.JSONException
import org.json.JSONObject
import java.net.URI

class ManifestException(message: String) : Exception(message)

/**
 * version.json, strictly validated:
 * {
 *   "schema": 1, "version": "1.2.0",
 *   "releaseUrl": "https://cse-c-hub.web.app/app-releases/1.2.0.zip",
 *   "sha256": "<64 lowercase hex of the ZIP>", "size": 123456,
 *   "minimumAppVersion": 8,            // APK versionCode needed to run this web release
 *   "rollback": false,                 // true = deliberately allow installing an OLDER version than the one in use
 *   "publishedAt": "2026-11-08T10:00:00Z",   // informational, not signed
 *   "signature": "<Base64 DER ECDSA-P256-SHA256 over signedPayload()>"
 * }
 */
class ReleaseManifest(
    val version: Semver,
    val releaseUrl: String,
    val sha256: String,
    val size: Long,
    val minimumAppVersion: Int,
    val rollback: Boolean,
    val signature: String
) {
    val versionString: String get() = version.toString()

    /** Exact bytes the publisher signed. MUST match signedPayload() in tools/release/release.mjs. */
    fun signedPayload(): ByteArray = listOf(
        "cse-hub-release-v1",
        versionString,
        releaseUrl,
        sha256,
        size.toString(),
        minimumAppVersion.toString(),
        rollback.toString()
    ).joinToString("\n").toByteArray(Charsets.UTF_8)

    companion object {
        private val HEX64 = Regex("^[0-9a-f]{64}$")

        fun parse(body: ByteArray): ReleaseManifest {
            if (body.isEmpty() || body.size > UpdateConfig.MAX_MANIFEST_BYTES) throw ManifestException("bad manifest size")
            val j = try { JSONObject(String(body, Charsets.UTF_8)) } catch (e: JSONException) { throw ManifestException("not JSON") }

            if (j.integer("schema") != 1L) throw ManifestException("unsupported schema")
            val versionText = j.text("version")
            val version = Semver.parseOrNull(versionText) ?: throw ManifestException("invalid version")
            if (version.toString() != versionText) throw ManifestException("non-canonical version")

            val url = j.text("releaseUrl")
            checkReleaseUrl(url, versionText)

            val sha = j.text("sha256")
            if (!HEX64.matches(sha)) throw ManifestException("invalid sha256")

            val size = j.integer("size")
            if (size < 1 || size > UpdateConfig.MAX_ZIP_BYTES) throw ManifestException("invalid size")

            val minApp = j.integer("minimumAppVersion")
            if (minApp < 1 || minApp > Int.MAX_VALUE) throw ManifestException("invalid minimumAppVersion")

            val rollbackRaw = j.opt("rollback")
            val rollback = when (rollbackRaw) {
                null, JSONObject.NULL -> false
                is Boolean -> rollbackRaw
                else -> throw ManifestException("invalid rollback flag")
            }

            val sig = j.text("signature")
            if (sig.length > 256) throw ManifestException("invalid signature")

            return ReleaseManifest(version, url, sha, size, minApp.toInt(), rollback, sig)
        }

        private fun checkReleaseUrl(url: String, version: String) {
            val u = try { URI(url) } catch (e: Exception) { throw ManifestException("invalid releaseUrl") }
            val host = u.host?.lowercase() ?: throw ManifestException("releaseUrl has no host")
            if (u.scheme != "https") throw ManifestException("releaseUrl must be https")
            if (host !in UpdateConfig.ALLOWED_HOSTS) throw ManifestException("releaseUrl host not allowed")
            if (u.userInfo != null || (u.port != -1 && u.port != 443)) throw ManifestException("releaseUrl authority not allowed")
            if (u.rawQuery != null || u.rawFragment != null) throw ManifestException("releaseUrl must be plain")
            if (u.rawPath != UpdateConfig.RELEASE_PATH_PREFIX + version + ".zip") throw ManifestException("releaseUrl path mismatch")
        }

        private fun JSONObject.text(key: String): String {
            val v = opt(key)
            if (v !is String || v.isEmpty()) throw ManifestException("missing or invalid '$key'")
            return v
        }

        private fun JSONObject.integer(key: String): Long = when (val v = opt(key)) {
            is Int -> v.toLong()
            is Long -> v
            else -> throw ManifestException("missing or invalid '$key'")
        }
    }
}
