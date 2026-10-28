import Foundation
import Vision
import AppKit

// macOS native OCR via the Vision framework — zero third-party dependencies.
// Usage: vision_ocr <image path>
//
// Language selection (2026-10-26, measured on a 2880x1800 mixed zh/en screen):
//   en-US primary            → 0.35s, 43 lines  (all CJK lines dropped)
//   en-US,zh-Hans            → 0.36s, 43 lines  (same loss — order decides the script)
//   zh-Hans,en-US            → 0.58s, 75 lines
//   zh-Hans,en-US,ja-JP,ko   → 0.62s, 75 lines
//   automaticallyDetectsLanguage → same recall as zh-primary, no benefit, keep it off
//   cold start (first Vision call after boot) → 60s, independent of configuration
//
// Reading: Vision recognises with the PRIMARY language's script model; Latin text is
// still read fine under a CJK primary, but CJK is lost under a Latin primary. So the
// default list puts zh-Hans first and appends the user's own languages after it.
// OCR_LANGS env overrides everything (comma separated BCP-47).

guard CommandLine.arguments.count > 1 else {
    print("{\"error\":\"missing image path\"}")
    exit(1)
}
let path = CommandLine.arguments[1]

guard let img = NSImage(contentsOfFile: path),
      let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    print("{\"error\":\"cannot read image\"}")
    exit(1)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true

/// Normalise a BCP-47 tag onto a language Vision actually supports
/// ("zh-Hans-CN" → "zh-Hans", "en-US" → "en-US").
func normalise(_ tag: String, supported: [String]) -> String? {
    if supported.contains(tag) { return tag }
    for candidate in supported where tag.hasPrefix(candidate) { return candidate }
    let parts = tag.split(separator: "-")
    if parts.count >= 2 {
        let two = "\(parts[0])-\(parts[1])"
        if supported.contains(two) { return two }
    }
    for candidate in supported where candidate.hasPrefix(String(parts[0]) + "-") { return candidate }
    return nil
}

/// Resolve recognition languages: explicit env > [zh-Hans, en-US, user languages].
func resolveLanguages() -> [String] {
    let supported = (try? request.supportedRecognitionLanguages()) ?? []
    if let raw = ProcessInfo.processInfo.environment["OCR_LANGS"], !raw.isEmpty {
        let wanted = raw.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
        let picked = wanted.compactMap { normalise($0, supported: supported) }
        if !picked.isEmpty { return Array(picked.prefix(4)) }
    }
    var picked: [String] = []
    for base in ["zh-Hans", "en-US"] where supported.contains(base) { picked.append(base) }
    for lang in Locale.preferredLanguages {
        guard let norm = normalise(lang, supported: supported) else { continue }
        if !picked.contains(norm) { picked.append(norm) }
        if picked.count == 4 { break }
    }
    if picked.isEmpty { picked = Array(supported.prefix(1)) }
    return picked
}

let langs = resolveLanguages()
request.recognitionLanguages = langs

let handler = VNImageRequestHandler(cgImage: cg, options: [:])
let t0 = Date()
do {
    try handler.perform([request])
} catch {
    print("{\"error\":\"ocr failed: \(error.localizedDescription)\"}")
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
    "engine": "vision",
    "image": path,
    "size": [cg.width, cg.height],
    "languages": langs,
    "count": lines.count,
    "elapsed": elapsed,
    "texts": lines.map { $0["text"] as? String ?? "" }
]
let data = try JSONSerialization.data(withJSONObject: out, options: [])
print(String(data: data, encoding: .utf8) ?? "{}")
