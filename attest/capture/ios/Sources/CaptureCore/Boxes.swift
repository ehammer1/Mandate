import Foundation

/// A top-level MP4 box spanning `start..<end` of its buffer.
public struct Box: Equatable {
    public let type: String
    public let start: Int
    public let end: Int
}

public enum CaptureError: Error, Equatable {
    case malformed(String)
    case state(String)
}

/// Parse every top-level box in `data`. Throws on a truncated or malformed box.
public func parseBoxes(_ data: Data) throws -> [Box] {
    let bytes = [UInt8](data)
    var boxes: [Box] = []
    var o = 0
    while o < bytes.count {
        guard bytes.count - o >= 8 else { throw CaptureError.malformed("truncated box header at byte \(o)") }
        var size = Int(readU32(bytes, o))
        let type = String(bytes: bytes[(o + 4)..<(o + 8)], encoding: .isoLatin1) ?? "????"
        var header = 8
        if size == 1 {
            guard bytes.count - o >= 16 else { throw CaptureError.malformed("truncated large box at byte \(o)") }
            size = Int(readU32(bytes, o + 8)) << 32 | Int(readU32(bytes, o + 12))
            header = 16
        } else if size == 0 {
            size = bytes.count - o
        }
        guard size >= header, o + size <= bytes.count else { throw CaptureError.malformed("bad size for \(type) box at byte \(o)") }
        boxes.append(Box(type: type, start: o, end: o + size))
        o += size
    }
    return boxes
}

func readU32(_ b: [UInt8], _ o: Int) -> UInt32 {
    UInt32(b[o]) << 24 | UInt32(b[o + 1]) << 16 | UInt32(b[o + 2]) << 8 | UInt32(b[o + 3])
}

/// Where a file cut short by a crash should be truncated: the end of the last complete
/// fragment (moof + mdat), or of the init segment if none finished. A half-written box or
/// a moof without its mdat is dropped, so what's left parses and verifies.
public func lastCompleteFragmentEnd(_ data: Data) -> Int {
    let bytes = [UInt8](data)
    var o = 0, goodEnd = 0
    var seenMoof = false, moofPending = false
    while bytes.count - o >= 8 {
        var size = Int(readU32(bytes, o))
        if size == 1 {
            guard bytes.count - o >= 16 else { break }
            size = Int(readU32(bytes, o + 8)) << 32 | Int(readU32(bytes, o + 12))
        }
        guard size >= 8, o + size <= bytes.count else { break }
        let type = String(bytes: bytes[(o + 4)..<(o + 8)], encoding: .isoLatin1) ?? ""
        if type == "moof" { seenMoof = true; moofPending = true }
        else if type == "mdat" && moofPending { goodEnd = o + size; moofPending = false }
        else if !seenMoof { goodEnd = o + size }
        o += size
    }
    return goodEnd
}
