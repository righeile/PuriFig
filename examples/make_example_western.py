#!/usr/bin/env python3
"""Write three synthetic western blots, each as the pair of images an imager
takes of one membrane -- chemiluminescence and white light, in register -- so
the blot panel and the quantification have something to open.

    python3 examples/make_example_western.py

The point of generating them rather than shipping a real blot is that the right
answer is known.  Every band is drawn from its own term, so its true integrated
signal is summed exactly, and `western_truth.json` records what quantification
ought to find: the target over the loading control in each lane, and that ratio
relative to the control lane of the same blot.

What makes them awkward on purpose, because real ones are:

* The prestained ladder is visible only in the white-light image.  In the
  chemiluminescence it is not there at all, which is why the sizes have to be
  read from the other picture.
* Each blot was loaded unevenly (up to a quarter either way) and exposed for a
  different time, so raw band signals mean nothing across lanes or blots until
  they are divided by the loading control.
* The lanes lean, and by a different amount on each membrane.
* Blot 3's chemiluminescence was taken at 2x2 binning, so it is half the size
  of its white-light image and the two have to be matched by scale.
* Blot 3's loading control in lane C is overloaded and clips at 65535.  Its
  true signal is recorded, but it cannot be recovered from the image, and the
  app is expected to say so rather than quietly report a ratio that is too high.
"""

import json
import os

import numpy as np
import tifffile

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "western")

W, H = 1344, 1024                                   # a ChemiDoc frame
LADDER = [250, 150, 100, 75, 50, 37, 25, 20, 15, 10]
REFERENCE_RUNGS = (75, 25)                          # the two colored ones
CONDITIONS = ["ctrl", "A", "B", "C", "D", "E"]
TRUTH = [1.0, 1.5, 2.0, 3.0, 4.0, 0.5]              # target per unit of loading
TARGET_KDA, CONTROL_KDA = 62, 37

BLOTS = [
    # membrane rectangle in the frame, lean in px top to bottom, exposure, binning
    dict(name="rep1", membrane=(150, 92, 1196, 958), lean=14, exposure=1.00, bin=1, seed=11),
    dict(name="rep2", membrane=(132, 110, 1178, 976), lean=-9, exposure=0.62, bin=1, seed=23),
    dict(name="rep3", membrane=(170, 80, 1216, 946), lean=22, exposure=1.35, bin=2, seed=37,
         overload=("C", 3.4)),                      # the loading control in lane C clips
]


def y_of(kDa, top, bottom):
    """Where a band of this size runs: log-linear over the resolving range."""
    hi, lo = np.log10(320), np.log10(8)
    return top + (bottom - top) * (hi - np.log10(kDa)) / (hi - lo)


def band(cx, cy, amp, half, sigma, lean):
    """One band: flat across its lane with soft sides, Gaussian down it."""
    y = np.arange(H, dtype=np.float64)[:, None]
    x = np.arange(W, dtype=np.float64)[None, :]
    shift = lean * (y - H / 2.0) / H               # the lane drifts sideways as it runs
    across = np.exp(-(((x - cx - shift) / half) ** 8))
    down = np.exp(-((y - cy) ** 2) / (2.0 * sigma ** 2))
    return amp * across * down


