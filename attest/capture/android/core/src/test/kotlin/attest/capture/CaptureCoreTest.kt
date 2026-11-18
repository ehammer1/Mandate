package attest.capture

import java.io.File
import java.util.Base64
import kotlin.random.Random
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class CaptureCoreTest {
    private val dir = File(System.getProperty("vectors"))
    private val out = File(System.getProperty("outDir")).apply { mkdirs() }

    @Suppress("UNCHECKED_CAST")
    private val v = Json.parse(File(dir, "vectors.json").readText()) as Map<String, Any?>
    private val sample = File(dir, "sample.mp4").readBytes()
    private val publicKey = Base64.getDecoder().decode(v["publicKey"] as String)
    private val signer = SoftwareSigner.fromPkcs8(
        Base64.getDecoder().decode(File(dir, "test-key.pk8.b64").readText().trim()),
        publicKey,
    )

    @Suppress("UNCHECKED_CAST")
    private fun strings(k: String) = v[k] as List<String>

    @Test
    fun `boxes split into init and fragments as in the vectors`() {
        val boxes = parseBoxes(sample)
        val firstMoof = boxes.indexOfFirst { it.type == "moof" }
        assertEquals((v["initLength"] as Long), boxes[firstMoof].start)
        val fragLengths = boxes.filter { it.type == "moof" }.map { moof ->
            val mdat = boxes[boxes.indexOf(moof) + 1]
            mdat.end - moof.start
        }
        assertEquals((v["fragmentLengths"] as List<*>).map { it as Long }, fragLengths)
    }

    @Test
    fun `hashes, chain, key id, canonical metadata and messages match the vectors`() {
        assertEquals(v["keyId"], keyIdOf(publicKey))
        val init = sample.copyOfRange(0, (v["initLength"] as Long).toInt())
        assertEquals(v["initHash"], sha256(init).toHex())

        var head = chainStart(sha256(init))
        assertEquals(strings("heads")[0], head.toHex())
        strings("fragmentHashes").forEachIndexed { i, h ->
            head = chainNext(head, h.hexToBytes(), null)
            assertEquals(strings("heads")[i + 1], head.toHex())
        }

        val session = CaptureSession(signer, platform = "reference", device = "test vectors", startMs = 1794979200000)
        assertEquals(v["canonicalMeta"], Json.write(session.meta, canonical = true))
        assertEquals(v["metaHash"], sha256((v["canonicalMeta"] as String).toByteArray()).toHex())
        assertTrue(verifySignature(publicKey, (v["sealMessage"] as String).toByteArray(), Base64.getDecoder().decode(v["sealSignature"] as String)))
    }

    @Test
    fun `sealing while the file grows gives the same chain as the vectors`() {
        // Write sample.mp4 in random-sized chunks, polling like the recorder does.
        val growing = File(out, "growing.mp4").apply { delete() }
        val session = CaptureSession(signer, platform = "reference", device = "test vectors", startMs = 1794979200000)
        val checkpointsAt = mutableListOf<Int>()
        val router = FragmentRouter(session) { n -> if (n % 10 == 0) { session.checkpoint(1794979200000 + n * 1000L); checkpointsAt += n } }
        val reader = GrowingBoxReader(growing)
        val rnd = Random(7)
        var o = 0
        growing.outputStream().use { os ->
            while (o < sample.size) {
                val n = minOf(sample.size - o, 1 + rnd.nextInt(9000))
                os.write(sample, o, n); os.flush(); o += n
                reader.poll().forEach { (box, bytes) -> router.accept(box, bytes) }
            }
        }
        reader.finish().forEach { (box, bytes) -> router.accept(box, bytes) }
        val manifest = session.seal(endMs = 1794979200000 + 13_000)

        @Suppress("UNCHECKED_CAST")
        val frags = (manifest["fragments"] as List<Map<String, Any?>>).map { it["hash"] }
        assertEquals(strings("fragmentHashes"), frags)
        @Suppress("UNCHECKED_CAST")
        val seal = manifest["seal"] as Map<String, Any?>
        assertEquals(strings("heads").last(), seal["head"])
        assertEquals(v["bodyHash"], seal["fileHash"])
        assertEquals(listOf(10), checkpointsAt)

        // The JS verifier checks this file in the cross-check test (test/capture.test.js).
        File(out, "kotlin-sealed.mp4").writeBytes(sample + manifestBox(manifest))
        File(out, "kotlin-unsealed.json").writeText(Json.write(session.unsealed()))
    }

    @Test
    fun `json output matches JavaScript for awkward strings`() {
        assertEquals("""{"a":"q\"b\\s\n\t\u0001é"}""", Json.write(mapOf("a" to "q\"b\\s\n\t\u0001é")))
        assertEquals("""{"a":1,"b":[true,null],"c":{"x":"y"}}""", Json.write(linkedMapOf("c" to mapOf("x" to "y"), "a" to 1, "b" to listOf(true, null)), canonical = true))
        val round = Json.parse("""{"n":1794979200000,"s":"é\n","l":[1,2],"o":{}}""") as Map<*, *>
        assertEquals(1794979200000L, round["n"])
        assertEquals("é\n", round["s"])
    }

    @Test
    fun `a file cut short mid-fragment is trimmed back to the last whole fragment`() {
        val boxes = parseBoxes(sample)
        val moofs = boxes.filter { it.type == "moof" }
        val mdat5 = boxes[boxes.indexOf(moofs[5]) + 1]
        // Crash halfway through fragment 6's mdat.
        val cut = File(out, "crashed.mp4").apply { writeBytes(sample.copyOfRange(0, (moofs[6].end + 500).toInt())) }
        assertEquals(mdat5.end, lastCompleteFragmentEnd(cut))
        // Crash right after a moof was written, before its mdat.
        cut.writeBytes(sample.copyOfRange(0, moofs[6].end.toInt()))
        assertEquals(mdat5.end, lastCompleteFragmentEnd(cut))
        // Crash before any fragment finished: keep the init segment only.
        cut.writeBytes(sample.copyOfRange(0, (moofs[0].end + 10).toInt()))
        assertEquals(moofs[0].start, lastCompleteFragmentEnd(cut))
    }

    @Test
    fun `malformed streams are refused`() {
        assertFailsWith<IllegalArgumentException> { parseBoxes(sample.copyOfRange(0, sample.size - 3)) }
        val s = CaptureSession(signer, "reference", "t")
        val r = FragmentRouter(s)
        val boxes = parseBoxes(sample)
        val moof = boxes.first { it.type == "moof" }
        assertFailsWith<IllegalStateException> { r.accept(moof, ByteArray(8)) } // no init yet
        assertContentEquals(MANIFEST_UUID, manifestBox(emptyMap()).copyOfRange(8, 24))
    }
}
