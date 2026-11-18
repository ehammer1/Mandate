#if os(iOS)
import AVFoundation
import CaptureCore
import Foundation
import UIKit
import UniformTypeIdentifiers

/// Records video and audio from the camera into a fragmented MP4 and seals it segment by
/// segment (capture/FORMAT.md). Only the live camera and microphone can feed it.
///
///   AVCaptureSession -> sample buffers -> AVAssetWriter (fMP4, 1 s segments)
///        -> delegate hands over each segment -> SegmentRouter -> CaptureSession -> file
///
/// AVAssetWriter writes nothing to disk itself here: the recorder writes each segment, so
/// the bytes hashed are exactly the bytes in the file. The unsealed manifest is saved at
/// every checkpoint, so a crash still leaves a provable prefix (`recoverUnsealed`).
///
/// NOT YET BUILT OR RUN: written without Xcode. Expect fixes on the first device build.
public final class SealedRecorder: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate,
    AVCaptureAudioDataOutputSampleBufferDelegate, AVAssetWriterDelegate {

    public let captureSession = AVCaptureSession()
    private let queue = DispatchQueue(label: "attest.capture.writer")
    private let videoOutput = AVCaptureVideoDataOutput()
    private let audioOutput = AVCaptureAudioDataOutput()
    private let signer: CaptureSigner
    private let checkpointEvery: Int

    private var writer: AVAssetWriter?
    private var videoInput: AVAssetWriterInput?
    private var audioInput: AVAssetWriterInput?
    private var session: CaptureSession?
    private var router: SegmentRouter?
    private var file: FileHandle?
    private var outputURL: URL?
    private var started = false
    private var failure: Error?

    public init(signer: CaptureSigner, checkpointEveryFragments: Int = 10) {
        self.signer = signer
        self.checkpointEvery = checkpointEveryFragments
        super.init()
    }

    /// Configure the camera and microphone. Call once, after permissions are granted.
    public func configure() throws {
        captureSession.beginConfiguration()
        captureSession.sessionPreset = .hd1920x1080
        guard let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
              let mic = AVCaptureDevice.default(for: .audio) else { throw CaptureError.state("no camera or microphone") }
        let videoIn = try AVCaptureDeviceInput(device: camera)
        let audioIn = try AVCaptureDeviceInput(device: mic)
        guard captureSession.canAddInput(videoIn), captureSession.canAddInput(audioIn) else { throw CaptureError.state("can't use camera") }
        captureSession.addInput(videoIn)
        captureSession.addInput(audioIn)
        videoOutput.setSampleBufferDelegate(self, queue: queue)
        audioOutput.setSampleBufferDelegate(self, queue: queue)
        captureSession.addOutput(videoOutput)
        captureSession.addOutput(audioOutput)
        captureSession.commitConfiguration()
    }

    public func start(to url: URL) throws {
        try queue.sync {
            FileManager.default.createFile(atPath: url.path, contents: nil)
            file = try FileHandle(forWritingTo: url)
            outputURL = url
            let s = CaptureSession(signer: signer, platform: "ios", device: UIDevice.current.model + " " + UIDevice.current.systemVersion)
            session = s
            router = SegmentRouter(session: s) { [weak self] n in self?.fragmentDone(n) }

            let w = AVAssetWriter(contentType: .mpeg4Movie)
            w.outputFileTypeProfile = .mpeg4AppleHLS
            w.preferredOutputSegmentInterval = CMTime(seconds: 1, preferredTimescale: 600)
            w.delegate = self
            let v = AVAssetWriterInput(mediaType: .video, outputSettings: [
                AVVideoCodecKey: AVVideoCodecType.h264,
                AVVideoWidthKey: 1920,
                AVVideoHeightKey: 1080,
                AVVideoCompressionPropertiesKey: [AVVideoMaxKeyFrameIntervalDurationKey: 1],
            ])
            let a = AVAssetWriterInput(mediaType: .audio, outputSettings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 48_000,
                AVNumberOfChannelsKey: 1,
                AVEncoderBitRateKey: 128_000,
            ])
            v.expectsMediaDataInRealTime = true
            a.expectsMediaDataInRealTime = true
            w.add(v)
            w.add(a)
            writer = w
            videoInput = v
            audioInput = a
            started = false
        }
        if !captureSession.isRunning { captureSession.startRunning() }
    }

    /// Stop, seal and return the sealed file.
    public func stop() async throws -> URL {
        guard let w = writer else { throw CaptureError.state("not recording") }
        queue.sync {
            videoInput?.markAsFinished()
            audioInput?.markAsFinished()
        }
        await w.finishWriting()
        return try queue.sync {
            if let failure { throw failure }
            guard let s = session, let f = file, let url = outputURL else { throw CaptureError.state("not recording") }
            let manifest = try s.seal()
            try f.write(contentsOf: manifestBox(manifest))
            try f.close()
            try Data(manifest.write().utf8).write(to: url.appendingPathExtension("manifest.json"))
            try? FileManager.default.removeItem(at: partialURL(url))
            writer = nil
            return url
        }
    }

    // MARK: capture

    public func captureOutput(_ output: AVCaptureOutput, didOutput sample: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let w = writer, failure == nil else { return }
        if !started {
            // Start on the first video frame so the recording begins with a picture.
            guard output == videoOutput else { return }
            let t = CMSampleBufferGetPresentationTimeStamp(sample)
            w.initialSegmentStartTime = t
            guard w.startWriting() else { failure = w.error; return }
            w.startSession(atSourceTime: t)
            started = true
        }
        let input = output == videoOutput ? videoInput : audioInput
        if let input, input.isReadyForMoreMediaData { input.append(sample) }
    }

    // MARK: segments

    public func assetWriter(_ writer: AVAssetWriter, didOutputSegmentData segmentData: Data,
                            segmentType: AVAssetSegmentType, segmentReport: AVAssetSegmentReport?) {
        // Called on the writer's own queue; hop onto ours so the session stays serial.
        queue.async { [self] in
            guard failure == nil, let router, let file else { return }
            do {
                let bytes = try router.accept(segment: segmentData)
                try file.write(contentsOf: bytes)
            } catch {
                failure = error
            }
        }
    }

    private func fragmentDone(_ n: Int) {
        guard n % checkpointEvery == 0, let s = session, let url = outputURL else { return }
        do {
            try s.checkpoint()
            try Data(s.unsealed().write().utf8).write(to: partialURL(url), options: .atomic)
        } catch {
            failure = error
        }
    }

    private func partialURL(_ url: URL) -> URL { url.appendingPathExtension("manifest.partial.json") }

    /// After a crash: trim the file to its last whole fragment and append the last saved
    /// unsealed manifest, so it verifies as "partial". Returns false if there's nothing to do.
    public static func recoverUnsealed(_ url: URL) throws -> Bool {
        let partial = url.appendingPathExtension("manifest.partial.json")
        guard FileManager.default.fileExists(atPath: url.path),
              let manifest = try? Data(contentsOf: partial) else { return false }
        let data = try Data(contentsOf: url)
        var trimmed = data.prefix(lastCompleteFragmentEnd(data))
        var size = UInt32(8 + 16 + manifest.count).bigEndian
        trimmed.append(Data(bytes: &size, count: 4))
        trimmed.append(Data("uuid".utf8))
        trimmed.append(manifestUUID)
        trimmed.append(manifest)
        try trimmed.write(to: url, options: .atomic)
        try manifest.write(to: url.appendingPathExtension("manifest.json"))
        try FileManager.default.removeItem(at: partial)
        return true
    }
}
#endif
