package com.poupous.app;

import android.Manifest;
import android.app.AlarmManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.AssetManager;
import android.os.Build;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.provider.Settings;
import android.util.Base64;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.webkit.ValueCallback;
import java.util.Iterator;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import android.content.Context;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.database.Cursor;
import android.net.Uri;
import android.provider.AlarmClock;
import android.provider.ContactsContract;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class MainActivity extends Activity {

    static final String CANAL = "poupous";


    static final String REPO = "chibplanning-blip/poupous";
    static final String UPDATE_URL = "https://raw.githubusercontent.com/" + REPO + "/HEAD/app.html";
    static final String API_URL = "https://api.anthropic.com/v1/messages";

    WebView web;
    TextToSpeech tts;
    volatile boolean ttsReady = false;
    SpeechRecognizer recognizer;
    final Handler main = new Handler(Looper.getMainLooper());
    SharedPreferences prefs;
    String pendingListenId = null;
    String pendingCaptureId = null;
    int pendingCaptureMs = 8000;
    volatile boolean capStop = false, capCancel = false;
    Thread capThread = null;
    String pendingContactId = null;
    String pendingContactQuery = null;
    ValueCallback<Uri[]> fileCallback = null;
    volatile String sharedJson = null;

    // ------------------------------------------------------------------ cycle de vie

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences("poupous", MODE_PRIVATE);

        web = new WebView(this);
        web.setBackgroundColor(0xFF070D1A);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setMediaPlaybackRequiresUserGesture(false);

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try {
                    Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
                    pick.addCategory(Intent.CATEGORY_OPENABLE);
                    pick.setType("*/*");
                    pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                    startActivityForResult(Intent.createChooser(pick, "Choisir un fichier pour Poupous"), 3);
                    return true;
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                checkStartedAfterUpgrade();
            }
        });
        web.addJavascriptInterface(new Bridge(), "Poupous");

        tts = new TextToSpeech(this, status -> {
            if (status == TextToSpeech.SUCCESS) {
                tts.setLanguage(Locale.FRANCE);
                ttsReady = true;
                applyVoice();
            }
        });
        tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override public void onStart(String id) { }
            @Override public void onDone(String id) { ttsFinished(id); }
            @Override public void onError(String id) { ttsFinished(id); }
            @Override public void onStop(String id, boolean interrupted) { ttsFinished(id); }
        });

        if (prefs.getBoolean("veille", false)) {
            try { startForegroundService(new Intent(this, Veille.class)); } catch (Exception ignored) {}
        }
        ensureAppFile();
        loadApp();
        checkForUpdate();
        handleShare(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleShare(intent);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != 3 || fileCallback == null) return;
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                int n = data.getClipData().getItemCount();
                result = new Uri[n];
                for (int i = 0; i < n; i++) result[i] = data.getClipData().getItemAt(i).getUri();
            } else if (data.getData() != null) {
                result = new Uri[]{data.getData()};
            }
        }
        fileCallback.onReceiveValue(result);
        fileCallback = null;
    }

    // ------------------------------------------------------------------ fichiers partagés vers Poupous

    static byte[] readBytes(InputStream in) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        in.close();
        return out.toByteArray();
    }

    String displayName(Uri uri) {
        try (Cursor c = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                String n = c.getString(0);
                if (n != null) return n;
            }
        } catch (Exception ignored) {
        }
        String last = uri.getLastPathSegment();
        return last == null ? "fichier" : last;
    }

    @SuppressWarnings("deprecation")
    void handleShare(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return;
        final String text = intent.getStringExtra(Intent.EXTRA_TEXT);
        final Uri uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        new Thread(() -> {
            try {
                JSONObject o = new JSONObject();
                if (uri != null) {
                    byte[] bytes = readBytes(getContentResolver().openInputStream(uri));
                    if (bytes.length > 15 * 1024 * 1024) throw new Exception("fichier trop gros");
                    String mime = getContentResolver().getType(uri);
                    o.put("nom", displayName(uri));
                    o.put("type", mime == null ? "application/octet-stream" : mime);
                    o.put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP));
                }
                if (text != null) o.put("texte", text);
                sharedJson = o.toString();
                js("window.__sharedAvailable && window.__sharedAvailable()");
            } catch (Exception e) {
                main.post(() -> Toast.makeText(this, "Impossible de lire le fichier partagé", Toast.LENGTH_LONG).show());
            }
        }).start();
    }

    // ------------------------------------------------------------------ fichiers créés par Poupous

    void preparerCanal() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        NotificationChannel c = new NotificationChannel(CANAL, "Poupous", NotificationManager.IMPORTANCE_HIGH);
        c.setDescription("Messages et rappels de Poupous");
        nm.createNotificationChannel(c);
    }

    boolean notificationsAutorisees() {
        if (Build.VERSION.SDK_INT < 33) return true;
        return checkSelfPermission("android.permission.POST_NOTIFICATIONS") == PackageManager.PERMISSION_GRANTED;
    }

    void demanderNotifications() {
        if (Build.VERSION.SDK_INT >= 33) requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, 4);
    }

    File shareDir() {
        File d = new File(getCacheDir(), "partage");
        d.mkdirs();
        return d;
    }

    static String safeName(String name) {
        String n = name == null ? "" : name.replaceAll("[\\\\/:*?\"<>|]", "_").trim();
        return n.isEmpty() ? "poupous.txt" : n;
    }

    // ------------------------------------------------------------------ mise à jour de l'APK

    void installApk(String id, File apk) {
        if (!getPackageManager().canRequestPackageInstalls()) {
            try {
                Intent s = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getPackageName()));
                s.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(s);
            } catch (Exception ignored) {
            }
            js("window.__installDone && window.__installDone(" + q(id) + ",'permission')");
            return;
        }
        try {
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(FilesProvider.uriFor(apk), "application/vnd.android.package-archive");
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
            js("window.__installDone && window.__installDone(" + q(id) + ",'ok')");
        } catch (Exception e) {
            js("window.__installDone && window.__installDone(" + q(id) + "," + q("erreur : " + e.getMessage()) + ")");
        }
    }

    void collectSource(AssetManager am, String dir, JSONObject out) throws Exception {
        String[] items = am.list(dir);
        if (items == null) return;
        for (String item : items) {
            String path = dir + "/" + item;
            String[] sub = am.list(path);
            if (sub != null && sub.length > 0) {
                collectSource(am, path, out);
            } else if (!item.endsWith(".keystore")) {
                out.put(path.substring("source/".length()), readStream(am.open(path)));
            }
        }
    }

    @Override
    protected void onDestroy() {
        if (tts != null) tts.shutdown();
        capCancel = true; capStop = true;
        if (recognizer != null) recognizer.destroy();
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        js("window.__onBack ? window.__onBack() : null");
    }

    // ------------------------------------------------------------------ fichiers de l'appli

    File appFile() { return new File(getFilesDir(), "app.html"); }
    File backupFile() { return new File(getFilesDir(), "app_backup.html"); }

    static int versionOf(String html) {
        if (html == null) return -1;
        Matcher m = Pattern.compile("POUPOUS_VERSION\\s*=\\s*(\\d+)").matcher(html);
        return m.find() ? Integer.parseInt(m.group(1)) : -1;
    }

    static String readStream(InputStream in) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        in.close();
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }

    static String readFile(File f) {
        try { return readStream(new FileInputStream(f)); } catch (Exception e) { return null; }
    }

    static boolean writeFile(File f, String text) {
        try {
            File tmp = new File(f.getAbsolutePath() + ".tmp");
            OutputStream out = new FileOutputStream(tmp);
            out.write(text.getBytes(StandardCharsets.UTF_8));
            out.close();
            return tmp.renameTo(f);
        } catch (Exception e) {
            return false;
        }
    }

    String assetApp() {
        try { return readStream(getAssets().open("app.html")); } catch (Exception e) { return null; }
    }

    void ensureAppFile() {
        String asset = assetApp();
        String current = readFile(appFile());
        if (current == null || versionOf(asset) > versionOf(current)) {
            if (current != null) writeFile(backupFile(), current);
            if (asset != null) writeFile(appFile(), asset);
        }
    }

    void loadApp() {
        web.loadUrl("file://" + appFile().getAbsolutePath());
    }

    void checkForUpdate() {
        if (UPDATE_URL.contains("__" + "REPO" + "__")) return;
        new Thread(() -> {
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(UPDATE_URL + "?t=" + System.currentTimeMillis()).openConnection();
                c.setConnectTimeout(10000);
                c.setReadTimeout(20000);
                if (c.getResponseCode() != 200) return;
                String remote = readStream(c.getInputStream());
                String current = readFile(appFile());
                if (!remote.contains("POUPOUS_APP")) return;
                if (versionOf(remote) > versionOf(current)) {
                    if (current != null) writeFile(backupFile(), current);
                    if (writeFile(appFile(), remote)) {
                        prefs.edit().putBoolean("upgradePending", true).apply();
                        main.post(() -> {
                            Toast.makeText(this, "Poupous a été mis à jour", Toast.LENGTH_SHORT).show();
                            loadApp();
                        });
                    }
                }
            } catch (Exception ignored) {
            }
        }).start();
    }

    // Si une nouvelle version ne démarre pas, on remet la précédente.
    void checkStartedAfterUpgrade() {
        if (!prefs.getBoolean("upgradePending", false)) return;
        main.postDelayed(() -> web.evaluateJavascript("!!window.__poupousOK", value -> {
            if ("true".equals(value)) {
                prefs.edit().putBoolean("upgradePending", false).apply();
            } else if (backupFile().exists()) {
                String backup = readFile(backupFile());
                prefs.edit().putBoolean("upgradePending", false).putBoolean("rolledBack", true).apply();
                if (backup != null && writeFile(appFile(), backup)) {
                    Toast.makeText(this, "La nouvelle version ne démarrait pas : retour à la précédente", Toast.LENGTH_LONG).show();
                    loadApp();
                }
            }
        }), 7000);
    }

    // ------------------------------------------------------------------ position GPS

    String pendingPosId;

    void sendPos(String id, Location l) {
        try {
            JSONObject o = new JSONObject();
            if (l == null) {
                o.put("erreur", "position introuvable");
            } else {
                o.put("lat", l.getLatitude());
                o.put("lon", l.getLongitude());
                o.put("vitesse", l.getSpeed());
                o.put("precision", l.getAccuracy());
            }
            js("window.__posDone && window.__posDone(" + q(id) + "," + q(o.toString()) + ")");
        } catch (Exception e) {
            sendPosErr(id, "erreur interne");
        }
    }

    void sendPosErr(String id, String message) {
        try {
            JSONObject o = new JSONObject();
            o.put("erreur", message);
            js("window.__posDone && window.__posDone(" + q(id) + "," + q(o.toString()) + ")");
        } catch (Exception e) {
            js("window.__posDone && window.__posDone(" + q(id) + ",'{}')");
        }
    }

    void requestPosition(final String id) {
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED
                && checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            pendingPosId = id;
            requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, 3);
            return;
        }
        final LocationManager lm = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        if (lm == null) {
            sendPosErr(id, "service de localisation indisponible");
            return;
        }
        Location recent = null;
        try {
            for (String provider : lm.getProviders(true)) {
                Location l = lm.getLastKnownLocation(provider);
                if (l == null) continue;
                if (recent == null || l.getTime() > recent.getTime()) recent = l;
            }
        } catch (SecurityException e) {
            sendPosErr(id, "autorisation de localisation refusée");
            return;
        }
        if (recent != null && System.currentTimeMillis() - recent.getTime() < 120000) {
            sendPos(id, recent);
            return;
        }
        final Location connue = recent;
        String provider = null;
        try {
            if (lm.isProviderEnabled(LocationManager.GPS_PROVIDER)) provider = LocationManager.GPS_PROVIDER;
            else if (lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) provider = LocationManager.NETWORK_PROVIDER;
        } catch (Exception e) {
            provider = null;
        }
        if (provider == null) {
            if (connue != null) sendPos(id, connue);
            else sendPosErr(id, "la localisation est désactivée sur le téléphone");
            return;
        }
        final boolean[] fini = {false};
        final LocationListener[] tenu = new LocationListener[1];
        tenu[0] = new LocationListener() {
            @Override
            public void onLocationChanged(Location l) {
                if (fini[0]) return;
                fini[0] = true;
                try { lm.removeUpdates(tenu[0]); } catch (Exception e) {}
                sendPos(id, l);
            }

            @Override
            public void onStatusChanged(String p, int status, Bundle extras) {}

            @Override
            public void onProviderEnabled(String p) {}

            @Override
            public void onProviderDisabled(String p) {}
        };
        try {
            lm.requestLocationUpdates(provider, 0L, 0f, tenu[0], Looper.getMainLooper());
        } catch (SecurityException e) {
            sendPosErr(id, "autorisation de localisation refusée");
            return;
        }
        main.postDelayed(() -> {
            if (fini[0]) return;
            fini[0] = true;
            try { lm.removeUpdates(tenu[0]); } catch (Exception e) {}
            if (connue != null) sendPos(id, connue);
            else sendPosErr(id, "le GPS ne répond pas : sors ou approche-toi d'une fenêtre, puis redemande");
        }, 15000);
    }

    // ------------------------------------------------------------------ utilitaires

    void js(String code) {
        main.post(() -> web.evaluateJavascript(code, null));
    }

    static String q(String s) {
        return JSONObject.quote(s == null ? "" : s);
    }

    // ------------------------------------------------------------------ voix

    void applyVoice() {
        if (!ttsReady) return;
        tts.setSpeechRate(prefs.getFloat("rate", 1.0f));
        tts.setPitch(prefs.getFloat("pitch", 1.0f));
        String name = prefs.getString("voice", "");
        if (!name.isEmpty() && tts.getVoices() != null) {
            for (Voice v : tts.getVoices()) {
                if (v.getName().equals(name)) { tts.setVoice(v); return; }
            }
        }
        tts.setLanguage(Locale.FRANCE);
    }

    void ttsFinished(String id) {
        if (id != null && !id.endsWith("_part")) js("window.__ttsDone && window.__ttsDone(" + q(id) + ")");
    }

    // ------------------------------------------------------------------ écoute

    // ------------------------------------------------------------------ capture micro maison (remplace SpeechRecognizer)

    static byte[] wav(byte[] pcm, int rate) {
        int n = pcm.length;
        byte[] h = new byte[44];
        byte[] riff = "RIFF".getBytes(), wave = "WAVEfmt ".getBytes(), data = "data".getBytes();
        System.arraycopy(riff, 0, h, 0, 4);
        int t = 36 + n; h[4] = (byte) t; h[5] = (byte) (t >> 8); h[6] = (byte) (t >> 16); h[7] = (byte) (t >> 24);
        System.arraycopy(wave, 0, h, 8, 8);
        h[16] = 16; h[20] = 1; h[22] = 1;
        h[24] = (byte) rate; h[25] = (byte) (rate >> 8); h[26] = (byte) (rate >> 16); h[27] = (byte) (rate >> 24);
        int br = rate * 2; h[28] = (byte) br; h[29] = (byte) (br >> 8); h[30] = (byte) (br >> 16); h[31] = (byte) (br >> 24);
        h[32] = 2; h[34] = 16;
        System.arraycopy(data, 0, h, 36, 4);
        h[40] = (byte) n; h[41] = (byte) (n >> 8); h[42] = (byte) (n >> 16); h[43] = (byte) (n >> 24);
        byte[] out = new byte[44 + n];
        System.arraycopy(h, 0, out, 0, 44);
        System.arraycopy(pcm, 0, out, 44, n);
        return out;
    }

    void captureEnd(String id, byte[] pcm, String err) {
        String b64 = "";
        if (pcm != null) b64 = Base64.encodeToString(wav(pcm, 16000), Base64.NO_WRAP);
        js("window.__captureDone && window.__captureDone(" + q(id) + "," + q(b64) + "," + q(err) + ")");
    }

    void startCapture(String id, int timeoutMs) {
        capCancel = true; capStop = true;
        Thread old = capThread;
        if (old != null) { try { old.join(600); } catch (InterruptedException ignored) { } }
        capCancel = false; capStop = false;
        capThread = new Thread(() -> runCapture(id, timeoutMs), "poupous-capture");
        capThread.start();
    }

    // Écoute le micro, détecte le début et la fin d'une phrase, renvoie un WAV 16 kHz.
    void runCapture(String id, int timeoutMs) {
        final int rate = 16000, frame = 320; // 20 ms
        AudioRecord rec = null;
        try {
            int min = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            rec = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, rate, AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT, Math.max(min, frame * 2 * 16));
            if (rec.getState() != AudioRecord.STATE_INITIALIZED) { captureEnd(id, null, "error-micro"); return; }
            rec.startRecording();
            short[] buf = new short[frame];
            ArrayList<short[]> pre = new ArrayList<>();
            ByteArrayOutputStream pcm = new ByteArrayOutputStream();
            double floor = 200;
            boolean speaking = false;
            int loudRun = 0, quiet = 0, voiced = 0, frames = 0;
            long t0 = System.currentTimeMillis();
            while (!capStop) {
                int n = rec.read(buf, 0, frame);
                if (n <= 0) { captureEnd(id, null, "error-micro"); return; }
                double sum = 0;
                for (int i = 0; i < n; i++) sum += (double) buf[i] * buf[i];
                double rms = Math.sqrt(sum / n);
                double seuil = Math.max(floor * 2.6, floor + 350);
                boolean loud = rms > seuil;
                if (!speaking) {
                    floor = Math.min(3000, Math.max(80, floor * 0.96 + rms * 0.04));
                    short[] copy = new short[n]; System.arraycopy(buf, 0, copy, 0, n);
                    pre.add(copy); if (pre.size() > 12) pre.remove(0);
                    loudRun = loud ? loudRun + 1 : 0;
                    if (loudRun >= 4) {
                        speaking = true; quiet = 0; voiced = 0; frames = 0;
                        for (short[] s : pre) for (short v : s) { pcm.write(v & 0xff); pcm.write((v >> 8) & 0xff); }
                        pre.clear();
                        js("window.__listenReady && window.__listenReady()");
                    } else if (System.currentTimeMillis() - t0 > timeoutMs) {
                        captureEnd(id, null, "no-speech"); return;
                    }
                } else {
                    for (int i = 0; i < n; i++) { pcm.write(buf[i] & 0xff); pcm.write((buf[i] >> 8) & 0xff); }
                    frames++;
                    if (loud) { voiced++; quiet = 0; } else quiet++;
                    if (quiet >= 42 || frames >= 900) break; // 0,85 s de silence ou 18 s max
                }
            }
            if (capCancel) { captureEnd(id, null, "aborted"); return; }
            if (!speaking || voiced < 12) { captureEnd(id, null, capStop && !speaking ? "aborted" : "no-speech"); return; }
            captureEnd(id, pcm.toByteArray(), "");
        } catch (SecurityException e) {
            captureEnd(id, null, "not-allowed");
        } catch (Exception e) {
            captureEnd(id, null, "error-" + e.getClass().getSimpleName());
        } finally {
            if (rec != null) { try { rec.stop(); } catch (Exception ignored) { } rec.release(); }
        }
    }

    void startListening(String id) {
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            js("window.__listenDone && window.__listenDone(" + q(id) + ",'','unsupported')");
            return;
        }
        if (recognizer != null) recognizer.destroy();
        recognizer = SpeechRecognizer.createSpeechRecognizer(this);
        recognizer.setRecognitionListener(new RecognitionListener() {
            boolean finished = false;

            void finish(String text, String err) {
                if (finished) return;
                finished = true;
                js("window.__listenDone && window.__listenDone(" + q(id) + "," + q(text) + "," + q(err) + ")");
            }

            @Override public void onReadyForSpeech(Bundle params) { js("window.__listenReady && window.__listenReady()"); }
            @Override public void onBeginningOfSpeech() { }
            @Override public void onRmsChanged(float rmsdB) { }
            @Override public void onBufferReceived(byte[] buffer) { }
            @Override public void onEndOfSpeech() { }
            @Override public void onEvent(int eventType, Bundle params) { }

            @Override
            public void onPartialResults(Bundle b) {
                ArrayList<String> r = b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                if (r != null && !r.isEmpty()) js("window.__listenPartial && window.__listenPartial(" + q(r.get(0)) + ")");
            }

            @Override
            public void onResults(Bundle b) {
                ArrayList<String> r = b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                finish(r != null && !r.isEmpty() ? r.get(0) : "", "");
            }

            @Override
            public void onError(int code) {
                String err;
                if (code == SpeechRecognizer.ERROR_NO_MATCH || code == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) err = "no-speech";
                else if (code == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS) err = "not-allowed";
                else if (code == SpeechRecognizer.ERROR_CLIENT) err = "aborted";
                else err = "error-" + code;
                finish("", err);
            }
        });
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "fr-FR");
        intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        recognizer.startListening(intent);
    }

    // ------------------------------------------------------------------ actions sur le téléphone

    static String simplify(String s) {
        if (s == null) return "";
        String n = Normalizer.normalize(s, Normalizer.Form.NFD).replaceAll("\\p{M}", "");
        return n.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]+", " ").trim();
    }

    // Lance une activité sur le fil principal et renvoie "ok" ou la raison de l'échec.
    String launch(Intent intent) {
        FutureTask<String> task = new FutureTask<>(() -> {
            try {
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(intent);
                return "ok";
            } catch (Exception e) {
                return "impossible : aucune appli ne peut faire cette action (" + e.getClass().getSimpleName() + ")";
            }
        });
        main.post(task);
        try {
            return task.get(5, TimeUnit.SECONDS);
        } catch (Exception e) {
            return "erreur : " + e.getMessage();
        }
    }

    void searchContacts(String id, String query) {
        new Thread(() -> {
            JSONArray out = new JSONArray();
            try {
                String q = simplify(query);
                Cursor c = getContentResolver().query(
                        ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                        new String[]{ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME, ContactsContract.CommonDataKinds.Phone.NUMBER},
                        null, null, null);
                if (c != null) {
                    ArrayList<String> seen = new ArrayList<>();
                    while (c.moveToNext() && out.length() < 8) {
                        String name = c.getString(0);
                        String number = c.getString(1);
                        String sn = simplify(name);
                        boolean match = !q.isEmpty() && (sn.contains(q) || q.contains(sn));
                        if (!match && !q.isEmpty()) {
                            for (String part : q.split(" ")) {
                                if (part.length() >= 3 && sn.contains(part)) { match = true; break; }
                            }
                        }
                        String key = sn + "|" + (number == null ? "" : number.replaceAll("[^0-9+]", ""));
                        if (match && !seen.contains(key)) {
                            seen.add(key);
                            JSONObject o = new JSONObject();
                            o.put("nom", name);
                            o.put("numero", number);
                            out.put(o);
                        }
                    }
                    c.close();
                }
            } catch (Exception e) {
                js("window.__contactsDone && window.__contactsDone(" + q(id) + "," + q("erreur : " + e.getMessage()) + ")");
                return;
            }
            js("window.__contactsDone && window.__contactsDone(" + q(id) + "," + q(out.toString()) + ")");
        }).start();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        boolean granted = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
        if (requestCode == 2 && pendingContactId != null) {
            String id = pendingContactId, query = pendingContactQuery;
            pendingContactId = null;
            pendingContactQuery = null;
            if (granted) searchContacts(id, query);
            else js("window.__contactsDone && window.__contactsDone(" + q(id) + "," + q("refusé : l'utilisateur n'a pas autorisé l'accès aux contacts") + ")");
            return;
        }
        if (requestCode == 3 && pendingPosId != null) {
            String pid = pendingPosId;
            pendingPosId = null;
            if (granted) requestPosition(pid);
            else sendPosErr(pid, "tu n'as pas autorisé la localisation");
            return;
        }
        if (requestCode == 6 && pendingCaptureId != null) {
            String cid = pendingCaptureId;
            pendingCaptureId = null;
            if (granted) startCapture(cid, pendingCaptureMs);
            else js("window.__captureDone && window.__captureDone(" + q(cid) + ",'','not-allowed')");
            return;
        }
        if (requestCode != 1 || pendingListenId == null) return;
        String id = pendingListenId;
        pendingListenId = null;
        if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) startListening(id);
        else js("window.__listenDone && window.__listenDone(" + q(id) + ",'','not-allowed')");
    }

    // ------------------------------------------------------------------ pont JavaScript

    class Bridge {

        @JavascriptInterface
        public boolean hasKey() {
            return !prefs.getString("apiKey", "").isEmpty();
        }

        @JavascriptInterface
        public void setKey(String key) {
            prefs.edit().putString("apiKey", key == null ? "" : key.trim()).apply();
        }

        @JavascriptInterface
        public String get(String name) {
            return prefs.getString("data_" + name, "");
        }

        @JavascriptInterface
        public void set(String name, String value) {
            prefs.edit().putString("data_" + name, value).apply();
        }

        @JavascriptInterface
        public int appVersion() {
            return versionOf(readFile(appFile()));
        }

        @JavascriptInterface
        public boolean wasRolledBack() {
            boolean r = prefs.getBoolean("rolledBack", false);
            if (r) prefs.edit().putBoolean("rolledBack", false).apply();
            return r;
        }

        @JavascriptInterface
        public void claude(String id, String body) {
            new Thread(() -> {
                int status = 0;
                String text;
                try {
                    HttpURLConnection c = (HttpURLConnection) new URL(API_URL).openConnection();
                    c.setRequestMethod("POST");
                    c.setConnectTimeout(20000);
                    c.setReadTimeout(600000);
                    c.setDoOutput(true);
                    c.setRequestProperty("content-type", "application/json");
                    c.setRequestProperty("anthropic-version", "2023-06-01");
                    c.setRequestProperty("x-api-key", prefs.getString("apiKey", ""));
                    OutputStream out = c.getOutputStream();
                    out.write(body.getBytes(StandardCharsets.UTF_8));
                    out.close();
                    status = c.getResponseCode();
                    InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
                    text = in == null ? "" : readStream(in);
                } catch (Exception e) {
                    text = "network: " + e.getMessage();
                }
                js("window.__claudeDone && window.__claudeDone(" + q(id) + "," + status + "," + q(text) + ")");
            }).start();
        }

        @JavascriptInterface
        public void speak(String id, String text) {
            if (!ttsReady || text == null || text.trim().isEmpty()) {
                ttsFinished(id);
                return;
            }
            int max = Math.max(500, TextToSpeech.getMaxSpeechInputLength() - 100);
            ArrayList<String> parts = new ArrayList<>();
            String rest = text;
            while (rest.length() > max) {
                int cut = rest.lastIndexOf(". ", max);
                if (cut < max / 2) cut = max;
                parts.add(rest.substring(0, cut + 1));
                rest = rest.substring(cut + 1);
            }
            parts.add(rest);
            for (int i = 0; i < parts.size(); i++) {
                String uid = i == parts.size() - 1 ? id : id + "_" + i + "_part";
                tts.speak(parts.get(i), TextToSpeech.QUEUE_ADD, null, uid);
            }
        }

        @JavascriptInterface
        public void stopSpeaking() {
            if (tts != null) tts.stop();
        }

        @JavascriptInterface
        public void setVoice(float rate, float pitch, String name) {
            prefs.edit().putFloat("rate", rate).putFloat("pitch", pitch).putString("voice", name == null ? "" : name).apply();
            main.post(MainActivity.this::applyVoice);
        }

        @JavascriptInterface
        public String voices() {
            JSONArray arr = new JSONArray();
            try {
                if (ttsReady && tts.getVoices() != null) {
                    for (Voice v : tts.getVoices()) {
                        if (v.getLocale() != null && "fr".equals(v.getLocale().getLanguage())) arr.put(v.getName());
                    }
                }
            } catch (Exception ignored) {
            }
            return arr.toString();
        }

        @JavascriptInterface
        public void listen(String id) {
            main.post(() -> {
                if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                    pendingListenId = id;
                    requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, 1);
                } else {
                    startListening(id);
                }
            });
        }

        @JavascriptInterface
        public void capture(String id, int timeoutMs) {
            final int t = timeoutMs < 3000 ? 3000 : Math.min(timeoutMs, 120000);
            main.post(() -> {
                if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                    pendingCaptureId = id; pendingCaptureMs = t;
                    requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, 6);
                } else {
                    startCapture(id, t);
                }
            });
        }

        @JavascriptInterface
        public void stopListening() {
            capStop = true;
            main.post(() -> { if (recognizer != null) recognizer.stopListening(); });
        }

        @JavascriptInterface
        public void cancelListening() {
            capCancel = true; capStop = true;
            main.post(() -> { if (recognizer != null) recognizer.cancel(); });
        }

        @JavascriptInterface
        public String getApp() {
            String s = readFile(appFile());
            return s == null ? "" : s;
        }

        @JavascriptInterface
        public String saveApp(String html) {
            if (html == null || !html.contains("POUPOUS_APP")) return "invalid";
            String current = readFile(appFile());
            if (current != null) writeFile(backupFile(), current);
            if (!writeFile(appFile(), html)) return "write-failed";
            prefs.edit().putBoolean("upgradePending", true).apply();
            main.postDelayed(MainActivity.this::loadApp, 300);
            return "ok";
        }

        @JavascriptInterface
        public String restoreBackup() {
            String backup = readFile(backupFile());
            if (backup == null) return "none";
            String current = readFile(appFile());
            if (!writeFile(appFile(), backup)) return "write-failed";
            if (current != null) writeFile(backupFile(), current);
            main.postDelayed(MainActivity.this::loadApp, 300);
            return "ok";
        }

        @JavascriptInterface
        public int nativeVersion() {
            return 11;
        }

        // ---- mentions dans les notifications (WhatsApp, WhatsApp Business, SMS)

        @JavascriptInterface
        public boolean accesNotificationsActif() {
            String actives = Settings.Secure.getString(getContentResolver(), "enabled_notification_listeners");
            return actives != null && actives.contains(getPackageName());
        }

        @JavascriptInterface
        public void ouvrirAccesNotifications() {
            main.post(() -> {
                try {
                    startActivity(new Intent("android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS")
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                } catch (Exception ignored) {
                }
            });
        }

        @JavascriptInterface
        public void setMention(String nom) {
            prefs.edit().putString("mention", nom == null ? "" : nom.trim()).apply();
        }

        @JavascriptInterface
        public String getMention() {
            return prefs.getString("mention", "");
        }

        // ---- position GPS

        @JavascriptInterface
        public void position(String id) {
            main.post(() -> requestPosition(id));
        }

        // ---- fichiers

        @JavascriptInterface
        public String takeShared() {
            String s = sharedJson;
            sharedJson = null;
            return s == null ? "" : s;
        }

        @JavascriptInterface
        public String surveillerRoute(boolean actif) {
            try {
                if (!actif) {
                    stopService(new Intent(MainActivity.this, Route.class));
                    return "arrêtée";
                }
                if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
                    main.post(() -> requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION}, 3));
                    return "il me faut d'abord l'autorisation de localisation : accepte-la puis réessaie";
                }
                if (Build.VERSION.SDK_INT >= 29
                        && checkSelfPermission("android.permission.ACCESS_BACKGROUND_LOCATION") != PackageManager.PERMISSION_GRANTED) {
                    main.post(() -> requestPermissions(new String[]{"android.permission.ACCESS_BACKGROUND_LOCATION"}, 5));
                    return "il faut choisir « Toujours autoriser » pour la localisation, puis réessaie";
                }
                if (!notificationsAutorisees()) {
                    main.post(this::demanderNotificationsPont);
                    return "il faut autoriser les notifications, puis réessaie";
                }
                Intent i = new Intent(MainActivity.this, Route.class);
                if (Build.VERSION.SDK_INT >= 26) startForegroundService(i);
                else startService(i);
                return "ok";
            } catch (Exception e) {
                return "erreur : " + e.getMessage();
            }
        }

        void demanderNotificationsPont() {
            demanderNotifications();
        }

        @JavascriptInterface
        public String notifier(String titre, String texte) {
            try {
                preparerCanal();
                if (!notificationsAutorisees()) {
                    main.post(() -> demanderNotifications());
                    return "autorisation demandée : accepte-la puis redemande-moi";
                }
                final String t = titre, x = texte;
                main.post(() -> Rappel.montrer(MainActivity.this, t, x));
                return "ok";
            } catch (Exception e) {
                return "erreur : " + e.getMessage();
            }
        }

        @JavascriptInterface
        public String rappel(double dansSecondes, String titre, String texte) {
            try {
                preparerCanal();
                if (!notificationsAutorisees()) {
                    main.post(() -> demanderNotifications());
                    return "autorisation demandée : accepte-la puis redemande-moi";
                }
                long delai = (long) Math.max(5, dansSecondes) * 1000L;
                long quand = System.currentTimeMillis() + delai;
                Intent i = new Intent(MainActivity.this, Rappel.class);
                i.putExtra("titre", titre);
                i.putExtra("texte", texte);
                PendingIntent pi = PendingIntent.getBroadcast(MainActivity.this,
                        (int) (quand % 100000), i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                AlarmManager am = (AlarmManager) getSystemService(Context.ALARM_SERVICE);
                if (am == null) return "le service d'alarme est indisponible";
                if (Build.VERSION.SDK_INT >= 23) am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, quand, pi);
                else am.set(AlarmManager.RTC_WAKEUP, quand, pi);
                return "ok";
            } catch (Exception e) {
                return "erreur : " + e.getMessage();
            }
        }

        @JavascriptInterface
        public void telecharger(String id, String url, String name, String mime, boolean share) {
            new Thread(() -> {
                String res;
                try {
                    String fileName = safeName(name);
                    String type = mime == null || mime.isEmpty() ? "application/octet-stream" : mime;
                    HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                    c.setConnectTimeout(20000);
                    c.setReadTimeout(180000);
                    c.setRequestProperty("User-Agent", "Poupous");
                    int status = c.getResponseCode();
                    if (status >= 400) {
                        js("window.__telechargeDone && window.__telechargeDone(" + q(id) + "," + q("téléchargement refusé (" + status + ")") + ")");
                        return;
                    }
                    File f = new File(shareDir(), fileName);
                    InputStream in = c.getInputStream();
                    OutputStream out = new FileOutputStream(f);
                    byte[] buf = new byte[16384];
                    int n;
                    long total = 0;
                    while ((n = in.read(buf)) > 0) {
                        out.write(buf, 0, n);
                        total += n;
                        if (total > 200L * 1024L * 1024L) break;
                    }
                    out.close();
                    in.close();

                    String where = "dans l'appli";
                    if (Build.VERSION.SDK_INT >= 29) {
                        ContentValues v = new ContentValues();
                        v.put(MediaStore.MediaColumns.DISPLAY_NAME, fileName);
                        v.put(MediaStore.MediaColumns.MIME_TYPE, type);
                        v.put(MediaStore.MediaColumns.RELATIVE_PATH, "Download/Poupous");
                        Uri saved = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                        if (saved != null) {
                            OutputStream o = getContentResolver().openOutputStream(saved);
                            if (o != null) {
                                InputStream src = new FileInputStream(f);
                                while ((n = src.read(buf)) > 0) o.write(buf, 0, n);
                                src.close();
                                o.close();
                                where = "dans Téléchargements/Poupous";
                            }
                        }
                    }
                    res = "enregistré " + where;
                    if (share) {
                        final String type2 = type, fn = fileName, w = where;
                        final File ff = f;
                        main.post(() -> {
                            Intent send = new Intent(Intent.ACTION_SEND);
                            send.setType(type2);
                            send.putExtra(Intent.EXTRA_STREAM, FilesProvider.uriFor(ff));
                            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                            Intent chooser = Intent.createChooser(send, "Envoyer " + fn);
                            chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                            launch(chooser);
                            js("window.__telechargeDone && window.__telechargeDone(" + q(id) + "," + q("enregistré " + w + " et menu de partage ouvert") + ")");
                        });
                        return;
                    }
                } catch (Exception e) {
                    res = "erreur : " + e.getMessage();
                }
                js("window.__telechargeDone && window.__telechargeDone(" + q(id) + "," + q(res) + ")");
            }).start();
        }

        @JavascriptInterface
        public String saveFile(String name, String mime, String base64, boolean share) {
            try {
                byte[] bytes = Base64.decode(base64 == null ? "" : base64, Base64.DEFAULT);
                String fileName = safeName(name);
                String type = mime == null || mime.isEmpty() ? "application/octet-stream" : mime;
                File f = new File(shareDir(), fileName);
                OutputStream out = new FileOutputStream(f);
                out.write(bytes);
                out.close();

                String where = "dans l'appli";
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.MediaColumns.DISPLAY_NAME, fileName);
                    v.put(MediaStore.MediaColumns.MIME_TYPE, type);
                    v.put(MediaStore.MediaColumns.RELATIVE_PATH, "Download/Poupous");
                    Uri saved = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                    if (saved != null) {
                        OutputStream o = getContentResolver().openOutputStream(saved);
                        if (o != null) {
                            o.write(bytes);
                            o.close();
                            where = "dans Téléchargements/Poupous";
                        }
                    }
                }

                if (share) {
                    Intent send = new Intent(Intent.ACTION_SEND);
                    send.setType(type);
                    send.putExtra(Intent.EXTRA_STREAM, FilesProvider.uriFor(f));
                    send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    Intent chooser = Intent.createChooser(send, "Envoyer " + fileName);
                    chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    String r = launch(chooser);
                    if (!"ok".equals(r)) return "enregistré " + where + ", mais le partage a échoué : " + r;
                    return "enregistré " + where + " et menu de partage ouvert";
                }
                return "enregistré " + where;
            } catch (Exception e) {
                return "erreur : " + e.getMessage();
            }
        }

        // ---- GitHub

        @JavascriptInterface
        public boolean hasGithub() {
            return !prefs.getString("githubToken", "").isEmpty();
        }

        @JavascriptInterface
        public void setGithub(String token) {
            prefs.edit().putString("githubToken", token == null ? "" : token.trim()).apply();
        }

        @JavascriptInterface
        public String repo() {
            return REPO;
        }

        @JavascriptInterface
        public void http(String id, String method, String url, String headersJson, String body) {
            new Thread(() -> {
                int status = 0;
                String text;
                try {
                    HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                    c.setRequestMethod(method == null || method.isEmpty() ? "GET" : method);
                    c.setConnectTimeout(20000);
                    c.setReadTimeout(180000);
                    c.setRequestProperty("User-Agent", "Poupous");
                    if (headersJson != null && !headersJson.isEmpty()) {
                        JSONObject h = new JSONObject(headersJson);
                        Iterator<String> it = h.keys();
                        while (it.hasNext()) {
                            String k = it.next();
                            c.setRequestProperty(k, h.optString(k, ""));
                        }
                    }
                    if (body != null && !body.isEmpty()) {
                        c.setDoOutput(true);
                        if (c.getRequestProperty("Content-Type") == null) c.setRequestProperty("Content-Type", "application/json");
                        OutputStream out = c.getOutputStream();
                        out.write(body.getBytes(StandardCharsets.UTF_8));
                        out.close();
                    }
                    status = c.getResponseCode();
                    InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
                    text = in == null ? "" : readStream(in);
                } catch (Exception e) {
                    text = "network: " + e.getMessage();
                }
                if (text.length() > 3000000) text = "trop-gros";
                js("window.__httpDone && window.__httpDone(" + q(id) + "," + status + "," + q(text) + ")");
            }).start();
        }

        @JavascriptInterface
        public void github(String id, String method, String path, String body) {
            new Thread(() -> {
                int status = 0;
                String text;
                try {
                    String url = path.startsWith("https://") ? path : "https://api.github.com" + path;
                    HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                    c.setRequestMethod(method);
                    c.setConnectTimeout(20000);
                    c.setReadTimeout(120000);
                    c.setRequestProperty("Accept", "application/vnd.github+json");
                    c.setRequestProperty("X-GitHub-Api-Version", "2022-11-28");
                    c.setRequestProperty("User-Agent", "Poupous");
                    if (url.startsWith("https://api.github.com/")) {
                        c.setRequestProperty("Authorization", "Bearer " + prefs.getString("githubToken", ""));
                    }
                    if (body != null && !body.isEmpty()) {
                        c.setDoOutput(true);
                        c.setRequestProperty("Content-Type", "application/json");
                        OutputStream out = c.getOutputStream();
                        out.write(body.getBytes(StandardCharsets.UTF_8));
                        out.close();
                    }
                    status = c.getResponseCode();
                    InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
                    text = in == null ? "" : readStream(in);
                } catch (Exception e) {
                    text = "network: " + e.getMessage();
                }
                if (text.length() > 150000) text = text.substring(text.length() - 150000);
                js("window.__githubDone && window.__githubDone(" + q(id) + "," + status + "," + q(text) + ")");
            }).start();
        }

        // ---- code source de l'APK et reconstruction

        @JavascriptInterface
        public String sourceFiles() {
            JSONObject out = new JSONObject();
            try {
                collectSource(getAssets(), "source", out);
            } catch (Exception ignored) {
            }
            return out.toString();
        }

        @JavascriptInterface
        public String buildZipBase64(String filesJson) {
            try {
                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                ZipOutputStream zos = new ZipOutputStream(bos);
                JSONObject files = new JSONObject(filesJson);
                Iterator<String> keys = files.keys();
                while (keys.hasNext()) {
                    String k = keys.next();
                    if (k.endsWith(".keystore")) continue;
                    zos.putNextEntry(new ZipEntry(k));
                    zos.write(files.getString(k).getBytes(StandardCharsets.UTF_8));
                    zos.closeEntry();
                }
                zos.putNextEntry(new ZipEntry("app/poupous.keystore"));
                zos.write(readBytes(getAssets().open("source/app/poupous.keystore")));
                zos.closeEntry();
                zos.close();
                return Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP);
            } catch (Exception e) {
                return "erreur : " + e.getMessage();
            }
        }

        @JavascriptInterface
        public void downloadAndInstall(String id, String url) {
            new Thread(() -> {
                try {
                    File apk = new File(shareDir(), "poupous-mise-a-jour.apk");
                    HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                    c.setInstanceFollowRedirects(true);
                    c.setConnectTimeout(20000);
                    c.setReadTimeout(120000);
                    c.setRequestProperty("User-Agent", "Poupous");
                    int st = c.getResponseCode();
                    if (st != 200) throw new Exception("HTTP " + st);
                    InputStream in = c.getInputStream();
                    OutputStream out = new FileOutputStream(apk);
                    byte[] buf = new byte[65536];
                    int n;
                    while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                    out.close();
                    in.close();
                    main.post(() -> installApk(id, apk));
                } catch (Exception e) {
                    js("window.__installDone && window.__installDone(" + q(id) + "," + q("erreur : " + e.getMessage()) + ")");
                }
            }).start();
        }

        @JavascriptInterface
        public void installDownloaded(String id) {
            File apk = new File(shareDir(), "poupous-mise-a-jour.apk");
            main.post(() -> {
                if (apk.exists()) installApk(id, apk);
                else js("window.__installDone && window.__installDone(" + q(id) + ",'absent')");
            });
        }

        @JavascriptInterface
        public void findContact(String id, String query) {
            main.post(() -> {
                if (checkSelfPermission(Manifest.permission.READ_CONTACTS) != PackageManager.PERMISSION_GRANTED) {
                    pendingContactId = id;
                    pendingContactQuery = query;
                    requestPermissions(new String[]{Manifest.permission.READ_CONTACTS}, 2);
                } else {
                    searchContacts(id, query);
                }
            });
        }

        @JavascriptInterface
        public String dial(String number) {
            return launch(new Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + Uri.encode(number == null ? "" : number))));
        }

        @JavascriptInterface
        public String sms(String number, String text) {
            Intent i = new Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:" + Uri.encode(number == null ? "" : number)));
            i.putExtra("sms_body", text == null ? "" : text);
            return launch(i);
        }

        @JavascriptInterface
        public String email(String to, String subject, String body) {
            Intent i = new Intent(Intent.ACTION_SENDTO, Uri.parse("mailto:" + Uri.encode(to == null ? "" : to)));
            if (to != null && !to.isEmpty()) i.putExtra(Intent.EXTRA_EMAIL, new String[]{to});
            i.putExtra(Intent.EXTRA_SUBJECT, subject == null ? "" : subject);
            i.putExtra(Intent.EXTRA_TEXT, body == null ? "" : body);
            return launch(i);
        }

        @JavascriptInterface
        public String alarm(int hour, int minute, String label) {
            Intent i = new Intent(AlarmClock.ACTION_SET_ALARM);
            i.putExtra(AlarmClock.EXTRA_HOUR, hour);
            i.putExtra(AlarmClock.EXTRA_MINUTES, minute);
            i.putExtra(AlarmClock.EXTRA_MESSAGE, label == null || label.isEmpty() ? "Poupous" : label);
            i.putExtra(AlarmClock.EXTRA_SKIP_UI, true);
            return launch(i);
        }

        @JavascriptInterface
        public String timer(int seconds, String label) {
            Intent i = new Intent(AlarmClock.ACTION_SET_TIMER);
            i.putExtra(AlarmClock.EXTRA_LENGTH, seconds);
            i.putExtra(AlarmClock.EXTRA_MESSAGE, label == null || label.isEmpty() ? "Poupous" : label);
            i.putExtra(AlarmClock.EXTRA_SKIP_UI, true);
            return launch(i);
        }

        @JavascriptInterface
        public String navigate(String destination) {
            Uri uri = Uri.parse("https://www.google.com/maps/dir/?api=1&destination=" + Uri.encode(destination == null ? "" : destination));
            return launch(new Intent(Intent.ACTION_VIEW, uri));
        }

        @JavascriptInterface
        public String openApp(String name) {
            PackageManager pm = getPackageManager();
            Intent query = new Intent(Intent.ACTION_MAIN);
            query.addCategory(Intent.CATEGORY_LAUNCHER);
            List<ResolveInfo> apps = pm.queryIntentActivities(query, 0);
            String wanted = simplify(name);
            ResolveInfo best = null;
            int bestScore = 0;
            for (ResolveInfo ri : apps) {
                String label = simplify(String.valueOf(ri.loadLabel(pm)));
                int score = 0;
                if (label.equals(wanted)) score = 3;
                else if (label.startsWith(wanted) || wanted.startsWith(label)) score = 2;
                else if (!wanted.isEmpty() && label.contains(wanted)) score = 1;
                if (score > bestScore) { bestScore = score; best = ri; }
            }
            if (best == null) return "introuvable : aucune appli installée ne s'appelle " + name;
            Intent launch = pm.getLaunchIntentForPackage(best.activityInfo.packageName);
            if (launch == null) return "impossible d'ouvrir " + best.loadLabel(pm);
            String r = MainActivity.this.launch(launch);
            return "ok".equals(r) ? "ouvert : " + best.loadLabel(pm) : r;
        }

        @JavascriptInterface
        public String veille(boolean actif) {
            try {
                prefs.edit().putBoolean("veille", actif).apply();
                Intent it = new Intent(MainActivity.this, Veille.class);
                if (actif) startForegroundService(it); else stopService(it);
                return "ok";
            } catch (Exception e) {
                return "erreur : " + e.getMessage();
            }
        }

        @JavascriptInterface
        public boolean veilleActive() {
            return prefs.getBoolean("veille", false);
        }

        @JavascriptInterface
        public boolean batterieLibre() {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            return pm != null && pm.isIgnoringBatteryOptimizations(getPackageName());
        }

        @JavascriptInterface
        public void reglerBatterie() {
            main.post(() -> {
                try {
                    startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                } catch (Exception ignored) {
                }
            });
        }

        @JavascriptInterface
        public void quit() {
            main.post(MainActivity.this::finish);
        }
    }
}
