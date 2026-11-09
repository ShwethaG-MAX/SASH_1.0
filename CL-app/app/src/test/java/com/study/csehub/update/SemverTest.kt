package com.study.csehub.update

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SemverTest {
    private fun v(s: String) = Semver.parse(s)

    @Test fun numericNotStringComparison() {
        assertTrue(v("1.10.0") > v("1.9.0"))
        assertTrue(v("2.0.0") > v("1.99.99"))
        assertTrue(v("1.0.10") > v("1.0.9"))
    }
    @Test fun preReleaseOrdering() {
        assertTrue(v("1.0.0") > v("1.0.0-beta.2"))
        assertTrue(v("1.0.0-beta.11") > v("1.0.0-beta.2"))
        assertTrue(v("1.0.0-beta") > v("1.0.0-alpha.1"))
        assertTrue(v("1.0.0-1") < v("1.0.0-alpha"))
    }
    @Test fun equalityAndRoundTrip() {
        assertEquals(v("1.2.3"), v("1.2.3"))
        assertEquals("1.2.3-rc.1", v("1.2.3-rc.1").toString())
    }
    @Test fun rejectsInvalid() {
        for (bad in listOf("", "1", "1.0", "01.0.0", "1.0.0+build", "v1.0.0", "1.0.0-", "../1.0.0", "1.0.0/x", "99999999999.0.0"))
            assertNull(bad, Semver.parseOrNull(bad))
    }
}
