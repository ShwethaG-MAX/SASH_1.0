CLASS C HUB – NOTIFICATIONS PACK
================================
Project folder (Windows):  C:\Users\Sanketh VS\AndroidStudioProjects\CSEHUB

PHASE 1  (offline reminders + backup fix + notification centre/settings)
  phase1_android\MainActivity.kt          -> app\src\main\java\com\study\csehub\   (REPLACE the old one)
  phase1_android\Notifs.kt                -> app\src\main\java\com\study\csehub\
  phase1_android\NotifStore.kt            -> app\src\main\java\com\study\csehub\
  phase1_android\ReminderScheduler.kt     -> app\src\main\java\com\study\csehub\
  phase1_android\AlarmReceiver.kt         -> app\src\main\java\com\study\csehub\
  phase1_android\BootReceiver.kt          -> app\src\main\java\com\study\csehub\
  phase1_android\Push.kt                  -> app\src\main\java\com\study\csehub\   (temporary stub)
  phase1_android\ic_notification.xml      -> app\src\main\res\drawable\
  index.html (separate download)          -> app\src\main\assets\                  (REPLACE the old one)
  + edit AndroidManifest.xml (see the chat guide)

PHASE 2  (push notifications for community / LinkLearn / resources / announcements)
  phase2_firebase\Push.kt                 -> REPLACES the Phase 1 Push.kt
  phase2_firebase\HubMessagingService.kt  -> app\src\main\java\com\study\csehub\
  phase2_firebase\functions\index.js      -> your Firebase "functions" folder
  phase2_firebase\functions\package.json  -> your Firebase "functions" folder
  + google-services.json (from Firebase Console) -> app\
  + Gradle + Manifest edits (see the chat guide)
