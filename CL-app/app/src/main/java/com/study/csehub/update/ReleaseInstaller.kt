package com.study.csehub.update

import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.Locale
import java.util.zip.ZipInputStream

/** The release is not what the publisher promised (corrupt, tampered, unsafe). Never retried blindly. */
class ReleaseException(message: String) : Exception(message)

/** The server answered with an unexpected HTTP status. */
class HttpStatusException(val code: Int) : IOException("HTTP $code")

object PathRules {
    /** True only for plain relative paths: no "..", no absolute paths, no backslashes, no drive letters, no control chars. */
    fun isSafeEntryName(name: String): Boolean {
        if (name.isEmpty() || name.length > 240) return false
        if (name.startsWith("/") || name.contains('\\') || name.contains(':')) return false
        if (name.any { it.code < 32 || it.code == 127 }) return false
        val trimmed = name.removeSuffix("/")
        if (trimmed.isEmpty()) return false
        for (seg in trimmed.split('/')) {
            if (seg.isEmpty() || seg == "." || seg == "..") return false
            if (seg.endsWith(".") || seg.endsWith(" ")) return false
        }
        return true
    }
}

/** Download, verification and safe extraction of one release ZIP. Pure JVM (no Android classes) so it is unit-testable. */
object ReleaseInstaller {
    private val HEX64 = Regex("^[0-9a-f]{64}$")

    // ------------------------------------------------------------------ hashing
    fun sha256(file: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        FileInputStream(file).use { ins ->
            val buf = ByteArray(64 * 1024)
            while (true) { val n = ins.read(buf); if (n < 0) break; md.update(buf, 0, n) }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    // ------------------------------------------------------------------ network (HTTPS + allow-listed hosts only)
    private fun requireAllowed(u: URL) {
        if (u.protocol != "https") throw ReleaseException("refusing non-HTTPS URL")
        if (u.host.lowercase(Locale.ROOT) !in UpdateConfig.ALLOWED_HOSTS) throw ReleaseException("host not allowed: ${u.host}")
        if (u.userInfo != null || (u.port != -1 && u.port != 443)) throw ReleaseException("URL authority not allowed")
    }

    private fun open(url: String, rangeStart: Long, identityEncoding: Boolean): HttpURLConnection {
        var current = url
        for (hop in 0..UpdateConfig.MAX_REDIRECTS) {
            val u = URL(current)
            requireAllowed(u)
            val c = u.openConnection() as HttpURLConnection
            c.instanceFollowRedirects = false          // every hop is re-checked against the allow-list
            c.connectTimeout = UpdateConfig.CONNECT_TIMEOUT_MS
            c.readTimeout = UpdateConfig.READ_TIMEOUT_MS
            c.useCaches = false
            c.setRequestProperty("Cache-Control", "no-cache, no-store, must-revalidate")
            c.setRequestProperty("Pragma", "no-cache")
            if (identityEncoding) c.setRequestProperty("Accept-Encoding", "identity")
            if (rangeStart > 0) c.setRequestProperty("Range", "bytes=$rangeStart-")
            val code = c.responseCode
            if (code == 301 || code == 302 || code == 303 || code == 307 || code == 308) {
                val loc = c.getHeaderField("Location") ?: throw IOException("redirect without Location")
                c.disconnect()
                current = URL(u, loc).toString()
                continue
            }
            return c
        }
        throw IOException("too many redirects")
    }

    /** Small GET (the manifest). Cache-busting query + no-cache headers are added by the caller / [open]. */
    fun httpGet(url: String, maxBytes: Int): ByteArray {
        val c = open(url, 0L, false)
        try {
            if (c.responseCode != 200) throw HttpStatusException(c.responseCode)
            val out = ByteArrayOutputStream()
            c.inputStream.use { ins ->
                val buf = ByteArray(4096)
                while (true) {
                    val n = ins.read(buf); if (n < 0) break
                    if (out.size() + n > maxBytes) throw ReleaseException("response too large")
                    out.write(buf, 0, n)
                }
            }
            return out.toByteArray()
        } finally { c.disconnect() }
    }

    /**
     * Downloads [url] into [part]; resumes a previous partial file with an HTTP Range request.
     * Returns normally only when exactly [expectedSize] bytes are on disk (the caller then checks SHA-256).
     * An interrupted download keeps [part] so the next attempt continues where it stopped.
     */
    fun download(url: String, part: File, expectedSize: Long, onProgress: (Long, Long) -> Unit) {
        var offset = if (part.isFile) part.length() else 0L
        if (offset > expectedSize) { part.delete(); offset = 0L }
        if (offset == expectedSize) { onProgress(expectedSize, expectedSize); return }

        val c = open(url, offset, true)
        try {
            val code = c.responseCode
            val append: Boolean
            when (code) {
                206 -> {
                    val range = c.getHeaderField("Content-Range") ?: ""
                    if (!range.startsWith("bytes $offset-")) { part.delete(); throw IOException("unexpected Content-Range") }
                    append = true
                }
                200 -> {
                    val len = c.contentLengthLong
                    if (len >= 0 && len != expectedSize) throw ReleaseException("server file size differs from manifest")
                    append = false; offset = 0L        // server ignored Range: start over
                }
                416 -> { part.delete(); throw IOException("range not satisfiable, restarting next time") }
                else -> throw HttpStatusException(code)
            }
            var written = offset
            part.parentFile?.mkdirs()
            FileOutputStream(part, append).use { fos ->
                c.inputStream.use { ins ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = ins.read(buf); if (n < 0) break
                        written += n
                        if (written > expectedSize) { fos.close(); part.delete(); throw ReleaseException("download is larger than the manifest says") }
                        fos.write(buf, 0, n)
                        onProgress(written, expectedSize)
                    }
                }
                fos.flush(); fos.fd.sync()
            }
            if (written != expectedSize) throw IOException("incomplete download ($written of $expectedSize bytes)")
        } finally { c.disconnect() }
    }

    // ------------------------------------------------------------------ safe extraction
    /** Extracts [zip] into [dest]. Rejects path traversal, absolute paths, duplicates, zip bombs and oversized files. */
    fun extract(zip: File, dest: File) {
        if (!dest.isDirectory && !dest.mkdirs()) throw IOException("cannot create $dest")
        val root = dest.canonicalFile
        val seen = HashSet<String>()
        var entries = 0
        var total = 0L
        ZipInputStream(BufferedInputStream(FileInputStream(zip))).use { zis ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val e = zis.nextEntry ?: break
                if (++entries > UpdateConfig.MAX_ENTRIES) throw ReleaseException("too many files in release")
                val name = e.name
                if (!PathRules.isSafeEntryName(name)) throw ReleaseException("unsafe path in ZIP: ${name.take(80)}")
                val plain = name.removeSuffix("/")
                if (!seen.add(plain.lowercase(Locale.ROOT))) throw ReleaseException("duplicate path in ZIP: $plain")
                val out = File(root, plain).canonicalFile
                if (!out.path.startsWith(root.path + File.separator)) throw ReleaseException("path traversal blocked: $plain")
                if (e.isDirectory) {
                    if (!out.isDirectory && !out.mkdirs()) throw IOException("cannot create $plain")
                    continue
                }
                val parent = out.parentFile ?: throw ReleaseException("bad path: $plain")
                if (!parent.isDirectory && !parent.mkdirs()) throw IOException("cannot create folder for $plain")
                var fileBytes = 0L
                FileOutputStream(out).use { fos ->
                    while (true) {
                        val n = zis.read(buf); if (n < 0) break
                        fileBytes += n; total += n
                        if (fileBytes > UpdateConfig.MAX_FILE_BYTES || total > UpdateConfig.MAX_UNPACKED_BYTES) throw ReleaseException("release is too large when unpacked")
                        fos.write(buf, 0, n)
                    }
                }
            }
        }
        if (entries == 0) throw ReleaseException("empty ZIP")
    }

