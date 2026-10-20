import Foundation
import Vision
import AppKit

// macOS 原生 Vision OCR：零第三方依赖
// 用法: swift vision_ocr.swift <图片路径>

guard CommandLine.arguments.count > 1 else {
    print("{\"error\":\"缺少图片路径\"}")
    exit(1)
}
let path = CommandLine.arguments[1]

guard let img = NSImage(contentsOfFile: path),
      let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    print("{\"error\":\"无法读取图片\"}")
    exit(1)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
request.recognitionLanguages = ["zh-Hans", "en-US"]

let handler = VNImageRequestHandler(cgImage: cg, options: [:])
let t0 = Date()
do {
    try handler.perform([request])
} catch {
    print("{\"error\":\"OCR 失败: \(error.localizedDescription)\"}")
    exit(1)
}
let elapsed = Date().timeIntervalSince(t0)

let lines = (request.results ?? []).compactMap { obs -> [String: Any]? in
    guard let cand = obs.topCandidates(1).first else { return nil }
    let box = obs.boundingBox
    return [
        "text": cand.string,
        "confidence": Double(cand.confidence),
        "x": Double(box.origin.x),
        "y": Double(box.origin.y),
        "w": Double(box.width),
        "h": Double(box.height)
    ]
}

let out: [String: Any] = [
    "image": path,
    "size": [cg.width, cg.height],
    "count": lines.count,
    "elapsed": elapsed,
    "texts": lines.map { $0["text"] as? String ?? "" }
]
let data = try JSONSerialization.data(withJSONObject: out, options: [])
print(String(data: data, encoding: .utf8) ?? "{}")