def make(blot):
    rng = np.random.default_rng(blot["seed"])
    mx0, my0, mx1, my1 = blot["membrane"]
    top, bottom = my0 + 0.05 * (my1 - my0), my0 + 0.95 * (my1 - my0)
    n_lanes = 1 + len(CONDITIONS)
    inner0, inner1 = mx0 + 0.035 * (mx1 - mx0), mx1 - 0.035 * (mx1 - mx0)
    pitch = (inner1 - inner0) / n_lanes
    centre = [inner0 + (i + 0.5) * pitch for i in range(n_lanes)]
    half = pitch * 0.36

    loading = 1.0 + 0.25 * rng.uniform(-1, 1, len(CONDITIONS))
    biology = 1.0 + 0.10 * rng.normal(0, 1, len(CONDITIONS))
    exposure = blot["exposure"]

    # ---- chemiluminescence: light bands on a dark field, in counts
    chemi = np.full((H, W), 1150.0)
    chemi += 260.0 * np.linspace(0, 1, W)[None, :]                     # uneven glow
    inside = np.zeros((H, W))
    inside[my0:my1, mx0:mx1] = 1.0
    chemi += 180.0 * inside                                             # the membrane glows a little
    for _ in range(5):                                                  # blotches
        bx, by = rng.uniform(mx0, mx1), rng.uniform(my0, my1)
        r = rng.uniform(40, 120)
        yy, xx = np.mgrid[0:H, 0:W]
        chemi += rng.uniform(80, 260) * np.exp(-((xx - bx) ** 2 + (yy - by) ** 2) / (2 * r * r))

    truth = []
    y_t, y_c = y_of(TARGET_KDA, top, bottom), y_of(CONTROL_KDA, top, bottom)
    for i, cond in enumerate(CONDITIONS):
        cx = centre[i + 1]
        t_amp = 7000.0 * TRUTH[i] * biology[i] * loading[i] * exposure
        c_amp = 16000.0 * loading[i] * exposure
        if blot.get("overload") and blot["overload"][0] == cond:
            c_amp *= blot["overload"][1]
        t = band(cx, y_t, t_amp, half, 6.5, blot["lean"])
        c = band(cx, y_c, c_amp, half, 5.0, blot["lean"])
        chemi += t + c
        truth.append({"condition": cond, "lane": i + 2,
                      "target": float(t.sum()), "control": float(c.sum()),
                      "loading": round(float(loading[i]), 4)})

    chemi += rng.normal(0, 38.0, chemi.shape) + rng.normal(0, 1, chemi.shape) * np.sqrt(np.clip(chemi, 0, None)) * 0.6
    clipped = chemi >= 65535
    chemi = np.clip(chemi, 0, 65535)

    # ---- white light: the membrane on the imager tray, with the prestained
    # ladder as dark bands.  Nothing else shows: the samples are not colored.
    white = np.full((H, W), 17500.0)
    white[my0:my1, mx0:mx1] = 46000.0
    yy, xx = np.mgrid[0:H, 0:W]
    white *= 1.0 - 0.07 * (((xx - W / 2) / (W / 2)) ** 2 + ((yy - H / 2) / (H / 2)) ** 2)  # vignetting
    for kDa in LADDER:
        depth = 30000.0 if kDa in REFERENCE_RUNGS else 21000.0
        white -= band(centre[0], y_of(kDa, top, bottom), depth, half, 4.2, blot["lean"])
    white += rng.normal(0, 140.0, white.shape)
    white = np.clip(white, 0, 65535)

    chemi_u16 = (chemi + 0.5).astype(np.uint16)
    if blot["bin"] == 2:
        # 2x2 binning, averaged: half the frame, the same field of view.
        chemi_u16 = chemi_u16.reshape(H // 2, 2, W // 2, 2).mean(axis=(1, 3)).round().astype(np.uint16)

    os.makedirs(OUT, exist_ok=True)
    stem = os.path.join(OUT, f"western_{blot['name']}")
    tifffile.imwrite(stem + "_chemi.tif", chemi_u16, compression="zlib")
    tifffile.imwrite(stem + "_white.tif", (white + 0.5).astype(np.uint16), compression="zlib")

    ctrl = truth[0]["target"] / truth[0]["control"]
    for t in truth:
        t["ratio"] = t["target"] / t["control"]
        t["relative"] = t["ratio"] / ctrl
    lanes = [[int(round(centre[i] - pitch / 2)), int(round(centre[i] + pitch / 2))]
             for i in range(n_lanes)]
    return {
        "blot": blot["name"], "chemi": os.path.basename(stem + "_chemi.tif"),
        "white": os.path.basename(stem + "_white.tif"),
        "binning": blot["bin"], "lean": blot["lean"], "exposure": exposure,
        "lanes_at_mid_height": lanes,
        "ladder_y": {str(k): round(float(y_of(k, top, bottom)), 1) for k in LADDER},
        "target_y": round(float(y_t), 1), "control_y": round(float(y_c), 1),
        "clipped_pixels": int(clipped.sum()),
        "overloaded": blot.get("overload", [None])[0],
        "lanes": truth,
    }


def main():
    record = {"frame": [W, H], "conditions": CONDITIONS, "truth_relative": TRUTH,
              "target_kDa": TARGET_KDA, "control_kDa": CONTROL_KDA,
              "ladder_kDa": LADDER, "blots": [make(b) for b in BLOTS]}
    with open(os.path.join(OUT, "western_truth.json"), "w") as fh:
        json.dump(record, fh, indent=1)
    for b in record["blots"]:
        rel = ", ".join(f"{t['condition']} {t['relative']:.3f}" for t in b["lanes"])
        print(f"{b['blot']}: {b['chemi']} + {b['white']}  (bin {b['binning']}, "
              f"{b['clipped_pixels']} clipped px)\n    relative to ctrl: {rel}")
    print(f"ladder in lane 1, sizes top to bottom: {', '.join(map(str, LADDER))} kDa")
    print(f"target at {TARGET_KDA} kDa, loading control at {CONTROL_KDA} kDa")


if __name__ == "__main__":
    main()
