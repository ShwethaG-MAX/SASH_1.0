package com.study.csehub.update

import android.util.Base64
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.X509EncodedKeySpec

/** Verifies the publisher's ECDSA P-256 / SHA-256 signature over the manifest (works on every Android version >= 7). */
object ManifestVerifier {
    fun verify(payload: ByteArray, signatureBase64: String, trustedKeysBase64: List<String>): Boolean {
        if (trustedKeysBase64.isEmpty()) return false
        val sig = try { Base64.decode(signatureBase64, Base64.DEFAULT) } catch (e: IllegalArgumentException) { return false }
        for (k in trustedKeysBase64) {
            try {
                val pub = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(Base64.decode(k, Base64.DEFAULT)))
                val s = Signature.getInstance("SHA256withECDSA")
                s.initVerify(pub)
                s.update(payload)
                if (s.verify(sig)) return true
            } catch (e: Exception) {
                // wrong/invalid key or malformed signature: try the next trusted key
            }
        }
        return false
    }
}
