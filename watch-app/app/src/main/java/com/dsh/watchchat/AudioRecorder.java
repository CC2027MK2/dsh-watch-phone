package com.dsh.watchchat;

import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.media.audiofx.AutomaticGainControl;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.RandomAccessFile;

/**
 * Records microphone audio to a 16 kHz mono 16-bit PCM WAV file.
 *
 * WAV (rather than OGG/Opus) is deliberate: the host-side offline recogniser
 * (Vosk) reads raw PCM directly, so no transcoding step — and no ffmpeg — is
 * needed between the watch and the transcript.
 */
final class AudioRecorder {
    private static final String TAG = "WatchChat.AudioRecorder";
    private static final int SAMPLE_RATE = 16000;
    private static final int CHANNEL = AudioFormat.CHANNEL_IN_MONO;
    private static final int ENCODING = AudioFormat.ENCODING_PCM_16BIT;

    private final File dir;
    private AudioRecord record;
    private AutomaticGainControl agc;
    private File current;
    private Thread pump;
    private volatile boolean running;

    AudioRecorder(File cacheDir) {
        this.dir = new File(cacheDir, "audio");
    }

    /** Starts a new recording; returns false if the mic is unavailable. */
    boolean start() {
        if (running) stop();
        try {
            if (!dir.exists() && !dir.mkdirs()) {
                Log.e(TAG, "cannot create cache dir " + dir);
                return false;
            }
            current = new File(dir, "watch-rec.wav");

            int minBuf = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL, ENCODING);
            if (minBuf <= 0) {
                Log.e(TAG, "invalid min buffer size: " + minBuf);
                return false;
            }
            int bufSize = Math.max(minBuf, SAMPLE_RATE / 4 * 2);

            // VOICE_RECOGNITION asks the platform for the tuning it uses for
            // speech input (usually louder and less noise-suppressed than MIC),
            // which matters because a watch mic records very quietly.
            record = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, SAMPLE_RATE, CHANNEL, ENCODING, bufSize);
            if (record.getState() != AudioRecord.STATE_INITIALIZED) {
                Log.w(TAG, "VOICE_RECOGNITION unusable, falling back to MIC");
                releaseRecord();
                record = new AudioRecord(MediaRecorder.AudioSource.MIC, SAMPLE_RATE, CHANNEL, ENCODING, bufSize);
            }
            if (record.getState() != AudioRecord.STATE_INITIALIZED) {
                Log.e(TAG, "AudioRecord not initialised");
                releaseRecord();
                return false;
            }

            // Automatic gain is best effort: plenty of wearable audio HALs do
            // not implement it, so a failure here must not stop the recording.
            try {
                if (AutomaticGainControl.isAvailable()) {
                    agc = AutomaticGainControl.create(record.getAudioSessionId());
                    if (agc != null) agc.setEnabled(true);
                }
            } catch (RuntimeException e) {
                Log.w(TAG, "AGC unavailable", e);
                agc = null;
            }

            // write a placeholder 44-byte header; it is rewritten with real sizes on stop
            try (FileOutputStream out = new FileOutputStream(current)) {
                out.write(new byte[44]);
            }

            record.startRecording();
            running = true;
            pump = new Thread(this::pumpAudio, "audio-pump");
            pump.start();
            return true;
        } catch (IOException | RuntimeException e) {
            Log.e(TAG, "record start failed", e);
            running = false;
            releaseRecord();
            return false;
        }
    }

    private void pumpAudio() {
        byte[] buf = new byte[4096];
        try (FileOutputStream out = new FileOutputStream(current, true)) {
            while (running) {
                int n = record.read(buf, 0, buf.length);
                if (n > 0) out.write(buf, 0, n);
            }
        } catch (IOException e) {
            Log.e(TAG, "pump failed", e);
        }
    }

    /** Stops recording, finalises the WAV header and returns the clip file. */
    File stop() {
        if (!running) return current;
        running = false;
        try {
            if (pump != null) pump.join(2000);
        } catch (InterruptedException ignored) {
        }
        try {
            if (record != null) record.stop();
        } catch (RuntimeException e) {
            Log.w(TAG, "stop failed", e);
        }
        releaseRecord();

        if (current != null && current.exists()) {
            writeWavHeader(current);
        }
        return current;
    }

    /** Patches the RIFF/data sizes now that the payload length is known. */
    private void writeWavHeader(File file) {
        long dataLen = Math.max(0, file.length() - 44);
        try (RandomAccessFile raf = new RandomAccessFile(file, "rw")) {
            raf.seek(0);
            raf.write("RIFF".getBytes("US-ASCII"));
            raf.write(le32(36 + dataLen));
            raf.write("WAVE".getBytes("US-ASCII"));
            raf.write("fmt ".getBytes("US-ASCII"));
            raf.write(le32(16));
            raf.write(le16(1));                 // PCM
            raf.write(le16(1));                 // mono
            raf.write(le32(SAMPLE_RATE));
            raf.write(le32(SAMPLE_RATE * 2));   // byte rate
            raf.write(le16(2));                 // block align
            raf.write(le16(16));                // bits per sample
            raf.write("data".getBytes("US-ASCII"));
            raf.write(le32(dataLen));
        } catch (IOException e) {
            Log.e(TAG, "cannot finalise wav header", e);
        }
    }

    private static byte[] le32(long v) {
        return new byte[]{(byte) v, (byte) (v >> 8), (byte) (v >> 16), (byte) (v >> 24)};
    }

    private static byte[] le16(int v) {
        return new byte[]{(byte) v, (byte) (v >> 8)};
    }

    private void releaseRecord() {
        if (agc != null) {
            try {
                agc.release();
            } catch (RuntimeException ignored) {
            }
            agc = null;
        }
        if (record != null) {
            try {
                record.release();
            } catch (RuntimeException ignored) {
            }
            record = null;
        }
    }

    void release() {
        stop();
    }
}
