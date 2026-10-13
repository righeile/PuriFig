#!/usr/bin/env python3
"""purifig backend: serves the canvas, and does the things a browser cannot.

    python3 purifig_server.py [--port 8778]

The canvas runs without this — drop a PNG or a JPEG on it and everything works.
What the server adds is the part that matters for a blot:

* **16-bit TIFFs.**  A browser decodes a 16-bit TIFF by throwing away half of
  it, and a gel doc (ImageQuant, Odyssey, ChemiDoc) writes 16-bit TIFFs.  Every
  levels adjustment here is computed against the original array and rendered to
  8-bit once, at the end, so windowing a faint band does not have to fight a
  quantization that already happened.
* **Lane finding** by column density, so "12 lanes" lands on the twelve lanes
  rather than on twelve equal twelfths of the image.
* **Densitometry**, for the lane profiles and for band quantification.
* **UNICORN / chromatography exports**, which are UTF-16 tab-separated files
  with paired columns and no header row anyone would call a header row.

Nothing here writes to the images it reads.
"""

import argparse
import base64
import csv
import hashlib
import io
import json
import re
import shutil
import struct
import os
import subprocess
import sys
import tempfile
import traceback
import urllib.parse
import urllib.request
import zipfile

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view
from scipy import ndimage as ndi
from flask import Flask, Response, jsonify, request, send_from_directory

from labkit import browse as LKB

import protocol as proto

HERE = os.path.dirname(os.path.abspath(__file__))

IMAGE_EXTS = (".tif", ".tiff", ".png", ".jpg", ".jpeg", ".gel", ".bmp", ".scn")
TRACE_EXTS = (".asc", ".txt", ".csv", ".tsv", ".xls", ".res")

try:
    import tifffile
except ImportError:                                        # pragma: no cover
    tifffile = None
try:
    from PIL import Image
except ImportError:                                        # pragma: no cover
    Image = None


# ============================================================ image reading

_cache: dict = {}
_CACHE_BYTES = 512 << 20


def read_image(path):
    """Return (2-D float array, bit depth, note).  Cached by (path, mtime).

    Color scans are collapsed to luminance: a Coomassie gel photographed in
    color still has one quantity in it, and quantifying a green channel
    because that is what the camera happened to emphasize is not a decision
    anyone would defend in a methods section.
    """
    key = (path, os.path.getmtime(path))
    if key in _cache:
        _cache[key] = _cache.pop(key)          # most recently used goes last
        return _cache[key]

    ext = os.path.splitext(path)[1].lower()
    note = ""
    if ext in (".tif", ".tiff", ".gel", ".scn") and tifffile is not None:
        arr = tifffile.imread(path)
    elif Image is not None:
        with Image.open(path) as im:
            arr = np.array(im)
    else:
        raise RuntimeError("neither tifffile nor pillow is installed")

    arr = np.asarray(arr)
    # Read the depth off the file, before the channels are collapsed: averaging
    # three uint8 channels makes a float array, and calling that 32-bit would put
    # a depth in the record the scanner never had.
    bits = 16 if arr.dtype == np.uint16 else 32 if arr.dtype.kind == "f" else 8
    if arr.ndim == 3 and arr.shape[0] in (1, 2, 3, 4) and arr.shape[-1] > 4:
        arr = np.moveaxis(arr, 0, -1)          # channel-first scan
    if arr.ndim == 3:
        if arr.shape[-1] >= 3:
            arr = (0.299 * arr[..., 0] + 0.587 * arr[..., 1] + 0.114 * arr[..., 2])
            note = "color collapsed to luminance"
        else:
            arr = arr[..., 0]
    if arr.ndim > 2:                            # a stack: take the first plane
        arr = arr[(0,) * (arr.ndim - 2)]
        note = "multi-page file, first page used"

    data = arr.astype(np.float32)

    # Oldest out, one at a time, under a budget in bytes rather than in files:
    # six blots is three replicates with their white light, so the old "clear
    # the lot at seven" threw away every array the moment a third replicate
    # arrived and re-read the TIFF for every call after that.  A count is also
    # the wrong unit -- six small scans are nothing and six large ones are a
    # gigabyte.
    _cache[key] = (data, bits, note)
    used = sum(v[0].nbytes for v in _cache.values())
    while len(_cache) > 1 and used > _CACHE_BYTES:
        used -= _cache.pop(next(iter(_cache)))[0].nbytes
    return _cache[key]


def full_range(bits, data):
    """The nominal range of the detector, not of this particular image.

    "Full range" has to mean the same thing for every panel cut from one
    membrane, so it comes from the bit depth rather than from whichever bands
    happened to fall inside a particular crop.
    """
    if bits == 8:
        return 0.0, 255.0
    if bits == 16:
        return 0.0, 65535.0
    return float(data.min()), float(data.max())


def apply_levels(data, black, white, gamma=1.0, invert=False):
    """Black/white point and gamma, to 8-bit.  This is the only pixel path."""
    if white == black:
        white = black + 1e-6
    out = (data - black) / (white - black)
    np.clip(out, 0.0, 1.0, out=out)
    if gamma and abs(gamma - 1.0) > 1e-6:
        out = out ** (1.0 / float(gamma))
    if invert:
        out = 1.0 - out
    return (out * 255.0 + 0.5).astype(np.uint8)


def crop_of(data, crop):
    """crop = {x, y, w, h} in source pixels; None or empty means all of it."""
    if not crop:
        return data
    h, w = data.shape
    x0 = int(round(max(0, min(w - 1, crop.get("x", 0)))))
    y0 = int(round(max(0, min(h - 1, crop.get("y", 0)))))
    x1 = int(round(max(x0 + 1, min(w, x0 + crop.get("w", w)))))
    y1 = int(round(max(y0 + 1, min(h, y0 + crop.get("h", h)))))
    return data[y0:y1, x0:x1]


