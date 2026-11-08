package com.study.csehub

import android.content.Context
import android.os.Bundle
import android.webkit.JavascriptInterface
import com.google.firebase.analytics.FirebaseAnalytics
import org.json.JSONObject

/**
 * Forwards events from CSE Hub (WebView) to NATIVE Firebase Analytics.
 * Exposed to JS as window.CseAnalyticsBridge. When present, the HTML uses ONLY this path
 * (the JS SDK stays off), so no event is recorded twice.
 */
class CseAnalyticsBridge(context: Context) {
    private val fa = FirebaseAnalytics.getInstance(context.applicationContext)

    @JavascriptInterface
    fun logEvent(name: String, paramsJson: String?) {
        if (!Regex("^[A-Za-z][A-Za-z0-9_]{0,39}$").matches(name)) return
        val b = Bundle()
        try {
            val o = JSONObject(paramsJson ?: "{}")
            for (k in o.keys()) {
                if (!Regex("^[A-Za-z][A-Za-z0-9_]{0,39}$").matches(k)) continue
                when (val v = o.get(k)) {
                    is Int -> b.putLong(k, v.toLong())
                    is Long -> b.putLong(k, v)
                    is Double -> b.putDouble(k, v)
                    is String -> b.putString(k, v.take(100))
                }
            }
        } catch (_: Exception) { return }
        fa.logEvent(name, b)
    }

    @JavascriptInterface
    fun setCollectionEnabled(enabled: Boolean) {
        fa.setAnalyticsCollectionEnabled(enabled)
    }
}