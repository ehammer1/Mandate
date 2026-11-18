package attest.capture.android

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaRecorder
import android.os.Build
import android.util.Size
import android.view.Surface
import androidx.camera.core.CameraSelector
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.lifecycle.LifecycleOwner
import androidx.media3.common.Format
import androidx.media3.common.MimeTypes
import androidx.media3.muxer.BufferInfo
import androidx.media3.muxer.FragmentedMp4Muxer
import attest.capture.CaptureSession
import attest.capture.CaptureSigner
import attest.capture.FragmentRouter
import attest.capture.GrowingBoxReader
import attest.capture.Json
import attest.capture.lastCompleteFragmentEnd
import attest.capture.manifestBox
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.util.concurrent.Executors

/**
 * Records video and audio from the camera straight into a fragmented MP4 and seals it as
 * it's written (see capture/FORMAT.md). There's no way to feed it anything but the live
 * camera and microphone.
 *
 *   camera --Preview surface--> H.264 encoder --\
 *                                                FragmentedMp4Muxer --> file on disk
 *   microphone --AudioRecord--> AAC encoder ----/                         |
 *                                                    GrowingBoxReader <---/
 *                                                         |
 *                                  FragmentRouter --> CaptureSession (hash chain, checkpoints)
 *
 * The unsealed manifest is saved next to the file at every checkpoint, so a crash still
 * leaves a provable prefix ([recoverUnsealed]).
 *
 * NOT YET BUILT OR RUN: written without the Android SDK. Expect fixes on the first device
 * build, particularly around the Media3 muxer API, which changes between releases.
 */
