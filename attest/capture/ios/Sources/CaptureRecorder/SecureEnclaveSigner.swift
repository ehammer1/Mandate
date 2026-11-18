#if os(iOS)
import CaptureCore
import CryptoKit
import DeviceCheck
import Foundation
import Security

/// A P-256 key generated inside the Secure Enclave. The private key never leaves the chip;
/// the app keeps only an encrypted handle that works on this device alone.
public final class SecureEnclaveSigner: CaptureSigner {
    private let key: SecureEnclave.P256.Signing.PrivateKey

    public var publicKeySPKI: Data { key.publicKey.derRepresentation }

    public func sign(_ message: Data) throws -> Data {
        try key.signature(for: message).derRepresentation
    }

    private init(key: SecureEnclave.P256.Signing.PrivateKey) { self.key = key }

    /// The device key stored under `tag`, creating it on first use.
    public static func loadOrCreate(tag: String) throws -> SecureEnclaveSigner {
        if let handle = try Keychain.read(tag: tag) {
            return SecureEnclaveSigner(key: try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: handle))
        }
        guard SecureEnclave.isAvailable else { throw CaptureError.state("this device has no Secure Enclave") }
        let key = try SecureEnclave.P256.Signing.PrivateKey()
        try Keychain.write(tag: tag, data: key.dataRepresentation)
        return SecureEnclaveSigner(key: key)
    }

    /// App Attest proof that this is the genuine app on a real device, bound to this
    /// signing key: Apple's attestation covers SHA256(challenge || public key). The device
    /// issuer service checks it in phase 2 before registering the key.
    public func appAttestation(challenge: Data) async throws -> (attestKeyID: String, attestation: Data) {
        let service = DCAppAttestService.shared
        guard service.isSupported else { throw CaptureError.state("App Attest is not supported on this device") }
        let attestKeyID = try await service.generateKey()
        let clientDataHash = sha256(challenge, publicKeySPKI)
        let attestation = try await service.attestKey(attestKeyID, clientDataHash: clientDataHash)
        return (attestKeyID, attestation)
    }
}

/// Stores the Secure Enclave key handle (not the key) in the Keychain, this device only.
enum Keychain {
    static func read(tag: String) throws -> Data? {
        var out: CFTypeRef?
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "attest-capture",
            kSecAttrAccount as String: tag,
            kSecReturnData as String: true,
        ]
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw CaptureError.state("keychain read failed (\(status))") }
        return out as? Data
    }

    static func write(tag: String, data: Data) throws {
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "attest-capture",
            kSecAttrAccount as String: tag,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemAdd(q as CFDictionary, nil)
        guard status == errSecSuccess else { throw CaptureError.state("keychain write failed (\(status))") }
    }
}
#endif
