"""A TECAN plate reader export, as the measurement a protocol step made.

A Spark writes its "Result sheet" as an .xlsx: a header saying which machine
and when, a block per read saying what it measured and how, and under each one
the plate itself -- a row of column numbers and a row per plate row, with a
number in every well that was read.

Nothing here knows what the wells are.  The file does not say: a TECAN export
carries wells, not samples, so the protocol step that made the measurement is
what gives it a meaning, and that coupling is kept in the figure's session
beside the sample-to-lane links.  The same reasoning as `protocol.py`: read
what is actually in the file, and let the protocol say what it was for.

An .xlsx is a zip of XML, which is how `protocol.py` writes .docx -- so this
reads it the same way rather than adding a spreadsheet library for one sheet.

    python3 tecan.py            # self-check on a file written here
    python3 tecan.py FILE.xlsx  # what this reads out of a real export
"""

import os
import re
import sys
import zipfile
from xml.etree import ElementTree as ET
from xml.sax.saxutils import escape

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"

#: The label a Spark writes, and the key it becomes.  Everything else in the
#: block is read as well -- these are only the ones worth a name of their own,
#: because they are what a methods line says about a fluorescence reading.
FIELDS = {
    "mode": "mode",
    "name": "name",
    "excitation wavelength [nm]": "ex",
    "emission wavelength [nm]": "em",
    "wavelength [nm]": "wl",
    "gain manual": "gain",
    "gain": "gain",
    "temperature [°c]": "temp",
    "part of plate": "part",
    "number of flashes": "flashes",
    "integration time [µs]": "integration",
}


def _cells(path):
    """The sheet as rows of text, each row a list of (column letter, value)."""
    z = zipfile.ZipFile(path)
    names = z.namelist()
    shared = []
    if "xl/sharedStrings.xml" in names:
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")):
            shared.append("".join(t.text or "" for t in si.iter(NS + "t")))
    sheets = sorted(n for n in names if re.match(r"xl/worksheets/sheet\d+\.xml$", n))
    if not sheets:
        raise ValueError("no sheet in this .xlsx")
    rows = []
    for row in ET.fromstring(z.read(sheets[0])).iter(NS + "row"):
        out = []
        for c in row.iter(NS + "c"):
            ref = c.get("r") or ""
            col = re.sub(r"\d", "", ref)
            if c.get("t") == "inlineStr":
                val = "".join(x.text or "" for x in c.iter(NS + "t"))
            else:
                v = c.find(NS + "v")
                val = v.text if v is not None else ""
                if c.get("t") == "s" and val not in ("", None):
                    val = shared[int(val)]
            if val not in ("", None):
                out.append((col, str(val)))
        if out:
            rows.append(out)
    return rows


def _num(s):
    """A number the way the sheet wrote it, rounded out of float noise.
    A Spark writes an emission wavelength as 528.00000000000011."""
    try:
        v = float(str(s).replace(",", "."))
    except (TypeError, ValueError):
        return None
    return int(v) if abs(v - round(v)) < 1e-6 and abs(v) < 1e15 else round(v, 3)


def read_xlsx(path):
    """`{file, device, date, reads: [...]}`; a read carries its own wells."""
    rows = _cells(path)
    head, reads, cur, cols = {}, [], None, None
    for row in rows:
        first = row[0][1].strip()
        second = row[1][1].strip() if len(row) > 1 else ""
        # A Spark writes a header as one cell, `Device: Spark`, and a setting as
        # two, `Gain Manual` and `100` several columns over -- and `Date: ` as
        # both at once.  The label is up to the colon, the value is whatever
        # comes after it, here or in the next cell that has anything in it.
        if ":" in first and not re.fullmatch(r"[A-Z]{1,2}", first):
            low, rest = first.split(":", 1)
            low, second = low.strip().lower(), rest.strip() or second
        else:
            low = first.rstrip(":").strip().lower()

        # The plate: a row of column numbers, then a row per plate row.  Which
        # well a cell is, is its own spreadsheet column under that header -- a
        # well that was not read leaves no cell at all, so counting along the
        # row would shift every reading after the gap.
        if first == "<>":
            cols = {c: v.strip() for c, v in row[1:]}
            continue
        if cols and re.fullmatch(r"[A-Z]{1,2}", first) and cur is not None:
            for col, val in row[1:]:
                if col in cols and _num(val) is not None:
                    cur["wells"][first + cols[col]] = _num(val)
            continue

        if low == "mode":
            cur = {"mode": second, "name": "", "wells": {}}
            reads.append(cur)
            cols = None
            continue
        key = FIELDS.get(low)
        if key and cur is not None:
            cur[key] = _num(second) if key not in ("mode", "name", "part") else second
        elif key in ("mode", "name") and cur is None:
            pass
        elif low in ("method name", "device", "date", "time", "plate", "user", "system"):
            head[low] = second
    for r in reads:
        r["n"] = len(r["wells"])
        vals = list(r["wells"].values())
        r["lo"], r["hi"] = (min(vals), max(vals)) if vals else (None, None)
    return {"file": os.path.basename(path), "method": head.get("method name", ""),
            "device": head.get("device", ""), "plate": head.get("plate", ""),
            "date": " ".join(x for x in (head.get("date", ""), head.get("time", "")) if x),
            "reads": [r for r in reads if r["wells"]]}


