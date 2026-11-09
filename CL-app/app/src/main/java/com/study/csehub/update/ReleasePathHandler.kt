package com.study.csehub.update

import android.webkit.MimeTypeMap
import android.webkit.WebResourceResponse
import androidx.webkit.WebViewAssetLoader
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileInputStream
import java.util.Locale

/**
 * Serves one downloaded release folder under https://appassets.androidplatform.net/assets/...
 * Same origin and same URL layout as the bundled assets, so localStorage / IndexedDB / auth sessions keep working.
 * No file:// access; every request is confined to the release folder.
 */
class ReleasePathHandler(root: File) : WebViewAssetLoader.PathHandler {
    private val root: File = root.canonicalFile

    override fun handle(path: String): WebResourceResponse? {
        var rel = path.trimStart('/')
        if (rel.isEmpty() || rel.endsWith("/")) rel += "index.html"
        if (!PathRules.isSafeEntryName(rel)) return notFound()
        val f = File(root, rel).canonicalFile
        if (!f.path.startsWith(root.path + File.separator) || !f.isFile) return notFound()
        val mime = mimeFor(rel)
        val charset = if (mime.startsWith("text/") || mime == "application/json" || mime == "image/svg+xml" || mime == "application/javascript") "utf-8" else null
        return try {
            WebResourceResponse(mime, charset, 200, "OK", HEADERS, FileInputStream(f))
        } catch (e: Exception) { notFound() }
    }

    private fun notFound() = WebResourceResponse(
        "text/plain", "utf-8", 404, "Not Found", HEADERS, ByteArrayInputStream("Not found".toByteArray())
    )

    private fun mimeFor(name: String): String {
        val ext = name.substringAfterLast('.', "").lowercase(Locale.ROOT)
        return KNOWN[ext] ?: MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "application/octet-stream"
    }

    companion object {
        private val HEADERS = mapOf("Cache-Control" to "no-cache", "X-Content-Type-Options" to "nosniff")
        private val KNOWN = mapOf(
            "html" to "text/html", "htm" to "text/html", "js" to "text/javascript", "mjs" to "text/javascript",
            "css" to "text/css", "json" to "application/json", "webmanifest" to "application/manifest+json",
            "svg" to "image/svg+xml", "png" to "image/png", "jpg" to "image/jpeg", "jpeg" to "image/jpeg",
            "gif" to "image/gif", "webp" to "image/webp", "ico" to "image/x-icon", "pdf" to "application/pdf",
            "woff" to "font/woff", "woff2" to "font/woff2", "ttf" to "font/ttf", "otf" to "font/otf",
            "txt" to "text/plain", "wasm" to "application/wasm", "mp3" to "audio/mpeg", "mp4" to "video/mp4"
        )
    }
}
