package attest.capture

/**
 * Just enough JSON for manifests. Output matches JavaScript's JSON.stringify for the
 * same values, which matters because the seal signs a hash of canonical JSON.
 * Values: null, Boolean, Long/Int, String, List<Any?>, Map<String, Any?>.
 */
object Json {
    /** Compact JSON. With [canonical], object keys are sorted (by UTF-16 code units, as JS does). */
    fun write(v: Any?, canonical: Boolean = false): String = StringBuilder().also { emit(it, v, canonical) }.toString()

    private fun emit(sb: StringBuilder, v: Any?, canonical: Boolean) {
        when (v) {
            null -> sb.append("null")
            is Boolean -> sb.append(v)
            is Int, is Long -> sb.append(v)
            is String -> quote(sb, v)
            is List<*> -> {
                sb.append('[')
                v.forEachIndexed { i, x -> if (i > 0) sb.append(','); emit(sb, x, canonical) }
                sb.append(']')
            }
            is Map<*, *> -> {
                sb.append('{')
                val keys = v.keys.map { it as String }.let { if (canonical) it.sorted() else it }
                keys.forEachIndexed { i, k ->
                    if (i > 0) sb.append(',')
                    quote(sb, k)
                    sb.append(':')
                    emit(sb, v[k], canonical)
                }
                sb.append('}')
            }
            else -> throw IllegalArgumentException("can't write ${v::class.simpleName} as JSON")
        }
    }

    private fun quote(sb: StringBuilder, s: String) {
        sb.append('"')
        for (c in s) {
            when (c) {
                '"' -> sb.append("\\\"")
                '\\' -> sb.append("\\\\")
                '\b' -> sb.append("\\b")
                '\u000c' -> sb.append("\\f")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                else -> if (c < ' ') sb.append("\\u%04x".format(c.code)) else sb.append(c)
            }
        }
        sb.append('"')
    }

    /** Parse JSON. Numbers come back as Long when integral, else Double. */
    fun parse(s: String): Any? = Parser(s).run { val v = value(); ws(); require(i == s.length) { "trailing data" }; v }

    private class Parser(val s: String) {
        var i = 0
        fun ws() { while (i < s.length && s[i] in " \t\n\r") i++ }
        fun value(): Any? {
            ws()
            require(i < s.length) { "unexpected end" }
            return when (s[i]) {
                '{' -> obj()
                '[' -> arr()
                '"' -> str()
                't' -> lit("true", true)
                'f' -> lit("false", false)
                'n' -> lit("null", null)
                else -> num()
            }
        }
        fun lit(w: String, v: Any?): Any? { require(s.startsWith(w, i)) { "bad literal at $i" }; i += w.length; return v }
        fun obj(): Map<String, Any?> {
            val m = LinkedHashMap<String, Any?>(); i++; ws()
            if (s[i] == '}') { i++; return m }
            while (true) {
                ws(); val k = str(); ws(); require(s[i] == ':') { "expected : at $i" }; i++
                m[k] = value(); ws()
                if (s[i] == ',') { i++; continue }
                require(s[i] == '}') { "expected } at $i" }; i++; return m
            }
        }
        fun arr(): List<Any?> {
            val l = mutableListOf<Any?>(); i++; ws()
            if (s[i] == ']') { i++; return l }
            while (true) {
                l += value(); ws()
                if (s[i] == ',') { i++; continue }
                require(s[i] == ']') { "expected ] at $i" }; i++; return l
            }
        }
        fun str(): String {
            require(s[i] == '"') { "expected string at $i" }; i++
            val sb = StringBuilder()
            while (true) {
                val c = s[i++]
                when (c) {
                    '"' -> return sb.toString()
                    '\\' -> when (val e = s[i++]) {
                        'n' -> sb.append('\n'); 't' -> sb.append('\t'); 'r' -> sb.append('\r')
                        'b' -> sb.append('\b'); 'f' -> sb.append('\u000c')
                        'u' -> { sb.append(s.substring(i, i + 4).toInt(16).toChar()); i += 4 }
                        else -> sb.append(e)
                    }
                    else -> sb.append(c)
                }
            }
        }
        fun num(): Number {
            val st = i
            while (i < s.length && (s[i].isDigit() || s[i] in "+-.eE")) i++
            val t = s.substring(st, i)
            return t.toLongOrNull() ?: t.toDouble()
        }
    }
}
