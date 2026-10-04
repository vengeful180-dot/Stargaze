#!/usr/bin/env python3
"""Measure rendered audio: loudness, peaks, clipping, DC, silence, spectral balance, clicks.

usage: analyze.py file.wav [file2.wav ...] [--json out.json] [--png spectrogram.png] [--tracks render.json]
       [--skip 2.0]   seconds to ignore at the start (radio warm-up)

Needs numpy + scipy (+ matplotlib for --png). Integrated loudness follows ITU-R BS.1770-4
(K-weighting, 400 ms blocks with 75% overlap, -70 LUFS absolute and -10 LU relative gates).
"""
import json
import math
import sys

import numpy as np
from scipy import signal
from scipy.io import wavfile
from scipy.ndimage import median_filter


def load(path):
    sr, x = wavfile.read(path)
    if x.dtype == np.int16:
        x = x.astype(np.float64) / 32768.0
    elif x.dtype == np.int32:
        x = x.astype(np.float64) / 2147483648.0
    else:
        x = x.astype(np.float64)
    if x.ndim == 1:
        x = x[:, None]
    return sr, x


def k_weight_sos(sr):
    """BS.1770 K-weighting (pre-filter shelf + RLB high-pass) for any sample rate."""
    # stage 1: high shelf (+4 dB @ ~1.68 kHz), coefficients derived from the analog prototype
    f0 = 1681.974450955533
    G = 3.999843853973347
    Q = 0.7071752369554196
    K = math.tan(math.pi * f0 / sr)
    Vh = 10 ** (G / 20)
    Vb = Vh ** 0.4996667741545416
    a0 = 1 + K / Q + K * K
    b = [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0]
    a = [1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0]
    # stage 2: high-pass @ ~38 Hz
    f0 = 38.13547087602444
    Q = 0.5003270373238773
    K = math.tan(math.pi * f0 / sr)
    a0b = 1 + K / Q + K * K
    b2 = [1, -2, 1]
    a2 = [1, 2 * (K * K - 1) / a0b, (1 - K / Q + K * K) / a0b]
    return np.array([b + a, b2 + a2])


def lufs(x, sr):
    """Integrated loudness (LUFS) and short-term (3 s) loudness series."""
    sos = k_weight_sos(sr)
    y = signal.sosfilt(sos, x, axis=0)
    blk = int(0.4 * sr)
    hop = int(0.1 * sr)
    if len(y) < blk:
        return -np.inf, np.array([])
    n = 1 + (len(y) - blk) // hop
    # mean square per channel per block (channel weights 1.0 for L/R)
    cs = np.cumsum(np.concatenate([np.zeros((1, y.shape[1])), y ** 2]), axis=0)
    starts = np.arange(n) * hop
    ms = (cs[starts + blk] - cs[starts]) / blk
    z = ms.sum(axis=1)
    lk = -0.691 + 10 * np.log10(np.maximum(z, 1e-12))
    gated = z[lk > -70]
    if len(gated) == 0:
        return -np.inf, lk
    rel = -0.691 + 10 * np.log10(gated.mean()) - 10
    g2 = z[(lk > -70) & (lk > rel)]
    integ = -0.691 + 10 * np.log10(g2.mean()) if len(g2) else -np.inf
    # short-term 3 s
    stb = int(3 * sr)
    st = []
    for s0 in range(0, len(y) - stb, int(sr)):
        m = (cs[s0 + stb] - cs[s0]) / stb
        st.append(-0.691 + 10 * np.log10(max(m.sum(), 1e-12)))
    return integ, np.array(st)


def true_peak(x):
    up = signal.resample_poly(x, 4, 1, axis=0)
    return float(np.max(np.abs(up)))


def db(v):
    return 20 * math.log10(max(v, 1e-12))


BANDS = [(20, 60, 'sub'), (60, 150, 'bass'), (150, 400, 'lowmid'), (400, 1000, 'mid'), (1000, 2500, 'upmid'),
         (2500, 5000, 'presence'), (5000, 8000, 'brilliance'), (8000, 12000, 'air'), (12000, 24000, 'ultra')]


def spectral(x, sr):
    m = x.mean(axis=1)
    f, p = signal.welch(m, sr, nperseg=8192)
    tot = p[(f >= 20)].sum() + 1e-20
    out = {}
    for lo, hi, name in BANDS:
        sel = (f >= lo) & (f < min(hi, sr / 2))
        out[name] = round(10 * math.log10(p[sel].sum() / tot + 1e-12), 1)
    cen = float((f * p).sum() / (p.sum() + 1e-20))
    return out, cen


OCTAVES = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]


