package attest.capture

import java.security.MessageDigest

const val FORMAT_TAG = "attest-capture/1"
val MANIFEST_UUID: ByteArray = "9b2d6e1a5c4f4b8ea7d30e6f2c1b8a45".hexToBytes()
private val ZERO32 = ByteArray(32)

fun chainStart(initHash: ByteArray): ByteArray = sha256(FORMAT_TAG.toByteArray(Charsets.US_ASCII), initHash)
fun chainNext(head: ByteArray, fragHash: ByteArray, sensorHash: ByteArray?): ByteArray =
    sha256(head, fragHash, sensorHash ?: ZERO32)

fun checkpointMessage(keyId: String, n: Int, head: String, timeMs: Long) =
    "$FORMAT_TAG|checkpoint|$keyId|$n|$head|$timeMs"

fun sealMessage(keyId: String, n: Int, head: String, fileHash: String, startMs: Long, endMs: Long, metaHash: String) =
    "$FORMAT_TAG|seal|$keyId|$n|$head|$fileHash|$startMs|$endMs|$metaHash"

/** Where a recording's location is kept (see docs/capture-app.md). Phase 1 records none. */
data class LocationSeal(val commitment: String?, val mode: String) {
    fun toMap(): Map<String, Any?> = linkedMapOf("commitment" to commitment, "mode" to mode)
    companion object { val NONE = LocationSeal(null, "none") }
}

/**
 * Seals a recording as the muxer writes it (FORMAT.md). Give it the init segment, then
 * each fragment; call [checkpoint] at least every 10 seconds; [seal] when recording stops.
 * Not thread-safe: drive it from the recorder's writer thread.
 */
class CaptureSession(
    private val signer: CaptureSigner,
    platform: String,
    device: String,
    app: String = "attest-capture/0.1.0",
    location: LocationSeal = LocationSeal.NONE,
    val startMs: Long = System.currentTimeMillis(),
) {
    val keyId: String = keyIdOf(signer.publicKeySpki)
    val meta: Map<String, Any?> = linkedMapOf(
        "app" to app,
        "platform" to platform,
        "device" to device,
        "location" to location.toMap(),
        "keyId" to keyId,
        "publicKey" to java.util.Base64.getEncoder().encodeToString(signer.publicKeySpki),
    )

    private val fileDigest = MessageDigest.getInstance("SHA-256")
    private var initHash: ByteArray? = null
    private var head: ByteArray? = null
    private val fragments = mutableListOf<Map<String, Any?>>()
    private val checkpoints = mutableListOf<Map<String, Any?>>()
    private var sealed = false

    val fragmentCount: Int get() = fragments.size

    fun init(bytes: ByteArray) {
        check(head == null) { "init already given" }
        initHash = sha256(bytes)
        head = chainStart(initHash!!)
        fileDigest.update(bytes)
    }

    fun addFragment(bytes: ByteArray, sensorRecord: ByteArray? = null) {
        val h = checkNotNull(head) { "give the init segment first" }
        check(!sealed) { "already sealed" }
        val fragHash = sha256(bytes)
        val sensorHash = sensorRecord?.let { sha256(it) }
        head = chainNext(h, fragHash, sensorHash)
        fragments += linkedMapOf("hash" to fragHash.toHex(), "sensorHash" to sensorHash?.toHex())
        fileDigest.update(bytes)
    }

    fun checkpoint(timeMs: Long = System.currentTimeMillis()): Map<String, Any?> {
        val n = fragments.size
        val h = checkNotNull(head).toHex()
        val sig = b64(signer.sign(checkpointMessage(keyId, n, h, timeMs).toByteArray()))
        return linkedMapOf<String, Any?>("n" to n, "head" to h, "timeMs" to timeMs, "sig" to sig).also { checkpoints += it }
    }

    /** Bytes written after the last fragment (e.g. an mfra index) must be included in the file hash. */
    fun addTrailer(bytes: ByteArray) = fileDigest.update(bytes)

    /** The manifest without a seal, persisted while recording for crash recovery. */
    fun unsealed(): Map<String, Any?> = manifest(endMs = null, seal = null)

    fun seal(endMs: Long = System.currentTimeMillis()): Map<String, Any?> {
        check(!sealed) { "already sealed" }
        sealed = true
        val n = fragments.size
        val h = checkNotNull(head).toHex()
        val fileHash = fileDigest.digest().toHex()
        val metaHash = sha256(Json.write(meta, canonical = true).toByteArray()).toHex()
        val sig = b64(signer.sign(sealMessage(keyId, n, h, fileHash, startMs, endMs, metaHash).toByteArray()))
        return manifest(endMs, linkedMapOf("n" to n, "head" to h, "fileHash" to fileHash, "sig" to sig))
    }

    private fun manifest(endMs: Long?, seal: Map<String, Any?>?): Map<String, Any?> = linkedMapOf(
        "format" to FORMAT_TAG,
        "meta" to meta,
        "startMs" to startMs,
        "endMs" to endMs,
        "initHash" to checkNotNull(initHash).toHex(),
        "fragments" to fragments.toList(),
        "checkpoints" to checkpoints.toList(),
        "seal" to seal,
    )

    private fun b64(b: ByteArray) = java.util.Base64.getEncoder().encodeToString(b)
}

/** The manifest as a top-level `uuid` box to append to the finished file. */
fun manifestBox(manifest: Map<String, Any?>): ByteArray {
    val json = Json.write(manifest).toByteArray(Charsets.UTF_8)
    val size = 8 + 16 + json.size
    val header = byteArrayOf(
        (size ushr 24).toByte(), (size ushr 16).toByte(), (size ushr 8).toByte(), size.toByte(),
        'u'.code.toByte(), 'u'.code.toByte(), 'i'.code.toByte(), 'd'.code.toByte(),
    )
    return header + MANIFEST_UUID + json
}

/**
 * Routes boxes from a [GrowingBoxReader] into a [CaptureSession]: everything before the
 * first `moof` is the init segment, each `moof`+`mdat` pair is a fragment, and boxes after
 * the fragments (mfra, free) are trailer. Calls [onFragment] after each fragment so the
 * recorder can decide when to checkpoint.
 */
class FragmentRouter(private val session: CaptureSession, private val onFragment: (Int) -> Unit = {}) {
    private val init = java.io.ByteArrayOutputStream()
    private var initDone = false
    private var pendingMoof: ByteArray? = null
    private var afterFragments = false

    fun accept(box: Box, bytes: ByteArray) {
        when {
            box.type == "moof" -> {
                check(!afterFragments) { "moof after trailing boxes" }
                check(pendingMoof == null) { "two moof boxes in a row" }
                if (!initDone) {
                    check(init.size() > 0) { "no init segment before the first moof" }
                    session.init(init.toByteArray())
                    initDone = true
                }
                pendingMoof = bytes
            }
            box.type == "mdat" && pendingMoof != null -> {
                session.addFragment(pendingMoof!! + bytes)
                pendingMoof = null
                onFragment(session.fragmentCount)
            }
            !initDone -> init.write(bytes)
            else -> {
                check(pendingMoof == null) { "moof without mdat" }
                check(box.type == "mfra" || box.type == "free") { "unexpected ${box.type} box after fragments" }
                afterFragments = true
                session.addTrailer(bytes)
            }
        }
    }
}
