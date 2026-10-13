#!/usr/bin/env python3
"""Purification protocols: read one out of Word, edit it as text, write it back
out with the figure.

A protocol in this lab is a .docx with three things in it -- headings carrying a
date, steps under them, and, in a color that is not the body's, what actually
happened on the day.  The color is the whole point.  It is the line between the
protocol, which is the same every time, and the one experiment the figure is
about, which is not; and it is the experiment that belongs beside a figure.

What `read_docx` returns is text, in five kinds of line, and the same text is
what `write_docx` and `write_pdf` take back:

    # the title
    ## a heading, usually a date
    - a step
      a line belonging to the step above it
    > a comment, which was colored in Word and is colored again on the way out

Nothing else survives: not the fonts, not the margins, not the buffer table as a
table.  A protocol that has been through here reads as a protocol rather than as
a copy of a Word file, and the text being editable is also the repair for every
heading the reader guesses wrong.

Run it to check itself:

    python3 protocol.py            # round-trips a protocol through both writers
    python3 protocol.py some.docx  # prints what it reads
"""

import io
import os
import re
import zipfile
from collections import Counter
from xml.etree import ElementTree as ET

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"

#: Word writes "no color" several ways, and a protocol typed in black and one
#: typed in automatic are the same protocol.
BODY_COLORS = {"", "auto", "000000", "0d0d0d", "1a1a1a", "212121", "262626",
               "333333", "404040", "595959"}

#: The words a lab protocol uses as a section, and anything with a date in it.
SECTION = re.compile(r"^(materials?|idea|aim|goal|procedure|protocol|notes?|"
                     r"results?|outcome|summary|day\s*\d+|d\d+\b)", re.I)
DATE = re.compile(r"\b(\d{8}|\d{4}[-./]\d{1,2}[-./]\d{1,2}|"
                  r"\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4})\b")

KINDS = ("title", "heading", "step", "line", "comment", "blank")


# --------------------------------------------------------------- reading ----

def _runs(p):
    """(text, color) per run, color lowercased and '' when the run has none."""
    out = []
    for r in p.iter(W + "r"):
        t = "".join(n.text or "" for n in r.iter(W + "t"))
        if r.find(W + "tab") is not None or list(r.iter(W + "tab")):
            t = t or "\t"
        rpr = r.find(W + "rPr")
        c = rpr.find(W + "color") if rpr is not None else None
        out.append((t, (c.get(W + "val") or "").lower() if c is not None else ""))
    return out


def _para(p):
    ppr = p.find(W + "pPr")
    style = ""
    listed = False
    if ppr is not None:
        s = ppr.find(W + "pStyle")
        style = (s.get(W + "val") or "") if s is not None else ""
        listed = ppr.find(W + "numPr") is not None
    runs = _runs(p)
    return {"text": re.sub(r"\s+", " ", "".join(t for t, _ in runs)).strip(),
            "runs": runs, "style": style, "listed": listed}


def _inline(runs, body, mark="*"):
    """The paragraph's text with its colored runs marked `*like this*`.

    The commonest comment in these protocols is not a line at all: it is the
    number that was actually used, typed over the recipe's number in red.  That
    is a span, and a span has to survive being edited as text.
    """
    runs2 = []
    for t, c in runs:
        if not t:
            continue
        hit = c not in body
        if runs2 and runs2[-1][0] == hit:
            runs2[-1][1] += t
        else:
            runs2.append([hit, t])
    out = ""
    for hit, t in runs2:
        if not hit or not t.strip() or mark in t:
            out += t
            continue
        out += t[:len(t) - len(t.lstrip())] + mark + t.strip() + mark + t[len(t.rstrip()):]
    return re.sub(r"\s+", " ", out).strip()


def _colored(runs, body):
    """True when most of the ink in the paragraph is not the body's color."""
    off = sum(len(t.strip()) for t, c in runs if c not in body)
    on = sum(len(t.strip()) for t, c in runs if c in body)
    return off > on and off > 0