def octave_bands(x, sr):
    """Energy per octave band in dB relative to the loudest band (a tonal balance fingerprint)."""
    m = x.mean(axis=1)
    f, p = signal.welch(m, sr, nperseg=16384)
    vals = []
    for fc in OCTAVES:
        lo, hi = fc / math.sqrt(2), fc * math.sqrt(2)
        sel = (f >= lo) & (f < min(hi, sr / 2))
        vals.append(10 * math.log10(p[sel].sum() + 1e-20))
    top = max(vals)
    return {str(int(fc)): round(v - top, 1) for fc, v in zip(OCTAVES, vals)}


def longest_silence(x, sr, thresh_db=-60.0):
    win = int(0.05 * sr)
    m = x.mean(axis=1)
    n = len(m) // win
    if n == 0:
        return 0.0
    r = np.sqrt((m[: n * win].reshape(n, win) ** 2).mean(axis=1))
    quiet = 20 * np.log10(np.maximum(r, 1e-12)) < thresh_db
    best = cur = 0
    for q in quiet:
        cur = cur + 1 if q else 0
        best = max(best, cur)
    return best * win / sr


def clicks(x, sr):
    """High-frequency bursts that stick out of their surroundings.

    Returns (impulsive, transients, max_jump). Impulsive events are discontinuities (a step or hard cut):
    their >7 kHz energy collapses within ~1 ms. Transients (plucks, hats) keep ringing for several ms.
    """
    m = x.mean(axis=1)
    sos = signal.butter(4, min(7000, sr * 0.4), 'highpass', fs=sr, output='sos')
    h = signal.sosfilt(sos, m)
    win = max(8, int(0.0005 * sr))
    n = len(h) // win
    e = np.sqrt((h[: n * win].reshape(n, win) ** 2).mean(axis=1) + 1e-20)
    edb = 20 * np.log10(e)
    med = median_filter(edb, size=81, mode='nearest')
    flag = (edb - med > 18) & (edb > -66)
    imp, trans = [], []
    i = 0
    while i < n:
        if flag[i]:
            j = i
            while j + 1 < n and flag[j + 1]:
                j += 1
            k = i + int(np.argmax(edb[i:j + 1] - med[i:j + 1]))
            s0 = k * win
            peak = np.sqrt((h[s0:s0 + win] ** 2).mean() + 1e-20)
            a, b = s0 + int(0.0015 * sr), s0 + int(0.004 * sr)
            after = np.sqrt((h[a:b] ** 2).mean() + 1e-20) if b < len(h) else peak
            ev = (k * win / sr, float(edb[k] - med[k]), float(edb[k]))
            (imp if 20 * np.log10(after / peak) < -15 else trans).append(ev)
            i = j + 1
        else:
            i += 1
    d = np.abs(np.diff(m))
    return imp, trans, float(d.max()) if len(d) else 0.0


def track_segments(log, total):
    segs = []
    cur = None
    for e in log:
        info = e['info']
        key = (info.get('title'), info.get('trackIndex'), info.get('station'))
        if info.get('title') is None:
            key = None
        if cur is None or key != cur[0]:
            if cur is not None:
                segs.append((cur[0], cur[1], e['t']))
            cur = (key, e['t'])
    if cur is not None:
        segs.append((cur[0], cur[1], total))
    return [s for s in segs if s[0] is not None]


def analyse(path, skip=0.0, tracks=None):
    sr, x = load(path)
    s0 = int(skip * sr)
    xs = x[s0:]
    I, st = lufs(xs, sr)
    peak = float(np.max(np.abs(xs)))
    tp = true_peak(xs)
    rms = float(np.sqrt((xs ** 2).mean()))
    clip = int((np.abs(xs) >= 0.999).sum())
    dc = [round(float(v), 6) for v in xs.mean(axis=0)]
    spec, cen = spectral(xs, sr)
    ev, trans, maxjump = clicks(xs, sr)
    ev = [(a + skip, b, c) for a, b, c in ev]
    trans = [(a + skip, b, c) for a, b, c in trans]
    res = {
        'file': path,
        'seconds': round(len(x) / sr, 2),
        'lufs': round(I, 2),
        'st_max': round(float(st.max()), 2) if len(st) else None,
        'st_min': round(float(st.min()), 2) if len(st) else None,
        'peak_dbfs': round(db(peak), 2),
        'true_peak_dbtp': round(db(tp), 2),
        'rms_dbfs': round(db(rms), 2),
        'crest_db': round(db(peak) - db(rms), 1),
        'clipped': clip,
        'dc': dc,
        'longest_silence_s': round(longest_silence(xs, sr), 2),
        'centroid_hz': round(cen),
        'bands_db': spec,
        'octaves_db': octave_bands(xs, sr),
        'clicks': len(ev),
        'worst_clicks': sorted(ev, key=lambda e: -e[1])[:5],
        'transients': len(trans),
        'max_jump': round(maxjump, 4),
    }
    if tracks is not None:
        segs = track_segments(tracks['log'], len(x) / sr)
        per = []
        for key, a, b in segs:
            a2, b2 = max(a, skip) + 2, b - 2
            if b2 - a2 < 8:
                continue
            seg = x[int(a2 * sr):int(b2 * sr)]
            li, _ = lufs(seg, sr)
            per.append({'title': key[0], 'index': key[1], 'from': round(a, 1), 'to': round(b, 1), 'lufs': round(li, 2)})
        res['tracks'] = per
        if len(per) > 1:
            vals = [p['lufs'] for p in per]
            res['track_lufs_spread'] = round(max(vals) - min(vals), 2)
    return res


