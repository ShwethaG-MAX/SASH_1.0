package com.study.csehub

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/** One notification as shown in the phone and kept for the in-app history. */
data class Entry(
    val id: String,       // unique per notification (used to prevent duplicates)
    val title: String,
    val body: String,
    val cat: String,      // class | tasks | calendar | holiday | community | linklearn | resources | announcements | important
    val channel: String,  // Android notification channel id
    val route: String,    // where a tap should go: timetable | tasks | calendar | chat | linklearn | resources | announcements
    val ref: String,      // task id / event id / document id
    val sub: String,      // subject name (study resources)
    val ts: Long
)

/** Small SharedPreferences-backed store. Everything here survives app restarts and reboots. */
object NotifStore {
    private fun sp(c: Context) =
        c.applicationContext.getSharedPreferences("csehub_notif", Context.MODE_PRIVATE)

    // ---------- scheduled reminders (sent by the website) ----------
    fun items(c: Context): JSONArray =
        try { JSONArray(sp(c).getString("items", "[]")) } catch (e: Exception) { JSONArray() }

    fun saveItems(c: Context, a: JSONArray) { sp(c).edit().putString("items", a.toString()).apply() }

    fun skip(c: Context): Set<String> {
        val out = HashSet<String>()
        try {
            val a = JSONArray(sp(c).getString("skip", "[]"))
            for (i in 0 until a.length()) out.add(a.getString(i))
        } catch (e: Exception) { }
        return out
    }

    fun saveSkip(c: Context, a: JSONArray) { sp(c).edit().putString("skip", a.toString()).apply() }

    // ---------- history waiting for the website to pick up ----------
    @Synchronized
    fun addPending(c: Context, e: Entry): Boolean {
        val p = sp(c)
        val seen = try { JSONArray(p.getString("seen", "[]")) } catch (x: Exception) { JSONArray() }
        for (i in 0 until seen.length()) if (seen.getString(i) == e.id) return false   // duplicate → ignore
        seen.put(e.id)
        val seenTrim = JSONArray()
        for (i in maxOf(0, seen.length() - 400) until seen.length()) seenTrim.put(seen.getString(i))

        val pend = try { JSONArray(p.getString("pending", "[]")) } catch (x: Exception) { JSONArray() }
        pend.put(
            JSONObject().put("id", e.id).put("title", e.title).put("body", e.body).put("cat", e.cat)
                .put("route", e.route).put("ref", e.ref).put("sub", e.sub).put("ts", e.ts)
        )
        val pendTrim = JSONArray()
        for (i in maxOf(0, pend.length() - 200) until pend.length()) pendTrim.put(pend.get(i))

        p.edit().putString("seen", seenTrim.toString()).putString("pending", pendTrim.toString()).apply()
        return true
    }

    @Synchronized
    fun takePending(c: Context): String {
        val p = sp(c)
        val s = p.getString("pending", "[]") ?: "[]"
        p.edit().putString("pending", "[]").apply()
        return s
    }

    // ---------- push topics ----------
    /** true once the website has saved its switches at least once (so "nothing saved yet" can be told apart from "all switches off"). */
    fun hasTopics(c: Context): Boolean = sp(c).contains("topics")
    fun topics(c: Context): Set<String> = HashSet(sp(c).getStringSet("topics", emptySet()) ?: emptySet())
    fun saveTopics(c: Context, t: Set<String>) { sp(c).edit().putStringSet("topics", HashSet(t)).apply() }
    fun subscribed(c: Context): Set<String> = HashSet(sp(c).getStringSet("subscribed", emptySet()) ?: emptySet())
    fun markSubscribed(c: Context, topic: String, on: Boolean) {
        val s = HashSet(subscribed(c)); if (on) s.add(topic) else s.remove(topic)
        sp(c).edit().putStringSet("subscribed", s).apply()
    }
    fun clearSubscribed(c: Context) { sp(c).edit().remove("subscribed").apply() }

    // ---------- misc ----------
    fun uid(c: Context): String = sp(c).getString("uid", "") ?: ""
    fun setUid(c: Context, v: String) { sp(c).edit().putString("uid", v).apply() }
    fun asked(c: Context): Boolean = sp(c).getBoolean("permAsked", false)
    fun setAsked(c: Context) { sp(c).edit().putBoolean("permAsked", true).apply() }
}