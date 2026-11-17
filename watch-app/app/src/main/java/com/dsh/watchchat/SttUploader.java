package com.dsh.watchchat;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.UUID;

/**
 * Uploads an audio clip to the DSH host bridge {@code /stt} endpoint and
 * returns the transcribed text. This is the offline speech-to-text path:
 * the watch only records, the host (with Whisper / faster-whisper) transcribes.
 */
final class SttUploader {

    /** Sends {@code clip} to {@code serverUrl + "/stt"} and returns the transcript. */
    static String upload(String serverUrl, File clip, String bearerToken) throws IOException {
        String boundary = "----watch" + UUID.randomUUID();
        String lineEnd = "\r\n";

        HttpURLConnection conn = (HttpURLConnection) new URL(serverUrl + "/stt").openConnection();
        try {
            conn.setDoOutput(true);
            conn.setConnectTimeout(5000);
            conn.setReadTimeout(60000); // transcription can take a while
            conn.setRequestMethod("POST");
            conn.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
            if (bearerToken != null && !bearerToken.isEmpty()) {
                conn.setRequestProperty("Authorization", "Bearer " + bearerToken);
            }

            try (OutputStream out = conn.getOutputStream()) {
                out.write(("--" + boundary + lineEnd).getBytes(StandardCharsets.UTF_8));
                out.write(("Content-Disposition: form-data; name=\"audio\"; filename=\""
                        + clip.getName() + "\"" + lineEnd).getBytes(StandardCharsets.UTF_8));
                out.write(("Content-Type: audio/wav" + lineEnd + lineEnd).getBytes(StandardCharsets.UTF_8));
                try (FileInputStream in = new FileInputStream(clip)) {
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = in.read(buf)) != -1) {
                        out.write(buf, 0, n);
                    }
                }
                out.write(lineEnd.getBytes(StandardCharsets.UTF_8));
                out.write(("--" + boundary + "--" + lineEnd).getBytes(StandardCharsets.UTF_8));
            }

            int code = conn.getResponseCode();
            String body = readAll(code == 200 ? conn.getInputStream() : conn.getErrorStream());
            if (code != 200) {
                throw new IOException("stt upload failed: HTTP " + code + " " + body);
            }
            return extractText(body);
        } finally {
            conn.disconnect();
        }
    }

    private static String readAll(java.io.InputStream in) throws IOException {
        if (in == null) return "";
        try (java.io.BufferedReader r = new java.io.BufferedReader(
                new java.io.InputStreamReader(in, StandardCharsets.UTF_8))) {
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = r.readLine()) != null) {
                sb.append(line);
            }
            return sb.toString();
        }
    }

    private static String extractText(String body) {
        String trimmed = body.trim();
        int idx = trimmed.indexOf("\"text\"");
        if (idx < 0) {
            return trimmed;
        }
        int colon = trimmed.indexOf(':', idx);
        int startQuote = trimmed.indexOf('"', colon + 1);
        if (startQuote < 0) return trimmed;
        StringBuilder sb = new StringBuilder();
        for (int i = startQuote + 1; i < trimmed.length(); i++) {
            char c = trimmed.charAt(i);
            if (c == '\\' && i + 1 < trimmed.length()) {
                char n = trimmed.charAt(++i);
                switch (n) {
                    case 'n': sb.append('\n'); break;
                    case 't': sb.append('\t'); break;
                    case '"': sb.append('"'); break;
                    case '\\': sb.append('\\'); break;
                    case 'u':
                        if (i + 4 < trimmed.length()) {
                            sb.append((char) Integer.parseInt(trimmed.substring(i + 1, i + 5), 16));
                            i += 4;
                        }
                        break;
                    default: sb.append(n); break;
                }
            } else if (c == '"') {
                return sb.toString();
            } else {
                sb.append(c);
            }
        }
        return sb.toString();
    }
}
