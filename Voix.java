package com.poupous.app;

/**
 * Signature vocale simple : moyenne des coefficients MFCC (timbre) + hauteur de voix (F0 médiane).
 * Entrée : WAV 16 kHz mono 16 bits. Sortie : 20 nombres, ou null s'il y a trop peu de voix.
 */
final class Voix {
    static final int RATE = 16000, WIN = 400, HOP = 160, NFFT = 512, NMEL = 26, NC = 20;

    static double[] vecteur(byte[] wav) {
        if (wav == null || wav.length < 44 + 2 * RATE / 2) return null; // au moins 0,5 s
        int n = (wav.length - 44) / 2;
        double[] x = new double[n];
        for (int i = 0; i < n; i++) {
            int lo = wav[44 + 2 * i] & 0xff, hi = wav[45 + 2 * i];
            x[i] = (short) ((hi << 8) | lo);
        }
        for (int i = n - 1; i > 0; i--) x[i] -= 0.97 * x[i - 1];
        int nf = (n - WIN) / HOP + 1;
        if (nf < 50) return null;
        double[] energie = new double[nf];
        double emax = -1e9, emin = 1e9;
        for (int f = 0; f < nf; f++) {
            double s = 0;
            for (int i = 0; i < WIN; i++) { double v = x[f * HOP + i]; s += v * v; }
            energie[f] = 10 * Math.log10(s / WIN + 1e-3);
            emax = Math.max(emax, energie[f]); emin = Math.min(emin, energie[f]);
        }
        double seuil = emin + 0.45 * (emax - emin);
        double[] fen = new double[WIN];
        for (int i = 0; i < WIN; i++) fen[i] = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (WIN - 1));
        double[][] banc = bancMel();
        double[][] cos = new double[NC][NMEL];
        for (int k = 0; k < NC; k++)
            for (int m = 0; m < NMEL; m++)
                cos[k][m] = Math.cos(Math.PI * k * (m + 0.5) / NMEL) * (k == 0 ? Math.sqrt(1.0 / NMEL) : Math.sqrt(2.0 / NMEL));
        double[] somme = new double[NC];
        int gardes = 0;
        double[] re = new double[NFFT], im = new double[NFFT], mel = new double[NMEL];
        for (int f = 0; f < nf; f++) {
            if (energie[f] < seuil) continue;
            java.util.Arrays.fill(re, 0); java.util.Arrays.fill(im, 0);
            for (int i = 0; i < WIN; i++) re[i] = x[f * HOP + i] * fen[i];
            fft(re, im);
            for (int m = 0; m < NMEL; m++) {
                double e = 0;
                for (int b = 0; b <= NFFT / 2; b++) e += banc[m][b] * (re[b] * re[b] + im[b] * im[b]);
                mel[m] = Math.log(e + 1e-6);
            }
            for (int k = 1; k < NC; k++) {
                double c = 0;
                for (int m = 0; m < NMEL; m++) c += cos[k][m] * mel[m];
                somme[k] += c;
            }
            gardes++;
        }
        if (gardes < 60) return null; // moins de 0,6 s de voix nette
        double[] v = new double[NC];
        for (int k = 1; k < NC; k++) v[k - 1] = somme[k] / gardes;
        v[NC - 1] = Math.log(f0(wav, n, energie, seuil)) / Math.log(2);
        return v;
    }

    // Hauteur médiane (Hz) par autocorrélation sur les trames de voix ; 150 par défaut.
    static double f0(byte[] wav, int n, double[] energie, double seuil) {
        double[] s = new double[n];
        for (int i = 0; i < n; i++) s[i] = (short) (((wav[45 + 2 * i]) << 8) | (wav[44 + 2 * i] & 0xff));
        java.util.ArrayList<Double> l = new java.util.ArrayList<>();
        int lmin = RATE / 400, lmax = RATE / 65, w = 640;
        for (int f = 0; f < energie.length; f += 2) {
            if (energie[f] < seuil) continue;
            int d = f * HOP;
            if (d + w + lmax >= n) break;
            double e0 = 0;
            for (int i = 0; i < w; i++) e0 += s[d + i] * s[d + i];
            if (e0 < 1) continue;
            double best = 0; int bl = 0;
            for (int lag = lmin; lag <= lmax; lag++) {
                double c = 0, e1 = 0;
                for (int i = 0; i < w; i++) { c += s[d + i] * s[d + i + lag]; e1 += s[d + i + lag] * s[d + i + lag]; }
                double r = c / Math.sqrt(e0 * e1 + 1e-9);
                if (r > best) { best = r; bl = lag; }
            }
            if (best > 0.5 && bl > 0) l.add((double) RATE / bl);
        }
        if (l.size() < 8) return 150;
        java.util.Collections.sort(l);
        return l.get(l.size() / 2);
    }

    static double[][] bancMel() {
        double fmin = 100, fmax = 7000;
        double mmin = 2595 * Math.log10(1 + fmin / 700), mmax = 2595 * Math.log10(1 + fmax / 700);
        double[] pts = new double[NMEL + 2];
        for (int i = 0; i < pts.length; i++) {
            double m = mmin + (mmax - mmin) * i / (NMEL + 1);
            double hz = 700 * (Math.pow(10, m / 2595) - 1);
            pts[i] = hz * NFFT / RATE;
        }
        double[][] b = new double[NMEL][NFFT / 2 + 1];
        for (int m = 0; m < NMEL; m++)
            for (int k = 0; k <= NFFT / 2; k++) {
                if (k > pts[m] && k <= pts[m + 1]) b[m][k] = (k - pts[m]) / (pts[m + 1] - pts[m]);
                else if (k > pts[m + 1] && k < pts[m + 2]) b[m][k] = (pts[m + 2] - k) / (pts[m + 2] - pts[m + 1]);
            }
        return b;
    }

    static void fft(double[] re, double[] im) {
        int n = re.length;
        for (int i = 1, j = 0; i < n; i++) {
            int bit = n >> 1;
            for (; (j & bit) != 0; bit >>= 1) j ^= bit;
            j ^= bit;
            if (i < j) { double t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
        }
        for (int len = 2; len <= n; len <<= 1) {
            double ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
            for (int i = 0; i < n; i += len) {
                double cr = 1, ci = 0;
                for (int j = 0; j < len / 2; j++) {
                    double ur = re[i + j], ui = im[i + j];
                    double vr = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci;
                    double vi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
                    re[i + j] = ur + vr; im[i + j] = ui + vi;
                    re[i + j + len / 2] = ur - vr; im[i + j + len / 2] = ui - vi;
                    double t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
                }
            }
        }
    }
}
