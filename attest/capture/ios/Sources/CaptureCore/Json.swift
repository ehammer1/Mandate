import Foundation

/// Just enough JSON for manifests, written exactly as JavaScript's JSON.stringify would,
/// because the seal signs a hash of the canonical JSON of the metadata.
public indirect enum JSONValue: Equatable {
    case null
    case bool(Bool)
    case int(Int64)
    case string(String)
    case array([JSONValue])
    /// Keys keep insertion order; `canonical` output sorts them.
    case object([(String, JSONValue)])

    public static func == (a: JSONValue, b: JSONValue) -> Bool { a.write() == b.write() }

    public func write(canonical: Bool = false) -> String {
        var s = ""
        emit(&s, canonical)
        return s
    }

    private func emit(_ s: inout String, _ canonical: Bool) {
        switch self {
        case .null: s += "null"
        case .bool(let b): s += b ? "true" : "false"
        case .int(let i): s += String(i)
        case .string(let str): JSONValue.quote(&s, str)
        case .array(let a):
            s += "["
            for (i, v) in a.enumerated() { if i > 0 { s += "," }; v.emit(&s, canonical) }
            s += "]"
        case .object(let pairs):
            // JS sorts keys by UTF-16 code units.
            let ordered = canonical ? pairs.sorted { Array($0.0.utf16).lexicographicallyPrecedes(Array($1.0.utf16)) } : pairs
            s += "{"
            for (i, (k, v)) in ordered.enumerated() {
                if i > 0 { s += "," }
                JSONValue.quote(&s, k)
                s += ":"
                v.emit(&s, canonical)
            }
            s += "}"
        }
    }

    private static func quote(_ s: inout String, _ str: String) {
        s += "\""
        for u in str.unicodeScalars {
            switch u {
            case "\"": s += "\\\""
            case "\\": s += "\\\\"
            case "\u{08}": s += "\\b"
            case "\u{0C}": s += "\\f"
            case "\n": s += "\\n"
            case "\r": s += "\\r"
            case "\t": s += "\\t"
            default:
                if u.value < 0x20 { s += String(format: "\\u%04x", u.value) } else { s.unicodeScalars.append(u) }
            }
        }
        s += "\""
    }

    public subscript(key: String) -> JSONValue? {
        if case .object(let pairs) = self { return pairs.first { $0.0 == key }?.1 }
        return nil
    }
}