def oriented(data, rotate=0, flip_h=False, flip_v=False, tilt=0.0):
    # A gel is put on the scanner by hand and lands a degree or two off, which
    # no number of quarter turns will fix.  The fine angle is applied first and
    # in place: the frame keeps the crop's own width and height, which is the
    # coordinate space every lane, rung and box is recorded in, so straightening
    # a picture does not renumber everything on it.  What rotates out of the
    # frame is the corners of the crop, and what rotates in is the edge pixel
    # repeated -- never black, which on a dark-bands scan is signal.
    if tilt:
        data = ndi.rotate(np.asarray(data, np.float32), -float(tilt),
                          reshape=False, order=1, mode="nearest")
    k = (int(rotate) // 90) % 4
    if k:
        data = np.rot90(data, -k)               # clockwise, as the button says
    if flip_h:
        data = data[:, ::-1]
    if flip_v:
        data = data[::-1, :]
    return data


def png_data_uri(u8, max_px=1600, level=3):
    """Encode an 8-bit array as a data URI, optionally shrinking it first.

    ``max_px`` of 0 or None means encode it as it is.  That is what the figure
    itself asks for -- a panel embeds the crop at the resolution it was scanned
    at -- while the interface previews, which only ever have to look right on a
    screen, ask for a few hundred kilobytes instead of a few megabytes.

    PNG is lossless at every setting, so the compression level buys file size
    and nothing else.  Pillow's ``optimize=True`` tries every filter at zlib 9
    and took 1.5 s on a 1344x1024 blot -- the whole cost of opening one, and
    paid again on every contrast change.  Level 3 does it in 39 ms for 20 %
    more bytes, which is a fifth of a second off a figure and a second and a
    half off every slider drag.
    """
    if Image is None:
        raise RuntimeError("pillow is needed to encode PNGs")
    im = Image.fromarray(u8, mode="L")
    if max_px and max(im.size) > max_px:
        scale = max_px / max(im.size)
        im = im.resize((max(1, int(im.width * scale)), max(1, int(im.height * scale))),
                       Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, format="PNG", compress_level=level)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def describe(data, bits):
    lo, hi = full_range(bits, data)
    p = np.percentile(data, [0.1, 1, 50, 99, 99.9])
    hist, _ = np.histogram(data, bins=256, range=(lo, hi))
    # A scan is mostly background, so the mode is the background: which side of
    # mid-range it falls on is what tells us whether bands are dark or light.
    mode_bin = int(np.argmax(hist))
    dark_bands = mode_bin > 128
    return {
        "min": float(data.min()), "max": float(data.max()),
        "mean": float(data.mean()), "std": float(data.std()),
        "p01": float(p[0]), "p1": float(p[1]), "p50": float(p[2]),
        "p99": float(p[3]), "p999": float(p[4]),
        "rangeLo": lo, "rangeHi": hi,
        "hist": hist.tolist(),
        "darkBands": bool(dark_bands),
        "saturated": int((data >= hi).sum()),
        "saturatedFraction": float((data >= hi).mean()),
    }


# ============================================================ lane finding

def lane_signal(u8, dark_bands=True):
    """One number per image column: how much protein is in it.

    Rows are summed after subtracting the per-row background, so a gradient in
    the illumination across the gel does not read as a lane.
    """
    a = u8.astype(np.float32)
    if dark_bands:
        a = 255.0 - a
    a = a - np.median(a, axis=1, keepdims=True)
    np.clip(a, 0, None, out=a)
    sig = a.sum(axis=0)
    if sig.max() > 0:
        sig = sig / sig.max()
    return sig


def _rolling_min(v, win):
    """The lowest value in a window around each point: a baseline that follows
    the gaps between bands rather than the bands themselves."""
    win = max(3, int(win) | 1)
    pad = np.pad(v, win // 2, mode="edge")
    # sliding_window_view is a view, not a copy: no window is ever materialized,
    # and it gives bit-identical minima ~40x faster than a Python loop over slices.
    return sliding_window_view(pad, win).min(axis=-1).astype(np.float32)


def smooth(v, win):
    win = max(1, int(win) | 1)
    k = np.ones(win, dtype=np.float32) / win
    return np.convolve(v, k, mode="same")


def _slope_of(u8, x0, x1, dark_bands=True, band=6):
    """Lean of one vertical slice, in pixels sideways per pixel down."""
    part = u8[:, x0:x1]
    h, w = part.shape
    if h < 40 or w < 20:
        return 0.0

    def strip(y0, y1):
        a = part[y0:y1].astype(np.float32)
        if dark_bands:
            a = 255.0 - a
        a = a - np.median(a, axis=1, keepdims=True)
        np.clip(a, 0, None, out=a)
        s = a.sum(axis=0)
        return s / (s.max() or 1.0)

    ref = strip(int(h * 0.40), int(h * 0.60))
    lag_max = max(2, int(w * 0.10))
    # Every lag at once.  np.roll(s, lag)[i] is s[(i - lag) % w], so one gather
    # over this index matrix is the whole correlation; the loop it replaces made
    # 401 round trips into numpy per strip on a flatbed-scale scan.
    roll = (np.arange(w)[None, :] - np.arange(-lag_max, lag_max + 1)[:, None]) % w
    ys, xs = [], []
    for i in range(band):
        y0 = int(h * (0.15 + 0.70 * i / band))
        y1 = int(h * (0.15 + 0.70 * (i + 1) / band))
        if y1 - y0 < 4:
            continue
        s = strip(y0, y1)
        scores = (s[roll] * ref).sum(axis=1)
        # A strip of blank membrane matches the middle of the gel equally well at
        # every lag, and argmax of a flat curve is a confident-looking number out
        # of nothing: that is how a western strip carrying two bands was told it
        # leaned 42 px.  A strip with lanes in it loses the match as soon as it is
        # shifted, so the peak has to beat a typical lag by half to get a vote.
        top = float(scores.max())
        if top <= 0 or top - float(np.median(scores)) < 0.5 * top:
            continue
        lag = int(np.argmax(scores)) - lag_max
        # A best lag sitting on the edge of the search window never had its peak
        # bracketed: the match was still improving where the search ran out, so
        # the number is the window's width and not the strip's shift.  One of
        # those pinned at 27 was the whole of a 63 px lean on a flat membrane.
        if abs(lag) >= lag_max:
            continue
        ys.append((y0 + y1) / 2.0)
        xs.append(float(lag))
    # A lean is a claim about the whole height, so it has to be fitted across
    # the whole height.  Three strips out of the middle fifth of a blot, one of
    # them a pixel off, extrapolate to 9 px of shear over the rest of it.
    if len(ys) < 3 or ys[-1] - ys[0] < 0.4 * h:
        return 0.0, 1e9
    ys, xs = np.asarray(ys), np.asarray(xs)
    fit = np.polyfit(ys, xs, 1)
    resid = float(np.sqrt(np.mean((np.polyval(fit, ys) - xs) ** 2)))
    return float(fit[0]), resid


def lane_skew(u8, dark_bands=True):
    """How far the lanes lean at the left and right of the gel, px across the height.

    Two numbers rather than one, because a gel does not merely lean: the two
    sides lean by different amounts, so the lanes fan out or in and the block is
    a different width at the bottom than at the top.  On these scans the two
    sides differ by up to 86 px -- about a whole lane -- which a single shear
    cannot describe at all, and which shows up as boundaries that fit the bands
    at one edge of the gel and miss them at the other.
    """
    h, w = u8.shape
    if h < 40 or w < 80:
        return 0.0, 0.0
    sl, rl = _slope_of(u8, 0, w // 2, dark_bands)
    sr, rr = _slope_of(u8, w // 2, w, dark_bands)

    # Half a gel with only a band or two in it gives a correlation that wanders,
    # and a wandering one produces a confident-looking slope through nothing.
    # The tell is the straight-line fit: a real lean puts every band on one line
    # to within a pixel or two, a lock onto the wrong lane misses by twenty.
    MAX_RESID, MAX_LEAN = 8.0, w * 0.18
    ok_l = rl <= MAX_RESID and abs(sl * h) <= MAX_LEAN
    ok_r = rr <= MAX_RESID and abs(sr * h) <= MAX_LEAN
    if ok_l and ok_r:
        return round(sl * h, 2), round(sr * h, 2)
    # One good side still says the gel leans; it just cannot say whether the
    # lanes fan.  Better a straight lean than an invented one.
    if ok_l:
        return round(sl * h, 2), round(sl * h, 2)
    if ok_r:
        return round(sr * h, 2), round(sr * h, 2)
    return 0.0, 0.0


def lane_relief(u8, dark_bands=True):
    """How deep the gaps between the lanes are, as a fraction of the signal.

    The lanes are a comb: shearing the picture the way they really lean deepens
    the gaps, and shearing an upright one fills them in.  That is the only
    reading that tells a gel photographed askew from one that merely ran
    downhill -- the rows of bands look the same in both.
    """
    s = smooth(lane_signal(u8, dark_bands), 5)
    return float(s.std() / (abs(s.mean()) or 1.0))


def band_tilt(u8, dark_bands=True, most=0.12, steps=49):
    """The angle the rows of bands lie at, in degrees, clockwise positive.

    The lean is read off the lanes -- how far the pattern slides sideways from
    top to bottom -- and on a blot carrying two bands there is no lane to read.
    The bands are the other half of the same fact: a gel that sits crooked has
    its rows of bands crooked by the same angle, and a row of bands is there
    even when the lanes are invisible in the picture, which on a western is
    exactly the case.

    Read by projection.  The picture is averaged along lines at each candidate
    angle, and the angle whose profile changes fastest from one row to the next
    is the one the bands lie along: cut across them and every row is part band
    and part gap, which averages flat.  Only the rows that every line crosses
    are scored, so a steeper angle is not rewarded for the rows it runs off the
    edge of the picture.
    """
    h, w = u8.shape
    if h < 60 or w < 60:
        return 0.0, False
    a = u8.astype(np.float32)
    if dark_bands:
        a = 255.0 - a
    # Each column against its own background, so the ladder lane -- brighter
    # than the rest of the gel all the way down -- does not decide the answer.
    a -= np.median(a, axis=0, keepdims=True)
    slopes = np.linspace(-most, most, steps)
    scores = []
    for sl in slopes:
        p = _tilted_profile(a, sl, np.mean)
        edge = int(abs(sl) * w / 2.0) + 1
        d = np.diff(p[edge:h - edge])
        scores.append(float(np.mean(d * d)) if len(d) > 8 else 0.0)
    scores = np.asarray(scores)
    i = int(np.argmax(scores))
    # A picture with no rows in it scores much the same at every angle, and the
    # best of a flat curve is noise with a number on it; a best at the end of
    # the search never had its peak bracketed at all.
    ok = 0 < i < len(slopes) - 1 and scores[i] > 1.3 * float(np.median(scores))
    return round(float(np.degrees(np.arctan(slopes[i]))), 2), bool(ok)


def deskew(u8, lean_l, lean_r):
    """Straighten the lanes, for measuring only.

    The shift varies along the width as well as down the height, so this is a
    resample rather than a roll.  Nothing that reaches the figure goes through
    it: the panel draws the scan exactly as it arrived and it is the boundaries
    that are drawn fanned instead.
    """
    if not lean_l and not lean_r:
        return u8
    h, w = u8.shape
    xs = np.arange(w, dtype=np.float32)
    t = xs / max(1.0, w - 1.0)
    slope = (lean_l + (lean_r - lean_l) * t) / max(1.0, float(h))   # px sideways per px down
    out = np.empty_like(u8)
    for y in range(h):
        src = xs + slope * (y - h / 2.0)
        out[y] = np.interp(src, xs, u8[y].astype(np.float32)).astype(u8.dtype)
    return out


def lane_block(u8, sig, dark_bands=True):
    """The stretch of width the lanes occupy, with the gel's blank margins left out.

    Read off the comb rather than off the bands.  The comb is what *defines* the
    lanes -- it is evenly spaced by construction, it is there whether or not a
    lane was loaded, and it spans the full set even when half the wells ran
    empty.  Band content cannot do any of that: an empty lane looks like margin,
    and a gel whose samples all ran in the middle looks narrower than it is.

    Returns the span between the outermost wells, or the full width if no comb
    survived the crop.
    """
    h, w = u8.shape
    strip = u8[:max(4, int(h * 0.16))].astype(np.float32)
    comb = strip.max() - strip.mean(axis=0) if dark_bands else strip.mean(axis=0) - strip.min()
    s = smooth(comb, max(3, w // 100))
    base, peak = float(np.percentile(s, 15)), float(np.percentile(s, 97))
    if peak - base < 1e-9:
        return 0, w, "no comb in the crop"
    on = np.where(s > base + 0.30 * (peak - base))[0]
    if on.size < 2:
        return 0, w, "no comb in the crop"
    lo, hi = int(on[0]), int(on[-1]) + 1
    # A comb spans nearly the whole gel.  Anything much narrower is not a comb --
    # on a scan with no comb in it at all this lands on the densest lane and
    # would squeeze every lane into that one's width -- so fall back to the full
    # width and let the even split stand.
    if hi - lo < w * 0.60:
        return 0, w, "no comb spanning the gel"

    return lo, hi, ""


def wells_row(u8, dark_bands=True):
    """The row the wells end on, or None when the crop starts below them.

    On one lane the comb and a rung are the same thing -- a dark line across it
    -- which is why blanking a fixed tenth of the top was only ever a guess at
    where the wells stop, and why a crop that kept more of the stacking gel than
    that had its comb read as the topmost rung.  Across the gel they differ: a
    rung is confined to its lane, the comb runs the whole set of them, and
    nothing migrated above it, because the wells are where everything started.
    So the first line down the picture that spans the lanes is the comb.

    The gel's own rim is the other line up there, and a comb is not it: a comb
    has teeth, so the well line is broken at every lane boundary, where a rim
    runs unbroken from one side of the frame to the other.

    Only the top fifth is searched.  Below that a line spanning the lanes is a
    band the samples share, and blanking to it would throw away real rungs.
    """
    h, w = u8.shape
    look = max(6, int(h * 0.22))
    v = u8[:look].astype(np.float32)
    if not dark_bands:
        v = -v
    # Against the gel directly under it, column by column.  A scan is lit from
    # one side, and a row mean taken flat finds the lighting before the comb.
    gel = np.percentile(v, 80, axis=0)
    span = float(np.percentile(gel[None, :] - v, 99)) or 1.0
    wide = ((gel[None, :] - v) > 0.35 * span).mean(axis=1)

    for y in range(look):
        if not 0.35 < wide[y] < 0.95:          # nothing, or the unbroken rim
            continue
        end = y
        while end + 1 < look and wide[end + 1] > 0.25:
            end += 1
        return end
    return None


def find_lanes(u8, sig, n_lanes, dark_bands=True, membrane=False, margin=0.5):
    """Lane boundaries: a regular grid from the comb, nudged onto the real gaps.

    Two things are true at once and the old code only ever used one of them.
    The lanes are *regular*, because a comb cuts them at one pitch -- so the
    grid, not each boundary, is the thing to fit.  And they are not where the
    grid alone says, because a gel runs a little wide or narrow and leans as it
    goes -- so each boundary is then allowed to slide onto the quietest column
    near where the grid put it.

    The sliding is bounded to a third of the pitch.  Unbounded, which is what
    cutting at the quietest column used to be, a boundary walks off into
    whatever blank stretch is nearest and takes the lane with it.

    `sig` must be measured along the lanes -- de-slanted -- or every gap is
    smeared into its neighbors and there is nothing left to find.
    """
    w = len(sig)
    n = max(1, int(n_lanes))
    if n == 1:
        return [[0, w]]

    # A cut piece has no comb -- it was cut off below the wells -- so there is
    # nothing at the top of it to read the block off, and the crop is the gel:
    # its edges were found in the white light and they are where the lanes end.
    # Read for a comb anyway, the top row of bands answered instead and the grid
    # was trimmed to the lanes that happened to run, which on one strip of a
    # sheet started 35 px in and on its neighbor did not.
    if membrane:
        # Ten lanes means ten lanes.  A piece with no comb has no wells to read
        # the block off, so the grid is laid across the whole of it -- and laid
        # edge to edge it spends two of the ten on the blank strip down each
        # side, which is a margin and not a lane.  `margin` is that strip, in
        # lanes: the pitch is the width over the lanes *plus* the margins.
        p = w / (n + 2.0 * max(0.0, float(margin)))
        lo, hi = margin * p + p / 2.0, w - margin * p - p / 2.0
    else:
        lo, hi = lane_block(u8, sig, dark_bands)[:2]
    pitch = (hi - lo) / max(1, n - 1)
    a = max(0.0, lo - pitch / 2.0)
    b = min(float(w), hi + pitch / 2.0)
    if b - a < w * 0.2:
        a, b = 0.0, float(w)
    grid = np.linspace(a, b, n + 1)
    pitch = (b - a) / n

    s = smooth(sig, max(3, int(pitch / 6) | 1))
    reach = pitch / 3.0
    # What slides onto the gaps is the grid, not each boundary.  A gel runs a
    # little wide or narrow and sits a little off, and both of those are still
    # one pitch; sliding the boundaries one at a time instead models a comb with
    # unequal teeth.  It had cut one control strip into lanes 34, 51, 46, 55,
    # 33, 48, 44, 50 and 46 px wide, and a lane that wide of its neighbor sits
    # 8 px off its own band -- which no panel fit can take out afterwards,
    # because fitting a strip under its blot can shift and scale it but cannot
    # make its lanes unequal to match.
    #
    # Only the boundaries between lanes vote.  The two outer edges are the gel's
    # margins, found in the comb or the crop, and letting them vote lets the
    # whole grid widen into whatever blank is outside the lanes.
    mid = float(grid.mean())
    x = np.arange(w, dtype=np.float32)

    def cost(d, k):
        e = (grid[1:-1] - mid) * k + mid + d
        if e.min() < 1 or e.max() > w - 1:
            return np.inf
        # of two equally empty sets of gaps, the one at the pitch and place the
        # comb said.  The pitch is given room because on a piece with no comb it
        # is a guess off the crop, and a crop carries whatever blank was cut
        # with it: one strip here wanted 46.6 px where its width said 52.9.
        return (float(np.interp(e, x, s).mean())
                + 0.1 * s.max() * ((abs(d) / reach) ** 2 + ((k - 1.0) / 0.25) ** 2))

    # Nominal first and only beaten strictly, or a picture with nothing in it --
    # s is all zeros when more than half of a row is band -- takes whichever
    # candidate came up first.
    best, cost0 = (0.0, 1.0), cost(0.0, 1.0)
    for d in np.arange(-reach, reach + 1.0, 1.0):
        for k in np.linspace(0.78, 1.28, 51):
            c = cost(float(d), float(k))
            if c < cost0:
                best, cost0 = (float(d), float(k)), c
    d, k = best
    cuts = [int(round(min(w, max(0, v)))) for v in (grid - mid) * k + mid + d]

    cuts = sorted(set(int(c) for c in cuts))
    if len(cuts) != n + 1:                      # a nudge collided with a neighbor
        cuts = [int(round(v)) for v in grid]
    return [[cuts[i], cuts[i + 1]] for i in range(n)]


def lane_ink(u8, lanes, dark_bands=True):
    """Where the ink sits in each lane, as a column in the picture.

    The lane's own rows less the row background, so a gradient down the membrane
    is not read as a band, and the center of mass of what is left.  `None` for a
    lane with nothing in it.
    """
    a = u8.astype(np.float32)
    if dark_bands:
        a = 255.0 - a
    a = a - np.median(a, axis=1, keepdims=True)
    np.clip(a, 0, None, out=a)
    col = smooth(a.sum(axis=0), 7)
    out = []
    for x0, x1 in lanes:
        seg = col[int(x0):int(x1)]
        out.append(int(x0) + float((np.arange(len(seg)) * seg).sum() / seg.sum())
                   if seg.sum() > 0 else None)
    return out


def even_lanes(u8, lanes, roles=None, dark_bands=True, drop=2):
    """The lanes you have, at one pitch, fitted to the bands in them.

    Different from finding lanes: which lane is which is already settled, and
    only the pitch and where the grid starts are fitted -- to the ink in the
    sample lanes, by least squares against the lane number.  That is the one
    reading a blot with a blown-out membrane edge still supports, where finding
    lanes from the column signal cannot be done at all: the edge outweighs every
    band on the strip.  One GAPDH strip here had lanes 65, 65, 68, 70, 47, 56,
    65, 71, 68 px wide from a comb that cuts one width, and nothing downstream
    can fit that out -- a control strip is placed under its blot by a shift and
    a scale.

    The fit drops up to `drop` lanes whose ink is unlike the rest, so a
    saturated lane or one whose center of mass is pulled by a membrane edge does
    not tilt the grid.  An outlier is a point unlike its neighbors, not the
    worst of a bad fit, so the pass stops when none stands out.
    """
    n = len(lanes)
    if n < 4:
        return [[int(a), int(b)] for a, b in lanes]
    roles = roles or ["sample"] * n
    ink = lane_ink(u8, lanes, dark_bands)
    idx = np.array([i for i in range(n) if ink[i] is not None and roles[i] == "sample"], float)
    if len(idx) < 3:
        return [[int(a), int(b)] for a, b in lanes]
    val = np.array([ink[int(i)] for i in idx], float)
    use = np.ones(len(idx), bool)
    for _ in range(drop):
        if use.sum() < 4:
            break
        b, a = np.polyfit(idx[use], val[use], 1)
        res = np.abs(val - (a + b * idx))
        spread = float(np.median(res[use])) * 1.4826 or 1.0
        bad = (res > max(3.0 * spread, 6.0)) & use
        if not bad.any():
            break
        use[int(np.argmax(np.where(bad, res, -1.0)))] = False
    b, a = np.polyfit(idx[use], val[use], 1)
    if not np.isfinite(b) or b <= 1:
        return [[int(a0), int(b0)] for a0, b0 in lanes]
    e = [int(round(a + b * (i - 0.5))) for i in range(n + 1)]
    return [[e[i], e[i + 1]] for i in range(n)]


def lane_profiles(u8, lanes, dark_bands=True, samples=256):
    """Down-the-lane density profile and integrated density, per lane."""
    a = u8.astype(np.float32)
    if dark_bands:
        a = 255.0 - a
    out = []
    for x0, x1 in lanes:
        x0 = max(0, min(a.shape[1] - 1, int(x0)))
        x1 = max(x0 + 1, min(a.shape[1], int(x1)))
        strip = a[:, x0:x1]
        prof = strip.mean(axis=1)
        base = np.percentile(prof, 10)          # this lane's own empty gel
        prof = np.clip(prof - base, 0, None)
        idx = np.linspace(0, len(prof) - 1, samples)
        res = np.interp(idx, np.arange(len(prof)), prof)
        peak = float(res.max()) or 1.0
        out.append({
            "x0": x0, "x1": x1,
            "profile": [round(float(v) / peak, 4) for v in res],
            "peak": peak,
            "integrated": float(prof.sum()),
        })
    total = sum(l["integrated"] for l in out) or 1.0
    for l in out:
        l["fractionOfGel"] = round(l["integrated"] / total, 4)
    return out


# ============================================================ chromatograms

def _decode(path):
    """Text out of a file, deciding the encoding from the bytes.

    The tell for UTF-16 is in the raw bytes, not in the decoded string: half of
    a Latin text encoded UTF-16LE is NUL.  Trying utf-16 first and rejecting the
    result if it *contains* NULs cannot see that — a plain ASCII file whose
    length happens to be even decodes as perfectly NUL-free CJK, and one whose
    length is odd raises and falls through.  Which is to say: it worked or it
    did not by the parity of the file size.
    """
    raw = open(path, "rb").read()
    if raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return raw.decode("utf-16"), "utf-16"

    look = raw[:4096]
    if len(look) > 8:
        highs = sum(1 for b in look[1::2] if b == 0)          # UTF-16LE
        lows = sum(1 for b in look[0::2] if b == 0)           # UTF-16BE
        if highs > len(look) // 4:
            return raw.decode("utf-16-le", "replace"), "utf-16-le (no BOM)"
        if lows > len(look) // 4:
            return raw.decode("utf-16-be", "replace"), "utf-16-be (no BOM)"

    for enc in ("utf-8-sig", "utf-8", "latin-1"):
        try:
            return raw.decode(enc), enc
        except UnicodeDecodeError:
            continue
    return raw.decode("latin-1", "replace"), "latin-1"


#: Column names UNICORN uses for event marks rather than for data.  They have
#: to be recognized by *name*: a fraction column whose labels happen to be "1",
#: "2", "3" parses as a perfectly good curve otherwise, and lands on the plot
#: as a staircase.
MARK_COLUMNS = ("fraction", "inject", "run log", "logbook", "event", "break")


def _is_mark_column(name, unit):
    text = f"{name} {unit}".lower()
    return any(k in text for k in MARK_COLUMNS)


def _num(s):
    s = (s or "").strip().replace(",", ".")
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


# ------------------------------------------------------------------ UNICORN .RES

#: A UNICORN 3.x result file: a short header, a directory of fixed-size entries,
#: and one block per curve or event list.  Little-endian throughout.  This is
#: the file the instrument writes; the ASCII export is a lossy view of it, so
#: reading it directly saves the export step and keeps the run's own numbers.
RES_MAGIC = b"\x11\x47\x11\x47"
RES_ENTRY = 0x158                    # stride of a directory entry
RES_DESC = 78                        # stride of an axis descriptor inside a block
RES_MARK = 180                       # stride of an event record
RES_CURVE = 0x1401                   # block sub-type: (x, y) integer pairs
RES_MARKS = {0x0444: "fractions", 0x0446: "inject", 0x0448: "logbook"}


def _res_str(d, off, n):
    return d[off:off + n].split(b"\x00")[0].decode("latin-1").strip()


def _res_axes(d, off):
    """The axis descriptors at the head of a block.

    A curve block carries two of them for x — accumulated time and accumulated
    volume — and one for y.  An event list carries its time and volume plus the
    text columns.  `kind` is 0x80 for an x axis and 0x40 for a y.
    """
    out, a = [], off + 6
    while a + RES_DESC <= len(d) and struct.unpack_from("<H", d, a)[0] == RES_DESC:
        out.append({
            "index": d[a + 2], "kind": d[a + 3],
            "name": _res_str(d, a + 4, 40),
            "unit": _res_str(d, a + 0x2C, 18),
            "factor": struct.unpack_from("<d", d, a + 0x3E)[0],
        })
        a += RES_DESC
    return out


def _res_pick_x(axes, xmax_raw, spans):
    """Which axis the stored x integers are counted in.

    A curve block offers both "Acc. Time" (min) and "Acc. Volume" (ml), but the
    data holds one integer per point, so only one of those two factors is the
    right one and the header does not say which.  The event lists do say: every
    mark records its time *and* its volume as doubles.  So take the axis under
    which the curve still reaches every mark — reading a 70 min run as 29 min
    leaves the last logbook entry off the end of the trace, which is the tell.
    With no marks to check against, prefer millilitres; a size-exclusion column
    is read in volume.
    """
    cands = [a for a in axes if a["kind"] == 0x80 and a["factor"] > 0]
    if not cands:
        raise ValueError("curve block has no x axis")
    def reaches(a):
        need = spans.get(a["unit"].lower())
        return need is None or xmax_raw * a["factor"] >= need - 1e-6
    fits = [a for a in cands if reaches(a)]
    pool = fits or cands
    for a in pool:
        if a["unit"].lower() in ("ml", "l"):
            return a, bool(fits) and len(fits) < len(cands)
    return pool[-1], bool(fits) and len(fits) < len(cands)


def _res_directory(d):
    count, dir_off = struct.unpack_from("<II", d, 4)
    out = []
    for i in range(count):
        o = dir_off + i * RES_ENTRY
        if o + RES_ENTRY > len(d):
            break
        name = _res_str(d, o + 6, 0x120)
        if not name:
            continue
        size, _alloc, off, start = struct.unpack_from("<IIII", d, o + 0x12E)
        if size <= start or off + size > len(d):
            continue
        out.append({"name": name, "sub": struct.unpack_from("<H", d, o + 4)[0],
                    "off": off, "size": size, "start": start})
    return out


def _res_events(d, e):
    """One event list: fraction starts, the injection, or the run log."""
    out = []
    for i in range((e["size"] - e["start"]) // RES_MARK):
        o = e["off"] + e["start"] + i * RES_MARK
        t, v = struct.unpack_from("<dd", d, o)
        label = _res_str(d, o + 16, 160)
        if label:
            out.append({"t": round(t, 4), "v": round(v, 4), "label": label})
    return out


#: How UNICORN spells two units it writes, against how they are spelled on a
#: figure axis.  Both reach print, so the capitals go back on, whichever reader
#: the file came through.  Nothing whose meaning could shift is rewritten.
_RES_UNITS = {"mAu": "mAU", "ml": "mL", "l": "L"}


def _res_unit(u):
    return _RES_UNITS.get(u, u)


def parse_res(path):
    """A UNICORN .RES, read straight from the instrument's own file."""
    d = open(path, "rb").read()
    if d[:4] != RES_MAGIC:
        raise ValueError("not a UNICORN .RES file")

    entries = _res_directory(d)
    events, spans = {}, {}
    for e in entries:
        kind = RES_MARKS.get(e["sub"])
        if not kind:
            continue
        rows = _res_events(d, e)
        events.setdefault(kind, []).extend(rows)
        for r in rows:                       # how far the run demonstrably got
            spans["min"] = max(spans.get("min", 0.0), r["t"])
            spans["ml"] = max(spans.get("ml", 0.0), r["v"])

    curves, xaxis, checked = [], None, False
    for e in entries:
        if e["sub"] != RES_CURVE:
            continue
        axes = _res_axes(d, e["off"])
        ys = [a for a in axes if a["kind"] == 0x40]
        n = (e["size"] - e["start"]) // 8
        if n < 2 or not ys:
            continue
        arr = np.frombuffer(d, dtype="<i4", count=n * 2,
                            offset=e["off"] + e["start"]).reshape(-1, 2)
        xax, decided = _res_pick_x(axes, int(arr[-1, 0]), spans)
        xaxis, checked = xax, checked or decided
        # The y descriptor's own name is overwritten in place by the instrument
        # and comes out as debris ("0", "annel 2"), so the curve is named from
        # the directory: "2026Sep04no002:10_UV" is the UV trace of run no002.
        name = e["name"].rsplit("_", 1)[-1]
        unit = _res_unit(ys[0]["unit"])
        curves.append({
            "name": name, "unit": unit, "xunit": _res_unit(xax["unit"]) or "mL",
            "x": (arr[:, 0] * xax["factor"]).round(6).tolist(),
            "y": (arr[:, 1] * ys[0]["factor"]).round(6).tolist(),
        })

    if not curves:
        raise ValueError("read the .RES directory but found no curves in it")

    # The run's own name is the prefix the instrument gives its curve blocks —
    # "2026Sep04no002:10_UV" — not the name of the first block in the file.
    named = next((e["name"] for e in entries if ":" in e["name"]), "")
    run = {"id": named.split(":")[0],
           "xaxis": f"{xaxis['name']} ({xaxis['unit']})" if xaxis else "",
           "xaxisChecked": checked,
           "logbook": events.get("logbook", [])}
    inject = events.get("inject") or []
    if inject:
        run["inject"] = inject[0]["v"]
    for r in run["logbook"]:
        m = re.match(r"Method Run ([\d.]+,\s*[\d:]+)", r["label"])
        if m:
            run["started"] = m.group(1)
        m = re.match(r"Flow\s+([\d.]+)\s*ml/min", r["label"], re.I)
        if m and "flow" not in run:
            run["flow"] = float(m.group(1))

    for c in curves:
        c["ymin"], c["ymax"] = float(min(c["y"])), float(max(c["y"]))
        c["xmin"], c["xmax"] = float(min(c["x"])), float(max(c["x"]))
    return {
        "path": path, "encoding": "binary (UNICORN .RES)", "paired": False,
        "curves": curves,
        "fractions": [{"name": "Fractions", "marks": events["fractions"]}]
                     if events.get("fractions") else [],
        "run": run, "columns": len(curves), "rows": len(curves[0]["x"]),
    }


#: Column headings a spectrophotometer might use, against what they mean.  The
#: ratios are matched first: "A260/A280" contains "A280" and would otherwise be
#: read as the absorbance itself.
ND_COLUMNS = [
    ("ratio280", r"260\s*[/:]\s*280|a260\s*/\s*a280"),
    ("ratio230", r"260\s*[/:]\s*230|a260\s*/\s*a230"),
    ("a280", r"(^|[^0-9])a\.?\s*-?\s*280|280\s*nm|abs.*280|\b280\b"),
    ("a260", r"(^|[^0-9])a\.?\s*-?\s*260|260\s*nm|abs.*260|\b260\b"),
    ("sample", r"sample\s*(id|name)?|^name$|^id$|description"),
    ("conc", r"conc|ng\s*/\s*[u\u00b5]l|mg\s*/\s*ml|\bcorr"),
    ("unit", r"^units?$"),
    ("dil", r"dilut|\bfactor\b"),
    ("date", r"date|time"),
]


def looks_like_nanodrop(rows):
    """Is this a spectrophotometer table rather than a chromatogram?

    Not a question wording can answer: "UV 280" heads a column in both, and a
    NanoDrop export saying "Concentration (mg/mL)" trips any rule that treats
    millilitres as the mark of a trace.  The difference is structural — a trace
    is thousands of rows against a number that only goes up, while this is one
    row per sample whose first column is a name, not a coordinate.
    """
    first = next((i for i, r in enumerate(rows)
                  if sum(_num(c) is not None for c in r) >= 2), 0)
    if first < 1:
        return False
    header = [str(c).lower() for c in rows[first - 1]]
    body = rows[first:]
    if not any("280" in h for h in header):
        return False
    if len(body) > 200:
        return False
    named = sum(1 for r in body if r and r[0] and _num(r[0]) is None)
    if named >= max(1, len(body) * 0.5):
        return True
    return bool(re.search(r"sample|nanodrop|nucleic acid|260\s*/\s*280", " ".join(header)))


def parse_nanodrop(text):
    """Read a spectrophotometer export into readings."""
    lines = [l for l in text.split("\n") if l.strip()]
    if not lines:
        raise ValueError("the file is empty")
    delim = "\t" if lines[0].count("\t") >= lines[0].count(",") else ","
    rows = [[c.strip() for c in r] for r in csv.reader(lines, delimiter=delim)]

    first = next((i for i, r in enumerate(rows)
                  if sum(_num(c) is not None for c in r) >= 2), 1)
    header = rows[max(0, first - 1)]

    mapping = {}
    for i, h in enumerate(header):
        if not h:
            continue
        for key, pattern in ND_COLUMNS:
            if key not in mapping and re.search(pattern, h, re.I):
                mapping[key] = i
                break
    if "a280" not in mapping:
        raise ValueError("no A280 column — is this a spectrophotometer export?")

    used = set(mapping.values())
    out = []
    for r in rows[first:]:
        r = r + [""] * (len(header) - len(r))
        if _num(r[mapping["a280"]]) is None:
            continue
        note = "; ".join(f"{h} {r[i]}" for i, h in enumerate(header)
                         if i not in used and h and r[i])
        out.append({
            "sample": r[mapping["sample"]] if "sample" in mapping else "",
            "a280": _num(r[mapping["a280"]]),
            "a260": _num(r[mapping["a260"]]) if "a260" in mapping else None,
            "dil": _num(r[mapping["dil"]]) if "dil" in mapping else None,
            "vol": None,
            "instrument": _num(r[mapping["conc"]]) if "conc" in mapping else None,
            "instrumentUnit": r[mapping["unit"]] if "unit" in mapping else "",
            "note": note[:120],
        })
    if not out:
        raise ValueError("found an A280 column but no readings under it")
    return {"rows": out, "header": header, "mapped": sorted(mapping)}


def _paired_layout(body, units, width):
    """Is this the paired layout — one (x, value) pair per curve?

    The tell is that every even column is a volume that only ever goes up.  Two
    things make that harder to see than it sounds.  A fraction or injection pair
    holds a handful of rows against the curves’ tens of thousands, so a scan
    that gives up early finds nothing in it; and a blank cell is not evidence
    either way.  So a column with too few numbers *abstains* rather than voting
    the layout down — the old rule let one sparse pair veto a perfectly good
    export — and the units row corroborates, because in a paired export every
    even column carries the same volume unit.
    """
    if width < 4:
        return False
    votes = 0
    for c in range(0, width - 1, 2):
        seen, last = 0, None
        for r in body:
            v = _num(r[c])
            if v is None:
                continue
            if last is not None and v < last - 1e-9:
                return False                       # an x that goes backwards is not an x
            last, seen = v, seen + 1
        votes += seen >= 3
    if not votes:
        return False
    even = [(units[c] or "").strip().lower() for c in range(0, width - 1, 2)]
    if any(even) and len(set(even)) > 1:
        return False                               # the even columns are not one quantity
    return votes >= 2 or (len(set(even)) == 1 and bool(even[0]))


def parse_chromatogram(path):
    """UNICORN ASCII export, or any x/y table.

    A UNICORN export is UTF-16, tab separated, and laid out as *pairs* of
    columns — one (volume, value) pair per curve, each pair with its own
    x-axis, because the curves are not sampled together.  Two header rows name
    the curves and their units.  Everything downstream assumes one shared x and
    silently mangles this, so it is worth reading properly here.

    A binary .RES is recognized by its magic number rather than by its
    extension, because the ASCII export is often saved as .res too.
    """
    with open(path, "rb") as fh:
        if fh.read(4) == RES_MAGIC:
            return parse_res(path)

    text, encoding = _decode(path)
    lines = [l.rstrip("\r\n") for l in text.split("\n")]
    lines = [l for l in lines if l.strip()]
    if not lines:
        raise ValueError("empty file")

    delim = "\t" if lines[0].count("\t") >= lines[0].count(",") else ","
    rows = list(csv.reader(lines, delimiter=delim))
    width = max(len(r) for r in rows)
    rows = [r + [""] * (width - len(r)) for r in rows]

    # Where do the numbers start?  The first row whose first two cells parse.
    first_data = None
    for i, r in enumerate(rows):
        if _num(r[0]) is not None and any(_num(c) is not None for c in r[1:2]):
            first_data = i
            break
    if first_data is None:
        raise ValueError("no numeric rows found — is this a chromatogram export?")

    header = rows[:first_data]
    # UNICORN writes the run name, then the curve names, then the units; a plain
    # CSV writes one row of names.  Counting from the bottom reads both — and
    # reads the three-row export that a fixed "row 0 is names" rule labels
    # "Chrom.1" the whole way across.
    if len(header) >= 2:
        names, units = header[-2], header[-1]
    elif header:
        names, units = header[0], [""] * width
    else:
        names, units = [""] * width, [""] * width

    body = rows[first_data:]
    paired = _paired_layout(body, units, width)

    curves, fractions = [], []
    if paired:
        for c in range(0, width - 1, 2):
            name = (names[c] or names[c + 1] or f"curve {c // 2 + 1}").strip()
            unit = (units[c + 1] or "").strip()
            marks_only = _is_mark_column(name, unit)
            xs, ys, labels = [], [], []
            for r in body:
                x = _num(r[c])
                if x is None:
                    continue
                raw = (r[c + 1] or "").strip()
                if marks_only:
                    # The position is the mark.  An injection writes its volume
                    # with an empty label, and dropping it loses the one number
                    # that says which zero the x axis has.
                    labels.append({"v": x, "label": raw})
                    continue
                y = _num(r[c + 1])
                if y is None:
                    if raw:
                        labels.append({"v": x, "label": raw})
                else:
                    xs.append(x)
                    ys.append(y)
            if labels and not ys:
                fractions.append({"name": name, "marks": labels})
            elif xs:
                curves.append({"name": name, "unit": _res_unit(unit),
                               "xunit": _res_unit((units[c] or "mL").strip()),
                               "x": xs, "y": ys})
    else:
        xs = [_num(r[0]) for r in body]
        for c in range(1, width):
            name = (names[c] or f"curve {c}").strip()
            unit = (units[c] or "").strip()
            if _is_mark_column(name, unit):
                marks = [{"v": x, "label": (r[c] or "").strip()}
                         for x, r in zip(xs, body) if x is not None and (r[c] or "").strip()]
                if marks:
                    fractions.append({"name": name, "marks": marks})
                continue
            pts = [(x, _num(r[c])) for x, r in zip(xs, body)
                   if x is not None and _num(r[c]) is not None]
            if len(pts) > 2:
                curves.append({"name": name, "unit": _res_unit(unit),
                               "xunit": _res_unit((units[0] or "mL").strip()),
                               "x": [p[0] for p in pts], "y": [p[1] for p in pts]})

    if not curves:
        raise ValueError("parsed the file but found no curves")

    # An export carries the injection too, and the same question applies to it
    # as to a .RES: whether x counts from the method or from the sample going on.
    run = {}
    for f in fractions:
        if "inject" in f["name"].lower() and f["marks"]:
            run["inject"] = float(f["marks"][0]["v"])
            break

    for c in curves:
        c["ymin"], c["ymax"] = float(min(c["y"])), float(max(c["y"]))
        c["xmin"], c["xmax"] = float(min(c["x"])), float(max(c["x"]))
    return {
        "path": path, "encoding": encoding, "paired": paired,
        "curves": curves, "fractions": fractions, "run": run or None,
        "columns": width, "rows": len(body),
    }


def downsample(curve, n=1400):
    """Thin a curve for the canvas, keeping the extremes of each bucket.

    Plain decimation drops peak maxima, and a chromatogram is mostly a
    statement about peak maxima.
    """
    x, y = curve["x"], curve["y"]
    if len(x) <= n:
        return list(map(list, zip(x, y)))
    xs = np.asarray(x)
    ys = np.asarray(y)
    edges = np.linspace(0, len(xs), n // 2 + 1).astype(int)
    out = []
    for a, b in zip(edges, edges[1:]):
        if b <= a:
            continue
        seg = ys[a:b]
        i_lo, i_hi = a + int(seg.argmin()), a + int(seg.argmax())
        for i in sorted((i_lo, i_hi)):
            out.append([float(xs[i]), float(ys[i])])
    return out


def kav_fit(standards, v0, vt):
    """log10(MW) against Kav = (Ve - V0) / (Vt - V0).  Returns slope, intercept, r2."""
    pts = [(s["ve"], s["kDa"]) for s in standards
           if s.get("ve") is not None and s.get("kDa")]
    if len(pts) < 2 or vt is None or v0 is None or vt <= v0:
        return None
    kav = np.array([(ve - v0) / (vt - v0) for ve, _ in pts], dtype=float)
    logmw = np.array([np.log10(mw) for _, mw in pts], dtype=float)
    m, b = np.polyfit(kav, logmw, 1)
    pred = m * kav + b
    ss_res = float(((logmw - pred) ** 2).sum())
    ss_tot = float(((logmw - logmw.mean()) ** 2).sum()) or 1e-12
    return {"m": float(m), "b": float(b), "r2": 1.0 - ss_res / ss_tot, "n": len(pts)}


# ============================================================ mobility fit

def rf_fit(marks, gel_height):
    """log10(kDa) against relative mobility, from the ladder the user clicked.

    Straight-line, because that is what a fixed-percentage gel gives over the
    range it resolves.  r2 is returned rather than hidden: on a gradient gel it
    will be poor, and the honest response is to read sizes off the ladder
    instead of off a fit.
    """
    pts = [(m["y"] / gel_height, m["kDa"]) for m in marks
           if m.get("kDa") and m.get("y") is not None and gel_height]
    if len(pts) < 2:
        return None
    rf = np.array([p[0] for p in pts], dtype=float)
    logmw = np.array([np.log10(p[1]) for p in pts], dtype=float)
    m, b = np.polyfit(rf, logmw, 1)
    pred = m * rf + b
    ss_res = float(((logmw - pred) ** 2).sum())
    ss_tot = float(((logmw - logmw.mean()) ** 2).sum()) or 1e-12
    return {"m": float(m), "b": float(b), "r2": 1.0 - ss_res / ss_tot, "n": len(pts)}


# ================================================================== server

app = Flask(__name__, static_folder=HERE, static_url_path="")
app.register_blueprint(LKB.flask_blueprint(default_extensions=IMAGE_EXTS + TRACE_EXTS))


@app.after_request
def _no_cache(response):
    if request.path.endswith((".js", ".css", ".html")):
        response.headers["Cache-Control"] = "no-store"
    return response


@app.route("/")
def index():
    return send_from_directory(HERE, "index.html")


@app.route("/api/health")
def health():
    return jsonify({
        "ok": True,
        "tifffile": getattr(tifffile, "__version__", None),
        "pillow": getattr(Image, "__version__", None) if Image else None,
        "numpy": np.__version__,
        "imageExts": list(IMAGE_EXTS),
        "traceExts": list(TRACE_EXTS),
    })


def _fail(exc, code=500):
    traceback.print_exc()
    return jsonify({"error": f"{type(exc).__name__}: {exc}"}), code


def _image_payload(path, max_px=1400, dropped=None):
    """Everything needed to set up a panel, before any pixel is thrown away."""
    data, bits, note = read_image(path)
    stats = describe(data, bits)
    dark = stats["darkBands"]
    # A window that shows the bands without clipping them: the 0.1st and
    # 99.9th percentiles, widened a little, and never wider than the file.
    lo, hi = stats["p01"], stats["p999"]
    span = (hi - lo) or 1.0
    black, white = lo - 0.02 * span, hi + 0.02 * span
    preview = png_data_uri(apply_levels(data, black, white, 1.0, False), max_px=max_px)
    return jsonify({
        "path": path, "name": dropped or os.path.basename(path),
        "dropped": bool(dropped),
        "w": int(data.shape[1]), "h": int(data.shape[0]),
        "bits": bits, "note": note,
        # A Coomassie scan is already dark-on-light and wants no inversion; a
        # chemiluminescent or fluorescent image arrives light-on-dark and
        # is inverted for print.  `darkBands` says which one this is.
        "suggest": {"black": black, "white": white, "gamma": 1.0,
                    "invert": not dark},
        "preview": preview,
        **stats,
    })


@app.route("/api/image/open", methods=["POST"])
def image_open():
    body = request.get_json(force=True, silent=True) or {}
    try:
        return _image_payload(body.get("path"), int(body.get("maxPx", 1400)))
    except Exception as exc:
        return _fail(exc, 400 if isinstance(exc, (OSError, ValueError)) else 500)


#: Where dropped scans are kept for the session.  A browser will not hand out a
#: path, so the bytes come across instead and have to live somewhere the later
#: crop/level/lane calls can read them from.
UPLOAD_DIR = os.path.join(tempfile.gettempdir(), "purifig-dropped")


@app.route("/api/image/upload", methods=["POST"])
def image_upload():
    """A scan dropped on the canvas rather than picked off disk.

    A dropped file has no path -- the browser does not give one out -- so the
    bytes are posted here and written to a working copy, and everything after
    that is the ordinary path-based route: full depth, real statistics, the
    same crop and levels arithmetic on the original array.  The *original* file
    name is what reaches the record; the working copy's path is plumbing, and
    is flagged so the report can say the file came in by hand.
    """
    name = os.path.basename(request.args.get("name") or "dropped.tif")
    raw = request.get_data(cache=False)
    if not raw:
        return _fail(ValueError("no image data arrived"), 400)
    try:
        os.makedirs(UPLOAD_DIR, exist_ok=True)
        stamp = hashlib.sha1(raw).hexdigest()[:12]
        path = os.path.join(UPLOAD_DIR, f"{stamp}-{name}")
        if not os.path.exists(path):
            with open(path, "wb") as fh:
                fh.write(raw)
        return _image_payload(path, int(request.args.get("maxPx", 1400)), dropped=name)
    except Exception as exc:
        return _fail(exc, 400 if isinstance(exc, (OSError, ValueError)) else 500)


def _margin(prof, rng, cap=0.45, win=14, frac=0.045, rim_reach=0.0):
    """How far in from one end the background reaches, and why if it is nothing.

    The test is a *local* one: walk inward and stop at the first place where the
    line profile steps, comparing each window against the one before it rather
    than against the outermost line.  Comparing against the edge is what left
    background at the bottom of every scan -- a scanner bed shades gently from
    one end to the other, and by halfway down that drift alone exceeds any
    threshold small enough to catch a real edge, so the walk stopped on the
    shading instead of on the gel.  A gradient gives small steps between
    neighbors; the gel's rim gives one large one.

    Nothing found means nothing done: the side is left where it is, which is
    also the right answer for a gel already trimmed flush against that edge.
    """
    n = len(prof)
    look = int(n * cap)
    if look < 3 * win:
        return 0, "too small to judge"
    thr = frac * rng
    bg = float(np.median(prof[:win]))
    hold = win * 8                     # how far past a step it has to keep holding
    first = None
    for i in range(win, look):
        here = float(np.median(prof[i:i + win]))
        before = float(np.median(prof[i - win:i]))
        if abs(here - before) <= thr:
            continue
        # An edge is a step that *stays*; a band is a dip that comes back.  The
        # synthetic gel has a row of bands strong enough to move the whole row
        # median, and without this it reads as the top of the gel and takes half
        # the picture with it.  So the level has to still be different well past
        # the step before it counts as one.
        beyond = prof[i:i + hold] if i + hold <= len(prof) else prof[i:]
        if len(beyond) < win or abs(float(np.median(beyond)) - bg) <= thr:
            continue
        # Found sensitively, accepted strictly, and judged on the whole strip
        # rather than a window: what is about to be cut off has to look properly
        # unlike what is kept.  Between two lanes of a gel it does not -- the
        # densest lane differs from its neighbor by a twentieth of the range,
        # where a gel differs from the bed it is lying on by a quarter -- so
        # this is what keeps a crop from walking in and taking the ladder.
        if abs(float(np.median(prof[:i])) - float(np.median(beyond))) <= 0.10 * rng:
            continue
        first = i
        break
    if first is None:
        return 0, "flush, or no edge in the margin"
    if not rim_reach:
        return first, ""

    # A gel is outlined by a dark rim, and the first step is not it: the first
    # step is where the background stops being background -- the shadow lying
    # beside the gel -- so stopping there leaves that shadow in the crop.  Going
    # on to the rim is what puts the edge on the gel.
    #
    # Only ever along the height.  Across the width the nearest dark thing
    # inward is not a rim, it is the ladder, and walking to it crops the
    # standards off the gel.
    hi = min(len(prof) - 1, first + int(len(prof) * rim_reach))
    seg = prof[first:hi]
    if len(seg) < 3:
        return first, ""
    k = int(np.argmin(seg))
    inside = float(np.median(prof[hi:hi + win * 3])) if hi + win * 3 <= len(prof) else float(np.median(prof[hi:]))
    if min(bg, inside) - float(seg[k]) > 0.06 * rng:           # darker than both sides of it
        return min(first + k + win // 2, look), ""
    return first, ""


@app.route("/api/image/autocrop", methods=["POST"])
def image_autocrop():
    """Find the gel in the scan.

    Each side is judged on its own, so a gel already trimmed flush on one or two
    sides keeps those sides: a side with no margin to read is reported as flush
    and left where it is, rather than guessed at.  The whole thing errs towards
    cropping too little -- a margin of scanner bed is untidy, a crop through the
    ladder is lost data.
    """
    body = request.get_json(force=True, silent=True) or {}
    try:
        data, _bits, _note = read_image(body["path"])
        h, w = data.shape
        rng = float(np.percentile(data, 99.5) - np.percentile(data, 0.5)) or 1.0
        rows = np.median(data, axis=1)
        cols = np.median(data, axis=0)
        top, r_top = _margin(rows, rng, rim_reach=0.14)
        bottom, r_bottom = _margin(rows[::-1], rng, rim_reach=0.14)
        left, r_left = _margin(cols, rng)
        right, r_right = _margin(cols[::-1], rng)
        crop = {"x": left, "y": top, "w": w - left - right, "h": h - top - bottom}
        if crop["w"] < w * 0.2 or crop["h"] < h * 0.2:
            raise ValueError("that would have thrown most of the scan away")
        return jsonify({
            "crop": crop,
            "kept": round(crop["w"] * crop["h"] / float(w * h), 3),
            "sides": {"top": r_top, "bottom": r_bottom, "left": r_left, "right": r_right},
            "trimmed": {"top": top, "bottom": bottom, "left": left, "right": right},
        })
    except Exception as exc:
        return _fail(exc, 400 if isinstance(exc, (OSError, ValueError, KeyError)) else 500)


def _tilted_profile(sub, slope, how=np.median):
    """The picture's brightness down the frame, read along a tilted line.

    Median rather than mean across the width by default, so the ladder lane, the
    bands and whatever was written on the membrane in pencil do not move it --
    which is what looking for the edge of a membrane wants.  Looking for the
    rows of bands wants the opposite and asks for the mean: bands in three lanes
    of ten are exactly what the median throws away.
    """
    h, w = sub.shape
    dy = np.round(slope * (np.arange(w) - w / 2.0)).astype(int)
    i = np.clip(np.arange(h)[:, None] + dy[None, :], 0, h - 1)
    return how(np.take_along_axis(sub, i, 0), axis=1)


def _cuts(sub, near=4, far=14, least=0.06, floor=0.02, tilt=0.04):
    """Where a membrane was cut across, as rows of `sub` with how clear each is.

    A cut is a thin dark line: the pieces are laid back down against each other
    and what shows is the gap between them.  A fold, a curled edge, or the
    shading where a membrane stops is dark too, and *darker* -- on the blot this
    was written against the strongest dark line in the top membrane was a fold
    five times deeper than the cut.  So the test is not depth but width: a cut is
    already as dark against the membrane four pixels away as against the membrane
    fourteen pixels away, and a shadow is not, because at four pixels it is still
    inside itself.

    Slopes are searched because nobody lays a membrane down square, and a line
    one degree off runs across ten rows of a picture this size -- averaged down
    the columns it flattens into nothing.  Pieces thinner than `least` of the
    membrane are not cuts: no one probes a two-millimeter strip, and that is what
    the membrane's own bottom edge would otherwise be taken for.
    """
    h, w = sub.shape
    if h < 6 * far:
        return []
    rng = float(np.percentile(sub, 98) - np.percentile(sub, 2)) or 1.0
    edge = max(int(least * h), far + 2)
    best = {}
    # Finely enough that the worst slope error smears a cut by under a pixel:
    # coarser and a line one degree off is half flattened before it is judged.
    for slope in np.linspace(-tilt, tilt, 33):
        p = _tilted_profile(sub, slope)
        mid = slice(far, h - far)
        # Against what touches the line, and against the membrane well away from
        # it.  The second being much the larger is what a shadow looks like.
        tight = np.minimum(p[far - near:h - far - near], p[far + near:h - far + near]) - p[mid]
        wide = np.minimum(p[:h - 2 * far], p[2 * far:]) - p[mid]
        score = np.where(wide < 1.5 * tight, tight / rng, -np.inf)
        for i in np.flatnonzero(score > floor):
            row = far + int(i)
            if edge <= row <= h - edge and score[i] > best.get(row, (-9,))[0]:
                best[row] = (float(score[i]), float(slope))
    out = []
    for score, row, slope in sorted(((v, r, s) for r, (v, s) in best.items()), reverse=True):
        if all(abs(row - k["at"]) > edge for k in out):
            out.append({"at": row, "tilt": round(slope * w, 1), "clarity": round(score, 3)})
    return sorted(out, key=lambda c: c["at"])


def _membranes(data):
    """The membrane pieces lying in one field of view, and which sides are cuts.

    Several membranes in one picture is the ordinary case on an imager, and some
    of them are strips cut off a larger one and probed separately -- which is a
    thing a figure has to say, so each piece carries which of its four sides was
    a cut rather than the membrane's own edge.
    """
    h, w = data.shape
    ring = np.r_[data[:20].ravel(), data[-20:].ravel(),
                 data[:, :20].ravel(), data[:, -20:].ravel()]
    # The tray, taken from the border of the picture, because that is what the
    # border is.  Distance from it rather than "brighter than" it, so a white
    # light exported inverted finds its membranes just the same.
    bg = float(np.median(ring))
    lo, hi = np.percentile(data, [1, 99])
    far = np.abs(data - bg)
    span = float(hi - lo)

    # Two thresholds, because membranes in one field are not equally bright: on
    # a tray of seven, the dimmest read a quarter of the brightest and a single
    # threshold set off the picture's range left it out altogether.  So seed on
    # what is certainly membrane and grow that down to what is certainly not
    # tray, which is what hysteresis is for.
    keep = ndi.binary_propagation(far > 0.30 * span, mask=far > 0.15 * span)

    # Each membrane is its own connected piece of that, and looking for them
    # that way is the point.  The projections this replaced -- dark rows across
    # the whole picture, then dark columns within each band -- need the gaps
    # between membranes to line up into full-width and full-height lanes of
    # tray.  Nobody lays membranes out like that.  On a staggered tray of seven
    # there was no such gap anywhere, so the whole field came back as one
    # rectangle, which was then cut into quarters and offered as four panels
    # that were each part of three membranes.
    out = []
    sheet = 0
    lab, _n = ndi.label(keep)
    for i, box in enumerate(ndi.find_objects(lab), 1):
        piece = lab[box] == i
        # Trimmed to where the piece is most of the row, as before: a membrane
        # lies at an angle and the corners of its bounding box are tray, which
        # `_cuts` would otherwise read as a cut across the top of it.
        ry = np.flatnonzero(piece.mean(1) > 0.5)
        rx = np.flatnonzero(piece.mean(0) > 0.5)
        if not len(ry) or not len(rx):
            continue
        a, b = box[0].start + int(ry[0]), box[0].start + int(ry[-1]) + 1
        c, d = box[1].start + int(rx[0]), box[1].start + int(rx[-1]) + 1
        if b - a < 0.03 * h or d - c < 0.03 * w:
            continue
        sub = data[a:b, c:d]
        rows = _cuts(sub)
        cols = _cuts(sub.T)
        ys = [0] + [k["at"] for k in rows] + [b - a]
        xs = [0] + [k["at"] for k in cols] + [d - c]
        sheet += 1
        for i2 in range(len(ys) - 1):
            for j in range(len(xs) - 1):
                out.append({
                    "sheet": sheet, "x": c + xs[j], "y": a + ys[i2],
                    "w": xs[j + 1] - xs[j], "h": ys[i2 + 1] - ys[i2],
                    "cut": {"top": i2 > 0, "bottom": i2 < len(ys) - 2,
                            "left": j > 0, "right": j < len(xs) - 2},
                    "tilt": rows[i2 - 1]["tilt"] if i2 else (rows[0]["tilt"] if rows else 0.0),
                })
    return out


@app.route("/api/image/membranes", methods=["POST"])
def image_membranes():
    """The membranes in a field of view, cut lines and all.

    Asked of the white-light picture, where a membrane is a bright rectangle on
    a dark tray; the signal picture is mostly empty and says nothing about where
    a membrane stops.  The two are the same frame, so the rectangles fit both.
    """
    body = request.get_json(force=True, silent=True) or {}
    try:
        data, _bits, _note = read_image(body["path"])
        pieces = _membranes(data)
        if not pieces:
            raise ValueError("no membrane stands out from the tray in that picture")
        return jsonify({"pieces": pieces, "w": int(data.shape[1]), "h": int(data.shape[0])})
    except Exception as exc:
        return _fail(exc, 400 if isinstance(exc, (OSError, ValueError, KeyError)) else 500)


@app.route("/api/image/render", methods=["POST"])
def image_render():
    """Crop + orient + level, computed on the original array every time.

    Deliberately *not* incremental: re-leveling an already-leveled 8-bit
    render is how a figure ends up with posterized bands, and it cannot be
    undone afterwards.
    """
    body = request.get_json(force=True, silent=True) or {}
    try:
        data, bits, _ = read_image(body["path"])
        lv = body.get("levels") or {}
        rangeLo, rangeHi = full_range(bits, data)
        sub = oriented(crop_of(data, body.get("crop")),
                       body.get("rotate", 0), body.get("flipH", False),
                       body.get("flipV", False), body.get("tilt", 0))
        u8 = apply_levels(sub,
                          float(lv.get("black", rangeLo)),
                          float(lv.get("white", rangeHi)),
                          float(lv.get("gamma", 1.0)),
                          bool(lv.get("invert", False)))
        clipped_low = float((sub <= float(lv.get("black", rangeLo))).mean())
        clipped_high = float((sub >= float(lv.get("white", rangeHi))).mean())
        h, w = int(u8.shape[0]), int(u8.shape[1])
        over = body.get("overlay")
        if over:
            u8 = _overlay(u8, over, body)
        # w/h are the crop's own pixel dimensions, which are the coordinate
        # space the lane boundaries and ladder rungs are recorded in.  They
        # equal the encoded PNG's size whenever nothing was shrunk, which is
        # what the figure asks for; a shrunken preview is still placed by these
        # numbers and stretched to fit, so the geometry holds either way.
        return jsonify({
            "png": png_data_uri(u8, max_px=int(body.get("maxPx", 1600))),
            "w": w, "h": h,
            "clippedLow": clipped_low, "clippedHigh": clipped_high,
            "linear": abs(float(lv.get("gamma", 1.0)) - 1.0) < 1e-6,
        })
    except Exception as exc:
        return _fail(exc)


def _overlay(u8, over, body):
    """Multiply a second image of the same membrane onto the first.

    For a western, the white-light picture onto the chemiluminescence: the
    prestained ladder shows in the one and the signal in the other, and the
    product shows both where they really are relative to each other.  Both are
    leveled on their own original data first, dark-on-light, so multiplying
    keeps whatever is dark in either.

    The result is on the grid of the *first* image, the signal: when the white
    light was taken at a finer binning it is resampled down to match, never the
    signal up, because the signal is the evidence.  This is a composite and the
    record says so.
    """
    data, bits, _ = read_image(over["path"])
    lv = over.get("levels") or {}
    lo, hi = full_range(bits, data)
    sub = oriented(crop_of(data, over.get("crop")),
                   body.get("rotate", 0), body.get("flipH", False),
                   body.get("flipV", False), body.get("tilt", 0))
    m8 = apply_levels(sub, float(lv.get("black", lo)), float(lv.get("white", hi)),
                      float(lv.get("gamma", 1.0)), bool(lv.get("invert", False)))
    if m8.shape != u8.shape:
        if Image is None:
            raise RuntimeError("pillow is needed to match two images' sizes")
        m8 = np.asarray(Image.fromarray(m8, mode="L").resize((u8.shape[1], u8.shape[0]),
                                                            Image.BILINEAR))
    return ((u8.astype(np.uint16) * m8.astype(np.uint16) + 127) // 255).astype(np.uint8)


@app.route("/api/image/lanes", methods=["POST"])
def image_lanes():
    """Lane boundaries for a requested lane count, plus per-lane densitometry."""
    body = request.get_json(force=True, silent=True) or {}
    try:
        data, bits, _ = read_image(body["path"])
        lv = body.get("levels") or {}
        rangeLo, rangeHi = full_range(bits, data)
        sub = oriented(crop_of(data, body.get("crop")),
                       body.get("rotate", 0), body.get("flipH", False),
                       body.get("flipV", False), body.get("tilt", 0))
        u8 = apply_levels(sub, float(lv.get("black", rangeLo)),
                          float(lv.get("white", rangeHi)), 1.0,
                          bool(lv.get("invert", False)))
        dark = bool(body.get("darkBands", True))
        # Everything measured across the width is measured along the lanes, not
        # across them: on a gel leaning half a lane from top to bottom, a signal
        # summed down the raw columns has no gaps left in it to find.
        if body.get("leanL") is not None or body.get("leanR") is not None:
            lean_l, lean_r = float(body.get("leanL") or 0.0), float(body.get("leanR") or 0.0)
            came_from = "given"
        else:
            lean_l, lean_r = lane_skew(u8, dark)
            came_from = "lanes" if (lean_l or lean_r) else "nothing"
        # The rows of bands, when they are asked for or when the lanes could not
        # be read.  Not for free: it is a search over angles across the whole
        # picture, and the lanes are found on every change of lane count.
        deg, sure = (0.0, False)
        if body.get("straighten") or came_from == "nothing":
            deg, sure = band_tilt(u8, dark)
        if came_from == "nothing" and sure:
            # A picture turned clockwise has its lanes drifting left as they go
            # down -- the same angle the bands lie at, a quarter turn round.
            # But a gel can also run downhill and keep its lanes upright, and
            # the rows of bands say the same thing in both cases, so the shear
            # is tried before it is kept: on a picture that really is turned it
            # deepens the gaps between the lanes, and on an upright one it fills
            # them in.  Unchecked it was written onto every blot whose bands are
            # not level -- thirteen panels of one figure, one of them by 17 px,
            # lane boundaries leaning across bands that do not.
            cand = round(-u8.shape[0] * np.tan(np.radians(deg)), 2)
            if lane_relief(deskew(u8, cand, cand), dark) > lane_relief(u8, dark) * 1.02:
                lean_l = lean_r = cand
                came_from = "bands"
        flat = deskew(u8, lean_l, lean_r)
        sig = lane_signal(flat, dark)
        lanes = body.get("lanes")
        if lanes and body.get("even"):
            # The lanes as they are, at one pitch: which lane is which is
            # already settled and only the grid is re-fitted.
            lanes = even_lanes(flat, lanes, body.get("roles"), dark)
        elif not lanes:
            lanes = find_lanes(flat, sig, int(body.get("nLanes", 10)), dark,
                               bool(body.get("membrane")),
                               float(body.get("margin", 0.5) or 0))
        profiles = lane_profiles(flat, lanes, dark)
        return jsonify({
            "w": int(u8.shape[1]), "h": int(u8.shape[0]),
            "leanL": round(lean_l, 2), "leanR": round(lean_r, 2),
            "leanFrom": came_from,
            # How far the rows of bands are off level, for the straighten button
            # -- of the picture as it is now, so it is what is left to correct.
            "tiltDeg": deg if sure else 0.0, "tiltSure": sure,
            "lanes": [[l[0], l[1]] for l in lanes],
            "signal": [round(float(v), 4) for v in smooth(sig, 5)],
            "profiles": profiles,
        })
    except Exception as exc:
        return _fail(exc)


def _rungs(u8, x0, x1, dark, membrane):
    """The rungs of a ladder in one lane window, top down, with the comb row.

    Its own function because the window is not always known: on a western the
    lanes are invisible in the picture the ladder is in, so the lane has to be
    found by reading rungs out of every window and keeping the best.
    """
    h, w = u8.shape

    # Down the lane, with the lane's own background taken off: a ladder sits
    # on a gradient like everything else, and an untouched profile finds the
    # gradient before it finds the rungs.
    # Across the lane, the median and not the mean.  A rung is a bar that spans
    # the lane; a pen mark on the membrane, a sliver of the neighboring lane, a
    # corner of imager tray inside the crop are all dark over part of it.  The
    # mean adds those to whatever else is in the window, which is how a lane
    # half on the ladder and half on somebody's handwriting outscored the lane
    # the ladder is actually in.
    col = np.median(u8[:, x0:x1].astype(np.float32), axis=1)
    if dark:
        col = 255.0 - col

    # The baseline is a rolling *minimum*, not a rolling mean.  A mean rides
    # up over the closely spaced rungs at the top of a ladder and subtracts
    # them away with the background -- which is exactly where bands went
    # missing.  A minimum follows the gaps between them instead, so the
    # crowded end of the ladder survives.
    # Wider than a band, or the rolling minimum steps *into* the rung instead of
    # over it and subtracts it away with the background.  A twentieth of the
    # height is that on a whole gel; on a strip a couple of hundred rows tall it
    # is nine pixels, which is narrower than the bands, and the ladder came back
    # empty.  Fifteen is the smallest a band is on a picture worth measuring.
    win = max(15, (h // 20) | 1)
    base = smooth(_rolling_min(col, win), win)
    prof = smooth(col - base, max(3, (h // 260) | 1))

    # Two things at the ends of a lane are not bands.  The wells, which are
    # dark and sit above the resolving gel, so nothing that ran can be up
    # there; and the gel's own rim, which is a darker line than any band in
    # it and, left in, sets the scale for everything else -- every real rung
    # then measures as a rounding error against the edge of the gel.
    #
    # A membrane has neither.  Its top rung can sit a few per cent from the
    # edge, which blanking a tenth would cut off; what it does have is an
    # edge where the membrane stops and the imager tray begins, which is a
    # step and not a band -- tested for below instead.
    top = max(2, int(h * (0.015 if membrane else 0.10)))
    wells = None if membrane else wells_row(u8, dark)
    if wells is not None:
        # Where the wells actually end, in place of the guess.  Both ways:
        # a crop that kept the stacking gel used to have its comb counted as
        # a rung, and a crop trimmed close used to lose the top rung to the
        # blanking.  Capped at the top half, because a comb found halfway
        # down the picture is not a comb.
        top = int(min(wells + max(2, int(h * 0.01)), h * 0.45))
    prof[:top] = 0.0
    prof[-max(2, int(h * (0.015 if membrane else 0.03))):] = 0.0

    noise = float(np.median(np.abs(prof - np.median(prof)))) or 0.5
    thr = 2.5 * noise
    gap = max(3, int(h * 0.020))            # two rungs cannot be closer than this
    peaks = []
    for y in range(1, h - 1):
        if prof[y] < thr or prof[y] < prof[y - 1] or prof[y] < prof[y + 1]:
            continue
        if peaks and y - peaks[-1][0] < gap:
            if prof[y] > peaks[-1][1]:
                peaks[-1] = (y, float(prof[y]))
            continue
        peaks.append((y, float(prof[y])))

    # Two maxima with no valley between them are one band with a dent in it, not
    # two rungs.  The old rule was a minimum spacing taken as a share of the
    # height, which on a cut strip is four pixels and splits every broad rung in
    # two.  A dip is a length scale the picture supplies itself.
    merged = []
    for y, v in peaks:
        if merged:
            a = merged[-1][0]
            if float(prof[a:y].min()) > 0.5 * min(merged[-1][1], v):
                if v > merged[-1][1]:
                    merged[-1] = (y, v)
                continue
        merged.append((y, v))
    peaks = merged

    if membrane:
        # A band comes back down on both sides; the edge of the membrane
        # steps and stays, and against a rolling-minimum baseline that step
        # shows up as a hump of exactly a rung's shape.  So the raw profile
        # has to fall away on *both* sides of a peak, by at least half its
        # height above the baseline, within a few rung-widths.
        raw = smooth(col, max(3, (h // 260) | 1))
        kept = []
        for y, v in peaks:
            # How far to look is the band's own width, not a share of the
            # picture: a band is the same few pixels across whether the picture
            # is a whole gel or a strip cut off one.  Read as a fraction of the
            # height it collapsed to five pixels on a 203-row strip, which is
            # still inside the band -- so every rung looked like a step and the
            # ladder came back empty.
            half = y
            while half > 0 and prof[half] > 0.5 * v:
                half -= 1
            far = y
            while far < h - 1 and prof[far] > 0.5 * v:
                far += 1
            reach = min(max(6, 3 * max(2, (far - half) // 2)), h // 4)
            # And the membrane has to be there to look at.  A peak nearer the
            # edge than its own reach has nothing on one side to be compared
            # with, so it cannot be told from the edge -- and the edge of one of
            # these crops is the imager tray, which is darker than any rung.
            if y < reach or y + reach >= h:
                continue
            lo_side = raw[y - reach:y]
            hi_side = raw[y + 1:y + 1 + reach]
            drop = min(raw[y] - lo_side.min(), raw[y] - hi_side.min())
            if drop >= 0.5 * v:
                kept.append((y, v))
        peaks = kept

    # Judge a rung against the run of them, not against the strongest: one
    # overloaded band would otherwise decide that the rest are noise.
    vals = sorted(v for _y, v in peaks)
    ref = vals[int(len(vals) * 0.75)] if vals else 0.0
    # `strength` is relative to the run of rungs in this lane, which is what a
    # reader wants; `depth` is how dark the rung actually is, which is the only
    # one of the two that can be compared between lanes -- blank membrane has a
    # noise floor of nothing, so everything in it clears a threshold set from
    # its own noise and an empty lane can out-count a ladder.
    bands = [{"y": int(y), "strength": round(v / (ref or 1.0), 3), "depth": round(v, 2)}
             for y, v in peaks if v > ref * 0.12]
    return bands, wells


def _ladder_lane(u8, dark, membrane, wide):
    """Which window of a picture holds the size standards, and their rungs.

    On a western the white light shows the prestained ladder and nothing else:
    the samples are colorless until they are probed.  So the window with the
    most rungs in it is the ladder, because there is nothing else it could be
    -- and reading rungs out of a window is the same work either way, so the
    search is the detector run across the picture rather than a second idea of
    what a band looks like.
    """
    h, w = u8.shape
    wide = int(min(max(8, wide), w))
    best = (0.0, 0)
    for x0 in range(0, w - wide + 1, max(1, wide // 6)):
        bands, _ = _rungs(u8, x0, x0 + wide, dark, membrane)
        # How much ladder is in the window, in the picture's own units: a lane
        # half off the ladder reads the same rungs, fainter, and a blank one
        # reads a dozen peaks worth nothing at all.
        score = sum(b["depth"] for b in bands)
        if score > best[0]:
            best = (score, x0)
    return best[1], best[1] + wide


@app.route("/api/image/ladder", methods=["POST"])
def image_ladder():
    """Find the rungs of a ladder lane.

    Returns the row of each band it can see, from the top down, so the sizes can
    be typed against them instead of every band being clicked.  It reports what
    it found and does not decide how many there should be: a ladder that ran off
    the bottom, or whose smallest rungs washed out, has fewer bands than the
    tube says, and quietly inventing the missing ones would put a size on a
    position nothing was measured at.
    """
    body = request.get_json(force=True, silent=True) or {}
    try:
        data, _bits, _note = read_image(body["path"])
        sub = oriented(crop_of(data, body.get("crop")),
                       body.get("rotate", 0), body.get("flipH", False),
                       body.get("flipV", False), body.get("tilt", 0))
        lv = body.get("levels") or {}
        rangeLo, rangeHi = full_range(_bits, sub)
        u8 = apply_levels(sub, float(lv.get("black", rangeLo)),
                          float(lv.get("white", rangeHi)), 1.0,
                          bool(lv.get("invert", False)))
        dark = bool(body.get("darkBands", True))
        u8 = deskew(u8, float(body.get("leanL") or 0.0), float(body.get("leanR") or 0.0))

        h, w = u8.shape
        membrane = bool(body.get("membrane"))
        if body.get("x0") is None:
            wide = int(body.get("wide") or max(8, w // 10))
            x0, x1 = _ladder_lane(u8, dark, membrane, wide)
        else:
            x0 = max(0, int(body.get("x0", 0)))
            x1 = min(w, int(body.get("x1", w)))
        if x1 - x0 < 3:
            raise ValueError("that lane is too narrow to read")
        bands, wells = _rungs(u8, x0, x1, dark, membrane)
        return jsonify({"bands": bands, "h": int(h), "x0": int(x0), "x1": int(x1),
                        "wells": None if wells is None else int(wells)})
    except Exception as exc:
        return _fail(exc, 400 if isinstance(exc, (OSError, ValueError, KeyError)) else 500)


# ============================================================ quantification

def saturation_level(data, bits, dark_bands):
    """The value a pixel holds when the detector ran out of range.

    The file's own full scale, normally: 65535 for light bands on a 16-bit
    image, 0 for dark ones.  But a camera can saturate short of full scale -- a
    12-bit sensor written into 16 bits, an imager that clips at 65520 -- and that
    shows up as a *plateau*: many pixels sharing the image's extreme value
    exactly.  A real peak in continuous 16-bit data does not repeat its maximum,
    so eight or more pixels at it is a clip, wherever it happens to fall.

    Returns (level, how it was decided).
    """
    lo, hi = full_range(bits, data)
    level = lo if dark_bands else hi
    extreme = float(data.min() if dark_bands else data.max())
    if bits >= 12 and extreme != level and int((data == extreme).sum()) >= 8:
        return extreme, "plateau at the image's own extreme"
    if bits == 32:
        return (-np.inf if dark_bands else np.inf), "floating-point data has no fixed ceiling"
    return level, "the file's full scale"


def find_band(prof, y_click, reach):
    """The band nearest a click in one lane's profile, and how tall it is.

    The profile is taken off its own rolling-minimum baseline first -- the same
    baseline the ladder finder uses, and for the same reason: a mean would ride
    up over a band and subtract it away.  The highest point within `reach` of
    the click says *which* band; where that band starts and stops -- the profile
    falling to a tenth of the peak, or turning back up into a neighbor -- says
    where the box goes.  The box is centered between those two ends and reaches
    the longer of them on both sides, because a box that stops short on one side
    undercounts the band by exactly that side's tail.

    Centered on the ends and not on the maximum, which is the whole point: a
    band exposed past the camera's range has a flat top, `argmax` takes the
    first row of that plateau, and a box centered there sat half a band high
    while the dark half of the band hung out below it.

    Returns (middle row of the band, box height, peak height, signal-to-noise).
    A peak that does not clear three times the noise is not a band, and the
    click is kept where it was rather than being walked onto whatever noise is
    nearest.
    """
    n = len(prof)
    # The window has to be wider than a band or it sits *on* one.  Taken over a
    # twentieth of the panel it was five rows on a blot whose bands are twenty,
    # so the rolling minimum tracked each band's own plateau and subtracted it
    # away -- leaving the band standing as its two shoulders with a dip between
    # them.  The highest point of the lane was then the top edge of the band in
    # one lane and the bottom edge in the next, which is exactly how the boxes
    # came to sit high on some lanes and low on others.  A quarter of the panel,
    # and never less than four times the reach the caller searches over, since
    # that reach is what it knows about how far apart the rows are -- but never
    # past half the panel either, or on a strip cropped close around one band
    # the window covers the whole thing, the minimum stops following the
    # background and the band no longer stands out of it.
    win = max(5, (n // 4) | 1, min(int(round(4 * reach)), n // 2) | 1)
    win = min(win, n if n % 2 else n - 1)
    base = smooth(_rolling_min(prof, win), win)
    p = smooth(prof - base, max(3, (n // 300) | 1))
    # A millionth of the lane's own brightness under the measured noise, not a
    # flat 1e-9: a lane with no grain at all -- a region exposed to one value
    # throughout -- divided float32's own rounding by that constant and
    # reported a signal-to-noise of 3814 on nothing.
    noise = max(float(np.median(np.abs(p - np.median(p)))) * 1.4826,
                1e-6 * float(np.abs(prof).max()), 1e-9)
    a, b = max(1, int(round(y_click - reach))), min(n - 1, int(round(y_click + reach)) + 1)
    if b <= a:
        return int(round(y_click)), 8, 0.0, 0.0
    k = a + int(np.argmax(p[a:b]))
    peak = float(p[k])
    snr = peak / noise
    if snr < 3.0:
        return int(round(y_click)), None, peak, snr

    def walk(step):
        i = k
        while 0 < i + step < n:
            nxt = i + step
            if p[nxt] <= 0.10 * peak:
                return abs(nxt - k)
            if p[nxt] > p[i] and p[i] < 0.5 * peak:       # a valley: the next band starts
                return abs(i - k)
            i = nxt
        return abs(i - k)

    top, bot = k - walk(-1), k + walk(+1)
    mid = (top + bot) // 2
    half = max(mid - top, bot - mid)
    h = int(max(4, min(n * 0.25, 2 * half + 1)))
    return mid, h, peak, snr


def measure_bands(sig, satmask, boxes, method="border", border=3):
    """Integrated signal in each box, less its own background.

    `sig` is the signal the way round that more protein is more (a dark band's
    pixels are inverted against full scale, a light band's are taken as they
    are), already sheared along the lanes so that a box is a rectangle.

    Two backgrounds, both local to the lane the band is in:

    ``border``  the median of a thin strip just above and just below the box,
                in its own lane -- the "top/bottom" border of densitometry
                software.  Above and below rather than all round, because to
                either side of a lane is the gap to the next lane, which is a
                different background from the one under the band.
    ``profile`` a rolling minimum down the lane's profile, the ladder finder's
                baseline, taken per row under the box.  Better on a smeared
                lane, where the strip just above the band is still part of the
                smear.

    Nothing is clipped at zero: a box with nothing in it measures as roughly
    nothing, sometimes a little below, and that is the honest answer.
    """
    H, W = sig.shape
    out = []
    for b in boxes:
        x0 = int(max(0, min(W - 1, round(b["x0"]))))
        x1 = int(max(x0 + 1, min(W, round(b["x1"]))))
        h = int(max(2, round(b["h"])))
        y0 = int(round(b["y"] - h / 2.0))
        y1 = y0 + h
        y0c, y1c = max(0, y0), min(H, y1)
        if y1c - y0c < 1:
            out.append({"id": b.get("id"), "error": "outside the image"})
            continue
        box = sig[y0c:y1c, x0:x1]
        edge = y0 < 0 or y1 > H
        if method == "profile":
            prof = sig[:, x0:x1].mean(axis=1)
            win = max(2 * h + 1, (H // 20) | 1)
            base = smooth(_rolling_min(prof, win), win)
            bg_rows = base[y0c:y1c][:, None]
            net = float((box - bg_rows).sum())
            bg = float(bg_rows.mean())
        else:
            ring = np.concatenate([sig[max(0, y0c - border):y0c, x0:x1].ravel(),
                                   sig[y1c:min(H, y1c + border), x0:x1].ravel()])
            bg = float(np.median(ring)) if ring.size else float(np.percentile(box, 5))
            net = float((box - bg).sum())
        sat = int(satmask[y0c:y1c, x0:x1].sum())
        # Whether anything is there at all, measured here rather than only where
        # a box is searched for: the box moves, the crop moves and the lanes are
        # redrawn, and the answer has to move with them.
        #
        # Against the lane's own background -- every row of it outside the box
        # and its border -- and not against a rolling minimum down the panel,
        # which is what `find_band` has to use while it is still looking for the
        # band.  On a loading-control strip cropped close around one band that
        # minimum climbs onto the band itself, nothing stands out of anything,
        # and every lane reads as empty: 19 boxes of one figure wore a "?" and
        # all 19 were squarely on a visible band.
        prof = sig[:, x0:x1].mean(axis=1)
        keep = np.ones(H, bool)
        keep[max(0, y0c - border):min(H, y1c + border)] = False
        back = sig[keep, x0:x1] if keep.any() else box
        noise = float(np.median(np.abs(back - np.median(back)))) * 1.4826
        # And a box holding the darkest row of its own lane is on that lane's
        # band whatever the ratio says.  There is nothing else for it to be on.
        on_peak = bool(y0c <= int(np.argmax(prof)) < y1c)
        out.append({
            "id": b.get("id"),
            "x0": x0, "x1": x1, "y": round((y0c + y1c) / 2.0, 2), "h": int(y1c - y0c),
            "net": net, "raw": float(box.sum()), "bg": bg,
            "area": int(box.size), "peak": float(box.max() - bg),
            "sat": sat, "edge": bool(edge),
            "snr": round(float(box.max() - bg) / noise, 2) if noise > 0 else None,
            "onPeak": on_peak,
        })
    return out


@app.route("/api/image/quant", methods=["POST"])
def image_quant():
    """Measure bands: the integrated signal in a box, less its background.

    Always on the original data.  The display window, the gamma and the invert
    shape what the figure looks like; none of them enters a number here, so
    making a faint band visible for the figure cannot change how much of it
    there is.  The boxes are sheared along the lanes exactly as the boundaries
    are drawn, so a box on a leaning lane measures that lane and not a slice of
    it and its neighbor.

    A box sent with ``find`` is first moved onto the band nearest it (and, when
    it has no height yet, given one to fit): that is what a click does.
    """
    body = request.get_json(force=True, silent=True) or {}
    try:
        data, bits, _note = read_image(body["path"])
        dark = bool(body.get("darkBands", True))
        sub = oriented(crop_of(data, body.get("crop")),
                       body.get("rotate", 0), body.get("flipH", False),
                       body.get("flipV", False), body.get("tilt", 0)).astype(np.float32)
        lean_l, lean_r = float(body.get("leanL") or 0.0), float(body.get("leanR") or 0.0)
        level, level_why = saturation_level(data, bits, dark)
        clip = (sub <= level) if dark else (sub >= level)
        flat = deskew(sub, lean_l, lean_r)
        clip = deskew(clip.astype(np.float32), lean_l, lean_r) > 0.5
        lo, hi = full_range(bits, data)
        sig = (hi - flat) if dark else (flat - lo)
        H = sig.shape[0]

        boxes, found = [], {}
        for b in body.get("bands") or []:
            b = dict(b)
            if b.get("find"):
                x0 = int(max(0, min(sig.shape[1] - 1, round(b["x0"]))))
                x1 = int(max(x0 + 1, min(sig.shape[1], round(b["x1"]))))
                reach = float(b.get("reach") or max(6.0, H * 0.03))
                y, h, peak, snr = find_band(sig[:, x0:x1].mean(axis=1), float(b["y"]), reach)
                b["y"] = y
                if not b.get("h"):
                    b["h"] = h or max(6, int(H * 0.03))
                found[b.get("id")] = {"fitted": h is not None}
            if not b.get("h"):
                b["h"] = max(6, int(H * 0.03))
            boxes.append(b)
        out = measure_bands(sig, clip, boxes, body.get("method", "border"),
                            int(body.get("border", 3)))
        for m in out:
            m.update(found.get(m.get("id"), {}))
        return jsonify({
            "bands": out, "w": int(sig.shape[1]), "h": int(H), "bits": bits,
            "satLevel": None if not np.isfinite(level) else float(level),
            "satWhy": level_why,
            "signal": "inverted against full scale" if dark else "as recorded",
        })
    except Exception as exc:
        return _fail(exc, 400 if isinstance(exc, (OSError, ValueError, KeyError)) else 500)


@app.route("/api/image/rf", methods=["POST"])
def image_rf():
    body = request.get_json(force=True, silent=True) or {}
    fit = rf_fit(body.get("marks") or [], float(body.get("height") or 0))
    return jsonify({"fit": fit})


@app.route("/api/chrom/open", methods=["POST"])
def chrom_open():
    body = request.get_json(force=True, silent=True) or {}
    try:
        parsed = parse_chromatogram(body["path"])
        for c in parsed["curves"]:
            c["points"] = downsample(c, int(body.get("maxPoints", 1400)))
            c.pop("x", None)
            c.pop("y", None)
        parsed["name"] = os.path.basename(body["path"])
        return jsonify(parsed)
    except Exception as exc:
        return _fail(exc, 400)


@app.route("/api/nanodrop/open", methods=["POST"])
def nanodrop_open():
    """A spectrophotometer table read off disk.

    The parsing itself lives in the browser — this exists so the file dialog can
    reach a file the browser has no path for, and so a very large export does
    not have to cross into JS as one string.  The column matching is the same
    idea either way: whatever the header calls it, the A280 column is the one
    whose heading says 280.
    """
    body = request.get_json(force=True, silent=True) or {}
    try:
        text, _enc = _decode(body["path"])
        return jsonify(parse_nanodrop(text))
    except Exception as exc:
        return _fail(exc, 400)


@app.route("/api/chrom/calibrate", methods=["POST"])
def chrom_calibrate():
    body = request.get_json(force=True, silent=True) or {}
    fit = kav_fit(body.get("standards") or [], body.get("v0"), body.get("vt"))
    out = {"fit": fit}
    if fit and body.get("ve") is not None:
        v0, vt, ve = float(body["v0"]), float(body["vt"]), float(body["ve"])
        kav = (ve - v0) / (vt - v0)
        out["kav"] = kav
        out["kDa"] = float(10 ** (fit["m"] * kav + fit["b"]))
    return jsonify(out)


# ============================================================ sequence files

"""What a plasmid map says the protein is.

A construct panel is a drawing of a coding sequence, and the coding sequence is
already written down -- in the map the cloning was designed in.  Retyping it
into the panel is how a figure ends up describing a plasmid nobody has.

Read rather than trusted: the *frame* comes from the sequence, not from a CDS
feature.  An exported map often carries a CDS whose ends were typed by hand, and
a frame one base out translates to a protein that never existed -- with a mass
to match, which is the number the panel exists to print.  Features name the
pieces; the sequence decides where they are.
"""

SEQ_EXTS = (".gb", ".gbk", ".genbank", ".ape", ".dna", ".fa", ".fasta", ".seq", ".clc")

try:
    from Bio import SeqIO
    from Bio.Seq import Seq
except ImportError:                                        # pragma: no cover
    SeqIO = Seq = None

STOPS = ("TAA", "TAG", "TGA")

#: The 2A peptides, by the tail they share.  Ribosome skipping happens between
#: the last glycine and the proline, so the proline belongs to the *downstream*
#: protein and everything before it stays on the upstream one.
TWO_A = {
    "P2A": "ATNFSLLKQAGDVEENPGP",
    "T2A": "EGRGSLLTCGDVEENPGP",
    "E2A": "QCTNYALLKLAGDVESNPGP",
    "F2A": "VKQTLNFDLLKLAGDVESNPGP",
}
TWO_A_TAIL = re.compile(r"D[VI]E[ESQKNT]NPGP")

#: A segment that ends in a cut: the protease sites, and the tags that are
#: removed by cleaving straight after them.
CUT_LABEL = re.compile(r"\b(tev|3c|hrv|prescission|thrombin|enterokinase|"
                       r"factor\s*xa|sumo|ulp1|sortase|2a)\b", re.I)

#: Where each protease actually cuts, counted from the start of the sequence it
#: recognizes.  A map draws the whole recognition site as one feature, and the
#: enzyme does not cut at the end of it.
CUT_SITES = [
    (re.compile(r"ENLYFQ"), 6),           # TEV        ENLYFQ / G
    (re.compile(r"LEVLFQ"), 6),           # 3C         LEVLFQ / GP
    (re.compile(r"LVPR"), 4),             # thrombin   LVPR / GS
    (re.compile(r"DDDDK"), 5),            # enterokinase
    (re.compile(r"I[ED]GR"), 4),          # factor Xa
    (re.compile(r"LP.TG"), 4),            # sortase A  LPXT / G
]
IRES_LABEL = re.compile(r"\bires\b", re.I)

#: What a vector carries to stay alive.  A promoter in front of one of these is
#: never the one the figure is about, however much protein it makes.
VECTOR_GENE = re.compile(r"\b(ampr|bla|neor|kanr|nptii|cmr|cat|specr|tetr|puror|"
                         r"hygr|blastr|zeor|laci|lacz|rop|ccdb|sacb)\b", re.I)


def _feat_label(f):
    q = f.qualifiers
    for k in ("label", "gene", "product", "standard_name", "note"):
        if q.get(k):
            return str(q[k][0]).strip()
    return f.type


# ---- .clc, which carries a sequence and keeps everything else to itself -------

#: The sequence inside a CLC file: an ordinary Java `byte[]`, written with the
#: standard serialization header, holding a flag, the base count, and then the
#: bases two bits each -- A=0, C=1, G=2, T=3, high pair first.
CLC_ARRAY = re.compile(re.escape(b"ur\x00\x02[B") + rb".{8}\x02\x00\x00xp", re.S)


def _clc_sequence(blob):
    """The plasmid out of a .clc, or None when that file keeps it compressed.

    Nothing else in the file is read.  A .clc is a serialized Java object graph
    whose own classes write themselves, so the features -- their names, their
    types, their positions -- sit behind code that only CLC has.  The sequence
    does not: it is a plain byte array in the middle of the graph, and two bits
    a base leaves four arrangements to try.  The one below is the arrangement
    that reads the CMV promoter, the resistance gene and the polyA signal out of
    these files, at the positions a map of them puts them at.

    Some files hold no such array and a payload that will not compress any
    further, which is a compression nobody has published; those are still an
    export job, and this returns None for them rather than a guess.
    """
    best = None
    for m in CLC_ARRAY.finditer(blob):
        d = m.end()
        (size,) = struct.unpack(">i", blob[d:d + 4])
        a = blob[d + 4:d + 4 + size]
        if len(a) < 9 or a[0] != 0x80 or a[1] != 0xFE:
            continue
        n = struct.unpack(">H", a[2:4])[0]
        if len(a) - 8 != -(-n // 4):
            continue        # several blocks in one array, in a layout this cannot read
        bases = "".join("ACGT"[(x >> sh) & 3] for x in a[8:] for sh in (6, 4, 2, 0))
        # Longest, because a file edited from a parent keeps the parent's own
        # sequence beside it, and the one that was grown into is the longer.
        if len(bases) >= n and (best is None or n > len(best)):
            best = bases[:n]
    return best


#: What a sequence says about itself when its file says nothing.  Each motif sits
#: at the *end* of the element it names, because what is wanted from a promoter
#: is where transcription starts -- the ORF is looked for downstream of `b`.
#: A plasmid carries an origin of replication and a linear fragment does not, so
#: this is what says a FASTA -- which states no topology at all -- is circular.
#: Three cores that no vector in common use has drifted from: pUC/ColE1, f1, and
#: the pBR322 stretch the pET and pcDNA families kept.
ORI = re.compile("TTGAGATCCTTTTTTTCTGCGCGTAATCTGCTGCTTGCAAACAAA"
                 "|ACGCGCCCTGTAGCGGCGCATTAAGCGCGGCGGGTGTGGTGGTTACGCGCAGCGTGACC"
                 "|GCGGTGTGAAATACCGCACAGATGCGTAAGGAGAAAATACCGCATCAGG")

DNA_MOTIFS = [
    ("promoter", "T7 promoter", "TAATACGACTCACTATAG"),
    ("promoter", "SP6 promoter", "ATTTAGGTGACACTATAG"),
    ("promoter", "T3 promoter", "AATTAACCCTCACTAAAG"),
    ("promoter", "CMV promoter", "GGTAGGCGTGTACGGTGGGAGGTCTATATAAGCAGAGCT"),
    ("promoter", "SV40 promoter", "CCGCCCATTCTCCGCCCCATGGCTGACTAAT"),
    ("misc_feature", "EMCV IRES", "TAACGTTACTGGCCGAAGCCGCTTGGAATAAGGCC"),
]

#: And what a protein says about itself.  Only the pieces whose sequence is
#: settled: a tag, a linker, a protease site.  A domain -- a fluorophore, MBP --
#: comes in variants differing by a few residues, and naming one of them after
#: another is how a figure ends up asserting something nobody did.  It stays an
#: unnamed stretch with its length on it, which is a question rather than a claim.
PROTEIN_MARKS = [
    (re.compile(r"WSHPQFEK(GG..GG)?(WSHPQFEK)?"), "Strep-II"),
    (re.compile(r"DYKDDDDK"), "FLAG"),
    (re.compile(r"EQKLISEEDL"), "myc"),
    (re.compile(r"YPYDVPDYA"), "HA"),
    (re.compile(r"MDEKTTGWRGGHVVEGLAGELEQLRARLEHHPQGQREP"), "SBP-tag"),
    (re.compile(r"ENLYFQ[GS]?"), "TEV site"),
    (re.compile(r"LEVLFQ(GP)?"), "HRV 3C site"),
    (re.compile(r"LVPR(GS)?"), "thrombin site"),
    (re.compile(r"DDDDK"), "enterokinase site"),
    (re.compile(r"I[ED]GR"), "factor Xa site"),
    (re.compile(r"(GGGGS){2,}|(GS){3,}"), "linker"),
]


def _dna_marks(seq):
    """Promoters and an IRES, found in the sequence, for a file with no features."""
    out = []
    rc = str(Seq(seq).reverse_complement())
    for kind, label, motif in DNA_MOTIFS:
        for strand, hay in ((1, seq), (-1, rc)):
            i = hay.find(motif)
            while i >= 0:
                a = i if strand > 0 else len(seq) - i - len(motif)
                out.append({"kind": kind, "label": label, "a": a, "found": True,
                            "b": a + len(motif), "strand": strand})
                i = hay.find(motif, i + 1)
    return sorted(out, key=lambda f: f["a"])


def _protein_marks(prot, at):
    """The tags and sites a protein carries, as features on the DNA under it.

    Same shape as a map's own features, so a chain read this way goes through
    exactly the same machinery afterwards: the site is cut at its scissile bond,
    a 2A is split before its proline, the rest stays unnamed.
    """
    marks = [(m.start(), m.end(), "%dxHis" % len(m.group()))
             for m in re.finditer(r"H{6,12}", prot)]
    marks += [(m.start(), m.end(), label)
              for rx, label in PROTEIN_MARKS for m in rx.finditer(prot)]
    # Longest wins where two overlap: DDDDK is enterokinase on its own and the
    # tail of a FLAG tag inside one, and a FLAG tag is what it is.
    keep = []
    for r0, r1, label in sorted(marks, key=lambda m: m[0] - m[1]):
        if not any(r0 < k1 and k0 < r1 for k0, k1, _ in keep):
            keep.append((r0, r1, label))
    return [{"kind": "misc_feature", "label": label, "strand": 1,
             "a": at + 3 * r0, "b": at + 3 * r1} for r0, r1, label in sorted(keep)]


def read_sequence_file(path):
    """(name, sequence, features, circular) from a plasmid map.

    GenBank and SnapGene, through Biopython, which parses both and is the same
    code the rest of the field reads these files with.
    """
    ext = os.path.splitext(path)[1].lower()
    name = os.path.splitext(os.path.basename(path))[0]
    if ext == ".clc":
        with open(path, "rb") as fh:
            seq = _clc_sequence(fh.read())
        if not seq:
            raise ValueError(
                "this .clc keeps its sequence compressed, in a form nobody outside "
                "CLC has published, so there is nothing in it to read. In CLC: "
                "File ▸ Export ▸ GenBank, then open the .gb here.")
        # The plasmid and nothing else: the features are behind the part of the
        # file that is CLC's own, so what the panel names, it finds in the bases.
        return name, seq, _dna_marks(seq), True
    if SeqIO is None:
        raise ValueError("reading sequence files needs Biopython — pip install biopython")
    fmt = {".dna": "snapgene", ".fa": "fasta",
           ".fasta": "fasta", ".seq": "fasta"}.get(ext, "genbank")
    recs = list(SeqIO.parse(path, fmt))
    if not recs:
        raise ValueError("that file holds no sequence record")
    if len(recs) > 1:
        # One file, one construct.  Reading the first of several silently is how a
        # panel ends up titled after one binder and drawn from another.
        names = ", ".join(str(r.id) for r in recs[:4]) + (", …" if len(recs) > 4 else "")
        raise ValueError(
            f"that file holds {len(recs)} sequences ({names}) — this reads one construct "
            "at a time, so split it or keep the one you want")
    rec = recs[0]
    seq = str(rec.seq).upper().replace("U", "T")
    feats = [{"kind": f.type, "label": _feat_label(f),
              "a": int(f.location.start), "b": int(f.location.end),
              "strand": -1 if (f.location.strand or 1) < 0 else 1}
             for f in rec.features if f.type != "source"]
    # A FASTA states no topology, and most of the ones anybody opens here are
    # plasmids -- so an origin of replication in the sequence is what says so.
    # Guessing circular outright would invent frames across the join of a
    # sequencing read, and half the reads in a lab folder are exactly that.
    circular = (bool(ORI.search(seq) or ORI.search(str(Seq(seq).reverse_complement())))
                if fmt == "fasta" else
                rec.annotations.get("topology") == "circular")
    # A FASTA, or a map that annotates nothing, gets the same treatment as a .clc.
    return name, seq, feats or _dna_marks(seq), circular


def _flip(seq, feats):
    """The other strand, with every feature carried over to it."""
    L = len(seq)
    rc = str(Seq(seq).reverse_complement())
    out = [{**f, "a": L - f["b"], "b": L - f["a"], "strand": -f["strand"]} for f in feats]
    return rc, sorted(out, key=lambda f: f["a"])


def _orf_from(run, i):
    """Where the reading frame opened at `i` stops, or None if it never does."""
    while i + 3 <= len(run):
        if run[i:i + 3] in STOPS:
            return i
        i += 3
    return None


def _orf_after(run, at, window=600, least=40):
    """The ORF a promoter drives: the first one that opens within `window` of it.

    The first, because that is how the ribosome reads it -- it scans from the
    cap and starts at the ATG it meets.  Not the longest: within a few hundred
    bases of the start codon there is usually a vector's own gene, and on a pET
    map the longest frame anywhere near the promoter is the repressor.

    `least` throws away the short frames that open by accident in an intron or a
    cloning site on the way; nothing anybody purifies is forty residues long.
    """
    for i in range(at, min(at + window, max(at, len(run) - 2))):
        if run[i:i + 3] != "ATG":
            continue
        e = _orf_from(run, i)
        if e is not None and (e - i) // 3 >= least:
            return i, e
    return None


def _open_frames(run, upto, least=100):
    """Every reading frame in a sequence nothing points into, longest first.

    A FASTA carries no promoter and no features at all, and neither do some
    .clc files -- so the frame has to come from the sequence itself.  An ATG
    inside a longer frame is the same gene read from a later start, so only the
    outermost one per stop is kept, and a frame running through an N is dropped
    because those residues would go missing out of the mass without saying so.
    """
    out = []
    for i in range(0, min(len(run) - 2, upto)):
        if run[i:i + 3] != "ATG":
            continue
        e = _orf_from(run, i)
        if e is not None and (e - i) // 3 >= least and "N" not in run[i:e]:
            out.append((i, e))
    ends = {}
    for a, b in out:
        ends[b] = min(ends.get(b, a), a)
    return sorted(((a, b) for b, a in ends.items()), key=lambda o: o[0] - o[1])


def _split_two_a(segs):
    """Mark a 2A where one is, wherever the pieces happened to fall.

    Skipping is not cleavage, but it leaves two chains just the same, and the
    break is between the last glycine and the proline -- so the proline starts
    the downstream protein and the rest of the peptide stays behind.
    """
    out = []
    for s in segs:
        m = TWO_A_TAIL.search(s["seq"])
        if not m:
            out.append(s)
            continue
        name, at = "2A", m.start()
        for k, v in TWO_A.items():
            i = s["seq"].find(v)
            if i >= 0:
                name, at = k, i
                break
        end = m.end() - 1                       # before the final proline
        if at:
            out.append({**s, "seq": s["seq"][:at]})
        out.append({"name": name, "seq": s["seq"][at:end], "cut": True})
        if s["seq"][end:]:
            out.append({"name": "", "seq": s["seq"][end:]})
    return out


def _inner(feats, a, b):
    """The features the map draws *inside* a reading frame: its tags, its sites.

    How the relevant promoter is told from the vector's own: a map annotates the
    construct it was made for, and leaves the resistance marker as one block.
    """
    # b + 3, because a CDS conventionally takes in its stop codon and a frame does not.
    return [f for f in feats
            if f["strand"] > 0 and f["a"] >= a - 2 and f["b"] <= b + 3
            and f["kind"] not in ("source", "primer_bind", "rep_origin")]


def _trim_cuts(segs):
    """Put the cut where the protease cuts, not where the feature ends.

    3C reads LEVLFQ/GP: the GP stays on the downstream protein.  Two residues
    either way is 154 Da, which is the difference between a mass that checks
    against the gel and one that quietly does not.
    """
    out = []
    for s in segs:
        m = next(((rx.search(s["seq"]), keep) for rx, keep in CUT_SITES
                  if s.get("cut") and rx.search(s["seq"])), None)
        if not m:
            out.append(s)
            continue
        at = m[0].start() + m[1]
        out.append({**s, "seq": s["seq"][:at]})
        if s["seq"][at:]:
            out.append({"name": "", "seq": s["seq"][at:], "cut": False})
    return out


def _merge_plain(segs):
    """Two unnamed stretches side by side are one unnamed stretch."""
    out = []
    for s in segs:
        if out and not s["name"] and not out[-1]["name"] \
                and not out[-1].get("cut") and not s.get("cut"):
            out[-1] = {**out[-1], "seq": out[-1]["seq"] + s["seq"]}
        else:
            out.append(s)
    return out


def _chain(run, feats, a, b, via):
    """One polypeptide: the ORF's residues, cut into the pieces named on the map.

    Short features win a clash.  A map usually carries both the whole coding
    sequence and the tags inside it, and the tags are the part a purification
    figure is about; the long feature is then the chain's own name rather than
    a segment.
    """
    prot = str(Seq(run[a:b]).translate())
    aa = len(prot)
    # Where the map annotated nothing inside the frame -- a .clc, a bare FASTA,
    # an insert nobody labeled -- the protein is asked instead.
    inside = _inner(feats, a, b) or _protein_marks(prot, a)
    whole = [f for f in inside if (f["b"] - f["a"]) >= 0.8 * (b - a)]
    rest = [f for f in inside if (f["b"] - f["a"]) < 0.8 * (b - a)]
    parts, taken = [], []
    for f in sorted(rest, key=lambda f: f["b"] - f["a"]):
        r0, r1 = round((f["a"] - a) / 3), round((f["b"] - a) / 3)
        r0, r1 = max(0, min(aa, r0)), max(0, min(aa, r1))
        if r1 - r0 < 1 or any(r0 < t1 and t0 < r1 for t0, t1 in taken):
            continue
        taken.append((r0, r1))
        parts.append((r0, r1, f["label"]))
    parts.sort()

    segs, at = [], 0
    for r0, r1, label in parts:
        if r0 > at:
            segs.append({"name": "", "seq": prot[at:r0]})
        segs.append({"name": label, "seq": prot[r0:r1], "cut": bool(CUT_LABEL.search(label))})
        at = r1
    if at < aa:
        segs.append({"name": "", "seq": prot[at:]})
    segs = _merge_plain(_trim_cuts(_split_two_a([s for s in segs if s["seq"]])))

    # The chain's name: a feature that is the whole coding sequence names it,
    # and otherwise the biggest unnamed stretch is the protein and the named
    # pieces around it are its tags.
    name = max(whole, key=lambda f: f["b"] - f["a"])["label"] if whole else ""
    big = max(segs, key=lambda s: len(s["seq"]))
    big["name"] = big["name"] or name           # the chain drawn as one bar is still named
    big["start"] = 1                            # the protein's own numbering starts here
    for s in segs:
        s.setdefault("cut", False)
    return {"name": name, "via": via, "aa": aa,
            "dna": [a, b], "segs": segs}


def construct_from_map(path, promoter=None):
    """The proteins a plasmid makes, read off its map.

    One chain per cistron: the promoter drives the first, and an IRES hands the
    ribosome a second one that is a separate protein rather than a fusion.  A 2A
    inside a chain is marked where it is, because it leaves two proteins too --
    by skipping rather than by cleaving, which is a different mechanism and the
    same thing to weigh.
    """
    name, seq, feats, circular = read_sequence_file(path)
    if len(seq) < 60:
        raise ValueError("there is no sequence in that file")

    opts = []
    for strand in (1, -1):
        s, fs = (seq, feats) if strand > 0 else _flip(seq, feats)
        run = s + (s if circular else "")
        for f in sorted((f for f in fs if f["kind"] == "promoter" and f["strand"] > 0),
                        key=lambda f: f["a"]):
            orf = _orf_after(run, f["b"])
            parts = _inner(fs, *orf) if orf else []
            vector = bool(VECTOR_GENE.search(f["label"])) or \
                any(VECTOR_GENE.search(p["label"]) for p in parts)
            opts.append({"label": f["label"], "at": f["b"], "strand": strand,
                         "aa": (orf[1] - orf[0]) // 3 if orf else 0,
                         "parts": len(parts), "vector": vector,
                         "orf": orf, "run": run, "feats": fs})
    # True when nothing in the file named anything: a .clc, or a bare FASTA.
    found = all(f.get("found") for f in feats)
    # Nothing in the file points at a gene.  The frames are then the menu, and the
    # one carrying the tags is the one somebody built: a vector's own resistance
    # gene is long, but it has no His run and no protease site in it.
    guessed = not opts
    if guessed:
        for strand in (1, -1):
            s, fs = (seq, feats) if strand > 0 else _flip(seq, feats)
            run = s + (s if circular else "")
            for a, b in _open_frames(run, len(s))[:8]:
                parts = _inner(fs, a, b) or _protein_marks(str(Seq(run[a:b]).translate()), a)
                opts.append({"label": "open frame at %d" % (a + 1), "at": a,
                             "strand": strand, "aa": (b - a) // 3, "parts": len(parts),
                             "vector": False, "orf": (a, b), "run": run, "feats": fs})
    if not opts:
        raise ValueError(
            "nothing in that sequence reads as a protein: no promoter this knows by heart "
            "(T7, SP6, T3, CMV, SV40) and no open reading frame of 100 residues or more")

    live = [o for o in opts if o["orf"]]
    pick = None
    if promoter:
        pick = next((o for o in live if o["label"] == promoter), None)
    if pick is None:
        # Not the one driving the most protein: on a pET vector that is often the
        # repressor.  The one driving the coding sequence the map bothered to
        # annotate, then the one that is not a marker, then the longest.  Two
        # promoters in tandem in front of one gene -- a CMV for the cell and a
        # T7 for the bench -- land on the same ORF, and it does not matter which
        # of them is named.
        pick = max(live, key=lambda o: (not o["vector"], o["parts"], o["aa"])) if live else None
    if pick is None:
        raise ValueError("no reading frame opens after any promoter in that map")

    run, fs = pick["run"], pick["feats"]
    chains = [_chain(run, fs, pick["orf"][0], pick["orf"][1], pick["label"])]
    end = pick["orf"][1]
    for f in sorted((f for f in fs if IRES_LABEL.search(f["label"]) and f["a"] >= end),
                    key=lambda f: f["a"]):
        orf = _orf_after(run, f["b"], window=400)
        if not orf:
            continue
        chains.append(_chain(run, fs, orf[0], orf[1], f["label"] or "IRES"))
        end = orf[1]

    return {
        "name": name, "len": len(seq), "circular": circular, "found": found,
        "guessed": guessed,
        "promoters": [{"label": o["label"], "aa": o["aa"], "strand": o["strand"],
                       "parts": o["parts"]} for o in opts],
        "promoter": pick["label"], "chains": chains,
    }


BLAST_URL = "https://blast.ncbi.nlm.nih.gov/Blast.cgi"

#: swissprot first because it is small enough to come back in a few minutes and
#: its descriptions are names rather than accessions; nr when swissprot has never
#: heard of the thing, which is most engineered proteins.
BLAST_DBS = ("swissprot", "nr", "pdb", "refseq_protein")


def _blast_post(fields):
    data = urllib.parse.urlencode(fields).encode()
    req = urllib.request.Request(BLAST_URL, data, {"User-Agent": "purifig"})
    with urllib.request.urlopen(req, timeout=60) as fh:
        return fh.read()


def _blast_start(seq, db):
    """Hand a protein to NCBI's queue and come straight back with the ticket.

    A ticket rather than an answer, because that queue is minutes long and
    sometimes twenty.  A route that waited would hold a browser request open for
    all of it, and the ticket is NCBI's own, so nothing on this side has to
    remember a job, clean one up, or survive a restart holding one.
    """
    if db not in BLAST_DBS:
        raise ValueError("no such database: " + db)
    page = _blast_post({"CMD": "Put", "PROGRAM": "blastp", "DATABASE": db,
                        "HITLIST_SIZE": 8, "QUERY": seq}).decode("utf-8", "replace")
    m = re.search(r"^ *RID = (\S+)", page, re.M)
    if not m:
        raise ValueError("NCBI did not take that search")
    return m.group(1)


def _hit_name(desc):
    """A name for a bar, out of what a database calls an entry.

    `RecName: Full=Green fluorescent protein [Aequorea victoria]` is the whole
    of what a figure wants said in three words, wrapped in the rest of a record.
    """
    d = desc.split(" >")[0]                                  # identical entries, one line
    d = re.sub(r"^RecName: Full=", "", d)
    d = re.split(r"; ?(?:AltName|Short|Flags|Contains)", d)[0]
    d = re.sub(r"\s*\[[^\]]*\]\s*$", "", d)                  # the organism
    return d.strip(" ;.") or desc


def _blast_fetch(rid):
    """The hits for a ticket, or None while NCBI is still working on it."""
    info = _blast_post({"CMD": "Get", "FORMAT_OBJECT": "SearchInfo",
                        "RID": rid}).decode("utf-8", "replace")
    m = re.search(r"Status=(\w+)", info)
    status = m.group(1) if m else "UNKNOWN"
    if status == "WAITING":
        return None
    if status != "READY":
        raise ValueError("NCBI no longer has that search (%s) — start it again" % status)

    from Bio import Blast
    rec = Blast.read(io.BytesIO(_blast_post({"CMD": "Get", "FORMAT_TYPE": "XML", "RID": rid})))
    n = max(1, len(rec.query))
    out = []
    for hit in rec:
        hsp = hit[0]
        a = hsp.annotations
        # The query's own row of the alignment, so coverage is of the piece that
        # was asked about rather than of whatever the database entry is long.
        span = abs(int(hsp.coordinates[1][-1] - hsp.coordinates[1][0]))
        out.append({"name": _hit_name(hit.target.description),
                    "acc": (hit.target.id or "").strip("|").split("|")[-1],
                    "ident": round(100 * a["identity"] / max(1, hsp.length)),
                    "cover": min(100, round(100 * span / n)),
                    "evalue": "%.0e" % a["evalue"] if a["evalue"] else "0"})
    return out


@app.route("/api/seq/blast", methods=["POST"])
def seq_blast():
    """What a stretch of protein is, asked of NCBI.

    The only thing in purifig that sends anything off this machine, which is why
    it is a button somebody presses rather than a step in reading a map.  Post a
    sequence to get a ticket, post the ticket to get the hits.
    """
    body = request.get_json(force=True, silent=True) or {}
    try:
        if body.get("rid"):
            hits = _blast_fetch(str(body["rid"]))
            return jsonify({"rid": body["rid"]} if hits is None else {"hits": hits})
        seq = re.sub(r"[^A-Za-z]", "", str(body.get("seq") or "")).upper()
        if len(seq) < 12:
            raise ValueError("a BLAST needs at least a dozen residues to say anything")
        return jsonify({"rid": _blast_start(seq, str(body.get("db") or "swissprot"))})
    except Exception as exc:
        return _fail(exc, 400 if isinstance(exc, ValueError) else 502)


@app.route("/api/seq/construct", methods=["POST"])
def seq_construct():
    """Read a plasmid map into the pieces a construct panel draws."""
    body = request.get_json(force=True, silent=True) or {}
    try:
        return jsonify(construct_from_map(body["path"], body.get("promoter")))
    except StopIteration:
        return _fail(ValueError("that file holds no sequence record"), 400)
    except Exception as exc:
        return _fail(exc, 400 if isinstance(exc, (OSError, ValueError, KeyError)) else 500)


# ==================================================================== sessions

#: Where the working state goes when nobody has said where.  An autosave that
#: lives in the browser dies with the browser, which is the one failure it
#: exists to survive.
STATE_DIR = os.path.join(os.path.expanduser("~"), ".purifig")
AUTOSAVE = os.path.join(STATE_DIR, "autosave.purifig.json")

SESSION_EXT = ".purifig.json"


def _session_path(raw):
    """Normalize what the browser sent into a path this will actually write."""
    path = os.path.abspath(os.path.expanduser(str(raw or "").strip()))
    if os.path.isdir(path):
        raise ValueError(f"{path} is a folder — give the session a file name too")
    if not path.lower().endswith(".json"):
        path += SESSION_EXT
    return path


def _sidecar(path):
    """The folder beside a session that holds the scans it would otherwise lose."""
    base = os.path.basename(path)
    for ext in (SESSION_EXT, ".json"):
        if base.lower().endswith(ext):
            base = base[: -len(ext)]
            break
    return os.path.join(os.path.dirname(path), base + ".files")


def _rehouse(session, path):
    """Give dropped scans a home next to the session.

    A scan picked off disk is referenced where it lives, and the session stays
    small.  A scan *dropped* on the canvas has no home: the browser hands over
    bytes and no path, so it was written into a temp folder that the operating
    system empties whenever it feels like it.  Saving a session that points
    into that folder is saving a link that will be dead by next week, so the
    file is copied out and the copy is what gets recorded.

    Returns the names copied, so the answer can say what it did.
    """
    copied = []
    sources = ((session.get("doc") or {}).get("sources") or [])
    for src in sources:
        old = src.get("path")
        if not old or not str(old).startswith(UPLOAD_DIR):
            continue
        if not os.path.exists(old):
            continue
        folder = _sidecar(path)
        os.makedirs(folder, exist_ok=True)
        dest = os.path.join(folder, os.path.basename(old))
        if os.path.abspath(dest) != os.path.abspath(old):
            shutil.copy2(old, dest)
        src["path"] = dest
        copied.append(os.path.basename(dest))
    return copied


def _check_sources(session):
    """Which scans this session refers to are not where it left them.

    Reported rather than repaired: the figure itself still draws, because every
    panel carries its own rendered image, but re-cropping or re-leveling needs
    the original and would otherwise fail with nothing to explain it.
    """
    missing = []
    for src in ((session.get("doc") or {}).get("sources") or []):
        path = src.get("path")
        if path and not os.path.exists(path):
            missing.append({"id": src.get("id"), "name": src.get("name"), "path": path})
    return missing


def _write_session(path, session):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    # Written beside the target and moved into place, so an interrupted save
    # cannot leave a half-written session where a whole one used to be.
    tmp = path + ".part"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(session, fh, ensure_ascii=False)
    os.replace(tmp, path)
    return os.path.getsize(path)


def _free_path(path):
    """A path nothing is at yet.  An export is cheap to repeat and a protocol
    is not: picking the same name twice adds -2, it does not overwrite."""
    base, ext = os.path.splitext(path)
    out, n = path, 1
    while os.path.exists(out):
        n += 1
        out = f"{base}-{n}{ext}"
    return out


# ---- the figure as a vector PDF ----

#: Nothing installed here can turn an SVG into a PDF -- cairosvg, svglib,
#: reportlab and fitz are all absent -- and ImageIO's own route,
#: `sips -s format pdf`, rasterizes it to a *JPEG* inside a PDF wrapper, which
#: is the one thing a vector export must not be.  A headless browser is the
#: renderer this machine does have: it keeps the labels as embedded TrueType
#: text and the scans as lossless image XObjects, and it is the same engine
#: that drew the figure on screen, so there is no second implementation to
#: drift away from it.
CHROME_PATHS = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
]


def find_chrome():
    for path in CHROME_PATHS:
        if os.path.exists(path):
            return path
    for name in ("google-chrome", "chromium", "chromium-browser", "chrome", "msedge"):
        found = shutil.which(name)
        if found:
            return found
    return None


#: `size` in millimeters and no margin, so the paper *is* the figure.  Chrome
#: still snaps the page to its own 1/300 inch grid -- 183 mm comes out 183.13
#: and 240 mm comes out 239.86, which leaves the bottom edge of the figure
#: outside the page box -- so the box is written again exactly afterwards.
PDF_PAGE = """<!doctype html><meta charset="utf-8">
<style>@page{{size:{w:.4f}mm {h:.4f}mm;margin:0}}
html,body{{margin:0;padding:0;background:transparent}}svg{{display:block}}</style>
{svg}
"""


def exact_page(path, w_mm, h_mm):
    """Chrome's page box, rounded to its device grid, made exact again.

    The drawing itself is placed from the top-left and is exact already, so the
    box is anchored there too: its top edge stays where the figure's top edge
    is, and its height becomes the figure's rather than the paper's."""
    import pypdf                      # this one route needs it

    reader = pypdf.PdfReader(path)
    writer = pypdf.PdfWriter()
    w, h = w_mm / 25.4 * 72, h_mm / 25.4 * 72
    for page in reader.pages:
        top = float(page.mediabox.top)
        page.mediabox = pypdf.generic.RectangleObject([0, top - h, w, top])
        writer.add_page(page)
    buf = io.BytesIO()
    writer.write(buf)
    return buf.getvalue()


def svg_to_pdf(svg, w_mm, h_mm):
    """One page, exactly w x h mm, the text still text and the scans embedded."""
    exe = find_chrome()
    if not exe:
        raise RuntimeError(
            "No Chrome, Chromium or Edge on this machine to render the PDF with. "
            "Export SVG instead, or open the figure in a browser and print it.")
    svg = re.sub(r"^\s*<\?xml[^>]*\?>\s*", "", svg)
    with tempfile.TemporaryDirectory() as tmp:
        page = os.path.join(tmp, "figure.html")
        out = os.path.join(tmp, "figure.pdf")
        with open(page, "w", encoding="utf-8") as fh:
            fh.write(PDF_PAGE.format(w=w_mm, h=h_mm, svg=svg))
        # Its own profile directory: a lab machine has a browser open with the
        # user's own tabs in it, and headless must not touch that profile.
        done = subprocess.run(
            [exe, "--headless=new", "--disable-gpu", "--no-pdf-header-footer",
             "--user-data-dir=" + os.path.join(tmp, "profile"),
             "--print-to-pdf=" + out,
             "file://" + urllib.request.pathname2url(page)],
            capture_output=True, timeout=240)
        if not os.path.exists(out):
            tail = done.stderr.decode("utf-8", "replace").strip()[-400:]
            raise RuntimeError("the browser wrote no PDF: " + (tail or "no output"))
        return exact_page(out, w_mm, h_mm)


@app.route("/api/figure/pdf", methods=["POST"])
def figure_pdf():
    """The figure as one vector PDF page, drawn by a headless browser."""
    body = request.get_json(force=True, silent=True) or {}
    try:
        pdf = svg_to_pdf(str(body.get("svg") or ""),
                         float(body.get("w") or 183), float(body.get("h") or 240))
        return Response(pdf, mimetype="application/pdf")
    except Exception as exc:
        return _fail(exc, 400 if isinstance(exc, (OSError, ValueError)) else 500)


@app.route("/api/protocol/open", methods=["POST"])
def protocol_open():
    """A Word protocol as the text the canvas edits."""
    body = request.get_json(force=True, silent=True) or {}
    try:
        path = os.path.abspath(os.path.expanduser(str(body.get("path") or "")))
        got = proto.read_docx(path)
        return jsonify({"path": path, "name": os.path.basename(path), **got})
    except Exception as exc:
        return _fail(exc, 400 if isinstance(exc, (OSError, ValueError,
                                                  zipfile.BadZipFile)) else 500)


@app.route("/api/protocol/export", methods=["POST"])
def protocol_export():
    """The protocol, the figure and an overview, as one .docx or one .pdf."""
    body = request.get_json(force=True, silent=True) or {}
    try:
        path = _free_path(os.path.abspath(os.path.expanduser(str(body.get("path") or ""))))
        png = str(body.get("png") or "")
        mm = body.get("pngMm") or (183, 240)
        write = proto.write_pdf if path.lower().endswith(".pdf") else proto.write_docx
        write(path, str(body.get("text") or ""),
              png=base64.b64decode(png.split(",", 1)[-1]) if png else None,
              png_mm=(float(mm[0]), float(mm[1])),
              figure=list(body.get("figure") or []),
              caption=str(body.get("caption") or ""),
              color=str(body.get("color") or "FF0000"),
              title=str(body.get("title") or ""))
        return jsonify({"path": path, "name": os.path.basename(path),
                        "bytes": os.path.getsize(path)})
    except Exception as exc:
        return _fail(exc, 400 if isinstance(exc, (OSError, ValueError)) else 500)


@app.route("/api/session/save", methods=["POST"])
def session_save():
    body = request.get_json(force=True, silent=True) or {}
    try:
        path = _session_path(body.get("path"))
        # Replacing a figure someone spent a day on should take saying so.
        if os.path.exists(path) and not body.get("overwrite"):
            return jsonify({"needsOverwrite": True, "path": path,
                            "name": os.path.basename(path)})
        session = body.get("session") or {}
        copied = _rehouse(session, path)
        size = _write_session(path, session)
        return jsonify({"path": path, "name": os.path.basename(path),
                        "bytes": size, "copied": copied,
                        "sources": [{"id": s.get("id"), "path": s.get("path")}
                                    for s in ((session.get("doc") or {}).get("sources") or [])]})
    except Exception as exc:
        return _fail(exc, 400 if isinstance(exc, (OSError, ValueError)) else 500)


@app.route("/api/session/open", methods=["POST"])
def session_open():
    body = request.get_json(force=True, silent=True) or {}
    try:
        path = os.path.abspath(os.path.expanduser(str(body.get("path") or "")))
        with open(path, "r", encoding="utf-8") as fh:
            session = json.load(fh)
        return jsonify({"path": path, "name": os.path.basename(path),
                        "session": session, "missing": _check_sources(session),
                        "savedAt": os.path.getmtime(path)})
    except Exception as exc:
        return _fail(exc, 400 if isinstance(exc, (OSError, ValueError)) else 500)


@app.route("/api/session/autosave", methods=["GET", "POST"])
def session_autosave():
    try:
        if request.method == "GET":
            if not os.path.exists(AUTOSAVE):
                return jsonify({"empty": True})
            with open(AUTOSAVE, "r", encoding="utf-8") as fh:
                return jsonify({"empty": False, "session": json.load(fh),
                                "savedAt": os.path.getmtime(AUTOSAVE)})
        body = request.get_json(force=True, silent=True) or {}
        if body.get("clear"):
            if os.path.exists(AUTOSAVE):
                os.remove(AUTOSAVE)
            return jsonify({"cleared": True})
        _write_session(AUTOSAVE, body.get("session") or {})
        return jsonify({"ok": True, "path": AUTOSAVE})
    except Exception as exc:
        return _fail(exc, 500)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int,
                    default=int(os.environ.get("PURIFIG_PORT") or 8778))
    # A second copy of the app -- a test, a demo -- must not share the first
    # one's autosave: the file's whole meaning is "this is what was lost", and
    # two copies writing and clearing it would each destroy the other's.
    ap.add_argument("--state", default=os.environ.get("PURIFIG_STATE") or STATE_DIR,
                    help="where the autosave lives (default ~/.purifig)")
    a = ap.parse_args()
    STATE_DIR = os.path.abspath(os.path.expanduser(a.state))
    AUTOSAVE = os.path.join(STATE_DIR, "autosave.purifig.json")
    missing = [n for n, m in (("pillow", Image), ("tifffile", tifffile)) if m is None]
    print(f"purifig  http://127.0.0.1:{a.port}")
    if missing:
        print("missing:  " + ", ".join(missing) +
              "   (pip install -r requirements.txt)", file=sys.stderr)
    app.run(host="127.0.0.1", port=a.port, threaded=True, debug=False)