def read_docx(path):
    """A .docx protocol as `{title, text, color}`; `color` is the comments'."""
    with zipfile.ZipFile(path) as z:
        root = ET.fromstring(z.read("word/document.xml"))
    paras = [_para(p) for p in root.iter(W + "p")]

    # The body color is whichever one most of the characters are in, so a
    # protocol typed in blue with black comments reads the same way round.
    ink = Counter()
    for p in paras:
        for t, c in p["runs"]:
            ink[c] += len(t.strip())
    body = BODY_COLORS | {(ink.most_common(1)[0][0] if ink else "")}
    comment = next((c for c, _ in ink.most_common() if c not in body), "")

    lines, title, blank = [], "", False
    for i, p in enumerate(paras):
        if not p["text"]:
            blank = True
            continue
        if blank and lines:
            lines.append("")
        blank = False
        if not title:
            title = p["text"]
            lines.append("# " + p["text"])
        elif _colored(p["runs"], body):
            lines.append("> " + p["text"])
        elif p["listed"]:
            lines.append("- " + _inline(p["runs"], body))
        elif _heading(p, paras[i + 1] if i + 1 < len(paras) else None):
            lines.append("")
            lines.append("## " + _inline(p["runs"], body))
        else:
            lines.append("  " + _inline(p["runs"], body))
    return {"title": title, "text": "\n".join(lines).strip() + "\n",
            "color": comment or "FF0000"}


def _heading(p, nxt=None):
    """A heading is short, is not a step, and either names a section or a date
    or reads like a title over the steps that follow it.

    The second half of that is what catches "Bacmid preparation" and
    "Purification with NiNTA resin", which no protocol writes as a date and
    Word was never told were headings: a short line with no number and no
    comma in it, standing immediately above a list.  A number is allowed in one
    -- "Purification with Strep4Flow resin" is a heading -- because what keeps
    the buffer recipes out is their commas, not their digits.

    ponytail: a guess.  It is wrong on a one-line step that opens with a date,
    and the fix is the editor -- the text is what gets saved, not the docx.
    """
    t = p["text"]
    if p["style"].lower().startswith("heading"):
        return True
    if len(t) <= 90 and (SECTION.match(t) or DATE.search(t)):
        return True
    return (nxt is not None and nxt["listed"] and len(t) <= 70
            and not re.search(r"[,;:]", t) and not t.endswith("."))


# --------------------------------------------------------------- the text ---

def parse(text):
    """The editable text back into items: `{kind, text, date}`."""
    items = []
    for raw in (text or "").splitlines():
        s = raw.strip()
        if not s:
            items.append({"kind": "blank", "text": "", "date": ""})
            continue
        if s.startswith("# "):
            kind, s = "title", s[2:]
        elif s.startswith("## "):
            kind, s = "heading", s[3:]
        elif s.startswith("#"):
            kind, s = "heading", s.lstrip("#").strip()
        elif s.startswith("> "):
            kind, s = "comment", s[2:]
        elif s[0] in "-*•" and s[1:2] in (" ", "\t"):
            kind, s = "step", s[1:].strip()
        else:
            kind = "line" if raw[:1] in (" ", "\t") else "step"
        d = DATE.search(s)
        items.append({"kind": kind, "text": s.strip(),
                      "date": d.group(0) if d else ""})
    while items and items[-1]["kind"] == "blank":
        items.pop()
    return items


