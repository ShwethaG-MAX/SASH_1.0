package com.study.csehub

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.Properties

/**
 * Persistent, verified local copies of chat documents.
 * No Android imports on purpose, so the logic can be tested on a plain JVM.
 *
 * Layout (one folder per file ID, so two different files with the same name never collide):
 *   <root>/<sha1(fileId)>/<name>             the finished file
 *   <root>/<sha1(fileId)>/<name>.part        a download in progress (resumed with a Range request after an interruption)
 *   <root>/<sha1(fileId)>/meta.properties    written LAST; "download complete" = this file exists AND the file size matches it
 *   <root>/<sha1(fileId)>/exported           where the copy in the public Downloads folder lives (survives a repair of the local copy)
 */
class ChatDocStore(private val root: File) {

    private fun sha1(s: String): String =
        MessageDigest.getInstance("SHA-1").digest(s.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

    private fun dirFor(fileId: String): File = File(root, sha1(fileId))

    private fun readMeta(dir: File): Properties? {
        val f = File(dir, META)
        if (!f.isFile) return null
        return try { Properties().also { p -> f.inputStream().use { p.load(it) } } } catch (e: Exception) { null }
    }

    private fun writeMeta(dir: File, p: Properties) {
        val tmp = File(dir, "$META.tmp")
        tmp.outputStream().use { p.store(it, null) }
        val dst = File(dir, META)
        dst.delete()
        if (!tmp.renameTo(dst)) throw IOException("can't save file info")
    }

    /** PDFs must start with %PDF- (within the first 1 KB, as the spec allows). Other types are not inspected. */
    private fun contentOk(f: File, mime: String): Boolean {
        val isPdf = mime.contains("pdf", ignoreCase = true) || f.name.removeSuffix(".part").endsWith(".pdf", ignoreCase = true)
        if (!isPdf) return true
        return try {
            f.inputStream().use { ins ->
                val b = ByteArray(1024); val n = ins.read(b)
                n >= 5 && String(b, 0, n, Charsets.ISO_8859_1).contains("%PDF-")
            }
        } catch (e: Exception) { false }
    }

    /**
     * The local copy for [fileId] if (and only if) it is complete and intact; otherwise null.
     * A copy that is missing, truncated, unreadable or not a real PDF is removed here, so the caller can safely fetch a fresh one.
     * A resumable ".part" file is left alone.
     */
    @Synchronized
    fun validFile(fileId: String): File? {
        val dir = dirFor(fileId)
        if (!dir.isDirectory) return null
        val meta = readMeta(dir)
        val name = meta?.getProperty("name")
        val size = meta?.getProperty("size")?.toLongOrNull()
        val f = if (name != null) File(dir, name) else null
        if (meta != null && f != null && f.isFile && size != null && size > 0 && f.length() == size &&
            contentOk(f, meta.getProperty("mime") ?: "")) return f
        dir.listFiles()?.forEach { if (!it.name.endsWith(".part") && it.name != EXPORTED) it.delete() }
        return null
    }

    /** Remember that the file was just used (so "unused for 30 days" cleanup does not remove something people still open). */
    @Synchronized
    fun touch(fileId: String) { File(dirFor(fileId), META).setLastModified(System.currentTimeMillis()) }

    @Synchronized
    fun exportedRef(fileId: String): String? =
        try { File(dirFor(fileId), EXPORTED).takeIf { it.isFile }?.readText()?.trim()?.ifEmpty { null } } catch (e: Exception) { null }

    @Synchronized
    fun setExported(fileId: String, ref: String) {
        val dir = dirFor(fileId); dir.mkdirs(); File(dir, EXPORTED).writeText(ref)
    }

    /**
     * Returns the verified local file, downloading it only if there is no valid copy yet.
     * - Writes to "<name>.part" and renames it only after the size and content checks pass (never a half file under the real name).
     * - If a previous attempt was interrupted, continues it with an HTTP Range request (falls back to a clean restart).
     * - [onProgress] receives (bytesSoFar, totalBytesOrMinus1).
     * Throws IOException with a short human-readable message on failure.
     */
    fun download(fileId: String, url: String, name: String, mime: String, expected: Long, onProgress: (Long, Long) -> Unit): File {
        validFile(fileId)?.let { return it }
        val dir = dirFor(fileId); dir.mkdirs()
        val part = File(dir, "$name.part")
        dir.listFiles()?.forEach { if (it.name.endsWith(".part") && it.name != part.name) it.delete() }

        var restarted = false
        while (true) {
            val from = if (part.isFile) part.length() else 0L
            val c = URL(url).openConnection() as HttpURLConnection
            c.connectTimeout = 15000; c.readTimeout = 30000; c.instanceFollowRedirects = true
            c.setRequestProperty("Accept-Encoding", "identity")      // bytes on the wire == bytes in the file, so sizes and offsets are exact
            if (from > 0) c.setRequestProperty("Range", "bytes=$from-")
            try {
                val code = c.responseCode
                if (code == 416 && from > 0 && !restarted) { part.delete(); restarted = true; continue }
                val append: Boolean
                var total: Long
                when (code) {
                    200 -> { append = false; total = c.contentLengthLong }                       // fresh start (or the server ignored Range)
                    206 -> {
                        append = true
                        total = (c.getHeaderField("Content-Range") ?: "").substringAfterLast('/').trim().toLongOrNull()
                            ?: c.contentLengthLong.let { if (it >= 0) from + it else -1L }
                    }
                    else -> throw IOException("server said $code")
                }
                val ct = (c.contentType ?: "").lowercase()
                if (ct.startsWith("text/html") && !mime.startsWith("text/html")) { part.delete(); throw IOException("not a file (got a web page)") }
                if (total <= 0 && expected > 0) total = expected
                val have = if (append) from else 0L
                if (total > 0 && dir.usableSpace < total - have + 1_048_576L) throw IOException("not enough storage space")

                var written = have
                FileOutputStream(part, append).use { out ->
                    c.inputStream.use { ins ->
                        val buf = ByteArray(64 * 1024)
                        while (true) {
                            val r = ins.read(buf); if (r < 0) break
                            out.write(buf, 0, r); written += r
                            onProgress(written, total)
                        }
                    }
                    out.fd.sync()                                                              // on disk before we call it complete
                }
                if (total > 0 && written < total) throw IOException("incomplete download")      // .part is kept: the next try resumes
                if (total > 0 && written > total) { part.delete(); throw IOException("corrupted download") }
                if (written == 0L) { part.delete(); throw IOException("empty file") }
                if (!contentOk(part, mime)) { part.delete(); throw IOException("downloaded file is damaged (not a valid PDF)") }

                synchronized(this) {
                    val fin = File(dir, name)
                    fin.delete()
                    if (!part.renameTo(fin)) throw IOException("can't save file")
                    val p = Properties()
                    p.setProperty("name", name); p.setProperty("size", fin.length().toString()); p.setProperty("mime", mime)
                    writeMeta(dir, p)
                    return fin
                }
            } finally { c.disconnect() }
        }
    }

    /** Removes copies not used for [maxAgeMs] and abandoned partial downloads. Call occasionally, off the main thread. */
    @Synchronized
    fun prune(maxAgeMs: Long) {
        val now = System.currentTimeMillis()
        root.listFiles()?.forEach { d ->
            if (!d.isDirectory) return@forEach
            val last = d.listFiles()?.maxOfOrNull { it.lastModified() } ?: 0L
            if (now - last > maxAgeMs) d.deleteRecursively()
        }
    }

    companion object {
        private const val META = "meta.properties"
        private const val EXPORTED = "exported"
    }
}

/**
 * "Only one download per file" bookkeeping. The first caller for a file ID becomes the starter;
 * everyone who asks while it runs just joins the list and is answered when the single download ends.
 * A second request from the same waiter (same key, e.g. a repeated tap) replaces the first instead of being counted twice.
 */
class InflightRegistry<W : Any>(private val sameWaiter: (W, W) -> Boolean) {
    private val map = HashMap<String, MutableList<W>>()

    /** true = caller must start the download; false = a download is already running, this waiter was attached to it. */
    fun join(id: String, w: W): Boolean = synchronized(map) {
        val l = map[id]
        if (l == null) { map[id] = mutableListOf(w); true }
        else { l.removeAll { sameWaiter(it, w) }; l.add(w); false }
    }

    fun waiters(id: String): List<W> = synchronized(map) { map[id]?.toList() ?: emptyList() }

    /** Ends the download for [id] and returns everyone who was waiting for it. */
    fun complete(id: String): List<W> = synchronized(map) { map.remove(id) ?: emptyList() }
}