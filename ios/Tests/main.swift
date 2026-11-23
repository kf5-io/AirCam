// Interop check with src/secure.js (same vector as test/secure.test.js). Run: swiftc ios/AirCam/Secure.swift ios/Tests/main.swift -o vector && ./vector
import CryptoKit
import Foundation

func hex(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }
func unhex(_ s: String) -> Data { Data(stride(from: 0, to: s.count, by: 2).map { UInt8(s.dropFirst($0).prefix(2), radix: 16)! }) }

let phone = SecureSession(privateKey: try! .init(rawRepresentation: Data(repeating: 1, count: 32)))
let pcPub = try! Curve25519.KeyAgreement.PrivateKey(rawRepresentation: Data(repeating: 2, count: 32)).publicKey.rawRepresentation
precondition(hex(pcPub) == "ce8d3ad1ccb633ec7b70c17814a5c76ecd029685050d344745ba05870e587d59", "X25519 public key mismatch")
try! phone.accept(SecureSession.magic + pcPub)
let rec = try! phone.seal(Data("AirCam".utf8))
precondition(hex(rec) == "000000166140687ce057365a382c462beb578fe021ce19e83ef3", "record mismatch: \(hex(rec))")
print("secure vector ok")
