CampusLoop Web (CL-Web)
CampusLoop is a student-focused campus platform. The web version is a Firebase-backed single-page application.
Features (brief)
- Home dashboard: quick overview of next classes, announcements, upcoming events and shortcuts.
- Schedule & timetable: daily timetable, previous/next day navigation, extra classes and substitute-class records.
- Attendance: subject-wise attendance tracking, previous-attendance logging and attendance summaries.
- Tasks & calendar: personal task list, academic/event calendar and reminders for important dates.
- Study materials: subject-organised resources, browse/search, favourites and recently accessed items.
- Contests & practice: Daily Quiz, syllabus-based tests, quiz/test history, answer review and explanations.
- Progress & XP: scores, statistics, XP history and daily/weekly leaderboards.
- Community: common chat and year-specific communities; Exam Q&A, questions/answers and shared resources through LinkLearn.
- Discover: curated tech articles/news, interest-based feed, latest/discussed/saved views and article discussions/comments.
- Campus events: event listings, details and registration.
- Connect: find people and teams, filter listings and send connection/join requests.
- Announcements: section/academic announcements and notifications.
- Personalisation: multiple visual themes, settings, profile/login options and backup/restore where available.
- Admin/CR tools: announcement posting, moderation/report handling, quiz/test management, leaderboard and platform controls.
Technology
- HTML, CSS and JavaScript single-page frontend (public/index.html)
- Firebase Authentication, Cloud Firestore, Cloud Storage and Cloud Functions
- Firebase Hosting; backend functions are organised into quiz, syllabus/XP, discover and community services.
Development / deployment
See the repository's deployment notes and function-specific READMEs. Configure Firebase, install each function package, validate, then deploy Firestore rules/indexes, functions and Hosting in the documented order.
