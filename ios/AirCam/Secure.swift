import CryptoKit
import Foundation

/// Encrypted transport, mirror of src/secure.js (format documented there):
/// X25519 ephemeral handshake ("ACv1" + public key), HKDF-SHA256 → per-direction keys, AES-256-GCM records.
final class SecureSession {
    enum Failure: Error { case handshake, notReady, record }
    static let magic = Data("ACv1".utf8)
    static let helloLength = 36

    private let privateKey: Curve25519.KeyAgreement.PrivateKey
    private var tx: SymmetricKey?, rx: SymmetricKey?
    private var txN: UInt64 = 0, rxN: UInt64 = 0

    init(privateKey: Curve25519.KeyAgreement.PrivateKey = .init()) { self.privateKey = privateKey }

    var hello: Data { Self.magic + privateKey.publicKey.rawRepresentation }

    /// Phone side: derives the keys from the PC's hello.
    func accept(_ peerHello: Data) throws {
        let b = [UInt8](peerHello)
        guard b.count == Self.helloLength, Data(b[0..<4]) == Self.magic else { throw Failure.handshake }
        let peer = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: Data(b[4...]))
        let secret = try privateKey.sharedSecretFromKeyAgreement(with: peer)
        let keys = secret.hkdfDerivedSymmetricKey(using: SHA256.self, salt: Data("AirCam v1".utf8),
                                                  sharedInfo: Data("keys".utf8), outputByteCount: 64)
        let raw = keys.withUnsafeBytes { Data($0) }
        tx = SymmetricKey(data: raw.prefix(32)) // phone → PC
        rx = SymmetricKey(data: raw.suffix(32)) // PC → phone
    }

    private static func nonce(_ n: UInt64) throws -> AES.GCM.Nonce {
        var d = Data(count: 4)
        var be = n.bigEndian
        withUnsafeBytes(of: &be) { d.append(contentsOf: $0) }
        return try AES.GCM.Nonce(data: d)
    }

    /// plaintext → [u32 BE length][ciphertext + tag]
    func seal(_ plain: Data) throws -> Data {
        guard let tx else { throw Failure.notReady }
        let box = try AES.GCM.seal(plain, using: tx, nonce: Self.nonce(txN))
        txN += 1
        let body = box.ciphertext + box.tag
        var len = UInt32(body.count).bigEndian
        var out = Data(capacity: body.count + 4)
        withUnsafeBytes(of: &len) { out.append(contentsOf: $0) }
        out.append(body)
        return out
    }

    /// record body (without its length) → plaintext; throws if tampered or out of order.
    func open(_ body: Data) throws -> Data {
        guard let rx else { throw Failure.notReady }
        let b = [UInt8](body)
        guard b.count >= 16 else { throw Failure.record }
        let box = try AES.GCM.SealedBox(nonce: Self.nonce(rxN), ciphertext: Data(b[..<(b.count - 16)]), tag: Data(b[(b.count - 16)...]))
        let plain = try AES.GCM.open(box, using: rx)
        rxN += 1
        return plain
    }
}
