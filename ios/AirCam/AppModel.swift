import AVFoundation
import CoreImage
import UIKit
import Vision

// Wires camera → (segmentation) → encoder → server, and applies settings sent by the PC.
final class AppModel: ObservableObject {
    @Published var peer: String?          // "USB", an IP, or nil when no PC is connected
    @Published var settings = Settings()
    @Published var dimmed = false

    let camera = CameraController()
    private let encoder = Encoder()
    private let segmenter = Segmenter()
    private let server = Server()
    private let faceRequest = VNDetectFaceRectanglesRequest()
    private var frameCount = 0

    init() {
        UIDevice.current.isBatteryMonitoringEnabled = true
        camera.onFrame = { [weak self] pb, pts in self?.frame(pb, pts) } // video queue
        encoder.onData = { [weak self] data, key, pts in self?.sendVideo(data, key, pts) }
        server.onConnection = { [weak self] peer in
            guard let self else { return }
            DispatchQueue.main.async { self.peer = peer }
            self.camera.queue.async { if peer != nil { self.encoder.requestKeyframe(); self.sendStatus() } else { self.encoder.reset() } }
        }
        server.onMessage = { [weak self] type, data in self?.message(type, data) }
        AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
            guard let self, granted else { return }
            self.camera.apply(self.camera.settings)
            self.camera.start()
        }
        server.start()
    }

    // MARK: video queue

    private func frame(_ pb: CVPixelBuffer, _ pts: CMTime) {
        guard server.isConnected else { return } // no PC: capture keeps running for the preview, nothing is encoded
        let s = camera.settings
        frameCount += 1
        if s.framing, frameCount % 5 == 0 { detectFaces(pb) } // ~6–24 Hz is plenty for smooth framing on the PC
        let img = s.background == "none" ? pb : segmenter.process(pb, mode: s.background)
        encoder.encode(img, pts: pts, fps: camera.activeFps, bitrate: s.bitrate)
    }

    private func detectFaces(_ pb: CVPixelBuffer) {
        guard (try? VNImageRequestHandler(cvPixelBuffer: pb, options: [:]).perform([faceRequest])) != nil else { return }
        // Vision: bottom-left origin → top-left for the PC.
        let f = (faceRequest.results ?? []).prefix(8).map { r -> [Double] in
            let b = r.boundingBox
            return [b.minX, 1 - b.maxY, b.width, b.height].map { (Double($0) * 1000).rounded() / 1000 }
        }
        if let json = try? JSONSerialization.data(withJSONObject: ["f": f]) { server.send(.faces, json, droppable: true) }
    }

    private func sendVideo(_ data: Data, _ key: Bool, _ pts: CMTime) {
        var payload = Data(capacity: data.count + 9)
        payload.append(key ? 1 : 0)
        var us = UInt64(max(0, CMTimeGetSeconds(pts) * 1_000_000)).bigEndian
        withUnsafeBytes(of: &us) { payload.append(contentsOf: $0) }
        payload.append(data)
        if !server.send(.video, payload, droppable: !key) { encoder.requestKeyframe() } // dropped: decoder needs a fresh keyframe
    }

    private func sendStatus() {
        let dev = camera.device
        let dims = dev.map { CMVideoFormatDescriptionGetDimensions($0.activeFormat.formatDescription) }
        let battery = UIDevice.current.batteryLevel
        let st = Status(name: UIDevice.current.name, model: Self.model, cameras: CameraController.available,
                        settings: camera.settings, hasTorch: dev?.hasTorch ?? false,
                        maxZoom: Double(dev.map(CameraController.maxZoom) ?? 1),
                        width: Int(dims?.width ?? 0), height: Int(dims?.height ?? 0), fps: camera.activeFps,
                        battery: battery < 0 ? -1 : Int(battery * 100),
                        supportsLog: dev.map(CameraController.supportsLog) ?? false,
                        maxFps: dev.map { CameraController.maxFps($0, width: camera.settings.width, log: camera.settings.log) } ?? 30)
        if let json = try? JSONEncoder().encode(st) { server.send(.status, json) }
    }

    // MARK: network queue

    private func message(_ type: Msg, _ data: Data) {
        switch type {
        case .control:
            guard let s = try? JSONDecoder().decode(Settings.self, from: data) else { return }
            camera.apply(s) { [weak self] in // runs on the video queue
                guard let self else { return }
                let applied = self.camera.settings
                DispatchQueue.main.async { self.settings = applied }
                self.sendStatus()
            }
        case .background:
            let img = CIImage(data: data)
            camera.queue.async { [weak self] in self?.segmenter.background = img }
        case .focus:
            guard let o = try? JSONSerialization.jsonObject(with: data) as? [String: Double], let x = o["x"], let y = o["y"] else { return }
            camera.focus(at: CGPoint(x: min(1, max(0, x)), y: min(1, max(0, y))))
        case .keyframe:
            camera.queue.async { [weak self] in self?.encoder.requestKeyframe() }
        default: break
        }
    }

    static let model: String = {
        var info = utsname()
        uname(&info)
        return withUnsafeBytes(of: &info.machine) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) } // e.g. "iPhone15,2"
    }()
}
