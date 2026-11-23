import Foundation

// Wire protocol shared with the Windows app (src/protocol.js): [u8 type][u32 BE length][payload].
enum Msg: UInt8 {
    case video = 0x01      // iPhone → PC: [u8 flags (bit0 = keyframe)][u64 BE pts µs][H.264 Annex B]
    case status = 0x02     // iPhone → PC: JSON Status
    case control = 0x10    // PC → iPhone: JSON Settings (full object)
    case background = 0x11 // PC → iPhone: JPEG/PNG image for background replacement
    case keyframe = 0x12   // PC → iPhone: decoder lost sync, send a keyframe
}

let aircamPort: UInt16 = 47800
let aircamBonjourType = "_aircam._tcp"

struct Settings: Codable, Equatable {
    var camera = "back"        // front | back | ultrawide | tele
    var resolution = "1080p"   // 720p | 1080p | 4k
    var fps = 30               // 30 | 60 | 120
    var torch = false
    var zoom = 1.0
    var exposure = 0.0         // EV bias, -2...2
    var focus = "auto"         // auto | locked
    var background = "none"    // none | blur | replace
    var whiteBalance = "auto"  // auto | manual
    var temperature = 5500.0   // Kelvin, manual white balance
    var tint = 0.0             // -150...150, manual white balance
    var log = false            // Apple Log capture (iPhone 15 Pro and later); the PC applies the LUT

    var width: Int32 { resolution == "4k" ? 3840 : resolution == "720p" ? 1280 : 1920 }
    var bitrate: Int {
        let base = resolution == "4k" ? 20_000_000 : resolution == "720p" ? 4_000_000 : 8_000_000
        return fps > 60 ? base * 2 : fps > 30 ? base * 3 / 2 : base
    }
}

struct Status: Codable {
    var name: String
    var model: String
    var cameras: [String]
    var settings: Settings
    var hasTorch: Bool
    var maxZoom: Double
    var width: Int
    var height: Int
    var fps: Int
    var battery: Int // percent, -1 unknown
    var supportsLog: Bool // current camera can capture in Apple Log
    var maxFps: Int       // highest frame rate (≤ 120) for the current camera, resolution and log mode
}

func frame(_ type: Msg, _ payload: Data) -> Data {
    var d = Data(capacity: payload.count + 5)
    d.append(type.rawValue)
    var len = UInt32(payload.count).bigEndian
    withUnsafeBytes(of: &len) { d.append(contentsOf: $0) }
    d.append(payload)
    return d
}
