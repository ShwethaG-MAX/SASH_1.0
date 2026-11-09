package com.study.csehub.update

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.FileOutputStream
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

class ReleaseInstallerTest {
    @get:Rule val tmp = TemporaryFolder()

    private fun zipOf(vararg entries: Pair<String, String>): File {
        val f = tmp.newFile()
        ZipOutputStream(FileOutputStream(f)).use { z ->
            for ((n, c) in entries) { z.putNextEntry(ZipEntry(n)); z.write(c.toByteArray()); z.closeEntry() }
        }
        return f
    }

    @Test fun safeNames() {
        assertTrue(PathRules.isSafeEntryName("index.html"))
        assertTrue(PathRules.isSafeEntryName("vendor/firebase/10.14.1/firebase-app-compat.js"))
        for (bad in listOf("../evil", "a/../../evil", "/abs", "C:/x", "a\\b", "a//b", "./a", "", "a/\u0000b"))
            assertFalse(bad, PathRules.isSafeEntryName(bad))
    }

    @Test fun extractsNormalZip() {
        val dest = tmp.newFolder()
        ReleaseInstaller.extract(zipOf("index.html" to "<html>", "docs/a.pdf" to "x"), dest)
        assertTrue(File(dest, "index.html").isFile)
        assertTrue(File(dest, "docs/a.pdf").isFile)
    }

    @Test fun blocksPathTraversal() {
        val dest = tmp.newFolder()
        try { ReleaseInstaller.extract(zipOf("../escaped.txt" to "pwn"), dest); fail("should throw") }
        catch (e: ReleaseException) { /* expected */ }
        assertFalse(File(dest.parentFile, "escaped.txt").exists())
    }

    @Test fun blocksDuplicates() {
        val dest = tmp.newFolder()
        try { ReleaseInstaller.extract(zipOf("a.txt" to "1", "A.TXT" to "2"), dest); fail("should throw") }
        catch (e: ReleaseException) { /* expected */ }
    }

    @Test fun validatesReleaseJson() {
        val dir = tmp.newFolder()
        File(dir, "index.html").writeText("<html>")
        val sha = ReleaseInstaller.sha256(File(dir, "index.html"))
        File(dir, "release.json").writeText(
            """{"schema":1,"version":"1.0.0","entry":"index.html","files":[{"path":"index.html","size":6,"sha256":"$sha"}]}"""
        )
        ReleaseInstaller.validateRelease(dir, "1.0.0", full = true)
        File(dir, "index.html").writeText("<html>TAMPERED")
        try { ReleaseInstaller.validateRelease(dir, "1.0.0", full = true); fail("should throw") }
        catch (e: ReleaseException) { /* expected */ }
        try { ReleaseInstaller.validateRelease(dir, "9.9.9", full = false); fail("should throw") }
        catch (e: ReleaseException) { /* expected */ }
    }
}