def overview(items, figure=(), ):
    """What happened, in a dozen lines: the days, and what each one cost.

    The days are the protocol's own headings -- whichever of them carry a date
    -- and under each one the steps belonging to it and how many of them the
    experiment had something to say about.  That is the overview a purification
    gets: not the recipe, which is in the protocol below, but when it ran and
    where it needed a comment.
    """
    # Steps before the first heading are still steps: a protocol that opens
    # straight into a list has one unnamed day, which is counted and not listed.
    days = [{"name": "", "date": "", "steps": 0, "notes": 0}]
    cur = days[0]
    for it in items:
        if it["kind"] == "heading":
            cur = {"name": it["text"], "date": it["date"], "steps": 0, "notes": 0}
            days.append(cur)
        elif cur and it["kind"] == "step":
            cur["steps"] += 1
            cur["notes"] += "*" in it["text"]
        elif cur and it["kind"] == "comment":
            cur["notes"] += 1
    dated = [d for d in days if d["date"]]
    steps = sum(d["steps"] for d in days)
    notes = sum(d["notes"] for d in days)

    out = []
    if dated:
        span = (f"{dated[0]['date']} to {dated[-1]['date']}"
                if dated[0]["date"] != dated[-1]["date"] else dated[0]["date"])
        out.append(f"The purification ran in {len(dated)} dated "
                   f"stage{'' if len(dated) == 1 else 's'}, {span}.")
    out.append(f"{steps} step{'' if steps == 1 else 's'} in all, "
               f"{notes} of them commented on in this experiment.")
    for d in days:
        if not d["name"] or (not d["steps"] and not d["notes"]):
            continue
        out.append(f"{d['name']} — {d['steps']} step{'' if d['steps'] == 1 else 's'}"
                   + (f", {d['notes']} comment{'' if d['notes'] == 1 else 's'}"
                      if d["notes"] else ""))
    out.extend(figure or [])
    return out


# --------------------------------------------------------------- Word out ---

