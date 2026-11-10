[README.md](https://github.com/user-attachments/files/34617803/README.md)
<div align="center">

# ∞ CampusLoop — CL-Web

### Your campus. Your community. Your growth.

[![CampusLoop](https://img.shields.io/badge/CampusLoop-CL--Web-16a34a?style=for-the-badge)](csehub.site/)
[![Firebase](https://img.shields.io/badge/Backend-Firebase-FFCA28?style=for-the-badge&logo=firebase&logoColor=black)](https://firebase.google.com/)
[![JavaScript](https://img.shields.io/badge/JavaScript-Vanilla-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)

**The web experience powering CampusLoop.** A student-focused platform bringing academic tools, collaboration, discovery, and campus life together in one place.

[Live Website](csehub.site/) · [Report an Issue](../../issues) · [Request a Feature](../../issues)

</div>

---

## ✨ Overview

**CL-Web** is the web platform behind CampusLoop. It combines a single-page interface with Firebase services and Cloud Functions to provide students with a unified space for learning, organizing their academic life, and connecting with peers.

The interface is organized around three main destinations:

- **Campus** — academic tools and student utilities.
- **Home** — a central landing space.
- **Connect** — discovery and community experiences, with room for future expansion.

## 🧭 Features

### 🎓 Campus — Academic workspace
- **Timetable & schedule:** view class schedules and organize academic routines.
- **Attendance tools:** track attendance and review attendance-related information.
- **Study materials:** subject-wise resources, links, and first-year P/C Cycle material organization.
- **Daily Quiz:** year-specific quizzes, scoring, and leaderboards.
- **Syllabus Test:** practice tests, server-side evaluation, results, and XP.
- **Study tools:** academic dashboards and related student utilities.
- **Themes:** selectable visual themes and responsive interface.

### 🏠 Home
- A central student-facing landing section.
- A consistent entry point between Campus and Connect.

### 🤝 Connect — Community & discovery
- **Discover:** curated technology/news articles from supported sources, interests, bookmarks, and refresh support.
- **Community / Study Chat:** room-based student conversations.
- **LinkLearn:** a separate learning-focused chat space.
- **Find People / Find Teams / Events:** Connect discovery areas for student networking and collaboration.
- **Moderation:** reporting, admin review, warnings, message removal, and chat restrictions.

### 🧠 Progress & engagement
- **XP and leaderboards:** server-managed quiz/test progress and rankings.
- **Syllabus XP:** completion/score-based XP with improvement-aware awarding.
- **Student profiles:** academic profile information used across relevant features.

### 🛡️ Admin & CR capabilities
- Admin/owner dashboards and controls.
- Quiz and test management, publishing, and moderation workflows.
- Community reports and moderation actions.
- CR-oriented campus communication tools where enabled.

> Feature availability can depend on the signed-in role, academic profile, deployed backend functions, and Firebase configuration.

## 🏗️ Architecture

| Layer | Implementation |
|---|---|
| Frontend | Single-page app in `public/index.html` |
| Authentication | Firebase Authentication (anonymous and configured sign-in methods) |
| Database | Cloud Firestore |
| File storage | Firebase Storage where required by app features |
| Server logic | Firebase Cloud Functions (2nd gen / callable & scheduled functions) |
| Hosting | Firebase Hosting |
| Region | `asia-south1` for project Cloud Functions |

### Repository map

```text
CL-web/
├── public/
│   ├── index.html          # Main CampusLoop web application
│   └── version.json       # Web version metadata
├── functions-quiz/         # Daily Quiz backend
├── functions-syllabus/     # Syllabus tests and XP
├── functions-discover/     # Discover feed ingestion and moderation
├── functions-test/         # Test creation, attempts, scoring and results
├── functions-community/    # Community chat, reports and moderation
├── firestore.rules        # Firestore security rules
├── firestore.indexes.json # Required Firestore indexes
├── firebase.json           # Hosting and Functions configuration
└── scripts/                # Validation and maintenance scripts
```

## 🧰 Tech stack

- HTML · CSS · JavaScript
- Firebase Authentication
- Cloud Firestore
- Firebase Storage
- Firebase Hosting
- Firebase Cloud Functions
- Node.js (backend functions and tooling)

## 🚀 Local setup

### Prerequisites

- Node.js (use the version compatible with the project's Functions runtime; Node 22 is documented in the project setup)
- Firebase CLI
- A Firebase project with Authentication, Firestore, and required services configured
- A Firebase project on the appropriate billing plan for deployed Cloud Functions and scheduled jobs

### Run the web page locally

The frontend is a static page. Serve `public/` using a local HTTP server rather than opening the HTML directly:

```bash
cd CL-web
python -m http.server 8080 --directory public
```

Open `http://localhost:8080` in your browser. Firebase-backed features require valid project configuration and deployed services.

### Install and validate Functions

```bash
cd CL-web/functions-quiz && npm ci
cd ../functions-syllabus && npm ci
cd ../functions-discover && npm ci
cd ../functions-test && npm ci
cd ../functions-community && npm ci
cd ..
bash scripts/check-all.sh
```

> Install each Functions codebase independently. Some checks or features may require environment configuration and credentials.

## 🔐 Configuration & security

- Configure the Firebase web app settings in the frontend before using it with a new Firebase project.
- Enable the sign-in providers used by your deployment.
- Deploy Firestore rules and indexes from this repository; rules are part of the security model.
- Configure required Functions secrets in Firebase Secret Manager (for example, quiz AI and Discover provider keys).
- Never commit service-account credentials, private signing keys, or production secrets.
- Server-side scoring and XP are intentionally authoritative; do not replace them with client writes.

## ☁️ Deployment

Review the Firebase project, secrets, billing, rules, and indexes before deployment. Typical deployment sequence:

```bash
firebase deploy --only firestore:rules,firestore:indexes
firebase deploy --only functions
firebase deploy --only hosting
```

Deploy only the codebases and services configured for your Firebase project. Scheduled Discover refreshes may require Cloud Scheduler and billing configuration.

## 🧪 Quality checks

```bash
bash scripts/check-all.sh
```

The repository includes validation scripts and feature-specific tests for supported backend modules. Run the relevant `npm test` commands inside individual Functions folders when changing their logic.

## 🗺️ Roadmap

- Continue expanding Connect and Grow experiences.
- Improve student collaboration and discovery.
- Refine accessibility, responsiveness, and performance.
- Add documentation and contribution workflows as the project evolves.

## 🤝 Contributing

1. Fork or branch from the repository.
2. Keep changes focused and test the relevant frontend/backend behavior.
3. Check Firestore rules whenever data access changes.
4. Run validation scripts before submitting a pull request.
5. Describe the change, testing performed, and any deployment requirements.

## 📄 License

Add your preferred license file before distributing or accepting external contributions.

<div align="center">

**CampusLoop — Campus. Connect. Grow.**

</div>