def spectrogram_png(path, png, skip=0.0):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    sr, x = load(path)
    m = x.mean(axis=1)
    f, t, S = signal.spectrogram(m, sr, nperseg=4096, noverlap=3072)
    fig, ax = plt.subplots(2, 1, figsize=(14, 7), gridspec_kw={'height_ratios': [3, 1]})
    ax[0].pcolormesh(t, f, 10 * np.log10(S + 1e-14), shading='auto', cmap='magma', vmin=-130, vmax=-40)
    ax[0].set_yscale('symlog', linthresh=200)
    ax[0].set_ylim(30, sr / 2)
    ax[0].set_ylabel('Hz')
    ax[0].set_title(path.split('/')[-1])
    _, st = lufs(x, sr)
    win = int(0.4 * sr)
    n = len(m) // win
    r = np.sqrt((m[: n * win].reshape(n, win) ** 2).mean(axis=1))
    ax[1].plot(np.arange(n) * 0.4, 20 * np.log10(np.maximum(r, 1e-9)), lw=0.8, label='RMS 400ms')
    if len(st):
        ax[1].plot(np.arange(len(st)) + 1.5, st, lw=1.2, label='short-term LUFS')
    ax[1].set_ylim(-70, 0)
    ax[1].set_xlim(0, len(m) / sr)
    ax[1].legend(loc='lower right')
    ax[1].grid(alpha=0.3)
    fig.tight_layout()
    fig.savefig(png, dpi=80)
    plt.close(fig)


def main(argv):
    files = []
    out_json = None
    png = None
    tracks = None
    skip = 0.0
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == '--json':
            out_json = argv[i + 1]
            i += 2
        elif a == '--png':
            png = argv[i + 1]
            i += 2
        elif a == '--tracks':
            tracks = json.load(open(argv[i + 1]))
            i += 2
        elif a == '--skip':
            skip = float(argv[i + 1])
            i += 2
        else:
            files.append(a)
            i += 1
    results = []
    for f in files:
        r = analyse(f, skip, tracks)
        results.append(r)
        print(f"\n{r['file']}")
        print(f"  {r['seconds']}s  LUFS {r['lufs']}  (short-term {r['st_min']}..{r['st_max']})  RMS {r['rms_dbfs']} dBFS  "
              f"peak {r['peak_dbfs']} dBFS  true-peak {r['true_peak_dbtp']} dBTP  crest {r['crest_db']} dB")
        print(f"  clipped {r['clipped']}  DC {r['dc']}  longest silence {r['longest_silence_s']}s  centroid {r['centroid_hz']} Hz  max jump {r['max_jump']}")
        print('  bands dB: ' + '  '.join(f"{k} {v}" for k, v in r['bands_db'].items()))
        print('  octaves:  ' + '  '.join(f"{k}:{v}" for k, v in r['octaves_db'].items()))
        print(f"  clicks (impulsive) {r['clicks']}  bright transients {r['transients']}" + (f"  worst {[(round(a, 3), round(b, 1), round(c, 1)) for a, b, c in r['worst_clicks']]}" if r['clicks'] else ''))
        if 'tracks' in r:
            for t in r['tracks']:
                print(f"    track #{t['index']} {t['title']!r} {t['from']}-{t['to']}s  LUFS {t['lufs']}")
            if 'track_lufs_spread' in r:
                print(f"  per-track loudness spread {r['track_lufs_spread']} LU")
        if png:
            p = png if len(files) == 1 else png.replace('.png', f'-{len(results)}.png')
            spectrogram_png(f, p, skip)
            print(f'  spectrogram -> {p}')
    if out_json:
        json.dump(results, open(out_json, 'w'), indent=1)


if __name__ == '__main__':
    main(sys.argv[1:])
