// Pixel-buffer -> composited, scaled CGImage -> JPEG bytes.
//
// One CoreGraphics bitmap context is used as the compositing surface so the
// multi-display ("virtual") case is the same code path as the single-display
// case: each display is drawn into its own slot of the virtual rectangle.
//
// Coordinates: display geometry is top-left origin, y down. A CGBitmapContext is
// bottom-left origin, y up, and CGContext.draw(_:in:) draws an image the right
// way up in that space — so the only conversion needed is flipping the y origin
// of each destination rect.

import CoreGraphics
import CoreVideo
import Foundation
import ImageIO
import UniformTypeIdentifiers

enum ImageOutput {
    /// Bilinear-class resampling. `.high` (Lanczos) looks marginally better and
    /// costs roughly 3x the CPU, which is not worth it at streaming frame rates.
    private static let interpolation: CGInterpolationQuality = .medium
    private static let minimumTargetWidth = 64
    private static let maximumTargetWidth = 7680

    /// Copies a BGRA pixel buffer into an independent CGImage. The copy is
    /// deliberate: the source IOSurface belongs to ScreenCaptureKit's recycling
    /// pool and may be overwritten as soon as we unlock it.
    static func cgImage(from pixelBuffer: CVPixelBuffer) throws -> CGImage {
        guard CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly) == kCVReturnSuccess else {
            throw HostError(.capture, "could not lock capture surface")
        }
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }

        guard let base = CVPixelBufferGetBaseAddress(pixelBuffer) else {
            throw HostError(.capture, "capture surface had no base address")
        }
        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
        guard width > 0, height > 0, bytesPerRow > 0 else {
            throw HostError(.capture, "capture surface had zero dimensions")
        }

        let bitmapInfo = CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
        guard let context = CGContext(
            data: base,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: bytesPerRow,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: bitmapInfo
        ), let image = context.makeImage() else {
            throw HostError(.capture, "could not wrap capture surface as an image")
        }
        return image
    }

    struct Composited {
        let image: CGImage
        let width: Int
        let height: Int
        let sourceWidth: Int
        let sourceHeight: Int
    }

    /// Draws every captured display into one image scaled so the whole `bounds`
    /// rectangle is `targetWidth` wide. Areas of `bounds` not covered by any
    /// display (non-rectangular multi-monitor layouts) stay black.
    static func composite(
        tiles: [(geometry: DisplayGeometry, image: CGImage)],
        bounds: CGRect,
        targetWidth: Int
    ) throws -> Composited {
        guard !tiles.isEmpty else { throw HostError(.capture, "nothing to composite") }
        let sourceWidth = max(1, Int(bounds.width.rounded()))
        let sourceHeight = max(1, Int(bounds.height.rounded()))

        let clamped = min(max(targetWidth, minimumTargetWidth), min(maximumTargetWidth, sourceWidth))
        let scale = Double(clamped) / Double(sourceWidth)
        let outWidth = clamped
        let outHeight = max(1, Int((Double(sourceHeight) * scale).rounded()))

        guard let context = CGContext(
            data: nil,
            width: outWidth,
            height: outHeight,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
        ) else {
            throw HostError(.encode, "could not allocate a \(outWidth)x\(outHeight) output surface")
        }
        context.interpolationQuality = interpolation
        context.setFillColor(gray: 0, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: outWidth, height: outHeight))

        for tile in tiles {
            context.draw(tile.image, in: destinationRect(for: tile.geometry.bounds, in: bounds, scale: scale))
        }

        guard let image = context.makeImage() else {
            throw HostError(.encode, "could not finalise the composited frame")
        }
        return Composited(image: image, width: outWidth, height: outHeight,
                          sourceWidth: sourceWidth, sourceHeight: sourceHeight)
    }

    /// Scales a single captured image to `targetWidth`, keeping its shape.
    ///
    /// The window-capture path's counterpart to `composite`: one image, no
    /// layout to reason about, but the same clamping and interpolation so a
    /// window frame and a display frame look alike and cost alike.
    static func scaled(_ image: CGImage, targetWidth: Int) throws -> Composited {
        let sourceWidth = max(1, image.width)
        let sourceHeight = max(1, image.height)
        let clamped = min(max(targetWidth, minimumTargetWidth), min(maximumTargetWidth, sourceWidth))
        let scale = Double(clamped) / Double(sourceWidth)
        let outWidth = clamped
        let outHeight = max(1, Int((Double(sourceHeight) * scale).rounded()))

        guard let context = CGContext(
            data: nil,
            width: outWidth,
            height: outHeight,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
        ) else {
            throw HostError(.encode, "could not allocate a \(outWidth)x\(outHeight) output surface")
        }
        context.interpolationQuality = interpolation
        context.draw(image, in: CGRect(x: 0, y: 0, width: outWidth, height: outHeight))

        guard let out = context.makeImage() else {
            throw HostError(.encode, "could not finalise the scaled frame")
        }
        return Composited(image: out, width: outWidth, height: outHeight,
                          sourceWidth: sourceWidth, sourceHeight: sourceHeight)
    }

    /// Maps a top-left-origin display rect into the bottom-left-origin context.
    private static func destinationRect(for display: CGRect, in bounds: CGRect, scale: Double) -> CGRect {
        CGRect(
            x: (display.minX - bounds.minX) * scale,
            y: (bounds.maxY - display.maxY) * scale,
            width: display.width * scale,
            height: display.height * scale
        )
    }

    static func jpeg(_ image: CGImage, quality: Int) throws -> Data {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            data, UTType.jpeg.identifier as CFString, 1, nil
        ) else {
            throw HostError(.encode, "could not create a JPEG encoder")
        }
        let normalised = Double(min(max(quality, 1), 100)) / 100.0
        CGImageDestinationAddImage(destination, image, [
            kCGImageDestinationLossyCompressionQuality: normalised,
        ] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else {
            throw HostError(.encode, "JPEG encoding failed")
        }
        return data as Data
    }
}
