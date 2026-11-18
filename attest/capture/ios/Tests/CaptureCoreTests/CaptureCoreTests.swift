import CaptureCore
import Foundation
import XCTest

/// Checks the Swift core against the shared vectors in capture/vectors. Run with `swift test`
/// on a Mac. Writes swift-sealed.mp4 for the JavaScript verifier to check.
final class CaptureCoreTests: XCTestCase {
    let vectorsDir = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().appendingPathComponent("vectors")
    var v: [String: Any] = [:]
    var sample = Data()
    var signer: SoftwareSigner!

    override func setUpWithError() throws {
        v = try JSONSerialization.jsonObject(with: Data(contentsOf: vectorsDir.appendingPathComponent("vectors.json"))) as! [String: Any]
        sample = try Data(contentsOf: vectorsDir.appendingPathComponent("sample.mp4"))
        let pk8 = try String(contentsOf: vectorsDir.appendingPathComponent("test-key.pk8.b64")).trimmingCharacters(in: .whitespacesAndNewlines)
        signer = try SoftwareSigner(pkcs8: Data(base64Encoded: pk8)!)
    }

    func testKeyAndMessagesMatchVectors() throws {
        XCTAssertEqual(signer.publicKeySPKI.base64EncodedString(), v["publicKey"] as? String)
        XCTAssertEqual(keyID(of: signer.publicKeySPKI), v["keyId"] as? String)
        let session = CaptureSession(signer: signer, platform: "reference", device: "test vectors", startMs: 1794979200000)
        XCTAssertEqual(session.meta.write(canonical: true), v["canonicalMeta"] as? String)
        XCTAssertTrue(verifySignature(spki: signer.publicKeySPKI, message: Data((v["sealMessage"] as! String).utf8),
                                      der: Data(base64Encoded: v["sealSignature"] as! String)!))
    }

    func testChainMatchesVectors() throws {
        let initLength = v["initLength"] as! Int
        XCTAssertEqual(sha256(sample.prefix(initLength)).hex, v["initHash"] as? String)
        let heads = v["heads"] as! [String]
        var head = chainStart(initHash: sha256(sample.prefix(initLength)))
        XCTAssertEqual(head.hex, heads[0])
        for (i, h) in (v["fragmentHashes"] as! [String]).enumerated() {
            head = chainNext(head, fragHash: Data(hex: h)!, sensorHash: nil)
            XCTAssertEqual(head.hex, heads[i + 1])
        }
    }

    func testSealingSegmentsMatchesVectorsAndWritesTheSameFile() throws {
        let session = CaptureSession(signer: signer, platform: "reference", device: "test vectors", startMs: 1794979200000)
        var checkpointsAt: [Int] = []
        let router = SegmentRouter(session: session) { n in
            if n % 10 == 0 { _ = try? session.checkpoint(timeMs: 1794979200000 + Int64(n) * 1000); checkpointsAt.append(n) }
        }
        // Feed the file split at box boundaries, in uneven groups, like segments arriving.
        let boxes = try parseBoxes(sample)
        var written = Data()
        var i = 0
        while i < boxes.count {
            let j = min(boxes.count, i + 1 + (i % 3))
            written.append(try router.accept(segment: sample.subdata(in: boxes[i].start..<boxes[j - 1].end)))
            i = j
        }
        XCTAssertEqual(written, sample)
        let manifest = try session.seal(endMs: 1794979200000 + 13_000)
        XCTAssertEqual(manifest["seal"]?["head"], .string((v["heads"] as! [String]).last!))
        XCTAssertEqual(manifest["seal"]?["fileHash"], .string(v["bodyHash"] as! String))
        XCTAssertEqual(checkpointsAt, [10])
        let out = FileManager.default.temporaryDirectory.appendingPathComponent("swift-sealed.mp4")
        try (sample + manifestBox(manifest)).write(to: out)
        print("wrote \(out.path); check with: attest verify-capture \(out.path)")
    }

    func testStypBoxesAreDroppedFromSegments() throws {
        let session = CaptureSession(signer: signer, platform: "reference", device: "t")
        let router = SegmentRouter(session: session)
        let boxes = try parseBoxes(sample)
        let firstMoof = boxes.firstIndex { $0.type == "moof" }!
        _ = try router.accept(segment: sample.prefix(boxes[firstMoof].start))
        var styp = Data([0, 0, 0, 16]); styp.append(Data("stypmsdh".utf8)); styp.append(Data([0, 0, 0, 0]))
        let frag = sample.subdata(in: boxes[firstMoof].start..<boxes[firstMoof + 1].end)
        XCTAssertEqual(try router.accept(segment: styp + frag), frag)
        XCTAssertEqual(session.fragmentCount, 1)
    }

    func testCrashTrimming() throws {
        let boxes = try parseBoxes(sample)
        let moofs = boxes.filter { $0.type == "moof" }
        let mdat5 = boxes[boxes.firstIndex(of: moofs[5])! + 1]
        XCTAssertEqual(lastCompleteFragmentEnd(sample.prefix(moofs[6].end + 500)), mdat5.end)
        XCTAssertEqual(lastCompleteFragmentEnd(sample.prefix(moofs[6].end)), mdat5.end)
        XCTAssertEqual(lastCompleteFragmentEnd(sample.prefix(moofs[0].end + 10)), moofs[0].start)
    }

    func testJSONMatchesJavaScript() {
        let o = JSONValue.object([("c", .object([("x", .string("y"))])), ("a", .int(1)), ("b", .array([.bool(true), .null]))])
        XCTAssertEqual(o.write(canonical: true), #"{"a":1,"b":[true,null],"c":{"x":"y"}}"#)
        XCTAssertEqual(JSONValue.string("q\"b\\s\n\t\u{01}é").write(), #""q\"b\\s\n\t\u0001é""#)
    }
}
