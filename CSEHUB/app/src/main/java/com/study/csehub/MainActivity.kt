package com.study.csehub

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.JsResult
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewAssetLoader
import org.json.JSONArray
import org.json.JSONObject
import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import com.google.firebase.messaging.FirebaseMessaging
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ContentValues
import android.os.Environment
import android.provider.MediaStore
import android.webkit.MimeTypeMap
import androidx.core.content.FileProvider
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
// ---- Native Google sign-in (Credential Manager) ----
import androidx.credentials.CredentialManager
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.lifecycle.lifecycleScope
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import kotlinx.coroutines.launch

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    @Volatile private var pageLoaded = false
    @Volatile private var launchRoute: String? = null

    // ---------- Save Backup: "Save as" dialog ----------
    private var pendingContent: String? = null
    private val createDoc = registerForActivityResult(
        ActivityResultContracts.CreateDocument("application/json")
    ) { uri: Uri? ->
        val content = pendingContent
        pendingContent = null
        if (uri != null && content != null) {
            try {
                contentResolver.openOutputStream(uri)?.use { it.write(content.toByteArray(Charsets.UTF_8)) }
                Toast.makeText(this, "✅ Backup saved", Toast.LENGTH_LONG).show()
            } catch (e: Exception) {
                Toast.makeText(this, "❌ Could not save backup", Toast.LENGTH_LONG).show()
            }
        }
    }

    // ---------- Load Backup / chat attachments: file picker ----------
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private val pickFile = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri: Uri? ->
        // Always answer the WebView exactly once (null = cancelled), otherwise the next <input type=file> tap can be ignored.
        filePathCallback?.onReceiveValue(if (uri != null) arrayOf(uri) else null)
        filePathCallback = null
    }

    // ---------- Notification permission (Android 13+) ----------
    private val notifPermLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) { _ ->
        js("window.__onNotifPermission&&window.__onNotifPermission('" + notifStatus() + "')")
    }

    // ---------- Chat documents: ONE persistent, verified copy per file ----------
    //
    //  * The copy lives in app-private storage:  filesDir/chat_docs/<hash of the file's ID>/<original name>
    //    (see ChatDocStore). It survives app restarts and is re-verified (exists, same size, real PDF) before every use.
    //  * "Open"     -> use that copy; download it first ONLY if there is no valid copy. Then hand it to a PDF viewer through FileProvider.
    //  * "Download" -> make sure that copy exists (download only if needed), then place ONE copy in the public Downloads folder.
    //                  Asking again just reports "exists" (the page offers to open it) - nothing is downloaded or copied twice.
    //  * Only one network download per file runs at a time; extra taps/buttons attach to it (InflightRegistry).
    // The page is told the real result through window.onChatFileResult(key, ok, info, status) and live progress through
    // window.onChatFileProgress(key, bytesDone, bytesTotal).
    private val io = Executors.newCachedThreadPool()
    private val docStore by lazy { ChatDocStore(File(filesDir, "chat_docs")) }
    private class Waiter(val key: String, val open: Boolean)
    private val inflight = InflightRegistry<Waiter> { a, b -> a.key == b.key }
    private val progressAt = ConcurrentHashMap<String, Long>()
    private val exportLock = Any()

    private data class PendingDl(val fileId: String, val url: String, val name: String, val mime: String, val size: Long, val key: String)
    private var pendingDl: PendingDl? = null
    private val storagePermLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        val d = pendingDl; pendingDl = null
        if (d != null) {
            if (ok) requestChatDoc(false, d.fileId, d.url, d.name, d.mime, d.size, d.key)
            else reportFile(d.key, false, "storage permission denied")
        }
    }

    private fun reportFile(key: String, ok: Boolean, info: String, status: String = "") {
        val k = JSONObject.quote(key); val i = JSONObject.quote(info); val s = JSONObject.quote(status)
        js("window.onChatFileResult&&window.onChatFileResult($k,$ok,$i,$s)")
    }

    /** Live progress for every button that is waiting on this file. Throttled to ~5 updates per second. */
    private fun progress(fileId: String, done: Long, total: Long) {
        val now = System.currentTimeMillis()
        val last = progressAt[fileId] ?: 0L
        if (now - last < 200 && done != total) return
        progressAt[fileId] = now
        for (w in inflight.waiters(fileId)) {
            js("window.onChatFileProgress&&window.onChatFileProgress(${JSONObject.quote(w.key)},$done,$total)")
        }
    }

    private fun okChatUrl(u: String) = try { val x = Uri.parse(u); x.scheme == "https" && x.host == "firebasestorage.googleapis.com" } catch (e: Exception) { false }
    private fun safeName(n: String): String {
        val s = n.replace(Regex("[\\\\/:*?\"<>|\\u0000-\\u001f]"), "_").trim().take(100)
        return if (s.isEmpty() || s == "." || s == "..") "file" else s
    }
    private fun mimeFor(name: String, m: String): String =
        if (m.isNotEmpty()) m else MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substringAfterLast('.', "").lowercase()) ?: "*/*"

    /** Short, human-readable reason. Messages like "server said 403" are passed through: the page uses them to refresh an expired link. */
    private fun friendly(t: Throwable): String {
        val m = (t.message ?: "").lowercase()
        return when {
            t is java.net.UnknownHostException || t is java.net.ConnectException -> "no internet connection"
            t is java.net.SocketTimeoutException -> "connection timed out"
            m.contains("enospc") || m.contains("no space left") || m.contains("not enough storage") -> "not enough storage space"
            else -> t.message ?: "error"
        }
    }

    /** Non-blocking. Called for both buttons ([open] = true for Open). Safe from any thread. */
    private fun requestChatDoc(open: Boolean, fileId: String, url: String, rawName: String, mime: String, size: Long, key: String) {
        io.execute {
            try { handleChatDoc(open, fileId, url, rawName, mime, size, key) }
            catch (t: Throwable) { reportFile(key, false, friendly(t)) }
        }
    }

    private fun handleChatDoc(open: Boolean, fileId: String, url: String, rawName: String, mime: String, size: Long, key: String) {
        if (fileId.isEmpty()) { reportFile(key, false, "missing file id"); return }
        val name = safeName(rawName); val type = mimeFor(name, mime)
        val me = Waiter(key, open)

        // 1) A valid local copy exists -> use it. No network request at all (this also works offline and with an expired link).
        val local = docStore.validFile(fileId)
        if (local != null) { finishChatDoc(me, fileId, local, name, type, url); return }

        // 2) No usable copy. The page normally passes the link; if it did not (it believed we had a copy), ask it for the link.
        if (url.isEmpty()) { reportFile(key, false, "need-url"); return }
        if (!okChatUrl(url)) { reportFile(key, false, "invalid file link"); return }

        // 3) ONE download per file. If one is already running, this tap just waits for it.
        if (!inflight.join(fileId, me)) return

        var file: File? = null; var err = "error"
        try {
            file = docStore.validFile(fileId)   // a download that finished a moment ago
                ?: docStore.download(fileId, url, name, type, size) { done, total -> progress(fileId, done, total) }
        } catch (t: Throwable) { err = friendly(t) }
        progressAt.remove(fileId)
        for (w in inflight.complete(fileId)) {
            if (file != null) finishChatDoc(w, fileId, file, name, type, url) else reportFile(w.key, false, err)
        }
    }

    private fun finishChatDoc(w: Waiter, fileId: String, file: File, name: String, type: String, url: String) {
        try {
            docStore.touch(fileId)
            if (w.open) openLocal(w.key, file, type, url)
            else {
                val fresh = exportToDownloads(fileId, file, name, type)
                reportFile(w.key, true, name, if (fresh) "saved" else "exists")
            }
        } catch (t: Throwable) { reportFile(w.key, false, friendly(t)) }
    }

    /** Opens the saved copy in a viewer app via FileProvider (a content:// URI - the raw path is never shared). */
    private fun openLocal(key: String, f: File, type: String, remoteUrl: String) {
        val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", f)
        val view = Intent(Intent.ACTION_VIEW).setDataAndType(uri, type).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        view.clipData = ClipData.newRawUri("", uri)
        runOnUiThread {
            var opened = false
            try { startActivity(view); opened = true }
            catch (e: ActivityNotFoundException) {
                // No PDF viewer installed: fall back to the phone's browser with the original link (only if the page gave us one).
                if (remoteUrl.isNotEmpty() && okChatUrl(remoteUrl)) {
                    try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(remoteUrl))); opened = true } catch (x: Exception) { }
                }
            }
            if (opened) reportFile(key, true, "", "opened")
            else reportFile(key, false, "no app can open this file type — install a PDF viewer")
        }
    }

    private fun exportStillThere(ref: String): Boolean = try {
        if (ref.startsWith("content://")) (contentResolver.openFileDescriptor(Uri.parse(ref), "r")?.use { true } ?: false)
        else File(ref).exists()
    } catch (e: Exception) { false }

    /**
     * Puts ONE copy of the (already verified) local file into the public Downloads folder, copying from local storage - no network.
     * Returns true if a copy was just created, false if one was already there from earlier.
     */
    private fun exportToDownloads(fileId: String, src: File, name: String, type: String): Boolean {
        return synchronized(exportLock) {
            val old = docStore.exportedRef(fileId)
            if (old != null && exportStillThere(old)) return false
            val ref: String
            if (Build.VERSION.SDK_INT >= 29) {
                // Android 10+: MediaStore.Downloads needs NO storage permission and the file shows up in Files > Downloads.
                val cv = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, name)
                    put(MediaStore.Downloads.MIME_TYPE, type)
                    put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
                    put(MediaStore.Downloads.IS_PENDING, 1)
                }
                val r = contentResolver
                val uri = r.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv) ?: throw java.io.IOException("can't create file")
                try {
                    r.openOutputStream(uri)!!.use { o -> src.inputStream().use { it.copyTo(o) } }
                    cv.clear(); cv.put(MediaStore.Downloads.IS_PENDING, 0); r.update(uri, cv, null, null)
                } catch (t: Throwable) { r.delete(uri, null, null); throw t }   // never leave an empty / partial file behind
                ref = uri.toString()
            } else {
                val dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS).apply { mkdirs() }
                var f = File(dir, name); var i = 1
                while (f.exists()) { f = File(dir, name.substringBeforeLast('.') + " ($i)." + name.substringAfterLast('.', "")); i++ }
                try { src.inputStream().use { ins -> f.outputStream().use { ins.copyTo(it) } } } catch (t: Throwable) { f.delete(); throw t }
                android.media.MediaScannerConnection.scanFile(this, arrayOf(f.path), arrayOf(type), null)
                ref = f.absolutePath
            }
            docStore.setExported(fileId, ref)
            true
        }
    }

    private fun js(code: String) {
        if (::webView.isInitialized) webView.post { webView.evaluateJavascript(code, null) }
    }

    /** granted | not_asked | denied */
    private fun notifStatus(): String {
        if (NotificationManagerCompat.from(this).areNotificationsEnabled()) return "granted"
        if (Build.VERSION.SDK_INT >= 33 && !NotifStore.asked(this)) return "not_asked"
        return "denied"
    }

    private fun launchNotifSettings(channel: String) {
        val i = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Intent(
                if (channel.isEmpty()) Settings.ACTION_APP_NOTIFICATION_SETTINGS
                else Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS
            ).putExtra(Settings.EXTRA_APP_PACKAGE, packageName).apply {
                if (channel.isNotEmpty()) putExtra(Settings.EXTRA_CHANNEL_ID, channel)
            }
        } else {
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))
        }
        try { startActivity(i) } catch (e: Exception) { }
    }

    /**
     * Native Google sign-in. Google blocks OAuth inside a WebView, so the account picker is shown natively (Credential Manager)
     * and the resulting Google ID token is handed to the page, which signs in to Firebase with it:
     * window.__onNativeGoogle(idToken, err)   err = '' | 'cancelled' | 'failed'
     * The ID below must be the WEB client ID (Firebase > Authentication > Google > Web SDK configuration).
     */
    private val googleWebClientId = "221968776813-kihimmrh4j0oopma4jnber26bjt6162f.apps.googleusercontent.com"

    private fun nativeGoogleResult(token: String, err: String) {
        js("window.__onNativeGoogle&&window.__onNativeGoogle(${JSONObject.quote(token)},${JSONObject.quote(err)})")
    }

    private fun startGoogleSignIn() {
        val cm = CredentialManager.create(this)
        val req = GetCredentialRequest.Builder()
            .addCredentialOption(GetSignInWithGoogleOption.Builder(googleWebClientId).build())
            .build()
        lifecycleScope.launch {
            try {
                val c = cm.getCredential(this@MainActivity, req).credential
                if (c is CustomCredential && c.type == GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL) {
                    val token = GoogleIdTokenCredential.createFrom(c.data).idToken
                    nativeGoogleResult(token, "")
                } else {
                    nativeGoogleResult("", "failed")
                }
            } catch (e: GetCredentialCancellationException) {
                nativeGoogleResult("", "cancelled")
            } catch (e: Exception) {
                nativeGoogleResult("", "failed")
            }
        }
    }

    /** Everything the website can call: window.AndroidBridge.xxx(...) */
    inner class Bridge {
        @JavascriptInterface
        fun getAppVersionCode(): Int = try {
            val pi = packageManager.getPackageInfo(packageName, 0)
            if (Build.VERSION.SDK_INT >= 28) pi.longVersionCode.toInt()
            else @Suppress("DEPRECATION") pi.versionCode
        } catch (e: Exception) { 1 }

        @JavascriptInterface
        fun saveFile(name: String, content: String) {
            runOnUiThread { pendingContent = content; createDoc.launch(name) }
        }

        @JavascriptInterface
        fun googleSignIn() { runOnUiThread { startGoogleSignIn() } }

        @JavascriptInterface
        fun syncSchedule(json: String) {
            try { ReminderScheduler.sync(applicationContext, json) } catch (e: Exception) { }
        }

        @JavascriptInterface
        fun getNotifStatus(): String = notifStatus()

        @JavascriptInterface
        fun subscribeUserTopic(uid: String) {
            FirebaseMessaging.getInstance().subscribeToTopic("user_$uid")
        }

        @JavascriptInterface
        fun requestNotifPermission() {
            runOnUiThread {
                when (notifStatus()) {
                    "granted" -> js("window.__onNotifPermission&&window.__onNotifPermission('granted')")
                    "not_asked" -> {
                        NotifStore.setAsked(this@MainActivity)
                        if (Build.VERSION.SDK_INT >= 33)
                            notifPermLauncher.launch(android.Manifest.permission.POST_NOTIFICATIONS)
                    }
                    else -> {
                        // Android only shows its dialog twice. After that the only way is the system settings page.
                        if (Build.VERSION.SDK_INT >= 33 && ActivityCompat.shouldShowRequestPermissionRationale(
                                this@MainActivity, android.Manifest.permission.POST_NOTIFICATIONS)
                        ) notifPermLauncher.launch(android.Manifest.permission.POST_NOTIFICATIONS)
                        else launchNotifSettings("")
                    }
                }
            }
        }

        @JavascriptInterface
        fun canExactAlarms(): Boolean = ReminderScheduler.canExact(applicationContext)

        @JavascriptInterface
        fun openExactAlarmSettings() {
            runOnUiThread {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    try {
                        startActivity(
                            Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:$packageName"))
                        )
                    } catch (e: Exception) { }
                }
            }
        }

        @JavascriptInterface
        fun openNotifSettings(channel: String) { runOnUiThread { launchNotifSettings(channel) } }

        @JavascriptInterface
        fun setTopics(json: String) {
            try {
                val a = JSONArray(json)
                val s = HashSet<String>()
                for (i in 0 until a.length()) s.add(a.getString(i))
                NotifStore.saveTopics(applicationContext, s)
                Push.syncTopics(applicationContext)
            } catch (e: Exception) { }
        }

        /**
         * Open / Download a chat document.
         *  action : "open" | "dl"
         *  fileId : the message's stable ID (NOT the file name - different files can share a name)
         *  url    : download link; may be "" when the page believes a local copy exists (we then ask for it only if the copy is gone)
         *  size   : expected size in bytes as a string ("" if unknown)
         *  key    : echoed back to window.onChatFileResult / onChatFileProgress so the page knows which button this belongs to
         */
        @JavascriptInterface
        fun chatDoc(action: String, fileId: String, url: String, name: String, mime: String, size: String, key: String) {
            val open = action == "open"; val sz = size.toLongOrNull() ?: -1L
            if (!open && Build.VERSION.SDK_INT <= 28 &&
                ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
                runOnUiThread {
                    pendingDl = PendingDl(fileId, url, name, mime, sz, key)
                    storagePermLauncher.launch(Manifest.permission.WRITE_EXTERNAL_STORAGE)
                }
            } else requestChatDoc(open, fileId, url, name, mime, sz, key)
        }

        /** "none" = no usable local copy | "local" = saved inside the app | "saved" = also placed in Downloads. Cheap; verifies the copy. */
        @JavascriptInterface
        fun chatDocState(fileId: String): String {
            if (docStore.validFile(fileId) == null) return "none"
            val ref = docStore.exportedRef(fileId)
            return if (ref != null && exportStillThere(ref)) "saved" else "local"
        }

        // Older page versions call these 4-argument methods; they now use the same persistent store (ID derived from the Storage path).
        @JavascriptInterface
        fun downloadChatFile(url: String, name: String, mime: String, key: String) {
            chatDoc("dl", "u:" + url.substringBefore('?'), url, name, mime, "", key)
        }

        @JavascriptInterface
        fun openChatFile(url: String, name: String, mime: String, key: String) {
            chatDoc("open", "u:" + url.substringBefore('?'), url, name, mime, "", key)
        }

        @JavascriptInterface
        fun setUid(uid: String) { NotifStore.setUid(applicationContext, uid) }

        @JavascriptInterface
        fun takePending(): String = NotifStore.takePending(applicationContext)

        @JavascriptInterface
        fun consumeLaunchRoute(): String { val r = launchRoute ?: ""; launchRoute = null; return r }

        /**
         * The page calls this (on every start / sign-in) to register THIS phone for private pushes ("Someone answered your question").
         * The token comes back through window.__onFcmToken(token); the page stores it at deviceTokens/{uid}, which only the Worker can read.
         */
        @JavascriptInterface
        fun requestFcmToken() {
            try {
                FirebaseMessaging.getInstance().token.addOnSuccessListener { t ->
                    if (!t.isNullOrEmpty()) js("window.__onFcmToken&&window.__onFcmToken(${JSONObject.quote(t)})")
                }
            } catch (e: Exception) { }
        }
    }

    /** A notification was tapped. */
    private fun handleLaunchIntent(i: Intent?) {
        if (i == null) return
        val route = i.getStringExtra("route")
        if (route.isNullOrEmpty()) return
        val o = JSONObject()
            .put("route", route)
            .put("ref", i.getStringExtra("ref") ?: "")
            .put("sub", i.getStringExtra("sub") ?: "")
            .put("id", i.getStringExtra("nid") ?: "")
        i.removeExtra("route")                           // never replay on rotation
        if (pageLoaded) {
            val q = { k: String -> JSONObject.quote(o.optString(k)) }
            js("window.__openFromNotification&&window.__openFromNotification(${q("route")},${q("ref")},${q("sub")},${q("id")})")
        } else {
            launchRoute = o.toString()                   // the page picks it up while it starts
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContentView(R.layout.activity_main)

        val root = findViewById<View>(R.id.main)
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
            insets
        }

        Notifs.createChannels(this)
        Push.syncTopics(applicationContext)

        // Housekeeping off the main thread: drop the old throw-away cache folder and copies nobody has used for 30 days.
        io.execute {
            try {
                File(cacheDir, "chat_open").deleteRecursively()
                docStore.prune(30L * 24 * 3600 * 1000)
            } catch (e: Exception) { }
        }

        webView = findViewById(R.id.webview)
        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
        }
        webView.addJavascriptInterface(Bridge(), "AndroidBridge")
        // Analytics: forwards the page's events to NATIVE Firebase Analytics. Registered BEFORE loadUrl so the page sees it at start-up.
        webView.addJavascriptInterface(CseAnalyticsBridge(this), "CseAnalyticsBridge")

        // Other downloads (not chat files — those go through the bridge): hand them to the phone's browser/viewer.
        webView.setDownloadListener { url, _, _, _, _ ->
            try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } catch (e: Exception) { }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams
            ): Boolean {
                filePathCallback?.onReceiveValue(null)      // answer any stale request first
                filePathCallback = callback
                return try { pickFile.launch(arrayOf("*/*")); true }
                catch (e: Exception) {
                    // MUST still answer the WebView, otherwise it keeps waiting and later picks can be ignored
                    filePathCallback?.onReceiveValue(null); filePathCallback = null; false
                }
            }

            // The website uses confirm() (delete task, reset attendance…). A WebView ignores it unless we show the dialog.
            override fun onJsConfirm(view: WebView, url: String?, message: String?, result: JsResult): Boolean {
                AlertDialog.Builder(this@MainActivity)
                    .setMessage(message)
                    .setPositiveButton("OK") { _, _ -> result.confirm() }
                    .setNegativeButton("Cancel") { _, _ -> result.cancel() }
                    .setOnCancelListener { result.cancel() }
                    .show()
                return true
            }

            override fun onJsAlert(view: WebView, url: String?, message: String?, result: JsResult): Boolean {
                AlertDialog.Builder(this@MainActivity)
                    .setMessage(message)
                    .setPositiveButton("OK") { _, _ -> result.confirm() }
                    .setOnCancelListener { result.confirm() }
                    .show()
                return true
            }
        }

        webView.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                pageLoaded = false
            }

            override fun onPageFinished(view: WebView, url: String?) { pageLoaded = true }

            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                assetLoader.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                if (url.host == "appassets.androidplatform.net") return false
                try { startActivity(Intent(Intent.ACTION_VIEW, url)) } catch (e: Exception) { }
                return true
            }
        }

        AppState.onHistoryChanged = { js("window.__notifChanged&&window.__notifChanged()") }

        if (savedInstanceState == null) handleLaunchIntent(intent)
        webView.loadUrl("https://appassets.androidplatform.net/assets/index.html")

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                webView.evaluateJavascript(
                    // 1st: close the topmost chat overlay (image viewer / preview sheet / media history); 2nd: your existing #shx panel
                    "(function(){var o=document.querySelector('.md-ov')||document.querySelector('.cp-ov')||document.querySelector('.mh-ov');if(o){o.click();return 1}" +
                            "var e=document.getElementById('shx');" +
                            "if(e&&e.classList.contains('on')){e.classList.remove('on');return 1}return 0})()"
                ) { r ->
                    if (r == "1") return@evaluateJavascript
                    if (webView.canGoBack()) webView.goBack()
                    else {
                        isEnabled = false; onBackPressedDispatcher.onBackPressed()
                    }
                }
            }
        })
        // 1) Notification channel (needed on Android 8 and newer)
        if (Build.VERSION.SDK_INT >= 26) {
            val ch = NotificationChannel("community", "Community updates", NotificationManager.IMPORTANCE_HIGH)
            getSystemService(NotificationManager::class.java).createNotificationChannel(ch)
        }

        // 2) Ask for notification permission (needed on Android 13 and newer)
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1001)
        }

        // 3) Join the topics the Worker sends to
        FirebaseMessaging.getInstance().subscribeToTopic("community_chat")
        FirebaseMessaging.getInstance().subscribeToTopic("community_links")
        FirebaseMessaging.getInstance().subscribeToTopic("study_chat_questions")
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleLaunchIntent(intent)
    }

    override fun onStart() { super.onStart(); AppState.foreground = true }

    override fun onStop() { super.onStop(); AppState.foreground = false }

    override fun onDestroy() {
        AppState.onHistoryChanged = null
        super.onDestroy()
    }
}