import VideoToolbox

// Hardware H.264 or HEVC (4K), no B-frames, output as Annex B with parameter sets before each keyframe.
final class Encoder {
    private var session: VTCompressionSession?
    private var width = 0, height = 0, fps = 0, bitrate = 0, hevc = false, lowLatency = true
    private var forceKey = false
    // Frames handed to VideoToolbox and not returned yet. EncodeFrame blocks when the encoder is behind, which would
    // stall the capture queue: past 3 in flight we drop the frame instead. 2 was too few: the hardware pipelines
    // frames, and at 2 it capped 1080p60 at ~48 fps and 4K60 at ~30 even when the encoder could keep up.
    private var inFlight = 0, dropped = 0
    private let lock = NSLock()
    var onData: ((Data, Bool, Bool, CMTime) -> Void)? // data, keyframe, HEVC, pts

    func requestKeyframe() { forceKey = true }

    /// Frames skipped because the encoder was behind, since the last call.
    func takeDropped() -> Int { lock.lock(); defer { dropped = 0; lock.unlock() }; return dropped }

    func reset() {
        if let s = session { VTCompressionSessionInvalidate(s) }
        session = nil
        lock.lock(); inFlight = 0; lock.unlock()
    }

    func encode(_ pb: CVPixelBuffer, pts: CMTime, fps: Int, bitrate: Int, hevc: Bool, lowLatency: Bool = true) {
        let w = CVPixelBufferGetWidth(pb), h = CVPixelBufferGetHeight(pb)
        let bitrate = hevc ? bitrate * 7 / 10 : bitrate // HEVC: same quality for ~30% fewer bits
        if session == nil || w != width || h != height || fps != self.fps || hevc != self.hevc || lowLatency != self.lowLatency { setup(w, h, fps, bitrate, hevc, lowLatency) }
        else if bitrate != self.bitrate, let s = session {
            VTSessionSetProperty(s, key: kVTCompressionPropertyKey_AverageBitRate, value: bitrate as CFNumber)
            self.bitrate = bitrate
        }
        guard let s = session else { return }
        lock.lock()
        if inFlight >= 3 { dropped += 1; lock.unlock(); return } // encoder behind: skip this frame
        inFlight += 1
        lock.unlock()
        let props: CFDictionary? = forceKey ? [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue] as CFDictionary : nil
        forceKey = false
        let err = VTCompressionSessionEncodeFrame(s, imageBuffer: pb, presentationTimeStamp: pts, duration: .invalid,
                                                  frameProperties: props, infoFlagsOut: nil) { [weak self] status, _, sbuf in
            guard let self else { return }
            self.lock.lock(); self.inFlight = max(0, self.inFlight - 1); self.lock.unlock()
            guard status == noErr, let sbuf, let (data, key, hevc) = Self.annexB(sbuf) else { return }
            self.onData?(data, key, hevc, CMSampleBufferGetPresentationTimeStamp(sbuf))
        }
        if err != noErr { lock.lock(); inFlight = max(0, inFlight - 1); lock.unlock() }
    }

