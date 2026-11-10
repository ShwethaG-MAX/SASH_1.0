<div align="center">

# ∞ CampusLoop — CL-App

### CampusLoop, built for Android.

[![Android](https://img.shields.io/badge/Platform-Android-3DDC84?style=for-the-badge&logo=android&logoColor=white)](https://developer.android.com/)
[![Kotlin](https://img.shields.io/badge/Language-Kotlin-7F52FF?style=for-the-badge&logo=kotlin&logoColor=white)](https://kotlinlang.org/)
[![Android Studio](https://img.shields.io/badge/IDE-Android_Studio-4285F4?style=for-the-badge&logo=androidstudio&logoColor=white)](https://developer.android.com/studio)

**The Android companion to CampusLoop.** An app-first experience that brings the CampusLoop web platform together with Android-native reminders, notifications, and app utilities.

</div>

---

## 📱 Overview

**CL-App** is the Android application for CampusLoop. It hosts the CampusLoop web experience inside an Android WebView while adding native Android capabilities that a browser-only experience cannot provide in the same way.

The app is designed to keep the CampusLoop experience convenient on mobile—with app integration, notification handling, reminders, and update infrastructure alongside the web interface.

## ✨ Features

### 🌐 CampusLoop inside Android
- CampusLoop web interface embedded in an Android WebView.
- Integrated navigation between the Campus, Home, and Connect areas.
- JavaScript bridge support for selected native/web interactions.
- App-aware handling for links and navigation.

### ⏰ Native alarms & reminders
- Schedule reminders from the Android side.
- Reminder scheduling and alarm receiver components.
- Boot handling to restore scheduled reminders after device restart where permitted.
- Local notification storage and notification utilities.
- Designed for reminders that can be delivered independently of an open webpage.

### 🔔 Notifications
- Native notification handling and notification centre infrastructure.
- Firebase Cloud Messaging integration for supported push notifications.
- Push pathways for community, LinkLearn, resources, and announcements when configured on the backend.
- Notification-related Android components and channels.

### 🔄 App update infrastructure
- Update manager and scheduler components.
- Release manifest handling and semantic-version comparison.
- Manifest verification and release-path handling.
- Installer flow for supported app updates.

> Exact notification delivery, alarm behavior, and update availability depend on Android permissions, device settings, release configuration, and Firebase setup.

## 🧱 Architecture

| Layer | Technology |
|---|---|
| Android app | Kotlin |
| UI container | Android WebView |
| Web content | CampusLoop HTML assets |
| Native bridge | JavaScript ↔ Kotlin bridge |
| Notifications | Android notifications + Firebase Cloud Messaging |
| Reminders | Android alarm scheduling / receivers |
| App updates | In-app update infrastructure and signed release metadata |
| Build system | Gradle |

## 📂 Project structure

```text
CL-app/
├── app/
│   ├── src/main/
│   │   ├── java/com/study/csehub/
│   │   │   ├── MainActivity.kt
│   │   │   ├── AlarmReceiver.kt
│   │   │   ├── BootReceiver.kt
│   │   │   ├── Notifs.kt
│   │   │   ├── NotifStore.kt
│   │   │   ├── ReminderScheduler.kt
│   │   │   ├── Push.kt
│   │   │   ├── ChatDocStore.kt
│   │   │   ├── Cseanalyticsbridge.kt
│   │   │   └── update/        # Update and release components
│   │   │   └── ...
│   │   ├── assets/            # Embedded CampusLoop web files
│   │   └── AndroidManifest.xml
│   └── ...
├── gradle/
├── gradlew
└── README.md
```

## 🛠️ Built with

- Kotlin
- Android SDK
- Android WebView
- Gradle
- Firebase / Firebase Cloud Messaging
- Android AlarmManager and BroadcastReceivers

## 🚀 Build & run

### Requirements

- Android Studio
- Android SDK and a compatible JDK (use the version required by the Gradle project)
- Android device or emulator
- Firebase configuration for features that use Firebase

### Open the project

1. Clone or download this repository.
2. Open the **CL-app** folder in Android Studio.
3. Allow Gradle to sync.
4. Configure Firebase files and project settings if needed.
5. Select a device/emulator and click **Run**.

### Build an APK

In Android Studio: **Build → Build Bundle(s) / APK(s) → Build APK(s)**.

Or use the Gradle wrapper from the project directory:

```bash
./gradlew assembleDebug
```

On Windows:

```bat
gradlew.bat assembleDebug
```

The debug APK is typically generated under `app/build/outputs/apk/debug/`.

## 🔑 Firebase & release configuration

- Use a `google-services.json` file generated for your own Firebase Android app.
- Enable Firebase Cloud Messaging and configure backend functions as required.
- Keep signing credentials and private release keys outside source control.
- Configure the release manifest, update endpoint, and signing verification values for your own release pipeline.
- Do not publish private keys, tokens, or production credentials in the repository.

## ⚠️ Android permissions & behavior

- Notifications require notification permission on Android versions that enforce it.
- Exact alarms and background execution may be restricted by Android version or device manufacturer.
- Battery optimization can affect reminder timing; users may need to adjust device settings.
- Boot restoration and push delivery depend on OS restrictions and app configuration.

## 🧪 Development notes

- Keep WebView and native bridge changes compatible with the CL-Web frontend.
- Test notification permission flows and reminders on real devices, not only emulators.
- Validate update manifests and release signatures before distributing builds.
- Test on supported Android versions and account for OEM battery management.

## 🤝 Contributing

1. Create a focused branch for your change.
2. Keep native Android functionality separate from web-only logic when possible.
3. Test both the WebView experience and affected native features.
4. Document permission, Firebase, or release-pipeline changes.
5. Submit a pull request with a clear description and test notes.

## 📄 License

Add your preferred license file before distributing or accepting external contributions.

<div align="center">

**CampusLoop — Your campus, in your pocket.**

</div>