class SealedRecorder(
    private val context: Context,
    private val signer: CaptureSigner,
    private val output: File,
    private val videoSize: Size = Size(1920, 1080),
    private val videoBitrate: Int = 10_000_000,
    private val checkpointEveryFragments: Int = 10,
) {
    private val writer = Executors.newSingleThreadExecutor() // muxer, hashing and checkpoints
    private val partial = File(output.path + ".manifest.partial.json")

    private lateinit var session: CaptureSession
    private lateinit var router: FragmentRouter
    private lateinit var reader: GrowingBoxReader
    private lateinit var muxer: FragmentedMp4Muxer
    private lateinit var videoCodec: MediaCodec
    private lateinit var audioCodec: MediaCodec
    private var audioRecord: AudioRecord? = null
    private var videoTrack = -1
    private var audioTrack = -1
    private var startPtsUs = -1L
    private var lastPollMs = 0L
    @Volatile private var recording = false

    /** Bind the camera and start recording. [preview] shows the viewfinder to the user. */
    @SuppressLint("MissingPermission") // CAMERA and RECORD_AUDIO are checked by the app before calling.
    fun start(owner: LifecycleOwner, preview: Preview.SurfaceProvider) {
        check(!recording) { "already recording" }
        output.delete()
        session = CaptureSession(signer, platform = "android", device = "${Build.MANUFACTURER} ${Build.MODEL}")
        router = FragmentRouter(session) { n -> if (n % checkpointEveryFragments == 0) checkpoint() }
        muxer = FragmentedMp4Muxer.Builder(FileOutputStream(output)).setFragmentDurationMs(1000).build()
        reader = GrowingBoxReader(output)

        videoCodec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC).apply {
            val f = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, videoSize.width, videoSize.height).apply {
                setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
                setInteger(MediaFormat.KEY_BIT_RATE, videoBitrate)
                setInteger(MediaFormat.KEY_FRAME_RATE, 30)
                setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1) // a keyframe per fragment
            }
            configure(f, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        }
        val encoderSurface: Surface = videoCodec.createInputSurface()
        videoCodec.start()

        val sampleRate = 48_000
        val minBuf = AudioRecord.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        audioRecord = AudioRecord(MediaRecorder.AudioSource.CAMCORDER, sampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, minBuf * 4)
        audioCodec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC).apply {
            val f = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, sampleRate, 1).apply {
                setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
                setInteger(MediaFormat.KEY_BIT_RATE, 128_000)
            }
            configure(f, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            start()
        }

        // Camera frames go to two places: the viewfinder and the encoder.
        val providerFuture = ProcessCameraProvider.getInstance(context)
        providerFuture.addListener({
            val provider = providerFuture.get()
            val viewfinder = Preview.Builder().build().also { it.setSurfaceProvider(preview) }
            val toEncoder = Preview.Builder().setTargetResolution(videoSize).build().also {
                it.setSurfaceProvider { request -> request.provideSurface(encoderSurface, writer) { } }
            }
            provider.unbindAll()
            provider.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, viewfinder, toEncoder)
        }, context.mainExecutor)

        recording = true
        Thread(::drainVideo, "attest-video").start()
        Thread(::pumpAudio, "attest-audio").start()
    }

    /** Stop, seal, and return the sealed file. Blocks until the seal is written. */
    fun stop(): File {
        check(recording) { "not recording" }
        recording = false
        videoCodec.signalEndOfInputStream()
        // The drain threads finish the encoders; then the writer closes and seals.
        return writer.submit<File> {
            awaitEncodersDone()
            muxer.close()
            reader.finish().forEach { (box, bytes) -> router.accept(box, bytes) }
            val manifest = session.seal()
            FileOutputStream(output, true).use { it.write(manifestBox(manifest)) }
            File(output.path + ".manifest.json").writeText(Json.write(manifest))
            partial.delete()
            output
        }.get()
    }

    // ------------------------------------------------------------------ encoders

    private val encodersDone = java.util.concurrent.CountDownLatch(2)
    private fun awaitEncodersDone() = encodersDone.await()

    private fun drainVideo() = drain(videoCodec, isVideo = true)

    private fun pumpAudio() {
        val rec = audioRecord ?: return
        rec.startRecording()
        val pcm = ByteArray(4096)
        while (true) {
            val stopping = !recording
            val inIndex = audioCodec.dequeueInputBuffer(10_000)
            if (inIndex >= 0) {
                val n = if (stopping) 0 else rec.read(pcm, 0, pcm.size).coerceAtLeast(0)
                audioCodec.getInputBuffer(inIndex)!!.apply { clear(); put(pcm, 0, n) }
                val ptsUs = System.nanoTime() / 1000
                audioCodec.queueInputBuffer(inIndex, 0, n, ptsUs, if (stopping) MediaCodec.BUFFER_FLAG_END_OF_STREAM else 0)
                if (stopping) break
            }
            drainOnce(audioCodec, isVideo = false)
        }
        rec.stop()
        rec.release()
        drain(audioCodec, isVideo = false)
    }

    private fun drain(codec: MediaCodec, isVideo: Boolean) {
        while (!drainOnce(codec, isVideo)) { /* until end of stream */ }
        codec.stop()
        codec.release()
        encodersDone.countDown()
    }

    /** Moves available encoded output into the muxer. Returns true at end of stream. */
    private fun drainOnce(codec: MediaCodec, isVideo: Boolean): Boolean {
        val info = MediaCodec.BufferInfo()
        val index = codec.dequeueOutputBuffer(info, 10_000)
        when {
            index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                val format = toMedia3Format(codec.outputFormat)
                writer.submit { if (isVideo) videoTrack = muxer.addTrack(format) else audioTrack = muxer.addTrack(format) }.get()
            }
            index >= 0 -> {
                val eos = info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0
                val isConfig = info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0
                if (info.size > 0 && !isConfig) {
                    val src = codec.getOutputBuffer(index)!!
                    val copy = ByteBuffer.allocateDirect(info.size).put(src.position(info.offset).limit(info.offset + info.size) as ByteBuffer)
                    copy.flip()
                    val pts = info.presentationTimeUs
                    val flags = info.flags
                    writer.submit { writeSample(isVideo, copy, pts, flags) }
                }
                codec.releaseOutputBuffer(index, false)
                return eos
            }
        }
        return false
    }

    /** Runs on [writer]. */
    private fun writeSample(isVideo: Boolean, data: ByteBuffer, ptsUs: Long, flags: Int) {
        val track = if (isVideo) videoTrack else audioTrack
        if (track < 0) return
        if (startPtsUs < 0) startPtsUs = ptsUs
        val keyFrame = flags and MediaCodec.BUFFER_FLAG_KEY_FRAME != 0
        muxer.writeSampleData(track, data, BufferInfo(ptsUs - startPtsUs, data.remaining(), if (keyFrame) MediaCodec.BUFFER_FLAG_KEY_FRAME else 0))
        // Pick up any fragments the muxer has finished writing, at most every 250 ms.
        val now = System.currentTimeMillis()
        if (now - lastPollMs >= 250) {
            lastPollMs = now
            reader.poll().forEach { (box, bytes) -> router.accept(box, bytes) }
        }
    }

    /** Runs on [writer], from the router. */
    private fun checkpoint() {
        session.checkpoint()
        partial.writeText(Json.write(session.unsealed()))
    }

    private fun toMedia3Format(f: MediaFormat): Format {
        val csd = (0..2).mapNotNull { i ->
            if (f.containsKey("csd-$i")) f.getByteBuffer("csd-$i")!!.let { b -> ByteArray(b.remaining()).also { b.duplicate().get(it) } } else null
        }
        val mime = f.getString(MediaFormat.KEY_MIME)!!
        return Format.Builder().setSampleMimeType(mime).setInitializationData(csd).apply {
            if (mime == MimeTypes.VIDEO_H264) {
                setWidth(f.getInteger(MediaFormat.KEY_WIDTH))
                setHeight(f.getInteger(MediaFormat.KEY_HEIGHT))
            } else {
                setSampleRate(f.getInteger(MediaFormat.KEY_SAMPLE_RATE))
                setChannelCount(f.getInteger(MediaFormat.KEY_CHANNEL_COUNT))
            }
        }.build()
    }

    companion object {
        /**
         * After a crash: append the last saved unsealed manifest to the file, so it verifies
         * as "partial" up to its last checkpoint. Returns false if there's nothing to recover.
         */
        fun recoverUnsealed(output: File): Boolean {
            val partial = File(output.path + ".manifest.partial.json")
            if (!output.exists() || !partial.exists()) return false
            @Suppress("UNCHECKED_CAST")
            val manifest = Json.parse(partial.readText()) as Map<String, Any?>
            // A crash can leave a half-written box at the end; cut back so the file parses.
            java.io.RandomAccessFile(output, "rw").use { it.setLength(lastCompleteFragmentEnd(output)) }
            FileOutputStream(output, true).use { it.write(manifestBox(manifest)) }
            File(output.path + ".manifest.json").writeText(partial.readText())
            partial.delete()
            return true
        }
    }
}
