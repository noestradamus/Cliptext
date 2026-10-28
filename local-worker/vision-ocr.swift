import Foundation
import ImageIO
import Vision

// One local image in, bounded JSON out. No URLs, credentials, or network clients.
func fail() -> Never {
    FileHandle.standardError.write(Data("Local image recognition failed.\n".utf8))
    exit(1)
}

guard CommandLine.arguments.count == 2 else { fail() }
let url = URL(fileURLWithPath: CommandLine.arguments[1])
guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
      let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
      let width = properties[kCGImagePropertyPixelWidth] as? NSNumber,
      let height = properties[kCGImagePropertyPixelHeight] as? NSNumber,
      width.intValue > 0, height.intValue > 0,
      width.intValue <= 16000, height.intValue <= 16000,
      width.int64Value * height.int64Value <= 40_000_000 else { fail() }

do {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.automaticallyDetectsLanguage = true
    request.usesLanguageCorrection = true
    let handler = VNImageRequestHandler(url: url, options: [:])
    try handler.perform([request])
    let observations = request.results ?? []
    guard observations.count <= 1000 else { fail() }
    var count = 0
    let rows: [[String: Any]] = observations.compactMap { observation in
        guard let candidate = observation.topCandidates(1).first else { return nil }
        let text = candidate.string
        count += text.utf8.count
        guard text.utf8.count <= 16384, count <= 200000 else { fail() }
        let box = observation.boundingBox.intersection(CGRect(x: 0, y: 0, width: 1, height: 1))
        guard !box.isNull, box.width > 0, box.height > 0 else { return nil }
        return ["text": text, "confidence": candidate.confidence,
                "x": box.minX, "y": 1 - box.maxY, "width": box.width, "height": box.height]
    }
    let data = try JSONSerialization.data(withJSONObject: ["blocks": rows], options: [.sortedKeys])
    guard data.count <= 1_048_576 else { fail() }
    FileHandle.standardOutput.write(data)
} catch {
    fail()
}