EMU = 36000                      # per mm
CT = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"""
RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"""
DRELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rIdFig" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/figure.png"/>
</Relationships>"""
DOC_NS = ('xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
          'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
          'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"')


def _x(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def _p(text, size=10, bold=False, italic=False, color="", indent=0,
       before=0, bullet=False, mark=""):
    """One Word paragraph.  Sizes are points, indents millimetres.

    `color` paints the whole paragraph, `mark` only the `*spans*` in it."""
    base = "".join(["<w:b/>" if bold else "", "<w:i/>" if italic else "",
                    f'<w:sz w:val="{int(size * 2)}"/>'
                    f'<w:szCs w:val="{int(size * 2)}"/>'])
    ind = int(indent / 25.4 * 1440) + (360 if bullet else 0)
    tag = '<w:ind w:left="%d"%s/>' % (ind, ' w:hanging="360"' if bullet else '')
    ppr = (f'<w:spacing w:before="{int(before * 20)}" w:after="{int(size * 2)}"/>'
           + (tag if ind else ""))
    segs = (("•\t" if bullet else "") + str(text)).split("*")
    runs = ""
    for i, seg in enumerate(segs):
        if not seg:
            continue
        col = color or (mark if i % 2 else "")
        runs += (f'<w:r><w:rPr>{base}'
                 + (f'<w:color w:val="{col}"/>' if col else "")
                 + f'</w:rPr><w:t xml:space="preserve">{_x(seg)}</w:t></w:r>')
    return f"<w:p><w:pPr>{ppr}</w:pPr>{runs}</w:p>"


def _image_p(mm_w, mm_h):
    cx, cy = int(mm_w * EMU), int(mm_h * EMU)
    return (
        '<w:p><w:pPr><w:spacing w:before="120" w:after="120"/></w:pPr><w:r><w:drawing>'
        f'<wp:inline distT="0" distB="0" distL="0" distR="0">'
        f'<wp:extent cx="{cx}" cy="{cy}"/><wp:docPr id="1" name="Figure"/>'
        '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
        '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
        '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">'
        '<pic:nvPicPr><pic:cNvPr id="1" name="figure.png"/><pic:cNvPicPr/></pic:nvPicPr>'
        '<pic:blipFill><a:blip r:embed="rIdFig"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
        f'<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm>'
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>'
        '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>')


def _blocks(items, color):
    out = []
    for it in items:
        k, t = it["kind"], it["text"]
        if k in ("blank", "title"):
            continue
        if k == "heading":
            out.append(_p(t, size=11.5, bold=True, before=8, mark=color))
        elif k == "step":
            out.append(_p(t, bullet=True, mark=color))
        elif k == "comment":
            out.append(_p(t, color=color, indent=8))
        else:
            out.append(_p(t, indent=8, mark=color))
    return out


def write_docx(path, text, png=None, png_mm=None, figure=(), caption="",
               color="FF0000", title=""):
    """The protocol, the figure and the overview as one .docx."""
    items = parse(text)
    head = next((i["text"] for i in items if i["kind"] == "title"), "") or title or "Purification"
    ps = [_p(head, size=15, bold=True)]
    ps.append(_p("Overview", size=12, bold=True, before=6))
    for line in overview(items, figure):
        ps.append(_p(line, size=10, bullet=True))
    if png:
        w, h = png_mm or (170, 170)
        k = min(170.0 / max(w, 1e-6), 1.0)
        ps.append(_image_p(w * k, h * k))
        # The legend is paragraphs, one per panel: run through one <w:t> they
        # would come out of Word as a single block of eight hundred words.
        for par in [c for c in str(caption).split("\n\n") if c.strip()]:
            ps.append(_p(par.strip(), size=8.5, italic=True))
    ps.append(_p("Protocol", size=12, bold=True, before=10))
    ps.extend(_blocks(items, color))
    doc = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
           f"<w:document {DOC_NS}><w:body>{''.join(ps)}"
           f'<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
           f'<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/>'
           f"</w:sectPr></w:body></w:document>")
    tmp = path + ".part"
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", CT)
        z.writestr("_rels/.rels", RELS)
        z.writestr("word/document.xml", doc)
        z.writestr("word/_rels/document.xml.rels", DRELS)
        z.writestr("word/media/figure.png", png or b"")
    os.replace(tmp, path)
    return path


# ---------------------------------------------------------------- PDF out ---

def write_pdf(path, text, png=None, png_mm=None, figure=(), caption="",
              color="FF0000", title=""):
    """The same document as a PDF: the overview, the figure on its own page at
    the size it was drawn, then the protocol."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.backends.backend_pdf import PdfPages

    items = parse(text)
    head = next((i["text"] for i in items if i["kind"] == "title"), "") or title or "Purification"
    PW, PH, M = 210.0, 297.0, 20.0
    plt.rcParams.update({"font.family": ["Arial", "Helvetica", "DejaVu Sans"],
                         "pdf.fonttype": 42})

    with PdfPages(path) as pdf:
        state = {"fig": None, "y": 0.0}

        def page():
            if state["fig"] is not None:
                pdf.savefig(state["fig"])
                plt.close(state["fig"])
            state["fig"] = plt.figure(figsize=(PW / 25.4, PH / 25.4))
            state["y"] = M

        def line(t, size=10, bold=False, italic=False, col="#000", mark="",
                 indent=0, before=0):
            import textwrap
            # ponytail: the wrap counts characters, half an em each.  A
            # caps-heavy line runs a millimetre long; where each run *starts*
            # is measured, which is the part a colored number would show.
            wid = max(10, int((PW - 2 * M - indent) / (size * 0.1834)))
            hit = False
            for i, row in enumerate(textwrap.wrap(t, wid) or [""]):
                state["y"] += (before if i == 0 else 0) + size * 0.3528
                if state["y"] > PH - M:
                    page()
                    state["y"] += size * 0.3528
                # A wrapped row hangs under the bullet rather than starting a
                # new one.
                x = M + indent + (0 if i == 0 else 3)
                # A step reads in the body color with the day's own numbers in
                # the comment color, the same way it does in Word.
                parts = row.split("*")
                for j, seg in enumerate(parts):
                    if j:
                        # Between runs, not after the last one: a row with no
                        # mark in it must leave the next row the color it found.
                        hit = not hit
                    if seg:
                        o = state["fig"].text(
                            x / PW, 1 - state["y"] / PH, seg, fontsize=size,
                            color=("#" + mark.lstrip("#")) if hit and mark else col,
                            ha="left", va="baseline",
                            fontweight="bold" if bold else "normal",
                            style="italic" if italic else "normal")
                        x += (o.get_window_extent(state["fig"].canvas.get_renderer())
                              .width / state["fig"].dpi * 25.4)
                state["y"] += size * 0.3528 * 0.45

        page()
        line(head, size=15, bold=True)
        line("Overview", size=12, bold=True, before=4)
        for t in overview(items, figure):
            line("• " + t.replace("*", ""), size=10, indent=4)

        if png:
            page()
            w, h = png_mm or (PW - 2 * M, PH - 2 * M)
            k = min((PW - 2 * M) / w, (PH - 2 * M - 14) / h)
            import matplotlib.image as mpimg
            img = mpimg.imread(io.BytesIO(png), format="png")
            ax = state["fig"].add_axes([M / PW, 1 - (M + h * k) / PH,
                                        w * k / PW, h * k / PH])
            ax.imshow(img)
            ax.axis("off")
            state["y"] = M + h * k + 4
            for par in [c for c in str(caption).split("\n\n") if c.strip()]:
                line(par.strip(), size=8.5, italic=True, before=1.2)

        page()
        line("Protocol", size=12, bold=True)
        for it in items:
            k, t = it["kind"], it["text"]
            if k in ("blank", "title"):
                continue
            if k == "heading":
                line(t, size=11.5, bold=True, before=4, mark=color)
            elif k == "step":
                line("• " + t, size=10, indent=2, mark=color)
            elif k == "comment":
                line(t, size=10, col="#" + color.lstrip("#"), indent=8)
            else:
                line(t, size=10, indent=8, mark=color)
        pdf.savefig(state["fig"])
        plt.close(state["fig"])
    return path


