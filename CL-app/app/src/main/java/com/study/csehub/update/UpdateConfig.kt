package com.study.csehub.update

/**
 * Every tunable of the offline-first web update system lives here.
 * Nothing in this file is secret: the public keys can only VERIFY signatures, never create them.
 */
object UpdateConfig {
    /** Firebase Hosting site that serves version.json and the release ZIPs (HTTPS only). */
    const val BASE_URL = "https://cse-c-hub.web.app"
    const val MANIFEST_PATH = "/version.json"

    /** Release ZIPs must live at RELEASE_PATH_PREFIX + "<version>.zip". */
    const val RELEASE_PATH_PREFIX = "/app-releases/"

    /** The ONLY hosts the updater will ever talk to (manifest, ZIP and redirects). */
    val ALLOWED_HOSTS: Set<String> = setOf("cse-c-hub.web.app", "cse-c-hub.firebaseapp.com")

    /**
     * ECDSA P-256 public keys (X.509 SubjectPublicKeyInfo, Base64) allowed to sign version.json.
     * Filled in automatically by:  node tools/release/release.mjs init --android <path to CSEHUB>
     * While this list is empty the updater is DISABLED (fail-closed) and the app keeps using its bundled/installed site.
     */
    val TRUSTED_PUBLIC_KEYS: List<String> = listOf(
        // BEGIN-TRUSTED-KEYS
        // END-TRUSTED-KEYS
    )

    // ---- limits (protect against corrupted servers, zip bombs and runaway downloads) ----
    const val MAX_MANIFEST_BYTES = 16 * 1024
    const val MAX_ZIP_BYTES = 150L * 1024 * 1024
    const val MAX_UNPACKED_BYTES = 300L * 1024 * 1024
    const val MAX_FILE_BYTES = 100L * 1024 * 1024
    const val MAX_ENTRIES = 20_000
    const val MAX_REDIRECTS = 3
    const val CONNECT_TIMEOUT_MS = 15_000
    const val READ_TIMEOUT_MS = 30_000

    // ---- scheduling ----
    const val PERIODIC_CHECK_HOURS = 6L
    /** After this many launches of a new release without the page proving it is healthy, roll back automatically. */
    const val MAX_UNCONFIRMED_LAUNCHES = 2
    /** A pending update is switched to automatically when the app returns from the background after this long. */
    const val AUTO_APPLY_AFTER_BACKGROUND_MS = 10L * 60 * 1000
    /** The page must still be alive (non-empty) this long after loading for a new release to count as healthy. */
    const val HEALTH_PROBE_DELAY_MS = 4_000L
}
