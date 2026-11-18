package com.dsh.watchchat;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.speech.RecognitionListener;import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.HapticFeedbackConstants;
import android.view.MotionEvent;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.widget.EditText;
import android.widget.ImageButton;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends AppCompatActivity {

    /**
     * Known bridges, probed in order on every launch. Entries 1-2 are the
     * phone's own DSH Go host: its wlan0 address on the office Wi-Fi and the
     * gateway address it owns when it shares its own hotspot (192.168.43.1 is
     * the Android tethering default). The last entries are the PC bridge, kept
     * only as a fallback.
     */
    private static final String[] KNOWN_SERVERS = {
            // Phone-as-hotspot gateway (Xiaomi uses 203.0.113.1, not 192.168.43.1)
            "http://203.0.113.1:38402",
            // Phone on the office Wi-Fi
            "http://198.51.100.20:38402",
            // PC bridges, kept only as a fallback
            "http://192.0.2.1:38402",
            "http://192.0.2.1:38401",
    };
    private static final String DEFAULT_SERVER = KNOWN_SERVERS[0];
    /** Offline TTS engine on HyperOS: com.xiaomi.mibrain.speech (小爱语音). */
    /** Ports probed by the LAN auto-discovery fallback, in priority order. */
    private static final int[] DISCOVERY_PORTS = {38402, 38401, 38400};
    /**
     * The bridge answers a broadcast probe on this UDP port, which is how the
     * watch finds the phone after either of them changes network.
     */
    private static final int DISCOVERY_PORT = 38403;
    /** DNS-SD service the bridge publishes while it is listening. */
    private static final String MDNS_SERVICE_TYPE = "_dsh-watch._tcp.local";
    private static final String PREFS_NAME = "watchchat";
    private static final String KEY_SERVER = "server_url";
    private static final String KEY_RECENT = "recent_servers";
    private static final String KEY_TOKEN = "auth_token";
    private static final int PERMISSION_REQUEST_AUDIO = 100;

    private ScrollView chatScroll;
    private LinearLayout chatContainer;
    private EditText inputText;
    private ImageButton micButton;
    private ImageButton sendButton;
    private TextView statusText;

    private SpeechRecognizer speechRecognizer;
    private boolean isListening = false;

    private TextToSpeech tts;
    private boolean ttsReady = false;
    private HostTts hostTts;

    private String serverUrl;
    private String token;
    private AudioRecorder sttRecorder;
    private boolean sttRecording = false;
    private final ExecutorService networkExecutor = Executors.newSingleThreadExecutor();

    /* ---- hold-to-talk state ---- */
    private ProgressBar micSpinner;
    /** True between "finger down" and "AudioRecord actually armed". */
    private volatile boolean micArming = false;
    /** Set when the finger came up before the recorder finished arming. */
    private volatile boolean releasedWhileArming = false;
    private long recordStartedAt = 0L;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private int waveFrame = 0;
    private static final int[] WAVE_FRAMES = {
            R.drawable.ic_wave_a, R.drawable.ic_wave_b, R.drawable.ic_wave_c};
    private static final long MIN_RECORD_MS = 600L;
    private static final long MAX_RECORD_MS = 20000L;

    private final Runnable waveTick = new Runnable() {
        @Override
        public void run() {
            if (!sttRecording) {
                return;
            }
            waveFrame = (waveFrame + 1) % WAVE_FRAMES.length;
            micButton.setImageResource(WAVE_FRAMES[waveFrame]);
            ui.postDelayed(this, 150);
        }
    };

    private final Runnable secondsTick = new Runnable() {
        @Override
        public void run() {
            if (!sttRecording) {
                return;
            }
            long secs = (SystemClock.elapsedRealtime() - recordStartedAt) / 1000L;
            statusText.setText(getString(R.string.listening) + " " + secs + "s");
            ui.postDelayed(this, 500);
        }
    };

    private final Runnable autoStop = new Runnable() {
        @Override
        public void run() {
            if (sttRecording) {
                Toast.makeText(MainActivity.this, "到最长了，先发这段", Toast.LENGTH_SHORT).show();
                endHold();
            }
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        chatScroll = findViewById(R.id.chatScroll);
        chatContainer = findViewById(R.id.chatContainer);
        inputText = findViewById(R.id.inputText);
        micButton = findViewById(R.id.micButton);
        micSpinner = findViewById(R.id.micSpinner);
        sendButton = findViewById(R.id.sendButton);
        statusText = findViewById(R.id.statusText);

        serverUrl = getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                .getString(KEY_SERVER, DEFAULT_SERVER);
        token = getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                .getString(KEY_TOKEN, "");

        initTts();
        hostTts = new HostTts(this);
        initSpeechRecognizer();
        setupListeners();
        checkConnection();
    }

    private void initTts() {
        tts = new TextToSpeech(this, status -> {
            if (status == TextToSpeech.SUCCESS) {
                tts.setLanguage(Locale.CHINESE);
                tts.setSpeechRate(1.0f);
                ttsReady = true;
            }
        }, "com.xiaomi.mibrain.speech");
    }

    private void initSpeechRecognizer() {
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            // No on-device recognition service (typical on HyperOS watches).
            // The mic stays enabled: the tap-to-record offline path uploads the
            // clip to the host, which transcribes it with Vosk.
            speechRecognizer = null;
            return;
        }
        speechRecognizer = SpeechRecognizer.createSpeechRecognizer(this);
        speechRecognizer.setRecognitionListener(new RecognitionListener() {
            @Override
            public void onReadyForSpeech(Bundle params) {
                isListening = true;
                runOnUiThread(() -> inputText.setHint(R.string.listening));
            }
            @Override public void onBeginningOfSpeech() {}
            @Override public void onRmsChanged(float rmsdB) {}
            @Override public void onBufferReceived(byte[] buffer) {}
            @Override
            public void onEndOfSpeech() {
                isListening = false;
                runOnUiThread(() -> inputText.setHint(R.string.hint_type));
            }
            @Override
            public void onError(int error) {
                isListening = false;
                runOnUiThread(() -> {
                    inputText.setHint(R.string.hint_type);
                    if (error != SpeechRecognizer.ERROR_NO_MATCH && error != SpeechRecognizer.ERROR_SPEECH_TIMEOUT) {
                        Toast.makeText(MainActivity.this, "识别错误: " + error, Toast.LENGTH_SHORT).show();
                    }
                });
            }
            @Override
            public void onResults(Bundle results) {
                isListening = false;
                ArrayList<String> matches = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                runOnUiThread(() -> {
                    inputText.setHint(R.string.hint_type);
                    if (matches != null && !matches.isEmpty()) {
                        String text = matches.get(0);
                        inputText.setText(text);
                        sendMessage(text);
                    }
                });
            }
            @Override
            public void onPartialResults(Bundle partialResults) {
                ArrayList<String> partial = partialResults.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                if (partial != null && !partial.isEmpty()) {
                    runOnUiThread(() -> inputText.setText(partial.get(0)));
                }
            }
            @Override public void onEvent(int eventType, Bundle params) {}
        });
    }

    private void setupListeners() {
        // Mic works like WeChat: hold to record, release to transcribe and send.
        // While the recorder arms we show a spinner; while it records we show an
        // animated waveform plus a running seconds counter.
        micButton.setOnTouchListener((v, event) -> {
            switch (event.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    beginHold();
                    return true;
                case MotionEvent.ACTION_UP:
                case MotionEvent.ACTION_CANCEL:
                    endHold();
                    return true;
                default:
                    return false;
            }
        });

        // Tapping the status line opens the server dialog (the mic long-press
        // gesture is gone now that holding means "talk").
        statusText.setOnClickListener(v -> showServerDialog());

        sendButton.setOnClickListener(v -> {
            String text = inputText.getText().toString().trim();
            if (!TextUtils.isEmpty(text)) {
                sendMessage(text);
                inputText.setText("");
            }
        });

        inputText.setOnEditorActionListener((v, actionId, event) -> {
            if (actionId == EditorInfo.IME_ACTION_SEND) {
                String text = inputText.getText().toString().trim();
                if (!TextUtils.isEmpty(text)) {
                    sendMessage(text);
                    inputText.setText("");
                }
                return true;
            }
            return false;
        });

        chatScroll.setOnLongClickListener(v -> {
            showServerDialog();
            return true;
        });
    }

    private void startListening() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this,
                    new String[]{Manifest.permission.RECORD_AUDIO}, PERMISSION_REQUEST_AUDIO);
            return;
        }
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "zh-CN");
        intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        speechRecognizer.startListening(intent);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions, @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == PERMISSION_REQUEST_AUDIO) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                startListening();
            } else {
                Toast.makeText(this, "需要录音权限才能语音输入", Toast.LENGTH_LONG).show();
            }
        }
    }

    /**
     * Finger down: arm the recorder off the UI thread (AudioRecord setup costs a
     * few hundred ms) while the button shows a spinner, then switch to the
     * animated waveform once audio is really flowing.
     */
    private void beginHold() {
        if (!hasRecordAudioPermission()) {
            ActivityCompat.requestPermissions(this,
                    new String[]{Manifest.permission.RECORD_AUDIO}, PERMISSION_REQUEST_AUDIO);
            return;
        }
        if (sttRecording || micArming) {
            return;
        }
        if (sttRecorder == null) {
            sttRecorder = new AudioRecorder(getCacheDir());
        }
        micArming = true;
        releasedWhileArming = false;
        micButton.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY);
        showMicSpinner(true);
        statusText.setText(getString(R.string.listening));
        statusText.setVisibility(View.VISIBLE);
        final AudioRecorder recorder = sttRecorder;
        new Thread(() -> {
            final boolean ok = recorder.start();
            runOnUiThread(() -> {
                micArming = false;
                if (!ok) {
                    showMicSpinner(false);
                    statusText.setVisibility(View.GONE);
                    Toast.makeText(this, "无法开始录音", Toast.LENGTH_SHORT).show();
                    return;
                }
                if (releasedWhileArming) {
                    // The finger left before we were armed: discard silently.
                    java.io.File early = recorder.stop();
                    if (early != null) {
                        //noinspection ResultOfMethodCallIgnored
                        early.delete();
                    }
                    showMicSpinner(false);
                    statusText.setVisibility(View.GONE);
                    Toast.makeText(this, "按住说话，松手发送", Toast.LENGTH_SHORT).show();
                    return;
                }
                sttRecording = true;
                recordStartedAt = SystemClock.elapsedRealtime();
                showMicSpinner(false);
                micButton.setBackgroundResource(R.drawable.talk_bg_recording);
                waveFrame = 0;
                micButton.setImageResource(WAVE_FRAMES[0]);
                micButton.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS);
                ui.post(waveTick);
                ui.post(secondsTick);
                ui.postDelayed(autoStop, MAX_RECORD_MS);
            });
        }, "mic-arm").start();
    }

    /** Finger up: stop, transcribe on the phone, and put the text in the box. */
    private void endHold() {
        if (micArming) {
            releasedWhileArming = true;
            return;
        }
        if (!sttRecording) {
            return;
        }
        sttRecording = false;
        ui.removeCallbacks(waveTick);
        ui.removeCallbacks(secondsTick);
        ui.removeCallbacks(autoStop);
        long heldMs = SystemClock.elapsedRealtime() - recordStartedAt;
        java.io.File clip = sttRecorder.stop();
        resetMicUi();
        if (clip == null || !clip.exists() || clip.length() == 0) {
            Toast.makeText(this, "录音失败", Toast.LENGTH_SHORT).show();
            return;
        }
        if (heldMs < MIN_RECORD_MS) {
            //noinspection ResultOfMethodCallIgnored
            clip.delete();
            Toast.makeText(this, "说话时间太短", Toast.LENGTH_SHORT).show();
            return;
        }
        showMicSpinner(true);
        statusText.setText(getString(R.string.recognizing));
        statusText.setVisibility(View.VISIBLE);
        final java.io.File f = clip;
        new Thread(() -> {
            try {
                String text = SttUploader.upload(serverUrl, f, token == null ? "" : token);
                final String draft = text == null ? "" : text.trim();
                runOnUiThread(() -> {
                    showMicSpinner(false);
                    statusText.setVisibility(View.GONE);
                    if (!draft.isEmpty()) {
                        // Speech goes through the same box as typing: the user
                        // reads it, fixes what the transcriber got wrong, and
                        // only then presses send.
                        inputText.setText(draft);
                        inputText.setSelection(draft.length());
                        Toast.makeText(this, "语音已填入输入框，检查后按发送", Toast.LENGTH_SHORT).show();
                    } else {
                        Toast.makeText(this, "没听清，再说一次", Toast.LENGTH_SHORT).show();
                    }
                });
            } catch (Exception e) {
                runOnUiThread(() -> {
                    showMicSpinner(false);
                    statusText.setVisibility(View.GONE);
                    Toast.makeText(this, "识别失败: " + e.getMessage(), Toast.LENGTH_SHORT).show();
                });
            } finally {
                //noinspection ResultOfMethodCallIgnored
                f.delete();
            }
        }, "stt-upload").start();
    }

    private void showMicSpinner(boolean show) {
        if (micSpinner == null) {
            return;
        }
        micSpinner.setVisibility(show ? View.VISIBLE : View.GONE);
        micButton.setAlpha(show ? 0.35f : 1f);
    }

    private void resetMicUi() {
        showMicSpinner(false);
        micButton.setBackgroundResource(R.drawable.talk_bg);
        micButton.setImageDrawable(ContextCompat.getDrawable(this, R.drawable.ic_mic));
        statusText.setVisibility(View.GONE);
    }

    private boolean hasRecordAudioPermission() {
        return ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                == PackageManager.PERMISSION_GRANTED;
    }

    private void sendMessage(String text) {
        addBubble(text, true);
        addBubble("思考中…", false);
        inputText.setText("");

        networkExecutor.execute(() -> {
            try {
                String reply = postChat(text);
                runOnUiThread(() -> {
                    removeLastBubble();
                    addBubble(reply, false);
                    speak(reply);
                });
            } catch (Exception e) {
                runOnUiThread(() -> {
                    removeLastBubble();
                    addBubble("⚠ 连接失败: " + e.getMessage(), false);
                });
            }
        });
    }

    private String postChat(String message) throws IOException {
        URL url = new URL(serverUrl + "/chat");
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setRequestMethod("POST");
        conn.setRequestProperty("Content-Type", "application/json");
        conn.setConnectTimeout(5000);
        conn.setReadTimeout(60000);
        conn.setDoOutput(true);

        String jsonBody = "{\"text\":\"" + message.replace("\\", "\\\\").replace("\"", "\\\"") + "\"}";
        OutputStream os = conn.getOutputStream();
        os.write(jsonBody.getBytes(StandardCharsets.UTF_8));
        os.flush();
        os.close();

        int code = conn.getResponseCode();
        InputStream is = (code >= 200 && code < 300) ? conn.getInputStream() : conn.getErrorStream();
        BufferedReader reader = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8));
        StringBuilder sb = new StringBuilder();
        String line;
        while ((line = reader.readLine()) != null) {
            sb.append(line).append('\n');
        }
        reader.close();
        conn.disconnect();

        if (code != 200) {
            return "服务器错误 (HTTP " + code + "): " + sb.toString().trim();
        }

        // Simple JSON parse: extract "reply" field
        String raw = sb.toString().trim();
        int idx = raw.indexOf("\"reply\"");
        if (idx >= 0) {
            int colon = raw.indexOf(':', idx);
            int startQuote = raw.indexOf('"', colon + 1);
            if (startQuote >= 0) {
                StringBuilder reply = new StringBuilder();
                for (int i = startQuote + 1; i < raw.length(); i++) {
                    char c = raw.charAt(i);
                    if (c == '\\' && i + 1 < raw.length()) {
                        char next = raw.charAt(i + 1);
                        if (next == '"') { reply.append('"'); i++; }
                        else if (next == '\\') { reply.append('\\'); i++; }
                        else if (next == 'n') { reply.append('\n'); i++; }
                        else if (next == 't') { reply.append('\t'); i++; }
                        else reply.append(c);
                    } else if (c == '"') {
                        return reply.toString();
                    } else {
                        reply.append(c);
                    }
                }
            }
        }
        return raw;
    }

    /**
     * Find the bridge no matter which network both devices happen to share:
     *  1. the saved address,
     *  2. the rolling list of previously-good addresses,
     *  3. a UDP broadcast probe (fast, needs no mDNS and no multicast lock),
     *  4. mDNS (_dsh-watch._tcp) when the network passes multicast,
     *  5. the /24 of every local interface,
     *  6. the hard-coded documentation ranges, as a last resort.
     */
    private String locateBridge() {
        if (probeHealth(serverUrl)) return serverUrl;
        for (String candidate : recentServers()) {
            if (!candidate.equals(serverUrl) && probeHealth(candidate)) return candidate;
        }
        String broadcast = discoverViaBroadcast();
        if (broadcast != null) return broadcast;
        String mdns = discoverViaMdns();
        if (mdns != null) return mdns;
        String scan = discoverServer();
        if (scan != null) return scan;
        for (String candidate : KNOWN_SERVERS) {
            if (probeHealth(candidate)) return candidate;
        }
        return null;
    }

    /** @return the rolling list of previously-good bridge URLs, newest first. */
    private java.util.List<String> recentServers() {
        String raw = getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getString(KEY_RECENT, "");
        java.util.List<String> out = new java.util.ArrayList<>();
        if (raw == null || raw.isEmpty()) return out;
        int i = 0;
        while (i < raw.length()) {
            int q = raw.indexOf('"', i);
            if (q < 0) break;
            int end = raw.indexOf('"', q + 1);
            if (end < 0) break;
            out.add(raw.substring(q + 1, end));
            i = end + 1;
        }
        return out;
    }

    /** Remember a working bridge address, newest first, at most 8 entries. */
    private void saveServerUrl(String url) {
        java.util.List<String> list = new java.util.ArrayList<>(recentServers());
        list.remove(url);
        list.add(0, url);
        while (list.size() > 8) list.remove(list.size() - 1);
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < list.size(); i++) {
            if (i > 0) sb.append(',');
            sb.append('"').append(list.get(i)).append('"');
        }
        sb.append(']');
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit()
                .putString(KEY_SERVER, url)
                .putString(KEY_RECENT, sb.toString())
                .apply();
    }

    /**
     * Broadcast a UDP probe and use the first answer that also passes /health.
     * Unlike mDNS this needs no multicast lock and no privileged port, so it
     * keeps working across tethering, hotspot and ordinary Wi-Fi unchanged.
     */
    private String discoverViaBroadcast() {
        java.net.DatagramSocket socket = null;
        try {
            socket = new java.net.DatagramSocket();
            socket.setBroadcast(true);
            socket.setSoTimeout(300);
            byte[] probe = "dsh-watch?".getBytes("UTF-8");
            sendProbe(socket, probe, "255.255.255.255");
            for (String bcast : broadcastAddresses()) {
                sendProbe(socket, probe, bcast);
            }
            long deadline = System.currentTimeMillis() + 1800L;
            byte[] buf = new byte[2048];
            while (System.currentTimeMillis() < deadline) {
                java.net.DatagramPacket in = new java.net.DatagramPacket(buf, buf.length);
                try {
                    socket.receive(in);
                } catch (java.net.SocketTimeoutException te) {
                    continue;
                }
                String text = new String(in.getData(), 0, in.getLength(), "UTF-8");
                String url = firstHealthyUrl(text);
                if (url != null) return url;
            }
        } catch (Exception ignored) {
        } finally {
            if (socket != null) socket.close();
        }
        return null;
    }

    private void sendProbe(java.net.DatagramSocket socket, byte[] probe, String host) {
        try {
            socket.send(new java.net.DatagramPacket(probe, probe.length,
                    java.net.InetAddress.getByName(host), DISCOVERY_PORT));
        } catch (Exception ignored) {
        }
    }

    /** Pull the first healthy URL out of the bridge's JSON discovery answer. */
    private String firstHealthyUrl(String text) {
        java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("\"urls\"\\s*:\\s*\\[([^\\]]*)\\]")
                .matcher(text);
        if (!m.find()) return null;
        for (String part : m.group(1).split(",")) {
            String url = part.trim().replace("\"", "");
            if (url.startsWith("http") && probeHealth(url)) return url;
        }
        return null;
    }

    /** Broadcast addresses of the local IPv4 interfaces. */
    private java.util.List<String> broadcastAddresses() {
        java.util.List<String> out = new java.util.ArrayList<>();
        try {
            java.util.List<java.net.NetworkInterface> all =
                    java.util.Collections.list(java.net.NetworkInterface.getNetworkInterfaces());
            for (java.net.NetworkInterface nif : all) {
                if (!nif.isUp() || nif.isLoopback()) continue;
                for (java.net.InterfaceAddress ia : nif.getInterfaceAddresses()) {
                    java.net.InetAddress b = ia.getBroadcast();
                    if (b instanceof java.net.Inet4Address) out.add(b.getHostAddress());
                }
            }
        } catch (Exception ignored) {
        }
        return out;
    }

    /**
     * Ask the system for the bridge over DNS-SD. While the bridge is listening
     * it publishes _dsh-watch._tcp; NsdManager resolves it to a host and port on
     * the current network with no configuration at all.
     */
    private String discoverViaMdns() {
        final android.net.nsd.NsdManager nsd =
                (android.net.nsd.NsdManager) getSystemService(Context.NSD_SERVICE);
        if (nsd == null) return null;
        final Object lock = new Object();
        final String[] result = new String[1];
        android.net.nsd.NsdManager.DiscoveryListener listener =
                new android.net.nsd.NsdManager.DiscoveryListener() {
                    @Override public void onDiscoveryStarted(String regType) { }
                    @Override public void onDiscoveryStopped(String serviceType) { }
                    @Override public void onServiceFound(android.net.nsd.NsdServiceInfo service) {
                        try {
                            nsd.resolveService(service, new android.net.nsd.NsdManager.ResolveListener() {
                                @Override public void onServiceResolved(android.net.nsd.NsdServiceInfo info) {
                                    int port = info.getPort();
                                    java.net.InetAddress host = info.getHost();
                                    if (host != null && port > 0) {
                                        String base = "http://" + host.getHostAddress() + ":" + port;
                                        if (probeHealth(base)) {
                                            synchronized (lock) {
                                                result[0] = base;
                                                lock.notifyAll();
                                            }
                                        }
                                    }
                                }
                                @Override public void onResolveFailed(android.net.nsd.NsdServiceInfo info, int code) { }
                            });
                        } catch (Exception ignored) { }
                    }
                    @Override public void onServiceLost(android.net.nsd.NsdServiceInfo service) { }
                    @Override public void onStartDiscoveryFailed(String serviceType, int code) { }
                    @Override public void onStopDiscoveryFailed(String serviceType, int code) { }
                };
        try {
            nsd.discoverServices(MDNS_SERVICE_TYPE,
                    android.net.nsd.NsdManager.PROTOCOL_DNS_SD, listener);
            synchronized (lock) {
                try {
                    lock.wait(4000);
                } catch (InterruptedException ignored) {
                    Thread.currentThread().interrupt();
                }
            }
            try {
                nsd.stopServiceDiscovery(listener);
            } catch (Exception ignored) { }
        } catch (Exception ignored) { }
        return result[0];
    }

    private void checkConnection() {
        networkExecutor.execute(() -> {
            String found = locateBridge();
            final boolean ok = found != null;
            if (ok) {
                serverUrl = found;
                saveServerUrl(serverUrl);
            }
            final boolean connected = ok;
            runOnUiThread(() -> {
                statusText.setVisibility(View.VISIBLE);
                statusText.setText(connected ? R.string.connected : R.string.disconnected);
                if (connected) {
                    // The banner sits above the chat bubbles on a 480px round screen;
                    // fade it away once the link is up so it stops covering messages.
                    statusText.postDelayed(() -> {
                        if (!isFinishing()) statusText.setVisibility(View.GONE);
                    }, 2500);
                    Toast.makeText(MainActivity.this, "已连接 " + serverUrl, Toast.LENGTH_SHORT).show();
                }
            });
        });
    }

    /** @return true when {@code base} answers /health with HTTP 200. */
    private boolean probeHealth(String base) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(base + "/health").openConnection();
            conn.setConnectTimeout(1200);
            conn.setReadTimeout(1200);
            int code = conn.getResponseCode();
            return code == 200;
        } catch (Exception e) {
            return false;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /**
     * Scan this device's own /24 for a reachable DSH bridge. The host address is
     * not stable (DHCP, phone tethering, hotspot), so guessing the last octet
     * beats asking the user to retype an IP on a 480px screen.
     *
     * @return the first responding base URL, or null.
     */
    private String discoverServer() {
        String prefix = ownSubnetPrefix();
        if (prefix == null) return null;
        runOnUiThread(() -> statusText.setText("正在搜索电脑…"));

        final java.util.concurrent.atomic.AtomicReference<String> hit =
                new java.util.concurrent.atomic.AtomicReference<>(null);
        java.util.concurrent.ExecutorService pool = Executors.newFixedThreadPool(16);
        for (int host = 1; host <= 254 && hit.get() == null; host++) {
            final String candidate = prefix + host;
            pool.execute(() -> {
                if (hit.get() != null) return;
                for (int port : DISCOVERY_PORTS) {
                    String base = "http://" + candidate + ":" + port;
                    if (probeHealth(base)) {
                        hit.compareAndSet(null, base);
                        return;
                    }
                }
            });
        }
        pool.shutdown();
        try {
            pool.awaitTermination(12, java.util.concurrent.TimeUnit.SECONDS);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
        return hit.get();
    }

    /** @return "a.b.c." for this device's first site-local IPv4 address, or null. */
    private String ownSubnetPrefix() {
        try {
            for (java.util.Enumeration<java.net.NetworkInterface> nifs =
                         java.net.NetworkInterface.getNetworkInterfaces(); nifs.hasMoreElements(); ) {
                java.net.NetworkInterface nif = nifs.nextElement();
                if (!nif.isUp() || nif.isLoopback()) continue;
                for (java.util.Enumeration<java.net.InetAddress> addrs = nif.getInetAddresses();
                     addrs.hasMoreElements(); ) {
                    java.net.InetAddress addr = addrs.nextElement();
                    if (addr.isLoopbackAddress() || !(addr instanceof java.net.Inet4Address)) continue;
                    String ip = addr.getHostAddress();
                    int dot = ip.lastIndexOf('.');
                    if (dot > 0) return ip.substring(0, dot + 1);
                }
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    private void showServerDialog() {
        inputText.setHint("输入服务器地址 (如 http://192.0.2.10:38401)");
        inputText.requestFocus();
        sendButton.setOnClickListener(v -> {
            String url = inputText.getText().toString().trim();
            if (!TextUtils.isEmpty(url)) {
                serverUrl = url;
                getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit().putString(KEY_SERVER, serverUrl).apply();
                inputText.setText("");
                inputText.setHint(R.string.hint_type);
                checkConnection();
                Toast.makeText(this, "服务器已更新: " + serverUrl, Toast.LENGTH_SHORT).show();
            }
            sendButton.setOnClickListener(v2 -> {
                String text = inputText.getText().toString().trim();
                if (!TextUtils.isEmpty(text)) {
                    sendMessage(text);
                    inputText.setText("");
                }
            });
        });
    }

    private void addBubble(String text, boolean isUser) {
        TextView bubble = new TextView(this);
        bubble.setText(text);
        bubble.setTextSize(TypedValue.COMPLEX_UNIT_PX,
                getResources().getDimension(R.dimen.bubble_text_size));
        bubble.setTextColor(getResources().getColor(R.color.text_primary));
        int padH = Math.round(getResources().getDimension(R.dimen.bubble_pad_horizontal));
        int padV = Math.round(getResources().getDimension(R.dimen.bubble_pad_vertical));
        bubble.setPadding(padH, padV, padH, padV);
        bubble.setBackgroundResource(isUser ? R.drawable.bubble_user : R.drawable.bubble_assistant);

        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.setMargins(8, 4, 8, 4);
        lp.gravity = isUser ? Gravity.END : Gravity.START;
        bubble.setLayoutParams(lp);
        // 160dp on the watch, 280dp on a phone: never wider than the display.
        bubble.setMaxWidth(Math.round(getResources().getDimension(R.dimen.bubble_max_width)));

        chatContainer.addView(bubble);
        chatScroll.post(() -> chatScroll.fullScroll(View.FOCUS_DOWN));
    }

    private void removeLastBubble() {
        int count = chatContainer.getChildCount();
        if (count > 0) {
            chatContainer.removeViewAt(count - 1);
        }
    }

    private void speak(String text) {
        if (TextUtils.isEmpty(text)) return;
        // The DSH persona is allowed to emit inline stage directions such as
        // `[表情:开心]`; those are for the eye, not the ear, so strip them (and
        // bare bracketed tags up to 12 chars) before synthesis.
        final String spoken = text.replaceAll("\\[[^\\]]{1,12}\\]", "").trim();
        if (TextUtils.isEmpty(spoken)) return;
        if (ttsReady && tts != null) {
            tts.speak(spoken, TextToSpeech.QUEUE_FLUSH, null, "msg_" + System.currentTimeMillis());
            return;
        }
        // No on-device engine: stream the clip the host synthesised for us.
        final String reply = spoken;
        networkExecutor.execute(() -> hostTts.play(serverUrl, reply, token, null));
    }
    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (speechRecognizer != null) {
            speechRecognizer.destroy();
        }
        if (tts != null) {
            tts.stop();
            tts.shutdown();
        }
        if (hostTts != null) hostTts.release();
        networkExecutor.shutdown();
    }
}