# ------------------------------------------------------------------ check ---

def _tiny_png(w=10, h=10):
    """A real 10x10 PNG, so the check does not lean on Pillow to make one."""
    import struct, zlib
    raw = b"".join(b"\x00" + bytes([200, 40, 40] * w) for _ in range(h))

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def _check():
    import tempfile
    src = ("# Testpurification of LRRC8A/D 06.02.2026\n\n"
           "## Material\n- Cell pellet, 13x350 ml\n  25 mM Tris pH 8.5\n\n"
           "## Day 1 - 06.02.2026\n- Thaw cell pellet\n> Comment: pellet was soft\n"
           "- Centrifuge at 85kg\n\n## Day 2 - 07.02.2026\n- Run the SEC\n")
    items = parse(src)
    kinds = [i["kind"] for i in items if i["kind"] != "blank"]
    assert kinds == ["title", "heading", "step", "line", "heading", "step",
                     "comment", "step", "heading", "step"], kinds
    ov = overview(items, ["(A) SEC trace"])
    assert "2 dated stages, 06.02.2026 to 07.02.2026" in ov[0], ov
    assert "4 steps in all, 1 of them commented" in ov[1], ov
    assert ov[-1] == "(A) SEC trace"

    png = _tiny_png()
    d = tempfile.mkdtemp()
    out = write_docx(os.path.join(d, "p.docx"), src, png=png, png_mm=(183, 240),
                     figure=["(A) SEC trace"], caption="Figure 1. SEC.", color="4472C4")
    back = read_docx(out)
    # The title, every step and every comment come back, and the comment comes
    # back in the color it went out in -- that is the round trip that matters.
    assert back["color"] == "4472c4", back["color"]
    for want in ("Thaw cell pellet", "Comment: pellet was soft", "Day 2 - 07.02.2026",
                 "Testpurification of LRRC8A/D"):
        assert want in back["text"], want
    assert back["text"].count("\n> ") == 1, back["text"]
    with zipfile.ZipFile(out) as z:
        assert z.read("word/media/figure.png") == png
    write_pdf(os.path.join(d, "p.pdf"), src, png=png, png_mm=(183, 240),
              figure=["(A) SEC trace"], caption="Figure 1. SEC.", color="4472C4")
    assert os.path.getsize(os.path.join(d, "p.pdf")) > 2000
    print("ok —", d)


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1:
        got = read_docx(sys.argv[1])
        print(f"# color {got['color']}\n")
        print(got["text"])
    else:
        _check()
