import CryptoKit
import Foundation

public let formatTag = "attest-capture/1"
public let manifestUUID = Data(hex: "9b2d6e1a5c4f4b8ea7d30e6f2c1b8a45")!

/// Signs capture messages with ECDSA P-256 / SHA-256, DER-encoded. On a phone this is the
/// Secure Enclave (`SecureEnclaveSigner`); in tests, a software key.
public protocol CaptureSigner {
    /// SubjectPublicKeyInfo DER.
    var publicKeySPKI: Data { get }
    func sign(_ message: Data) throws -> Data
}

/// A software key, for tests and tools only.
public struct SoftwareSigner: CaptureSigner {
    let key: P256.Signing.PrivateKey
    public init(pkcs8 der: Data) throws { key = try P256.Signing.PrivateKey(derRepresentation: der) }
    public init() { key = P256.Signing.PrivateKey() }
    public var publicKeySPKI: Data { key.publicKey.derRepresentation }
    public func sign(_ message: Data) throws -> Data { try key.signature(for: message).derRepresentation }
}

public func sha256(_ parts: Data...) -> Data {
    var h = SHA256()
    for p in parts { h.update(data: p) }
    return Data(h.finalize())
}

public func keyID(of spki: Data) -> String { sha256(spki).hex }

public func chainStart(initHash: Data) -> Data { sha256(Data(formatTag.utf8), initHash) }

public func chainNext(_ head: Data, fragHash: Data, sensorHash: Data?) -> Data {
    sha256(head, fragHash, sensorHash ?? Data(count: 32))
}

public func checkpointMessage(keyID: String, n: Int, head: String, timeMs: Int64) -> String {
    "\(formatTag)|checkpoint|\(keyID)|\(n)|\(head)|\(timeMs)"
}

public func sealMessage(keyID: String, n: Int, head: String, fileHash: String, startMs: Int64, endMs: Int64, metaHash: String) -> String {
    "\(formatTag)|seal|\(keyID)|\(n)|\(head)|\(fileHash)|\(startMs)|\(endMs)|\(metaHash)"
}

public func verifySignature(spki: Data, message: Data, der: Data) -> Bool {
    guard let key = try? P256.Signing.PublicKey(derRepresentation: spki),
          let sig = try? P256.Signing.ECDSASignature(derRepresentation: der) else { return false }
    return key.isValidSignature(sig, for: message)
}

public func nowMs() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

/// Seals a recording as segments are produced (capture/FORMAT.md). Feed it the init
/// segment, then fragments; checkpoint at least every 10 seconds; seal when recording stops.
/// Not thread-safe: drive it from one serial queue.
public final class CaptureSession {
    public let keyID: String
    public let meta: JSONValue
    public let startMs: Int64
    private let signer: CaptureSigner
    private var fileHash = SHA256()
    private var initHash: Data?
    private var head: Data?
    private var fragments: [JSONValue] = []
    private var checkpoints: [JSONValue] = []
    private var sealed = false

    public var fragmentCount: Int { fragments.count }

    public init(
        signer: CaptureSigner,
        platform: String,
        device: String,
        app: String = "attest-capture/0.1.0",
        location: (commitment: String?, mode: String) = (nil, "none"),
        startMs: Int64 = nowMs()
    ) {
        self.signer = signer
        self.startMs = startMs
        keyID = CaptureCore.keyID(of: signer.publicKeySPKI)
        meta = .object([
            ("app", .string(app)),
            ("platform", .string(platform)),
            ("device", .string(device)),
            ("location", .object([("commitment", location.commitment.map(JSONValue.string) ?? .null), ("mode", .string(location.mode))])),
            ("keyId", .string(keyID)),
            ("publicKey", .string(signer.publicKeySPKI.base64EncodedString())),
        ])
    }

    public func setInit(_ bytes: Data) throws {
        guard head == nil else { throw CaptureError.state("init already given") }
        let h = sha256(bytes)
        initHash = h
        head = chainStart(initHash: h)
        fileHash.update(data: bytes)
    }

    public func addFragment(_ bytes: Data, sensorRecord: Data? = nil) throws {
        guard let h = head, !sealed else { throw CaptureError.state("give the init segment first, and don't add after sealing") }
        let fragHash = sha256(bytes)
        let sensorHash = sensorRecord.map { sha256($0) }
        head = chainNext(h, fragHash: fragHash, sensorHash: sensorHash)
        fragments.append(.object([("hash", .string(fragHash.hex)), ("sensorHash", sensorHash.map { .string($0.hex) } ?? .null)]))
        fileHash.update(data: bytes)
    }

