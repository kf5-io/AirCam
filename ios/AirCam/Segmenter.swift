import CoreImage
import Vision

// Background blur / replacement with Vision person segmentation, rendered on the GPU via Core Image.
final class Segmenter {
    private let request: VNGeneratePersonSegmentationRequest = {
        let r = VNGeneratePersonSegmentationRequest()
        r.qualityLevel = .balanced
        r.outputPixelFormat = kCVPixelFormatType_OneComponent8
        return r
    }()
    private let ctx = CIContext(options: [.cacheIntermediates: false])
    private var pool: CVPixelBufferPool?
    private var poolSize = (0, 0)
    var background: CIImage? // replacement image, set from the video queue

    func process(_ pb: CVPixelBuffer, mode: String) -> CVPixelBuffer {
        guard (try? VNImageRequestHandler(cvPixelBuffer: pb, options: [:]).perform([request])) != nil,
              let maskPb = request.results?.first?.pixelBuffer, let out = buffer(like: pb) else { return pb }
        let src = CIImage(cvPixelBuffer: pb)
        let ext = src.extent
        var mask = CIImage(cvPixelBuffer: maskPb)
        mask = mask.transformed(by: CGAffineTransform(scaleX: ext.width / mask.extent.width, y: ext.height / mask.extent.height))
        let bg: CIImage
        if mode == "replace", let img = background {
            let k = max(ext.width / img.extent.width, ext.height / img.extent.height) // aspect fill, centered
            let scaled = img.transformed(by: CGAffineTransform(scaleX: k, y: k))
            bg = scaled.transformed(by: CGAffineTransform(translationX: (ext.width - scaled.extent.width) / 2 - scaled.extent.minX,
                                                          y: (ext.height - scaled.extent.height) / 2 - scaled.extent.minY)).cropped(to: ext)
        } else {
            bg = src.clampedToExtent().applyingGaussianBlur(sigma: ext.width / 60).cropped(to: ext)
        }
        let result = src.applyingFilter("CIBlendWithMask", parameters: [kCIInputBackgroundImageKey: bg, kCIInputMaskImageKey: mask])
        ctx.render(result, to: out)
        return out
    }

    private func buffer(like pb: CVPixelBuffer) -> CVPixelBuffer? {
        let w = CVPixelBufferGetWidth(pb), h = CVPixelBufferGetHeight(pb)
        if pool == nil || poolSize != (w, h) {
            let attrs: [String: Any] = [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                kCVPixelBufferWidthKey as String: w, kCVPixelBufferHeightKey as String: h,
                kCVPixelBufferIOSurfacePropertiesKey as String: [:],
            ]
            pool = nil
            CVPixelBufferPoolCreate(nil, nil, attrs as CFDictionary, &pool)
            poolSize = (w, h)
        }
        var out: CVPixelBuffer?
        if let pool { CVPixelBufferPoolCreatePixelBuffer(nil, pool, &out) }
        return out
    }
}
