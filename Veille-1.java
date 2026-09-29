package com.poupous.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

/**
 * Garde Poupous connecté : service de premier plan avec notification permanente,
 * processeur maintenu éveillé et WiFi maintenu actif, même écran éteint.
 */
public class Veille extends Service {

    static final String CANAL = "poupous-veille";
    static final int ID = 4243;
    static final String STOP = "com.poupous.app.STOP_VEILLE";

    PowerManager.WakeLock cpu;
    WifiManager.WifiLock wifi;

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onCreate() {
        super.onCreate();
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) {
                NotificationChannel c = new NotificationChannel(CANAL, "Poupous reste connecté", NotificationManager.IMPORTANCE_LOW);
                c.setDescription("Affichée tant que Poupous reste connecté écran éteint");
                nm.createNotificationChannel(c);
            }
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && STOP.equals(intent.getAction())) {
            getSharedPreferences("poupous", MODE_PRIVATE).edit().putBoolean("veille", false).apply();
            stopSelf();
            return START_NOT_STICKY;
        }
        Intent ouvrir = new Intent(this, MainActivity.class);
        ouvrir.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, ouvrir,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Intent arret = new Intent(this, Veille.class).setAction(STOP);
        PendingIntent pa = PendingIntent.getService(this, 1, arret,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification n = new Notification.Builder(this, CANAL)
                .setSmallIcon(android.R.drawable.ic_btn_speak_now)
                .setContentTitle("Poupous est connecté")
                .setContentText("Touche pour ouvrir. Connexion maintenue écran éteint.")
                .setOngoing(true)
                .setContentIntent(pi)
                .addAction(new Notification.Action.Builder(null, "Arrêter", pa).build())
                .build();
        if (Build.VERSION.SDK_INT >= 34) {
            int type = ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE;
            if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) == android.content.pm.PackageManager.PERMISSION_GRANTED)
                type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
            startForeground(ID, n, type);
        } else startForeground(ID, n);
        verrouiller();
        return START_STICKY;
    }

    void verrouiller() {
        try {
            if (cpu == null) {
                PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                cpu = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "poupous:veille");
                cpu.setReferenceCounted(false);
            }
            if (!cpu.isHeld()) cpu.acquire();
            if (wifi == null) {
                WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                int mode = Build.VERSION.SDK_INT >= 29 ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY : WifiManager.WIFI_MODE_FULL_HIGH_PERF;
                wifi = wm.createWifiLock(mode, "poupous:wifi");
                wifi.setReferenceCounted(false);
            }
            if (!wifi.isHeld()) wifi.acquire();
        } catch (Exception ignored) {
        }
    }

    @Override
    public void onDestroy() {
        try { if (cpu != null && cpu.isHeld()) cpu.release(); } catch (Exception ignored) {}
        try { if (wifi != null && wifi.isHeld()) wifi.release(); } catch (Exception ignored) {}
        super.onDestroy();
    }
}
