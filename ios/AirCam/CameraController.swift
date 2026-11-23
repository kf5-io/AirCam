import AVFoundation
import CoreImage

// Owns the capture session. Frames arrive on `queue` (landscape, NV12 full range).
final class CameraController: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    let session = AVCaptureSession()
    let queue = DispatchQueue(label: "aircam.video")
    private let output = AVCaptureVideoDataOutput()
    private var input: AVCaptureDeviceInput?
    private(set) var settings = Settings()
    private(set) var activeFps = 30
    var onFrame: ((CVPixelBuffer, CMTime) -> Void)?

    static func device(_ name: String) -> AVCaptureDevice? {
        switch name {
        case "front": return AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front)
        case "ultrawide": return AVCaptureDevice.default(.builtInUltraWideCamera, for: .video, position: .back)
        case "tele": return AVCaptureDevice.default(.builtInTelephotoCamera, for: .video, position: .back)
        default: return AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back)
        }
    }
    static let available = ["front", "back", "ultrawide", "tele"].filter { device($0) != nil }

    var device: AVCaptureDevice? { input?.device }

    override init() {
        super.init()
        output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange]
        output.alwaysDiscardsLateVideoFrames = true
        output.setSampleBufferDelegate(self, queue: queue)
        session.sessionPreset = .inputPriority // we pick device formats ourselves (needed for 60 fps / 4K)
        if session.canAddOutput(output) { session.addOutput(output) }
    }

    func start() { queue.async { if !self.session.isRunning { self.session.startRunning() } } }
    func stop() { queue.async { self.session.stopRunning() } }

    /// Applies settings; call from any thread. Runs on the video queue so frames and config never race.
    func apply(_ s: Settings, done: @escaping () -> Void = {}) {
        queue.async {
            self.configure(s)
            done()
        }
    }

    private func configure(_ new: Settings) {
        var s = new
        if !Self.available.contains(s.camera) { s.camera = "back" }
        session.beginConfiguration()
        if input == nil || s.camera != settings.camera, let dev = Self.device(s.camera), let inp = try? AVCaptureDeviceInput(device: dev) {
            if let old = input { session.removeInput(old) }
            if session.canAddInput(inp) { session.addInput(inp); input = inp }
        }
        guard let dev = input?.device else { session.commitConfiguration(); return }

        do {
            try dev.lockForConfiguration()
            let (format, fps) = Self.pickFormat(dev, width: s.width, fps: s.fps)
            if let format { dev.activeFormat = format }
            dev.activeVideoMinFrameDuration = CMTime(value: 1, timescale: CMTimeScale(fps))
            dev.activeVideoMaxFrameDuration = CMTime(value: 1, timescale: CMTimeScale(fps))
            activeFps = fps
            dev.videoZoomFactor = max(dev.minAvailableVideoZoomFactor, min(CGFloat(s.zoom), Self.maxZoom(dev)))
            let bias = Float(s.exposure)
            dev.setExposureTargetBias(max(dev.minExposureTargetBias, min(bias, dev.maxExposureTargetBias)))
            if s.focus == "locked", dev.isFocusModeSupported(.locked) { dev.focusMode = .locked }
            else if dev.isFocusModeSupported(.continuousAutoFocus) { dev.focusMode = .continuousAutoFocus }
            if dev.hasTorch, dev.isTorchAvailable {
                if s.torch { try? dev.setTorchModeOn(level: 1) } else { dev.torchMode = .off }
            }
            dev.unlockForConfiguration()
        } catch {}

        if let conn = output.connection(with: .video) {
            if conn.isVideoOrientationSupported { conn.videoOrientation = .landscapeRight } // webcam output is always 16:9
            if conn.isVideoMirroringSupported { conn.isVideoMirrored = false } // mirroring is done on the PC
            if conn.isVideoStabilizationSupported { conn.preferredVideoStabilizationMode = .off } // adds latency
        }
        session.commitConfiguration()
        settings = s
    }

    static func maxZoom(_ dev: AVCaptureDevice) -> CGFloat { min(dev.maxAvailableVideoZoomFactor, 10) }

    /// Best format at `width` (16:9, NV12 full range) supporting `fps`; falls back to 30 fps, then any 16:9 width.
    static func pickFormat(_ dev: AVCaptureDevice, width: Int32, fps: Int) -> (AVCaptureDevice.Format?, Int) {
        func find(_ w: Int32, _ f: Int) -> AVCaptureDevice.Format? {
            dev.formats.first { fmt in
                let d = CMVideoFormatDescriptionGetDimensions(fmt.formatDescription)
                return d.width == w && d.height * 16 == d.width * 9
                    && CMFormatDescriptionGetMediaSubType(fmt.formatDescription) == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
                    && fmt.videoSupportedFrameRateRanges.contains { $0.maxFrameRate >= Double(f) }
            }
        }
        for (w, f) in [(width, fps), (width, 30), (1920, 30), (1280, 30)] {
            if let fmt = find(w, f) { return (fmt, f) }
        }
        return (nil, 30)
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let pb = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        onFrame?(pb, CMSampleBufferGetPresentationTimeStamp(sampleBuffer))
    }
}
