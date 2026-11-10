CampusLoop Android App (CL-App)
CL-App is the Android application wrapper for CampusLoop. It packages the CampusLoop web experience in an Android WebView and adds native Android capabilities.
Features (brief)
- CampusLoop experience: Home, Campus, Connect and Grow areas, with the campus tools and content available in the embedded web interface.
- Student access: student sign-in/guest access, email and Google sign-in flows; CR and admin entry points where enabled.
- Native notifications: Android notification support and notification routing into relevant app screens.
- Alarms & reminders: scheduled reminders/alarms, notification delivery and boot-time rescheduling support.
- App lifecycle integration: WebView resume/reconnect handling to restore Firebase and live community features after backgrounding.
- App updates: release metadata/manifest verification, update scheduling and installation flow.
- Android integration: app launcher identity/icons, native activity and receiver components, Android permissions and system notification settings.
- Web features inside the app: timetable, attendance, tasks/calendar, materials, quizzes/tests, community chat, Q&A/LinkLearn, Discover, events, Connect, themes and dashboards.
Project structure
- app/src/main/assets/index.html — bundled CampusLoop frontend
- app/src/main/java/ — Android activity, alarm/reminder, notification, chat storage and update components
- app/src/main/res/ — launcher icons, layouts, themes and app resources
Build
Open CL-app in Android Studio, allow Gradle sync, select the app configuration and build/run on an Android device or emulator. Keep Firebase configuration and signing/release settings appropriate for your environment.
