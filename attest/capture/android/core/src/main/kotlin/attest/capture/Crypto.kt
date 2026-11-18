package attest.capture

import java.security.KeyFactory
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.PublicKey
import java.security.Signature
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec

fun sha256(vararg parts: ByteArray): ByteArray {
    val d = MessageDigest.getInstance("SHA-256")
    for (p in parts) d.update(p)
    return d.digest()
}

fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it.toInt() and 0xff) }

fun String.hexToBytes(): ByteArray {
    require(length % 2 == 0) { "odd-length hex" }
    return ByteArray(length / 2) { i -> substring(2 * i, 2 * i + 2).toInt(16).toByte() }
}

/**
 * Signs capture messages with ECDSA P-256 / SHA-256, DER-encoded. On a phone this is
 * backed by StrongBox or the TEE (see the recorder module); here it can be a software key.
 */
interface CaptureSigner {
    /** SubjectPublicKeyInfo DER. */
    val publicKeySpki: ByteArray
    fun sign(message: ByteArray): ByteArray
}

/** A software key, for tests and tools only. */
class SoftwareSigner(private val privateKey: PrivateKey, override val publicKeySpki: ByteArray) : CaptureSigner {
    override fun sign(message: ByteArray): ByteArray =
        Signature.getInstance("SHA256withECDSA").run {
            initSign(privateKey)
            update(message)
            sign()
        }

    companion object {
        /** From a PKCS#8 DER private key and its SubjectPublicKeyInfo DER public key. */
        fun fromPkcs8(privateDer: ByteArray, publicSpki: ByteArray): SoftwareSigner =
            SoftwareSigner(KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(privateDer)), publicSpki)
    }
}

fun verifySignature(spki: ByteArray, message: ByteArray, der: ByteArray): Boolean = try {
    val key: PublicKey = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(spki))
    Signature.getInstance("SHA256withECDSA").run {
        initVerify(key)
        update(message)
        verify(der)
    }
} catch (e: Exception) {
    false
}

fun keyIdOf(spki: ByteArray): String = sha256(spki).toHex()