    // ------------------------------------------------------------------ release validation
    /**
     * Checks a release folder against its own release.json (file list with sizes + SHA-256).
     * full = true  : every file hashed, no unlisted files allowed (used right after extraction).
     * full = false : release.json + entry + every file present with the right size (used at each app launch, no hashing).
     */
    fun validateRelease(dir: File, expectedVersion: String, full: Boolean) {
        val meta = File(dir, "release.json")
        if (!meta.isFile || meta.length() > 4_000_000) throw ReleaseException("release.json missing")
        val j = try { JSONObject(meta.readText(Charsets.UTF_8)) } catch (e: Exception) { throw ReleaseException("release.json unreadable") }
        if (j.optInt("schema", -1) != 1) throw ReleaseException("unsupported release.json schema")
        if (j.optString("version") != expectedVersion) throw ReleaseException("release.json version mismatch")
        val entry = j.optString("entry")
        val arr = j.optJSONArray("files") ?: throw ReleaseException("release.json has no file list")
        if (arr.length() == 0 || arr.length() > UpdateConfig.MAX_ENTRIES) throw ReleaseException("bad file list")

        val root = dir.canonicalFile
        val listed = HashSet<String>()
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: throw ReleaseException("bad file entry")
            val p = o.optString("path")
            val size = o.optLong("size", -1L)
            val sha = o.optString("sha256")
            if (!PathRules.isSafeEntryName(p) || p.endsWith("/") || p == "release.json") throw ReleaseException("bad file path in release.json")
            if (!listed.add(p)) throw ReleaseException("duplicate file in release.json")
            if (size < 0 || !HEX64.matches(sha)) throw ReleaseException("bad file metadata: $p")
            val f = File(root, p).canonicalFile
            if (!f.path.startsWith(root.path + File.separator) || !f.isFile) throw ReleaseException("required file missing: $p")
            if (f.length() != size) throw ReleaseException("file size mismatch: $p")
            if (full && sha256(f) != sha) throw ReleaseException("file hash mismatch: $p")
        }
        if (entry.isEmpty() || entry !in listed) throw ReleaseException("entry page missing")
        if (full) {
            root.walkTopDown().filter { it.isFile }.forEach { f ->
                val rel = f.relativeTo(root).path.replace(File.separatorChar, '/')
                if (rel != "release.json" && rel !in listed) throw ReleaseException("unexpected file in release: $rel")
            }
        }
    }
}
