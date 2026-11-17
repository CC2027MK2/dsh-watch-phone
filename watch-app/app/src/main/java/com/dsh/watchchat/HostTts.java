package com.dsh.watchchat;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Plays a reply out loud by streaming a WAV clip from the DSH host.
 *
 * HyperOS watches ship no TextToSpeech service at all (`cmd text-to-speech`
 * reports "Can't find service"), so on-device synthesis is impossible. The host
 * synthesises with the Windows voice and this class pulls the audio down and
 * hands it to MediaPlayer. Everything stays on the LAN — no cloud service.
 */
final class HostTts {
    private static final String TAG = "WatchChat.HostTts";

    private final Context context;
    private MediaPlayer player;

    HostTts(Context context) {
        this.context = context.getApplicationContext();
    }

    interface Callback {
        void onDone(boolean ok);
    }

    /** Downloads the clip and plays it; must be called off the UI thread. */
    boolean play(String serverUrl, String text, String token, Callback callback) {
        File wav = new File(context.getCacheDir(), "reply.wav");
        HttpURLConnection conn = null;
        try {
            byte[] payload = ("{\"text\":" + quote(text) + "}").getBytes(StandardCharsets.UTF_8);
            conn = (HttpURLConnection) new URL(serverUrl + "/tts").openConnection();
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(60000);
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            if (token != null && !token.isEmpty()) {
                conn.setRequestProperty("Authorization", "Bearer " + token);
            }
            try (OutputStream out = conn.getOutputStream()) {
                out.write(payload);
            }
            int code = conn.getResponseCode();
            if (code != 200) {
                Log.w(TAG, "tts http " + code);
                if (callback != null) callback.onDone(false);
                return false;
            }
            try (InputStream in = conn.getInputStream();
                 FileOutputStream out = new FileOutputStream(wav)) {
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            }
            if (wav.length() <= 44) {
                if (callback != null) callback.onDone(false);
                return false;
            }
            playFile(wav, callback);
            return true;
        } catch (Exception e) {
            Log.w(TAG, "tts failed", e);
            if (callback != null) callback.onDone(false);
            return false;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private void playFile(File wav, Callback callback) {
        try {
            if (player != null) {
                try {
                    player.release();
                } catch (RuntimeException ignored) {
                }
                player = null;
            }
            player = new MediaPlayer();
            player.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build());
            player.setDataSource(wav.getAbsolutePath());
            player.setOnCompletionListener(mp -> {
                if (callback != null) callback.onDone(true);
            });
            player.setOnErrorListener((mp, what, extra) -> {
                if (callback != null) callback.onDone(false);
                return true;
            });
            player.prepare();
            player.start();
        } catch (Exception e) {
            Log.w(TAG, "playback failed", e);
            if (callback != null) callback.onDone(false);
        }
    }

    /** Stops whatever is currently speaking. */
    void stop() {
        if (player != null) {
            try {
                if (player.isPlaying()) player.stop();
            } catch (RuntimeException ignored) {
            }
            try {
                player.release();
            } catch (RuntimeException ignored) {
            }
            player = null;
        }
    }

    void release() {
        stop();
    }

    private static String quote(String s) {
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        return sb.append('"').toString();
    }
}
