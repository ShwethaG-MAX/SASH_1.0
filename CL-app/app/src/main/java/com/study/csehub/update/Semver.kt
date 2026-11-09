package com.study.csehub.update

import java.math.BigInteger

/**
 * Strict Semantic Versioning 2.0 value: MAJOR.MINOR.PATCH[-pre.release].
 * Build metadata (+xyz) is deliberately NOT accepted for web releases (version strings become folder names).
 * Compared numerically per the spec, never as plain strings ("1.10.0" > "1.9.0", "1.0.0" > "1.0.0-beta.2").
 */
class Semver private constructor(
    val major: Int,
    val minor: Int,
    val patch: Int,
    val preRelease: List<String>
) : Comparable<Semver> {

    override fun compareTo(other: Semver): Int {
        if (major != other.major) return major.compareTo(other.major)
        if (minor != other.minor) return minor.compareTo(other.minor)
        if (patch != other.patch) return patch.compareTo(other.patch)
        // A version WITHOUT a pre-release tag is greater than the same version with one.
        if (preRelease.isEmpty() && other.preRelease.isEmpty()) return 0
        if (preRelease.isEmpty()) return 1
        if (other.preRelease.isEmpty()) return -1
        val n = minOf(preRelease.size, other.preRelease.size)
        for (i in 0 until n) {
            val c = compareIdentifier(preRelease[i], other.preRelease[i])
            if (c != 0) return c
        }
        return preRelease.size.compareTo(other.preRelease.size)
    }

    private fun compareIdentifier(a: String, b: String): Int {
        val aNum = a.all { it in '0'..'9' }
        val bNum = b.all { it in '0'..'9' }
        return when {
            aNum && bNum -> BigInteger(a).compareTo(BigInteger(b))
            aNum -> -1          // numeric identifiers sort before alphanumeric ones
            bNum -> 1
            else -> a.compareTo(b)
        }
    }

    override fun equals(other: Any?): Boolean = other is Semver && compareTo(other) == 0

    override fun hashCode(): Int = 31 * (31 * (31 * major + minor) + patch) + preRelease.hashCode()

    override fun toString(): String =
        "$major.$minor.$patch" + if (preRelease.isEmpty()) "" else "-" + preRelease.joinToString(".")

    companion object {
        private const val IDENT = """(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)"""
        private val PATTERN = Regex("""^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-($IDENT(?:\.$IDENT)*))?$""")

        fun parseOrNull(text: String?): Semver? {
            if (text == null || text.length > 64) return null
            val m = PATTERN.matchEntire(text) ?: return null
            val major = m.groupValues[1].toIntOrNull() ?: return null
            val minor = m.groupValues[2].toIntOrNull() ?: return null
            val patch = m.groupValues[3].toIntOrNull() ?: return null
            val pre = if (m.groupValues[4].isEmpty()) emptyList() else m.groupValues[4].split('.')
            return Semver(major, minor, patch, pre)
        }

        fun parse(text: String): Semver =
            parseOrNull(text) ?: throw IllegalArgumentException("Invalid semantic version: $text")
    }
}
