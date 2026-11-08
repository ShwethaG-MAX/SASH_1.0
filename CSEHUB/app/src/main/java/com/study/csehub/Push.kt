package com.study.csehub

import android.content.Context
import com.google.firebase.messaging.FirebaseMessaging

/**
 * Keeps the phone's FCM topic subscriptions in line with the notification switches in the app's Settings.
 * The website calls AndroidBridge.setTopics([...]) with the switches that are ON; MainActivity then calls syncTopics().
 *
 *   Settings key        ->  FCM topic the Cloudflare Worker sends to
 *   community           ->  community_chat          (OLD single chat; kept for compatibility)
 *   chat_global         ->  chat_global             (Global Chat - everyone)                          NEW
 *   chat_y1 / chat_y2   ->  chat_y1 / chat_y2       (First / Second Year Community - ONLY my year)    NEW
 *   linklearn           ->  community_links         (new LinkLearn resources)
 *   studychat           ->  study_chat_questions    (new Study Chat questions)
 *   resources           ->  study_resources         (new study material)
 *   important           ->  important_updates       (admin's important updates)
 *   ann_A ... ann_G     ->  announcements_A ... G   (class announcements of MY section only; the page sends the current section)
 *
 * Before the website has ever saved its switches (first launch) the fixed topics are ON, except the two year rooms
 * (the website decides which ONE of them applies to this student's year).  Safe to call repeatedly.
 * Answers to MY questions and Daily Quiz reminders / results are NOT topics: the server sends them to this phone's own FCM token
 * (see requestFcmToken in MainActivity and deviceTokens/{uid}), so they can be personal ("you haven't solved today's quiz").
 * Class / task / calendar / holiday reminders are not push at all: Android alarms scheduled by ReminderScheduler.
 */
object Push {
    private val FIXED = mapOf(
        "community" to "community_chat",
        "chat_global" to "chat_global",
        "chat_y1" to "chat_y1",
        "chat_y2" to "chat_y2",
        "linklearn" to "community_links",
        "studychat" to "study_chat_questions",
        "resources" to "study_resources",
        "important" to "important_updates"
    )
    // first launch, before the website has saved anything: everything fixed EXCEPT the year-specific chat rooms
    private val DEFAULT_ON: Set<String> = FIXED.filterKeys { it != "chat_y1" && it != "chat_y2" }.values.toSet()
    private val SECTIONS = listOf("A", "B", "C", "D", "E", "F", "G")
    private val SECTION_KEY = Regex("^ann_[A-G]$")

    private fun topicFor(key: String): String? =
        FIXED[key] ?: if (SECTION_KEY.matches(key)) "announcements_" + key.substring(4) else null

    @Synchronized
    fun syncTopics(ctx: Context) {
        val app = ctx.applicationContext
        try {
            val fm = FirebaseMessaging.getInstance()
            val wanted: Set<String> =
                if (NotifStore.hasTopics(app)) NotifStore.topics(app).mapNotNull { topicFor(it) }.toSet()
                else DEFAULT_ON
            val have = NotifStore.subscribed(app)
            val all = FIXED.values + SECTIONS.map { "announcements_$it" }
            for (t in all) {
                if (t in wanted) {
                    if (t !in have) fm.subscribeToTopic(t).addOnSuccessListener { NotifStore.markSubscribed(app, t, true) }
                } else if (t in have || t in FIXED.values) {
                    // idempotent: also clears subscriptions that older app versions made without recording them
                    // (this is also what drops the OTHER year's chat room when a student changes year)
                    fm.unsubscribeFromTopic(t).addOnSuccessListener { NotifStore.markSubscribed(app, t, false) }
                }
            }
        } catch (e: Exception) { }
    }
}