    private func setup(_ w: Int, _ h: Int, _ fps: Int, _ bitrate: Int, _ hevc: Bool, _ lowLatency: Bool) {
        reset()
        width = w; height = h; self.fps = fps; self.bitrate = bitrate; self.hevc = hevc; self.lowLatency = lowLatency // even on failure: don't retry every frame
        // Low-latency rate control keeps every frame about the same size (no bursts that queue up on Wi-Fi).
        let spec = (lowLatency ? [kVTVideoEncoderSpecification_EnableLowLatencyRateControl: kCFBooleanTrue] : [:]) as CFDictionary
        func create(_ codec: CMVideoCodecType) -> VTCompressionSession? {
            var s: VTCompressionSession?
            return VTCompressionSessionCreate(allocator: nil, width: Int32(w), height: Int32(h), codecType: codec,
                                              encoderSpecification: spec, imageBufferAttributes: nil, compressedDataAllocator: nil,
                                              outputCallback: nil, refcon: nil, compressionSessionOut: &s) == noErr ? s : nil
        }
        let hs = hevc ? create(kCMVideoCodecType_HEVC) : nil
        guard let s = hs ?? create(kCMVideoCodecType_H264) else { return } // no HEVC encoder: H.264
        let set = { (k: CFString, v: CFTypeRef) in VTSessionSetProperty(s, key: k, value: v) }
        set(kVTCompressionPropertyKey_RealTime, kCFBooleanTrue)
        set(kVTCompressionPropertyKey_ProfileLevel, hs != nil ? kVTProfileLevel_HEVC_Main_AutoLevel : kVTProfileLevel_H264_High_AutoLevel)
        set(kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse)
        set(kVTCompressionPropertyKey_ExpectedFrameRate, fps as CFNumber)
        set(kVTCompressionPropertyKey_MaxKeyFrameInterval, (fps * 2) as CFNumber)
        set(kVTCompressionPropertyKey_AverageBitRate, bitrate as CFNumber)
        // Without low-latency mode the encoder bursts up to ~2.5x the average (54 Mbit/s seen in 4K): cap it at 1.5x per second.
        if !lowLatency { set(kVTCompressionPropertyKey_DataRateLimits, [bitrate * 3 / 16, 1] as CFArray) }
        // Tag as plain BT.709 so the PC decoder never color-manages the signal (Apple Log is decoded by the PC's LUT).
        set(kVTCompressionPropertyKey_ColorPrimaries, kCVImageBufferColorPrimaries_ITU_R_709_2)
        set(kVTCompressionPropertyKey_TransferFunction, kCVImageBufferTransferFunction_ITU_R_709_2)
        set(kVTCompressionPropertyKey_YCbCrMatrix, kCVImageBufferYCbCrMatrix_ITU_R_709_2)
        VTCompressionSessionPrepareToEncodeFrames(s)
        session = s
    }

    static func annexB(_ sbuf: CMSampleBuffer) -> (Data, Bool, Bool)? {
        guard let block = CMSampleBufferGetDataBuffer(sbuf) else { return nil }
        let att = CMSampleBufferGetSampleAttachmentsArray(sbuf, createIfNecessary: false) as? [[CFString: Any]]
        let key = !((att?.first?[kCMSampleAttachmentKey_NotSync] as? Bool) ?? false)
        let start: [UInt8] = [0, 0, 0, 1]
        var out = Data()
        let fmt = CMSampleBufferGetFormatDescription(sbuf)
        let hevc = fmt.map { CMFormatDescriptionGetMediaSubType($0) == kCMVideoCodecType_HEVC } ?? false
        if key, let fmt {
            // H.264: SPS, PPS. HEVC: VPS, SPS, PPS.
            func paramSet(_ i: Int, _ ptr: UnsafeMutablePointer<UnsafePointer<UInt8>?>?, _ size: UnsafeMutablePointer<Int>?,
                          _ count: UnsafeMutablePointer<Int>?) {
                if hevc {
                    CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(fmt, parameterSetIndex: i, parameterSetPointerOut: ptr,
                                                                       parameterSetSizeOut: size, parameterSetCountOut: count, nalUnitHeaderLengthOut: nil)
                } else {
                    CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, parameterSetIndex: i, parameterSetPointerOut: ptr,
                                                                       parameterSetSizeOut: size, parameterSetCountOut: count, nalUnitHeaderLengthOut: nil)
                }
            }
            var count = 0
            paramSet(0, nil, nil, &count)
            for i in 0..<count {
                var ptr: UnsafePointer<UInt8>?
                var size = 0
                paramSet(i, &ptr, &size, nil)
                if let ptr { out.append(contentsOf: start); out.append(ptr, count: size) }
            }
        }
        let length = CMBlockBufferGetDataLength(block)
        var bytes = [UInt8](repeating: 0, count: length)
        guard CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: &bytes) == noErr else { return nil }
        // AVCC (4-byte big-endian lengths) → Annex B start codes
        var i = 0
        while i + 4 <= length {
            let n = Int(bytes[i]) << 24 | Int(bytes[i + 1]) << 16 | Int(bytes[i + 2]) << 8 | Int(bytes[i + 3])
            let end = min(i + 4 + n, length)
            out.append(contentsOf: start)
            out.append(contentsOf: bytes[(i + 4)..<end])
            i = end
        }
        return (out, key, hevc)
    }
}
