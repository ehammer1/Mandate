package attest.capture

import java.io.File
import java.io.RandomAccessFile

/** A top-level MP4 box: `size | type | body`, spanning [start, end) in the file. */
data class Box(val type: String, val start: Long, val end: Long) {
    val size: Long get() = end - start
}

/** Parse every top-level box of a complete file. Throws on a truncated or malformed box. */
fun parseBoxes(buf: ByteArray): List<Box> {
    val boxes = mutableListOf<Box>()
    var o = 0L
    val n = buf.size.toLong()
    while (o < n) {
        val h = headerAt(buf, o.toInt(), n - o) ?: throw IllegalArgumentException("truncated box header at byte $o")
        val size = if (h.size == 0L) n - o else h.size
        if (size < h.headerLength || o + size > n) throw IllegalArgumentException("bad size for ${h.type} box at byte $o")
        boxes += Box(h.type, o, o + size)
        o += size
    }
    return boxes
}

internal data class BoxHeader(val type: String, val size: Long, val headerLength: Int)

/** Reads a box header from `buf` at `off`, with `available` bytes after it; null if incomplete. */
internal fun headerAt(buf: ByteArray, off: Int, available: Long): BoxHeader? {
    if (available < 8) return null
    val size32 = readU32(buf, off)
    val type = String(buf, off + 4, 4, Charsets.ISO_8859_1)
    if (size32 == 1L) {
        if (available < 16) return null
        val big = readU64(buf, off + 8)
        require(big >= 16) { "bad large size for $type box" }
        return BoxHeader(type, big, 16)
    }
    return BoxHeader(type, size32, 8)
}

internal fun readU32(b: ByteArray, o: Int): Long =
    ((b[o].toLong() and 0xff) shl 24) or ((b[o + 1].toLong() and 0xff) shl 16) or
        ((b[o + 2].toLong() and 0xff) shl 8) or (b[o + 3].toLong() and 0xff)

internal fun readU64(b: ByteArray, o: Int): Long = (readU32(b, o) shl 32) or readU32(b, o + 4)

/**
 * Follows a file while a muxer writes it, and returns each top-level box once it's
 * complete on disk. The recorder calls [poll] after each fragment is flushed, and
 * [finish] after the muxer closes.
 */
class GrowingBoxReader(private val file: File) {
    private var offset = 0L

    /** Boxes completed since the last call, with their bytes. */
    fun poll(): List<Pair<Box, ByteArray>> {
        val out = mutableListOf<Pair<Box, ByteArray>>()
        RandomAccessFile(file, "r").use { raf ->
            while (true) {
                val length = raf.length()
                if (length - offset < 8) break
                val head = ByteArray(16)
                raf.seek(offset)
                val got = raf.read(head, 0, minOf(16L, length - offset).toInt())
                val h = headerAt(head, 0, got.toLong()) ?: break
                if (h.size == 0L) break // "runs to end of file": only known at finish()
                require(h.size >= h.headerLength) { "bad size for ${h.type} box at byte $offset" }
                if (offset + h.size > length) break
                require(h.size <= Int.MAX_VALUE) { "box larger than 2 GB at byte $offset" }
                val bytes = ByteArray(h.size.toInt())
                raf.seek(offset)
                raf.readFully(bytes)
                out += Box(h.type, offset, offset + h.size) to bytes
                offset += h.size
            }
        }
        return out
    }

    /** Remaining boxes once the muxer has closed the file. Throws on trailing garbage. */
    fun finish(): List<Pair<Box, ByteArray>> {
        val out = poll().toMutableList()
        val length = file.length()
        if (offset < length) {
            RandomAccessFile(file, "r").use { raf ->
                val rest = ByteArray((length - offset).toInt())
                raf.seek(offset)
                raf.readFully(rest)
                val h = headerAt(rest, 0, rest.size.toLong())
                require(h != null && h.size == 0L) { "incomplete box at byte $offset" }
                out += Box(h.type, offset, length) to rest
                offset = length
            }
        }
        return out
    }
}

/**
 * Where a file cut short by a crash should be truncated: the end of the last complete
 * fragment (moof + mdat), or of the init segment if no fragment finished. A half-written
 * box or a moof without its mdat is dropped, so what's left parses and verifies.
 */
fun lastCompleteFragmentEnd(file: File): Long {
    var goodEnd = 0L
    var seenMoof = false
    var moofPending = false
    for ((box, _) in GrowingBoxReader(file).poll()) {
        when {
            box.type == "moof" -> { seenMoof = true; moofPending = true }
            box.type == "mdat" && moofPending -> { goodEnd = box.end; moofPending = false }
            !seenMoof -> goodEnd = box.end
        }
    }
    return goodEnd
}
