import AVFoundation
import CoreImage

// Owns the capture session. Frames arrive on `queue` (landscape, NV12 full range); configuration runs on its own
// `sessionQueue` so a busy video queue (e.g. 4K) can never hold back a camera change.
final class CameraController: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    let session = AVCaptureSession()
    let queue = DispatchQueue(label: "aircam.video")
    private let sessionQueue = DispatchQueue(label: "aircam.session")
    private let output = AVCaptureVideoDataOutput()
    private var input: AVCaptureDeviceInput?
    private let lock = NSLock() // settings / activeFps are written on sessionQueue, read on the video queue
    private var _settings = Settings(), _activeFps = 30
    private(set) var settings: Settings {
        get { lock.lock(); defer { lock.unlock() }; return _settings }
        set { lock.lock(); _settings = newValue; lock.unlock() }
    }
    private(set) var activeFps: Int {
        get { lock.lock(); defer { lock.unlock() }; return _activeFps }
        set { lock.lock(); _activeFps = newValue; lock.unlock() }
    }
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
        session.sessionPreset = .inputPriority // we pick device formats ourselves (needed for 60/120 fps / 4K)
        session.automaticallyConfiguresCaptureDeviceForWideColor = false // we set the color space (Apple Log) ourselves
        if session.canAddOutput(output) { session.addOutput(output) }
    }

    func start() { sessionQueue.async { if !self.session.isRunning { self.session.startRunning() } } }
    func stop() { sessionQueue.async { self.session.stopRunning() } }

    /// Applies settings; call from any thread. Serialized on the session queue.
    func apply(_ s: Settings, done: @escaping () -> Void = {}) {
        sessionQueue.async {
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
            let log = s.log && Self.supportsLog(dev)
            let (format, fps) = Self.pickFormat(dev, width: s.width, fps: Self.encodableFps(width: s.width, fps: s.fps), log: log)
            // Only touch the format / color space / frame rate when they change: re-setting them restarts the sensor
            // (visible hiccup), and zoom or exposure drags send dozens of updates per second.
            if let format, format != dev.activeFormat { dev.activeFormat = format }
            if #available(iOS 17.0, *), log, dev.activeFormat.supportedColorSpaces.contains(.appleLog) {
                if dev.activeColorSpace != .appleLog { dev.activeColorSpace = .appleLog }
            } else if dev.activeColorSpace != .sRGB, dev.activeFormat.supportedColorSpaces.contains(.sRGB) { dev.activeColorSpace = .sRGB } // unsupported value would throw
            s.log = log
            let duration = CMTime(value: 1, timescale: CMTimeScale(fps))
            // A frame rate the format can't do raises an exception: check first.
            if dev.activeFormat.videoSupportedFrameRateRanges.contains(where: { $0.minFrameRate <= Double(fps) && Double(fps) <= $0.maxFrameRate }),
               dev.activeVideoMinFrameDuration != duration || dev.activeVideoMaxFrameDuration != duration {
                dev.activeVideoMinFrameDuration = duration
                dev.activeVideoMaxFrameDuration = duration
            }
            let secs = CMTimeGetSeconds(dev.activeVideoMaxFrameDuration)
            activeFps = secs > 0 ? Int((1 / secs).rounded()) : fps
            dev.videoZoomFactor = max(dev.minAvailableVideoZoomFactor, min(CGFloat(s.zoom), Self.maxZoom(dev)))
            let bias = Float(s.exposure)
            dev.setExposureTargetBias(max(dev.minExposureTargetBias, min(bias, dev.maxExposureTargetBias)))
            if s.focus == "locked", dev.isFocusModeSupported(.locked) { dev.focusMode = .locked }
            else if dev.isFocusModeSupported(.continuousAutoFocus) { dev.focusMode = .continuousAutoFocus }
            if s.whiteBalance == "manual", dev.isLockingWhiteBalanceWithCustomDeviceGainsSupported {
                let tt = AVCaptureDevice.WhiteBalanceTemperatureAndTintValues(temperature: Float(s.temperature), tint: Float(s.tint))
                var g = dev.deviceWhiteBalanceGains(for: tt)
                let mx = dev.maxWhiteBalanceGain
                g.redGain = max(1, min(g.redGain, mx)); g.greenGain = max(1, min(g.greenGain, mx)); g.blueGain = max(1, min(g.blueGain, mx))
                dev.setWhiteBalanceModeLocked(with: g, completionHandler: nil)
            } else if dev.isWhiteBalanceModeSupported(.continuousAutoWhiteBalance) {
                dev.whiteBalanceMode = .continuousAutoWhiteBalance
            }
            if dev.hasTorch, dev.isTorchAvailable {
                if s.torch { try? dev.setTorchModeOn(level: 1) } else { dev.torchMode = .off }
            }
            dev.unlockForConfiguration()
        } catch {}

        if let conn = output.connection(with: .video) {
            let orientation: AVCaptureVideoOrientation = s.portrait ? .portrait : .landscapeRight
            if conn.isVideoOrientationSupported, conn.videoOrientation != orientation { conn.videoOrientation = orientation }
            if conn.isVideoMirroringSupported { conn.isVideoMirrored = false } // mirroring is done on the PC
            if conn.isVideoStabilizationSupported { conn.preferredVideoStabilizationMode = .off } // adds latency
        }
        session.commitConfiguration()
        settings = s
    }

    static func maxZoom(_ dev: AVCaptureDevice) -> CGFloat { min(dev.maxAvailableVideoZoomFactor, 10) }

    static func supportsLog(_ dev: AVCaptureDevice) -> Bool {
        guard #available(iOS 17.0, *) else { return false }
        return dev.formats.contains { $0.supportedColorSpaces.contains(.appleLog) }
    }

    /// Best format at `width` (16:9, NV12 full range) supporting `fps`; falls back to 60, then 30 fps, then any 16:9 width.
    /// Apple Log formats are 10-bit; the video output still delivers 8-bit NV12 (log values preserved).
    static func pickFormat(_ dev: AVCaptureDevice, width: Int32, fps: Int, log: Bool = false) -> (AVCaptureDevice.Format?, Int) {
        for (w, f) in [(width, fps), (width, min(fps, 60)), (width, 30), (1920, 30), (1280, 30)] {
            if let fmt = formats(dev, width: w, log: log).first(where: { $0.videoSupportedFrameRateRanges.contains { $0.maxFrameRate >= Double(f) } }) { return (fmt, f) }
        }
        return (nil, 30)
    }

    /// Highest of 30/60/120 fps available at `width` (and encodable, see encodableFps).
    static func maxFps(_ dev: AVCaptureDevice, width: Int32, log: Bool) -> Int {
        let best = formats(dev, width: width, log: log).flatMap { $0.videoSupportedFrameRateRanges.map(\.maxFrameRate) }.max() ?? 30
        return encodableFps(width: width, fps: best >= 120 ? 120 : best >= 60 ? 60 : 30)
    }

    /// The H.264 hardware encoder tops out around 45 fps in 4K: above that it falls behind and frames pile up.
    static func encodableFps(width: Int32, fps: Int) -> Int { width >= 3840 ? min(fps, 30) : fps }

    private static func formats(_ dev: AVCaptureDevice, width w: Int32, log: Bool) -> [AVCaptureDevice.Format] {
        dev.formats.filter { fmt in
            let d = CMVideoFormatDescriptionGetDimensions(fmt.formatDescription)
            let kind: Bool
            if #available(iOS 17.0, *), log { kind = fmt.supportedColorSpaces.contains(.appleLog) }
            else { kind = CMFormatDescriptionGetMediaSubType(fmt.formatDescription) == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange }
            return d.width == w && d.height * 16 == d.width * 9 && kind
        }
    }

    /// Focus and exposure at a point of the video frame (normalized, top-left origin).
    func focus(at p: CGPoint) {
        sessionQueue.async {
            guard let dev = self.device, (try? dev.lockForConfiguration()) != nil else { return }
            // Points of interest use the sensor's landscape-right space; portrait frames are rotated 90° from it.
            let poi = self.settings.portrait ? CGPoint(x: p.y, y: 1 - p.x) : p
            if dev.isFocusPointOfInterestSupported {
                dev.focusPointOfInterest = poi
                let mode: AVCaptureDevice.FocusMode = self.settings.focus == "locked" ? .autoFocus : .continuousAutoFocus // locked: focus once, then hold
                if dev.isFocusModeSupported(mode) { dev.focusMode = mode }
            }
            if dev.isExposurePointOfInterestSupported {
                dev.exposurePointOfInterest = poi
                if dev.isExposureModeSupported(.continuousAutoExposure) { dev.exposureMode = .continuousAutoExposure }
            }
            dev.unlockForConfiguration()
        }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let pb = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        onFrame?(pb, CMSampleBufferGetPresentationTimeStamp(sampleBuffer))
    }
}