    @discardableResult
    public func checkpoint(timeMs: Int64 = nowMs()) throws -> JSONValue {
        guard let h = head?.hex else { throw CaptureError.state("no init segment") }
        let n = fragments.count
        let sig = try signer.sign(Data(checkpointMessage(keyID: keyID, n: n, head: h, timeMs: timeMs).utf8))
        let cp = JSONValue.object([("n", .int(Int64(n))), ("head", .string(h)), ("timeMs", .int(timeMs)), ("sig", .string(sig.base64EncodedString()))])
        checkpoints.append(cp)
        return cp
    }

    /// Bytes written after the last fragment are part of the file hash.
    public func addTrailer(_ bytes: Data) { fileHash.update(data: bytes) }

    /// The manifest without a seal, saved while recording for crash recovery.
    public func unsealed() -> JSONValue { manifest(endMs: nil, seal: .null) }

    public func seal(endMs: Int64 = nowMs()) throws -> JSONValue {
        guard !sealed, let h = head?.hex else { throw CaptureError.state("already sealed or never started") }
        sealed = true
        let n = fragments.count
        let fh = Data(fileHash.finalize()).hex
        let metaHash = sha256(Data(meta.write(canonical: true).utf8)).hex
        let sig = try signer.sign(Data(sealMessage(keyID: keyID, n: n, head: h, fileHash: fh, startMs: startMs, endMs: endMs, metaHash: metaHash).utf8))
        return manifest(endMs: endMs, seal: .object([("n", .int(Int64(n))), ("head", .string(h)), ("fileHash", .string(fh)), ("sig", .string(sig.base64EncodedString()))]))
    }

    private func manifest(endMs: Int64?, seal: JSONValue) -> JSONValue {
        .object([
            ("format", .string(formatTag)),
            ("meta", meta),
            ("startMs", .int(startMs)),
            ("endMs", endMs.map(JSONValue.int) ?? .null),
            ("initHash", .string(initHash?.hex ?? "")),
            ("fragments", .array(fragments)),
            ("checkpoints", .array(checkpoints)),
            ("seal", seal),
        ])
    }
}

/// The manifest as a top-level `uuid` box to append to the finished file.
public func manifestBox(_ manifest: JSONValue) -> Data {
    let json = Data(manifest.write().utf8)
    var size = UInt32(8 + 16 + json.count).bigEndian
    var box = Data(bytes: &size, count: 4)
    box.append(Data("uuid".utf8))
    box.append(manifestUUID)
    box.append(json)
    return box
}

/// Splits segment data into boxes and routes them into a session: boxes before the first
/// `moof` are the init segment, each `moof`+`mdat` pair is a fragment, `mfra`/`free` after
/// the fragments are trailer. `styp` boxes (which AVAssetWriter may put at the start of
/// each segment) are dropped and never written to the file. Returns the bytes to append
/// to the file.
public final class SegmentRouter {
    private let session: CaptureSession
    private let onFragment: (Int) -> Void
    private var initBuffer = Data()
    private var initDone = false
    private var pendingMoof: Data?

    public init(session: CaptureSession, onFragment: @escaping (Int) -> Void = { _ in }) {
        self.session = session
        self.onFragment = onFragment
    }

    public func accept(segment: Data) throws -> Data {
        var written = Data()
        for box in try parseBoxes(segment) {
            let bytes = segment.subdata(in: (segment.startIndex + box.start)..<(segment.startIndex + box.end))
            switch box.type {
            case "styp":
                continue
            case "moof":
                guard pendingMoof == nil else { throw CaptureError.malformed("two moof boxes in a row") }
                if !initDone {
                    guard !initBuffer.isEmpty else { throw CaptureError.malformed("no init segment before the first moof") }
                    try session.setInit(initBuffer)
                    initDone = true
                }
                pendingMoof = bytes
            case "mdat" where pendingMoof != nil:
                try session.addFragment(pendingMoof! + bytes)
                pendingMoof = nil
                onFragment(session.fragmentCount)
            default:
                if !initDone {
                    initBuffer.append(bytes)
                } else {
                    guard pendingMoof == nil, box.type == "mfra" || box.type == "free" else {
                        throw CaptureError.malformed("unexpected \(box.type) box after fragments")
                    }
                    session.addTrailer(bytes)
                }
            }
            written.append(bytes)
        }
        return written
    }
}

extension Data {
    public var hex: String { map { String(format: "%02x", $0) }.joined() }

    public init?(hex: String) {
        guard hex.count % 2 == 0 else { return nil }
        var d = Data(capacity: hex.count / 2)
        var i = hex.startIndex
        while i < hex.endIndex {
            let j = hex.index(i, offsetBy: 2)
            guard let b = UInt8(hex[i..<j], radix: 16) else { return nil }
            d.append(b)
            i = j
        }
        self = d
    }
}
