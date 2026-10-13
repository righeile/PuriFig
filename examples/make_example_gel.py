#!/usr/bin/env python3
"""Write a synthetic 16-bit gel scan, so the gel panel has something to open
without anyone having to find a real blot first.

    python3 examples/make_example_gel.py

Dark bands on a light background at 16 bits, which is what a flatbed or a
ChemiDoc actually writes, and what the browser cannot read on its own.
"""

import os
import numpy as np
import tifffile

HERE = os.path.dirname(os.path.abspath(__file__))

W, H = 1440, 760
LANES = 12
LADDER = [250, 150, 100, 75, 50, 37, 25, 20, 15]

rng = np.random.default_rng(7)


def y_of(kDa):
    """Where a band of this size lands: log-linear over the resolving range."""
    top, bot = 0.10, 0.90
    lo, hi = np.log10(10), np.log10(300)
    return (top + (bot - top) * (hi - np.log10(kDa)) / (hi - lo)) * H


def band(img, lane, kDa, amp, width=None, smear=0.0):
    pitch = W / LANES
    cx = (lane + 0.5) * pitch
    half = (width or pitch * 0.34)
    cy = y_of(kDa)
    sy = 5.5 + smear * 26
    x = np.arange(W)[None, :]
    y = np.arange(H)[:, None]
    lane_mask = np.exp(-((x - cx) / half) ** 8)          # flat-topped, sharp sides
    prof = np.exp(-((y - cy) ** 2) / (2 * sy ** 2))
    img += amp * lane_mask * prof


def main():
    img = np.zeros((H, W), dtype=np.float64)

    for kDa in LADDER:                                   # lane 0: the ladder
        band(img, 0, kDa, 0.55 if kDa in (75, 25) else 0.34)

    # A purification, left to right: lysate, flow-through, wash, then peak
    # fractions that get cleaner and then run out.
    band(img, 1, 62, 0.30, smear=0.5)
    for kDa, a in [(180, .22), (110, .26), (62, .34), (40, .30), (28, .24), (17, .20)]:
        band(img, 1, kDa, a, smear=0.35)
    for kDa, a in [(180, .18), (110, .20), (40, .22), (28, .18)]:
        band(img, 2, kDa, a, smear=0.3)
    band(img, 3, 62, 0.10)
    for kDa, a in [(110, .12), (40, .10)]:
        band(img, 3, kDa, a, smear=0.25)

    band(img, 4, 62, 0.30)                               # the loading control lane
    band(img, 4, 42, 0.55)

    for i, a in zip(range(5, 12), [.18, .46, .82, .95, .70, .34, .12]):
        band(img, i, 62, a)
        if a > 0.5:
            band(img, i, 124, a * 0.06)                  # a faint dimer
        if i in (5, 6):
            band(img, i, 95, a * 0.15, smear=0.2)

    img /= img.max() or 1
    background = 0.86 + 0.04 * np.linspace(0, 1, W)[None, :]     # a lit-from-one-side scan
    frame = np.clip(background - img * 0.78, 0, 1)
    frame += rng.normal(0, 0.004, frame.shape)
    frame = np.clip(frame, 0, 1)

    out = (frame * 62000).astype(np.uint16)              # not quite full scale, like a real scan
    path = os.path.join(HERE, "example_gel.tif")
    tifffile.imwrite(path, out)
    print(f"{path}  {out.shape[1]}×{out.shape[0]}  16-bit")
    print("ladder lane 1, sizes top to bottom: " + ", ".join(str(k) for k in LADDER))
    print("lane 5 is a loading control; lanes 6–12 are peak fractions")


if __name__ == "__main__":
    main()
