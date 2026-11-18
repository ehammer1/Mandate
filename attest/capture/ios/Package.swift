// swift-tools-version:5.9
// Capture format and recorder for iPhone. CaptureCore is plain Swift + CryptoKit and its
// tests also run on macOS (`swift test`). CaptureRecorder needs iOS (AVFoundation, App Attest).
import PackageDescription

let package = Package(
    name: "AttestCapture",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [
        .library(name: "CaptureCore", targets: ["CaptureCore"]),
        .library(name: "CaptureRecorder", targets: ["CaptureRecorder"]),
    ],
    targets: [
        .target(name: "CaptureCore"),
        .target(name: "CaptureRecorder", dependencies: ["CaptureCore"]),
        .testTarget(name: "CaptureCoreTests", dependencies: ["CaptureCore"]),
    ]
)