def says(read):
    """The one line a methods paragraph would write about this reading."""
    bit = []
    if read.get("ex") and read.get("em"):
        bit.append(f"{read['ex']}/{read['em']} nm")
    elif read.get("wl"):
        bit.append(f"{read['wl']} nm")
    if read.get("gain"):
        bit.append(f"gain {read['gain']}")
    if read.get("temp"):
        bit.append(f"{read['temp']} °C")
    return ", ".join([read.get("name") or read.get("mode") or "reading"] + bit)


# ---------------------------------------------------------------- self-check

def _sheet_xml(rows):
    """Rows of (ref, value) as a worksheet, numbers inline and text as-is."""
    out = ['<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org'
           '/spreadsheetml/2006/main"><sheetData>']
    for n, cells in enumerate(rows, 1):
        out.append(f'<row r="{n}">')
        for col, val in cells:
            if re.fullmatch(r"-?\d+(\.\d+)?", str(val)):
                out.append(f'<c r="{col}{n}"><v>{val}</v></c>')
            else:
                out.append(f'<c r="{col}{n}" t="inlineStr"><is><t>{escape(str(val))}</t></is></c>')
        out.append("</row>")
    out.append("</sheetData></worksheet>")
    return "".join(out)


def _write_fixture(path):
    """A Spark result sheet with the shape of a real one, small enough to read."""
    rows = [
        [("A", "Method name: Venus_20260217")], [("A", "Device: Spark")],
        [("A", "Date: "), ("E", "2026-02-24")], [("A", "Time: "), ("E", "16:34")],
        [("A", "Mode"), ("B", "Fluorescence Top Reading")],
        [("A", "Name"), ("B", "Venus")],
        [("A", "Excitation wavelength [nm]"), ("E", "510")],
        [("A", "Emission wavelength [nm]"), ("E", "528.00000000000011")],
        [("A", "Gain Manual"), ("E", "100")],
        [("A", "Temperature [°C]"), ("E", "29.3")],
        [("A", "<>"), ("B", "1"), ("C", "2"), ("D", "3")],
        [("A", "A"), ("C", "786"), ("D", "711")],          # A1 was not read
        [("A", "B"), ("B", "359"), ("C", "295"), ("D", "292")],
        [("A", "C")],                                       # an empty plate row
    ]
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("[Content_Types].xml",
                   '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org'
                   '/package/2006/content-types"><Default Extension="xml" ContentType='
                   '"application/xml"/></Types>')
        z.writestr("xl/worksheets/sheet1.xml", _sheet_xml(rows))


def _check():
    import tempfile
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "spark.xlsx")
        _write_fixture(p)
        got = read_xlsx(p)
    assert got["device"] == "Spark", got
    assert got["date"] == "2026-02-24 16:34", got
    assert len(got["reads"]) == 1, got
    r = got["reads"][0]
    assert r["name"] == "Venus" and r["ex"] == 510, r
    # The float noise a Spark writes an emission wavelength with is not a number
    # anybody means: 528, not 528.00000000000011.
    assert r["em"] == 528, r["em"]
    # A well is its own letter and its own column number, so a row that starts
    # part way along the plate does not shift every reading left.
    assert r["wells"] == {"A2": 786, "A3": 711, "B1": 359, "B2": 295, "B3": 292}, r["wells"]
    assert r["n"] == 5 and r["lo"] == 292 and r["hi"] == 786, r
    assert says(r) == "Venus, 510/528 nm, gain 100, 29.3 °C", says(r)
    print("ok — tecan: a Spark result sheet, its read and its wells")


if __name__ == "__main__":
    if len(sys.argv) > 1:
        got = read_xlsx(sys.argv[1])
        print(f"{got['file']} — {got['device']} {got['date']}")
        for r in got["reads"]:
            print(f"  {says(r)} — {r['n']} wells, {r['lo']}–{r['hi']}")
            print("   ", ", ".join(f"{w} {v}" for w, v in list(r["wells"].items())[:12]), "…")
    else:
        _check()
