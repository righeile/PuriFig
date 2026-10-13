#!/usr/bin/env python3
"""Write a synthetic SEC run in the two shapes the app has to read.

    python3 examples/make_example_sec.py

``example_sec.asc``  the UNICORN shape: UTF-16 with a BOM, tab separated, two
                     header rows, and one *pair* of columns per curve — each
                     curve carrying its own volume axis, because they are not
                     sampled together.  The fractions ride in a pair whose value
                     column holds labels rather than numbers.
``example_sec.csv``  the plain shape: one shared volume column, one column per
                     curve, one header row.

Both describe the same run, so loading either should give the same panel.
"""

import os
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))

V0, VT = 8.0, 24.0
rng = np.random.default_rng(11)


def gauss(x, centre, amp, width):
    return amp * np.exp(-((x - centre) ** 2) / (2 * width ** 2))


def run():
    v = np.arange(6.0, 24.0, 0.01)
    a280 = (gauss(v, 8.2, 24, 0.34) + gauss(v, 12.6, 142, 0.55)
            + gauss(v, 15.4, 47, 0.5) + gauss(v, 19.5, 11, 0.9)
            + 2.0 + rng.normal(0, 0.25, v.size))
    a260 = a280 * 0.54 + gauss(v, 8.2, 9, 0.34) + rng.normal(0, 0.2, v.size)
    # Conductivity drifts, as it does when the sample buffer is not quite the
    # running buffer, and jumps where the salt from the injection comes off.
    cond = 21.0 + gauss(v, 21.5, 3.2, 1.4) + np.linspace(0, 0.35, v.size)
    return v, a280, a260, cond


def fractions(step=0.5, start=9.0, end=20.0):
    out, n = [], 1
    x = start
    while x <= end:
        out.append((round(x, 3), str(n)))
        x += step
        n += 1
    return out


def write_asc(path, v, a280, a260, cond, frac):
    """Two header rows, then paired columns, UTF-16 with a BOM."""
    names = ["UV 280", "", "UV 260", "", "Cond", "", "Fractions", ""]
    units = ["ml", "mAU", "ml", "mAU", "ml", "mS/cm", "ml", "Fraction"]
    # Each pair keeps its own x, and the fraction pair is much shorter than the
    # curves -- which is the whole reason the layout is paired.
    rows = max(len(v), len(frac))
    lines = ["\t".join(names), "\t".join(units)]
    for i in range(rows):
        cells = []
        for series in (a280, a260, cond):
            if i < len(v):
                cells += [f"{v[i]:.4f}", f"{series[i]:.5f}"]
            else:
                cells += ["", ""]
        if i < len(frac):
            cells += [f"{frac[i][0]:.4f}", frac[i][1]]
        else:
            cells += ["", ""]
        lines.append("\t".join(cells))
    with open(path, "wb") as fh:
        fh.write("\r\n".join(lines).encode("utf-16"))     # BOM included


def write_csv(path, v, a280, a260, cond):
    lines = ["Volume (mL),UV 280 (mAU),UV 260 (mAU),Cond (mS/cm)"]
    for i in range(len(v)):
        lines.append(f"{v[i]:.4f},{a280[i]:.5f},{a260[i]:.5f},{cond[i]:.5f}")
    open(path, "w").write("\n".join(lines))


def main():
    v, a280, a260, cond = run()
    frac = fractions()
    asc = os.path.join(HERE, "example_sec.asc")
    csv = os.path.join(HERE, "example_sec.csv")
    write_asc(asc, v, a280, a260, cond, frac)
    write_csv(csv, v, a280, a260, cond)
    print(f"{asc}  UTF-16, 8 columns, {len(v)} rows, {len(frac)} fractions")
    print(f"{csv}  UTF-8, 4 columns, {len(v)} rows")
    print(f"peaks at 8.2 (void), 12.6, 15.4, 19.5 mL   V0 {V0}  Vt {VT}")


if __name__ == "__main__":
    main()
