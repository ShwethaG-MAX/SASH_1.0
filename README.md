CampusLoop — Project Overview (CL-Web + CL-App)
CampusLoop is a student platform built as a Firebase-powered web application and an Android app. CL-Web is the hosted website/backend project; CL-App is the Android Studio project that embeds the CampusLoop experience and adds native Android features.
CL-Web
The web project provides the core platform:
- Home dashboard with next classes, announcements, upcoming events and quick links.
- Schedule/timetable, extra and substitute classes.
- Subject attendance and previous-attendance logging.
- Tasks, personal calendar and academic events.
- Subject study materials, resource browsing, favourites and recent history.
- Daily Quiz, syllabus tests, answer review, statistics, XP and leaderboards.
- Community chat, year communities, Exam Q&A and LinkLearn resource sharing.
- Discover feed with technology articles, interests, saved items and discussions.
- Campus events and registration.
- Connect tools to find people/teams and request connections or team membership.
- Notifications, themes, settings, student/CR/admin experiences and moderation/management tools.
CL-App
The Android project packages the CampusLoop frontend in a WebView and supplies Android-specific capabilities:
- Native notification handling and deep links/routing to app content.
- Alarm and reminder scheduling, including boot rescheduling.
- WebView/Firebase lifecycle recovery when the app returns from background.
- App release/update checks and installation support.
- Android launcher, activity, receiver, resources and system settings integration.
How the two relate
- The web frontend is the shared CampusLoop interface and most feature logic.
- The Android app contains a bundled copy of that frontend plus native Kotlin code.
- Firebase services provide authentication, database, storage and server-side functionality used by both.
- Frontend changes should be kept in sync between CL-web/public/index.html and CL-app/app/src/main/assets/index.html when both versions are intended to match.
Repository map
- CL-web/ — website, Firebase configuration/rules/indexes and Cloud Functions.
- CL-app/ — Android Studio project, WebView assets and native Android components.
For setup, testing and deployment, follow the README and documentation inside each project.
