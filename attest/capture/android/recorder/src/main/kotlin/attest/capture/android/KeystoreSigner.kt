package attest.capture.android

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import attest.capture.CaptureSigner
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec

/**
 * A P-256 signing key that lives in StrongBox (a separate security chip) when the phone has
 * one, otherwise in the TEE. The private key can't be exported, even with root access.
 *
 * [attestationChain] is the certificate chain Google's key attestation produces for this key.
 * The device issuer service checks it in phase 2 to prove the key is hardware-backed on a
 * genuine, unmodified phone, with the server's [challenge] inside it.
 */
class KeystoreSigner private constructor(private val alias: String) : CaptureSigner {
    private val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
    private val privateKey = keyStore.getKey(alias, null) as PrivateKey

    override val publicKeySpki: ByteArray = keyStore.getCertificate(alias).publicKey.encoded

    override fun sign(message: ByteArray): ByteArray =
        Signature.getInstance("SHA256withECDSA").run {
            initSign(privateKey)
            update(message)
            sign()
        }

    /** DER certificates, leaf first. */
    val attestationChain: List<ByteArray>
        get() = keyStore.getCertificateChain(alias).map { it.encoded }

    /** "strongbox", "tee" or "software" (the last should be refused by the issuer). */
    val securityLevel: String
        get() {
            val info = KeyFactory.getInstance(privateKey.algorithm, ANDROID_KEYSTORE).getKeySpec(privateKey, KeyInfo::class.java)
            return when (info.securityLevel) {
                KeyProperties.SECURITY_LEVEL_STRONGBOX -> "strongbox"
                KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT -> "tee"
                else -> "software"
            }
        }

    companion object {
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"

        /** The existing key under [alias], or null. */
        fun load(alias: String): KeystoreSigner? {
            val ks = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
            return if (ks.containsAlias(alias)) KeystoreSigner(alias) else null
        }

        /**
         * Create the device key. [challenge] comes from the device issuer service so the
         * attestation can't be replayed. Prefers StrongBox and falls back to the TEE.
         */
        fun create(alias: String, challenge: ByteArray): KeystoreSigner {
            try {
                generate(alias, challenge, strongBox = true)
            } catch (e: StrongBoxUnavailableException) {
                generate(alias, challenge, strongBox = false)
            }
            return KeystoreSigner(alias)
        }

        private fun generate(alias: String, challenge: ByteArray, strongBox: Boolean) {
            val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setAttestationChallenge(challenge)
                .setIsStrongBoxBacked(strongBox)
                .build()
            KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, ANDROID_KEYSTORE).apply {
                initialize(spec)
                generateKeyPair()
            }
        }
    }
}
