"""Checks for the two bits of the server with a decision in them.

    python3 test_purifig.py

The cache and the PNG level both trade memory or bytes for time, and both are
the kind of thing that stops working quietly: an eviction rule that throws away
the array you are using looks like nothing at all except a slow app.
"""
import os
import struct
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import purifig_server as S


def test_cache_keeps_what_is_in_use():
    """Three replicates with their white light is six arrays and has to fit.

    The old rule cleared the whole cache at seven entries, so a third blot
    evicted the first two and every call after that re-read the file.
    """
    here = os.path.dirname(os.path.abspath(__file__))
    western = os.path.join(here, "examples", "western")
    paths = [os.path.join(western, f"western_rep{i}_{c}.tif")
             for i in (1, 2, 3) for c in ("chemi", "white")]
    if not all(os.path.exists(p) for p in paths):
        print("  (skipped: run examples/make_example_western.py first)")
        return

    S._cache.clear()
    for p in paths:
        S.read_image(p)
    assert len(S._cache) == 6, f"six scans should all be cached, kept {len(S._cache)}"

    # And a second read is a cache hit, not a re-read.
    t = time.time()
    for p in paths:
        S.read_image(p)
    assert time.time() - t < 0.05, "reading six cached scans should cost nothing"


def test_cache_evicts_under_the_budget():
    """Past the budget the *least recently used* goes, not the whole cache."""
    S._cache.clear()
    budget, S._CACHE_BYTES = S._CACHE_BYTES, 3 * 4 * 1000 * 1000   # three 1 Mpx float32
    try:
        keys = []
        for i in range(5):
            k = (f"/fake/{i}.tif", 0)
            S._cache[k] = (np.zeros((1000, 1000), np.float32), 16, "")
            keys.append(k)
            # the same eviction the real function runs
            used = sum(v[0].nbytes for v in S._cache.values())
            while len(S._cache) > 1 and used > S._CACHE_BYTES:
                used -= S._cache.pop(next(iter(S._cache)))[0].nbytes
            assert S._cache, "never evict down to nothing"
        assert list(S._cache) == keys[-3:], f"oldest three should be gone, held {list(S._cache)}"
    finally:
        S._CACHE_BYTES = budget
        S._cache.clear()


def test_png_level_is_lossless_and_quick():
    """PNG is lossless at every level, so the level only buys file size."""
    rng = np.random.default_rng(0)
    u8 = np.clip(rng.normal(120, 30, (1024, 1344)), 0, 255).astype(np.uint8)

    t = time.time()
    uri = S.png_data_uri(u8, max_px=0)
    quick = time.time() - t

    import base64
    import io
    from PIL import Image
    back = np.asarray(Image.open(io.BytesIO(base64.b64decode(uri.split(",", 1)[1]))))
    assert np.array_equal(back, u8), "the level must not change a single pixel"
    # Noise is the worst case for zlib; a real scan encodes far faster than this.
    assert quick < 1.0, f"a 1.4 Mpx panel took {quick:.1f} s to encode"


def test_vectorised_measurements_are_bit_identical():
    """The fast forms of the two inner loops must not move a single number.

    Both feed lane positions and band baselines, so "close enough" is not a
    thing: a last-bit difference can flip an argmax and move a lane.
    """
    rng = np.random.default_rng(1)
    for n in (760, 1024, 3000):
        v = rng.random(n).astype(np.float32)
        win = max(9, n // 12)
        pad = np.pad(v, (max(3, int(win) | 1) // 2), mode="edge")
        slow = np.array([pad[i:i + (max(3, int(win) | 1))].min() for i in range(n)],
                        dtype=np.float32)
        assert np.array_equal(S._rolling_min(v, win), slow), f"_rolling_min moved at n={n}"

    # The circular correlation: np.roll(s, lag)[i] == s[(i - lag) % w].
    for w, lag_max in ((672, 67), (2000, 200)):
        s = rng.random(w).astype(np.float32)
        ref = rng.random(w).astype(np.float32)
        roll = (np.arange(w)[None, :] - np.arange(-lag_max, lag_max + 1)[:, None]) % w
        slow = [float((np.roll(s, lag) * ref).sum()) for lag in range(-lag_max, lag_max + 1)]
        assert int((s[roll] * ref).sum(axis=1).argmax()) == int(np.argmax(slow)), \
            f"the lag of best fit moved at w={w}"


def _gel_with_a_comb(well_y, rungs, samples=(0.46, 0.62)):
    """A scan with the three things at the top of a real one: the gel's rim, a
    comb, and a ladder -- plus a band the samples share, to be left alone."""
    H, W, LANES = 760, 1440, 12
    img = np.full((H, W), 0.86, np.float64)
    pitch = W / LANES
    img[:6, :] = img[-6:, :] = img[:, :6] = img[:, -6:] = 0.42      # the gel's rim
    y0 = int(H * well_y)
    for i in range(LANES):                                          # the comb
        x = int((i + 0.5) * pitch)
        img[y0:y0 + 13, x - int(pitch * 0.36):x + int(pitch * 0.36)] = 0.30
    ys = np.arange(H)[:, None]

    def band(lane, f, amp):
        x = int((lane + 0.5) * pitch)
        img[:, x - int(pitch * 0.34):x + int(pitch * 0.34)] -= \
            amp * np.exp(-((ys - H * f) ** 2) / (2 * 5.5 ** 2))

    for f in rungs:
        band(0, f, 0.36)
    for f in samples:
        for i in range(1, LANES):
            band(i, f, 0.30)
    return (np.clip(img, 0, 1) * 62000).astype(np.uint16)


def _rungs_found(u16, tmp):
    import tifffile
    path = os.path.join(tmp, f"comb{abs(hash(u16.tobytes())) % 10000}.tif")
    tifffile.imwrite(path, u16)
    S._cache.clear()
    r = S.app.test_client().post("/api/image/ladder", json={
        "path": path, "x0": 0, "x1": int(u16.shape[1] / 12), "darkBands": True})
    assert r.status_code == 200, r.get_data(as_text=True)
    return [b["y"] for b in r.get_json()["bands"]]


def test_the_comb_is_not_a_rung():
    """The wells are where everything started, so nothing above them ran.

    The fixed tenth that used to be blanked cut both ways.  A crop that kept the
    plate above the gel put the comb below the tenth, and it was counted as the
    topmost rung -- every size then typed one row off.  A crop trimmed close to
    the wells put the first real rung above it, and that rung was thrown away.
    Both gels are here, and both are read off the comb the same way.
    """
    import tempfile
    H = 760
    with tempfile.TemporaryDirectory() as d:
        # A loose crop: the comb sits at 14% of the height, past the old tenth.
        loose = _gel_with_a_comb(0.14, (0.22, 0.34, 0.46, 0.58, 0.72, 0.88), samples=(0.50, 0.66))
        u8 = S.apply_levels(loose.astype(np.float32), 0, 65535, 1.0, False)
        wells = S.wells_row(u8, True)
        assert wells is not None, "a comb across twelve lanes should be found"
        assert int(H * 0.14) <= wells <= int(H * 0.14) + 20, f"wells read at row {wells}"
        ys = _rungs_found(loose, d)
        assert not any(abs(y - H * 0.14) < 20 for y in ys), \
            f"the comb at row {int(H * 0.14)} was read as a rung: {ys}"
        for f in (0.22, 0.34, 0.46, 0.58, 0.72, 0.88):
            assert any(abs(y - H * f) <= 6 for y in ys), f"the rung at {f:.0%} went missing: {ys}"

        # A tight crop: the comb is at 4%, and the top rung at 8% is inside the
        # tenth the old rule blanked.
        tight = _gel_with_a_comb(0.04, (0.08, 0.20, 0.34, 0.50, 0.68, 0.86))
        ys = _rungs_found(tight, d)
        assert any(abs(y - H * 0.08) <= 6 for y in ys), f"the top rung was blanked away: {ys}"
        assert not any(y < H * 0.06 for y in ys), f"the comb was read as a rung: {ys}"


def _plasmid(path):
    """A map with everything the construct reader has to get right: a promoter
    that is the one, a promoter that is the vector's own, tags inside the frame,
    a protease site drawn as its whole recognition sequence, a 2A, and an IRES
    with a second protein after it."""
    from Bio.Data import CodonTable
    from Bio.Seq import Seq
    from Bio.SeqRecord import SeqRecord
    from Bio.SeqFeature import SeqFeature, SimpleLocation
    from Bio import SeqIO

    back = {}
    for codon, aa in CodonTable.unambiguous_dna_by_id[1].forward_table.items():
        back.setdefault(aa, codon)
    dna = lambda prot: "".join(back[a] for a in prot)

    P2A = "ATNFSLLKQAGDVEENPGP"
    target = "MK" + "AGSTVLIE" * 7 + "WY"          # 60 aa, one W and one Y
    second = "M" + "QNDEKRST" * 6 + "W"            # 49 aa after the 2A's proline
    venus = "M" + "GAVLIFPS" * 5 + "WYC"           # 44 aa
    orf = "M" + "H" * 10 + "GGSGGSGGS" + "ENLYFQ" + "G" + target + P2A + second
    parts = []                                     # (label, kind, aa offset, aa length)
    at = 1
    for label, piece in [("10xHis", "H" * 10), ("GS linker", "GGSGGSGGS"),
                         ("TEV site", "ENLYFQG"), ("target", target), ("P2A", P2A)]:
        parts.append((label, at, len(piece)))
        at += len(piece)

    filler = "CTGAC" * 40                          # no ATG, so no frame opens in it
    seq = filler + dna(orf) + "TAA" + filler
    orf_at = len(filler)
    ires_at = len(seq)
    seq += "GCCTCTCCC" * 12                        # the IRES stands in for itself
    ires_end = len(seq)
    seq += "CTGAC" * 4 + dna(venus) + "TAA" + filler
    amp_at = len(seq)
    seq += "CTGAC" * 8 + dna("M" + "AKLGVTSED" * 27) + "TAA"

    rec = SeqRecord(Seq(seq), id="test", name="test", description="synthetic",
                    annotations={"molecule_type": "DNA", "topology": "circular"})

    def feat(kind, label, a, b):
        rec.features.append(SeqFeature(SimpleLocation(a, b, 1), type=kind,
                                       qualifiers={"label": [label]}))

    feat("promoter", "CMV promoter", orf_at - 60, orf_at - 20)
    for label, r0, n in parts:
        feat("misc_feature", label, orf_at + r0 * 3, orf_at + (r0 + n) * 3)
    feat("misc_feature", "IRES", ires_at, ires_end)
    feat("CDS", "Venus", ires_end + 20, ires_end + 20 + len(venus) * 3 + 3)
    feat("promoter", "AmpR promoter", amp_at, amp_at + 30)
    SeqIO.write(rec, path, "genbank")
    return orf, target, second, venus


def test_a_map_reads_into_a_construct():
    """Every residue of the frame lands in exactly one segment, in order.

    That one check covers all the splitting: a 2A cut in the wrong place, a
    protease site trimmed to the wrong residue, a feature snapped to the wrong
    codon -- each of them either loses a residue or prints it twice, and the
    mass the panel exists to report moves with it.
    """
    import tempfile
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "synthetic.gb")
        orf, target, second, venus = _plasmid(path)
        r = S.construct_from_map(path)

        assert r["promoter"] == "CMV promoter", \
            f"the vector's own promoter was picked: {r['promoter']}"
        assert len(r["chains"]) == 2, f"an IRES makes a second protein: {len(r['chains'])}"

        a, b = r["chains"]
        assert "".join(s["seq"] for s in a["segs"]) == orf, "the frame was not covered exactly once"
        assert b["via"] == "IRES" and b["name"] == "Venus"
        assert "".join(s["seq"] for s in b["segs"]) == venus

        by = {s["name"]: s for s in a["segs"]}
        assert by["10xHis"]["seq"] == "H" * 10
        # Drawn as ENLYFQG on the map; TEV cuts ENLYFQ / G.
        assert by["TEV site"]["seq"] == "ENLYFQ" and by["TEV site"]["cut"]
        assert by["P2A"]["cut"] and by["P2A"]["seq"].endswith("NPG"), by["P2A"]["seq"]
        assert by["target"]["seq"] == target and by["target"].get("start") == 1

        # The three pieces the panel will weigh: everything up to the TEV cut,
        # the protein between the two cuts, and what the 2A leaves downstream.
        pieces, cur = [], []
        for s in a["segs"]:
            cur.append(s["seq"])
            if s["cut"]:
                pieces.append("".join(cur)); cur = []
        pieces.append("".join(cur))
        assert pieces[-1] == "P" + second, f"the 2A kept the proline: {pieces[-1][:12]}"
        assert pieces[1].startswith("G" + target[0]), f"TEV left the wrong end: {pieces[1][:8]}"


def _clc(path, seq):
    """A .clc holding the one thing this reads out of one: the packed byte[].

    The rest of a real file is a serialized Java object graph; the reader walks
    past all of it to this array, so the array is all the test needs to be.
    """
    import struct
    packed = bytearray()
    for i in range(0, len(seq), 4):
        b = 0
        for j, c in enumerate(seq[i:i + 4].ljust(4, "A")):
            b |= "ACGT".index(c) << (6 - 2 * j)
        packed.append(b)
    body = bytes([0x80, 0xFE, len(seq) >> 8, len(seq) & 0xFF, 0, 0, 0, 0]) + bytes(packed)
    blob = (b"CLC" + b"\0" * 29 + b"\xac\xed\x00\x05" +
            b"ur\x00\x02[B" + b"\0" * 8 + b"\x02\x00\x00xp" +
            struct.pack(">i", len(body)) + body)
    with open(path, "wb") as fh:
        fh.write(blob)
    return blob


def test_a_clc_is_read_from_its_bases():
    """A .clc names nothing this can read, so the sequence has to say it all.

    Two things can go quietly wrong here and both put a wrong protein on a
    figure: the bases can come out of the packing shifted, which still looks
    like DNA, and a file whose array holds more than one block can decode into
    a plausible sequence that is not the plasmid.  So the bases are checked
    against what went in, and the second kind of file has to be refused rather
    than read.
    """
    import tempfile
    from Bio.Data import CodonTable

    back = {}
    for codon, aa in CodonTable.unambiguous_dna_by_id[1].forward_table.items():
        back.setdefault(aa, codon)
    dna = lambda prot: "".join(back[a] for a in prot)

    CMV = "GGTAGGCGTGTACGGTGGGAGGTCTATATAAGCAGAGCT"      # what the reader looks for
    P2A = "ATNFSLLKQAGDVEENPGP"
    target = "MK" + "AGSTVLIE" * 7 + "WY"
    second = "M" + "QNDEKRST" * 6 + "W"
    orf = "M" + "H" * 10 + "LEVLFQGP" + target + P2A + second
    filler = "CTGAC" * 30                                # opens no frame of its own
    seq = filler + CMV + "CTGAC" * 6 + dna(orf) + "TAA" + filler

    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "synthetic.clc")
        _clc(path, seq)
        name, got, feats, circular = S.read_sequence_file(path)
        assert got == seq, "the bases did not survive two-bit packing"
        assert name == "synthetic" and circular
        assert [f["label"] for f in feats] == ["CMV promoter"], feats

        r = S.construct_from_map(path)
        assert r["found"] and r["promoter"] == "CMV promoter"
        segs = r["chains"][0]["segs"]
        assert "".join(s["seq"] for s in segs) == orf, "a residue went missing"
        by = {s["name"]: s for s in segs}
        assert by["10xHis"]["seq"] == "H" * 10
        # Drawn as LEVLFQGP; 3C cuts LEVLFQ / GP, and the GP is the next protein's.
        assert by["HRV 3C site"]["seq"] == "LEVLFQ" and by["HRV 3C site"]["cut"]
        assert by["P2A"]["cut"] and by["P2A"]["seq"].endswith("NPG")

        # One array, two blocks in it: the sizes no longer agree, and a sequence
        # read out of it anyway would be wrong from the first block boundary on.
        blob = _clc(path, seq)
        i = blob.rindex(b"\x02\x00\x00xp") + 5
        patched = bytearray(blob)
        patched[i:i + 4] = struct.pack(">i", len(blob) - i - 4 + 9)
        with open(path, "wb") as fh:
            fh.write(bytes(patched) + b"\0" * 9)
        try:
            S.read_sequence_file(path)
        except ValueError as e:
            assert "Export" in str(e), e
        else:
            raise AssertionError("a file this cannot read was read anyway")


def test_a_fasta_with_no_promoter_is_read_from_its_frames():
    """A FASTA carries a sequence and nothing else — no promoter, no features.

    So the frame is picked out of the sequence, and the thing that has to be
    right is *which* frame: a plasmid's resistance gene is long and a construct
    is not always longer, so length alone would put the marker on the figure.
    The frame carrying the tags is the one somebody built.
    """
    import tempfile
    from Bio.Data import CodonTable

    back = {}
    for codon, aa in CodonTable.unambiguous_dna_by_id[1].forward_table.items():
        back.setdefault(aa, codon)
    dna = lambda prot: "".join(back[a] for a in prot)

    target = "MK" + "AGSTVLIE" * 20 + "WY"                  # 163 aa, with tags
    marker = "M" + "QNDEKRST" * 40 + "W"                    # 322 aa, longer, bare
    orf = "M" + "H" * 10 + "LEVLFQGP" + target
    filler = "CTGAC" * 30                                   # opens no frame of its own
    seq = filler + dna(orf) + "TAA" + filler + dna(marker) + "TAA" + filler

    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "insert.fasta")
        with open(path, "w") as fh:
            fh.write(">insert\n" + seq + "\n")

        r = S.construct_from_map(path)
        assert r["guessed"] and r["found"], r
        chain = r["chains"][0]
        assert chain["aa"] == len(orf), "the longer, bare frame won over the tagged one"
        assert "".join(s["seq"] for s in chain["segs"]) == orf
        by = {s["name"]: s for s in chain["segs"]}
        assert by["10xHis"]["seq"] == "H" * 10
        assert by["HRV 3C site"]["cut"]
        # The marker frame is still offered, so the choice is the user's to change.
        assert marker in [c["label"] for c in r["promoters"]] or \
            any(o["aa"] == len(marker) for o in r["promoters"]), r["promoters"]

        # A plasmid's gene sits wherever the file happened to be cut open, which is
        # often across the start.  An origin in the sequence is what says the file
        # is circular and the frame may be read through the join.
        cut = len(filler) + 60
        wrapped = seq[cut:] + S.ORI.pattern.split("|")[0] + seq[:cut]
        with open(path, "w") as fh:
            fh.write(">wrapped\n" + wrapped + "\n")
        r = S.construct_from_map(path)
        assert r["circular"], "an origin of replication did not make the file circular"
        assert r["chains"][0]["aa"] == len(orf), "the frame was cut at the join"

        # Without the origin it is a fragment, and reading through the join would
        # invent a protein that only exists because a file started where it did.
        with open(path, "w") as fh:
            fh.write(">fragment\n" + seq[cut:] + seq[:cut] + "\n")
        assert not S.construct_from_map(path)["circular"]

        # Several sequences in one file: reading the first silently would title the
        # panel after one of them and draw another.
        with open(path, "w") as fh:
            fh.write(">one\n" + seq + "\n>two\n" + seq + "\n")
        try:
            S.construct_from_map(path)
        except ValueError as e:
            assert "2 sequences" in str(e), e
        else:
            raise AssertionError("a file holding two constructs was read as one")


def test_a_blast_hit_becomes_a_name_a_bar_can_carry():
    """What a database calls an entry is a record; a bar needs the three words.

    And the part that has to hold is the refusal: a segment too short to mean
    anything must not be sent off the machine at all.
    """
    assert S._hit_name("RecName: Full=Green fluorescent protein [Aequorea victoria]") \
        == "Green fluorescent protein"
    assert S._hit_name("RecName: Full=Maltose/maltodextrin-binding periplasmic protein; "
                       "AltName: Full=MMBP; Flags: Precursor [Escherichia coli]") \
        == "Maltose/maltodextrin-binding periplasmic protein"
    assert S._hit_name("volume-regulated anion channel subunit LRRC8A [Homo sapiens]") \
        == "volume-regulated anion channel subunit LRRC8A"
    assert S._hit_name("chain A, Something >chain B, Something") == "chain A, Something"
    # Nothing recognisable left: the record itself, rather than an empty label.
    assert S._hit_name("[Homo sapiens]") == "[Homo sapiens]"

    r = S.app.test_client().post("/api/seq/blast", json={"seq": "MKV"})
    assert r.status_code == 400 and "dozen" in r.get_json()["error"], r.get_json()


def test_a_cut_membrane_is_not_a_fold():
    """Several membranes in one picture, and the cuts found inside them.

    The thing that has to hold is the difference between a cut and a shadow.  A
    cut is a thin line; a fold, or the shading where a membrane curls at its own
    edge, is darker than any cut and would win every contest decided on depth.
    So this blot carries both, and the fold is twice as deep as the cut.
    """
    h, w = 700, 900
    img = np.full((h, w), 400, np.uint16)                 # the imager's tray
    img[40:330, 150:800] = 40000                          # one membrane
    img[380:660, 150:800] = 40000                         # and another beside it
    # A cut across the first, a degree off square, as a membrane is really laid.
    for x in range(150, 800):
        img[185 + int(round(0.02 * (x - 475))), x] = 31000
    # A fold across the second: deeper, and twenty pixels wide instead of three.
    prof = np.cos(np.linspace(-np.pi / 2, np.pi / 2, 41)) ** 2
    for i, f in enumerate(prof):
        img[500 + i, 150:800] = 40000 - int(18000 * f)

    pieces = S._membranes(img.astype(np.float64))
    boxes = [(p["sheet"], p["y"], p["h"], p["cut"]["top"], p["cut"]["bottom"]) for p in pieces]
    assert len(pieces) == 3, boxes                        # cut membrane split, folded one whole
    assert [b[0] for b in boxes] == [1, 1, 2], boxes
    assert boxes[0][3] is False and boxes[0][4] is True, boxes
    assert boxes[1][3] is True and boxes[1][4] is False, boxes
    assert boxes[2][3] is False and boxes[2][4] is False, "a fold was read as a cut"
    assert abs(boxes[1][1] - 186) <= 4, boxes             # the cut, where it was drawn
    assert not any(p["cut"]["left"] or p["cut"]["right"] for p in pieces), boxes
    # Tilt is reported in pixels across the width, so a panel can be told how far
    # off square the membrane it was cut from was lying.
    assert abs(pieces[0]["tilt"] - 0.02 * 650) < 3, pieces[0]["tilt"]

    # And without the slope search it is not there at all: thirteen rows of drift
    # flatten a one-pixel line into the membrane it is cut into.
    assert not S._cuts(img[40:330, 150:800].astype(np.float64), tilt=0.0), \
        "found square-on what is not lying square"
    assert len(S._cuts(img[40:330, 150:800].astype(np.float64))) == 1


def test_a_staggered_tray_of_membranes_is_found_piece_by_piece():
    """Membranes laid out the way people lay them out, and one badly lit.

    Two things broke on a real tray of seven.  The pieces were found by
    projection — dark rows across the whole picture, then dark columns within
    each band — which needs the gaps between membranes to line up into
    full-width and full-height lanes of tray, and on a staggered tray there is
    no such line anywhere: the whole field came back as one rectangle, cut into
    quarters, offered as four panels that were each part of three membranes.
    And the one threshold was a share of the picture's range, so the dimmest
    membrane, lit a quarter as brightly as the brightest, fell out of it.

    Every gap here is blocked by another membrane, and one membrane is lit
    across a five-fold gradient.
    """
    h, w = 700, 900
    img = np.full((h, w), 400, np.float64)                 # the tray
    img[40:330, 60:430] = 40000
    img[20:300, 470:860] = 40000                           # offset, so no dark row
    img[330:610, 540:860] = 40000                          # and no dark column
    img[360:640, 60:500] = np.linspace(40000, 8000, 440)[None, :]

    pieces = S._membranes(img)
    boxes = sorted((p["x"], p["y"], p["w"], p["h"]) for p in pieces)
    assert len(pieces) == 4, boxes
    assert len({p["sheet"] for p in pieces}) == 4, boxes   # four membranes, not one cut up
    assert not any(any(p["cut"].values()) for p in pieces), "a gradient was read as a cut"
    assert boxes == [(60, 40, 370, 290), (60, 360, 440, 280),
                     (470, 20, 390, 280), (540, 330, 320, 280)], boxes
    # The dim end of the lit-across membrane is the part a single threshold
    # loses: it drops below three tenths of the picture's range around x = 440.
    assert boxes[1][0] + boxes[1][2] == 500, boxes[1]


def test_a_membrane_strip_does_not_lean():
    """A lean is measured off lanes, and a strip of blank membrane has none.

    The lean shears every band box on the panel, so a made-up one is not a
    cosmetic error: it moves the boxes densitometry is taken in.  Two ways to
    get one out of nothing -- a flat correlation whose argmax is noise, and a
    peak still climbing where the search window ends -- and both showed up on a
    real blot, as 42 px and 63 px of lean across membranes lying flat.
    """
    def gel(h, w, rows, lean):
        img = np.full((h, w), 240, np.uint8)             # bright scan, dark bands
        for y in rows:
            for i in range(10):
                c = int(w * (i + 0.5) / 10 + lean * (y / h - 0.5))
                img[y:y + 8, max(0, c - 10):c + 10] = 40
        return img

    # A gel that really leans: 30 px of drift across its height, both sides.
    ll, lr = S.lane_skew(gel(400, 500, range(60, 340, 40), 30.0), True)
    assert 20 < abs(ll) < 40 and 20 < abs(lr) < 40, (ll, lr)
    # Leaned the other way it comes back the other way, so the number is a
    # measurement of this gel and not a constant the guards let through.
    other = S.lane_skew(gel(400, 500, range(60, 340, 40), -30.0), True)[0]
    assert ll * other < 0 and 20 < abs(other) < 40, (ll, other)
    # And a gel that does not lean reads as one that does not.
    assert S.lane_skew(gel(400, 500, range(60, 340, 40), 0.0), True) == (0.0, 0.0)

    # A strip cut off a membrane: two rows of bands and blank membrane between.
    # There is nothing here to measure a lean from, and the answer is no lean.
    assert S.lane_skew(gel(180, 549, (60, 110), 0.0), True) == (0.0, 0.0)

    # Bands in the middle of the gel only.  Whatever they do there, they say
    # nothing about the top and the bottom, and a slope fitted across a fifth of
    # the height and read off across all of it is how a flat blot got 9 px.
    assert S.lane_skew(gel(400, 500, range(170, 240, 30), 30.0), True) == (0.0, 0.0)


def test_a_cut_gel_has_its_lanes_across_the_whole_of_it():
    """A piece cut off a gel has no comb, so the crop is the whole of it.

    The lane grid is normally fitted to the comb, which is right: the comb cuts
    the lanes and spans them whether or not they were loaded.  A strip has none
    -- it was cut below the wells -- and read for one anyway the topmost row of
    bands answered instead.  So the grid was trimmed to the lanes that happened
    to run on that strip, at a pitch to match, and two strips of one sheet came
    out with lanes of different widths that reached neither edge.
    """
    h, w, n = 300, 600, 10

    def strip(loaded):
        img = np.full((h, w), 230, np.uint8)
        for i in loaded:
            # on the grid the margin asks for, and narrow: a band row more than
            # half ink has no column background to subtract and reads as blank.
            c = int((margin + i + 0.5) * w / (n + 2 * margin))
            for y in (18, 150):                       # a row near the cut, and one below
                img[y:y + 10, c - 14:c + 14] = 60
        return img, S.find_lanes(img, S.lane_signal(img, True), n, True,
                                 membrane=True, margin=margin)

    # Ten lanes and half a lane of margin down each side: eleven pitches across
    # the piece, the first lane starting half a pitch in.  Edge to edge -- the
    # margin at nought -- spends two of the ten on the blank strips at the
    # sides, which is what asking for ten lanes and getting eight is.
    margin = 0.5
    pitch = w / (n + 2 * margin)
    img, cut = strip(range(1, 9))
    assert abs(cut[0][0] - margin * pitch) <= 2, cut
    assert abs(cut[-1][1] - (w - margin * pitch)) <= 2, cut
    assert all(abs((b - a) - pitch) <= pitch / 3 + 1 for a, b in cut), cut

    margin = 0.0
    _, flush = strip(range(1, 9))
    assert flush[0][0] == 0 and flush[-1][1] == w, flush

    # The other strip off the same sheet, with other lanes on it: same sheet,
    # same comb, so the same lanes -- which is the whole of what was wrong.
    margin = 0.5
    _, kin = strip((0, 4, 9))
    assert all(abs(a[0] - b[0]) <= pitch / 3 + 1 for a, b in zip(cut, kin)), (cut, kin)

    # And the comb still rules where there is one: the flag is the crop saying
    # it has no wells in it, not a new opinion about where lanes go.
    gel = S.apply_levels(_gel_with_a_comb(0.06, (0.3, 0.6)).astype(np.float32),
                         0, 65535, 1.0, False)
    lanes = S.find_lanes(gel, S.lane_signal(gel, True), 12, True)
    assert len(lanes) == 12 and all(abs((b - a) - gel.shape[1] / 12) <= 14
                                    for a, b in lanes), lanes


def test_one_comb_cuts_lanes_of_one_width():
    """Lanes come out equal, because a comb cuts them equal.

    What slides onto the gaps is the grid -- its pitch and where it starts --
    and not each boundary on its own.  Slid one at a time, onto the quietest
    column within a third of a pitch, boundaries walk onto whatever gap is
    nearest: one control strip of one figure came out 34, 51, 46, 55, 33, 48,
    44, 50 and 46 px wide from a comb whose teeth are all one width, and its
    widest lane sat 8 px off its own band.  Nothing downstream can take that
    out, because fitting a control strip under its blot shifts and scales the
    whole strip -- it cannot make its lanes unequal to match.  That pair read
    0.51 mm out of a 3.44 mm pitch, and 0.04 mm once both grids were one pitch.

    The pitch has to be free as well as the offset.  On a piece cut below the
    wells there is no comb to read it off, so it is guessed from the crop width
    -- and a crop carries whatever blank was cut with it.
    """
    h, w, n, pitch, first = 300, 560, 9, 46, 82
    img = np.full((h, w), 232, np.uint8)
    for i in range(n):
        c = first + i * pitch
        for y in (60, 180):
            img[y:y + 12, c - 10:c + 10] = 55
    # The crop is 560 px over 9 lanes and a half-lane margin each side: 56 px a
    # lane, a fifth wider than the comb really cut.
    lanes = S.find_lanes(img, S.lane_signal(img, True), n, True, membrane=True, margin=0.5)
    wide = [b - a for a, b in lanes]
    assert max(wide) - min(wide) <= 1, wide
    assert abs(sum(wide) / n - pitch) <= 3, wide
    for i, (a, b) in enumerate(lanes):
        c = first + i * pitch
        assert a < c < b, (i, c, lanes)
        assert abs((a + b) / 2 - c) <= pitch / 4, (i, c, lanes)


def test_the_lanes_you_have_can_be_made_one_pitch():
    """Even up a grid that is already assigned, on a strip no finder can read.

    `find_lanes` reads the column signal, and on a loading-control strip with a
    blown-out membrane edge the edge outweighs every band on it -- the strip in
    this test is that strip.  What is still readable is the ink in the lanes
    that are already named, so only the pitch and where the grid starts are
    fitted, against the lane number.  Worth doing at all because a control strip
    is placed under its blot by a shift and a scale: lanes 65, 65, 68, 70, 47,
    56, 65, 71, 68 px wide cannot be matched to a blot however the panel is
    fitted, and that pair sat 1.09 mm out of a 7.57 mm pitch.

    The blank lane has no band to fit to, and the saturated one's ink is not
    where its band is, so neither may tilt the grid.
    """
    h, w, n, pitch, first = 40, 650, 9, 63.0, 76.0
    img = np.full((h, w), 235, np.uint8)
    for i in range(n):
        if i == 4:                                   # the blank: the ladder lane
            continue
        c = int(round(first + pitch * i))
        if i == 8:                                   # the membrane's blown-out end
            img[:, c - 10:] = 20
            continue
        img[16:24, c - 12:c + 12] = 70       # narrow: a row over half ink has no
        #                                      background to subtract and reads blank

    # The grid as a per-boundary nudge leaves it: one comb, lanes 47 to 71 wide.
    rng = np.random.default_rng(5)
    cut = [first + pitch * (i - 0.5) for i in range(n + 1)]
    ragged = [[int(round(cut[i] + (0 if i in (0, n) else rng.integers(-8, 9)))),
               int(round(cut[i + 1] + (0 if i + 1 in (0, n) else rng.integers(-8, 9))))]
              for i in range(n)]
    for i in range(n - 1):                           # boundaries are shared
        ragged[i + 1][0] = ragged[i][1]
    assert max(b - a for a, b in ragged) - min(b - a for a, b in ragged) >= 8, ragged

    roles = ["sample"] * n
    roles[4] = "blank"
    out = S.even_lanes(img, ragged, roles)
    wide = [b - a for a, b in out]
    assert max(wide) - min(wide) <= 1, wide
    assert abs(sum(wide) / n - pitch) <= 1, wide
    for i in range(n - 1):                           # and the band is in its lane
        c = first + pitch * i
        a, b = out[i]
        assert a < c < b and abs((a + b) / 2 - c) <= pitch / 4, (i, c, out)

    # Nothing to fit to is left alone rather than guessed at.
    blank = np.full((h, w), 235, np.uint8)
    assert S.even_lanes(blank, ragged, roles) == [[a, b] for a, b in ragged]


def test_the_ladder_lane_is_found_in_the_white_light():
    """Where the size standards are, on a picture that does not show the lanes.

    A western's white light is the only picture the prestained ladder is in, and
    it shows nothing else — the samples are colorless until they are probed —
    so the lane has to be found rather than pointed at. What is in the way is
    everything else dark on a membrane: the pen mark beside lane 1, and the
    corner of imager tray inside a crop of a membrane lying a few degrees off
    square, which is darker than any rung.
    """
    h, w = 200, 400
    img = np.full((h, w), 200, np.uint8)                  # membrane
    for y in (40, 80, 120, 160):                          # the ladder
        img[y:y + 9, 150:186] = 110
    for y in (30, 62, 104, 140):                          # somebody's biro
        img[y:y + 22, 6:13] = 70
    img[:6, :40] = 20                                     # a corner of the tray
    img[h - 4:, :] = 30                                   # and the membrane's edge

    x0, x1 = S._ladder_lane(img, True, True, 40)
    assert 150 <= (x0 + x1) // 2 < 186, (x0, x1)          # the ladder, not the biro
    bands, _ = S._rungs(img, x0, x1, True, True)
    ys = [b["y"] for b in bands]
    assert len(ys) == 4 and all(abs(a - b) <= 4 for a, b in zip(ys, (44, 84, 124, 164))), bands

    # The same ladder on a strip a quarter the height: a rung is the same few
    # pixels across whether it is on a whole blot or on a piece cut off one, and
    # read as a share of the height the test of one collapsed inside the band.
    short = img[20:120]
    ys = [b["y"] for b in S._rungs(short, x0, x1, True, True)[0]]
    assert len(ys) == 2 and all(abs(a - b) <= 4 for a, b in zip(ys, (24, 64))), ys



def test_a_box_sits_on_the_band_and_not_on_its_first_bright_row():
    """A band overexposed into a flat top still gets a box around the band.

    The maximum of a plateau is its first row, and a box centered there sat
    half a band high -- the complaint that started this, four lanes of blot
    with the boxes visibly above the black.  So the band's two ends decide
    where the box goes and the peak only decides which band it is.
    """
    n = 400
    prof = np.zeros(n, np.float32)
    # A band from 150 to 210 whose middle 40 rows are clipped flat, plus the
    # smear below a heavy band, so the two ends are not the same distance away.
    prof[150:210] = 100.0
    prof[140:150] = np.linspace(0, 100, 10)
    prof[210:245] = np.linspace(100, 0, 35)
    y, h, peak, snr = S.find_band(prof, 180.0, 40.0)
    assert snr > 3, snr
    lo, hi = y - h / 2, y + h / 2
    assert lo <= 150 and hi >= 210, (y, h)          # the whole flat top is in it
    assert abs(y - 190) <= 12, y                    # near the middle of 140..~240
    assert h <= 130, h                              # and not the whole lane

    # A clean symmetric band is found where it always was.
    sym = np.zeros(n, np.float32)
    sym[195:206] = 100.0
    y2, h2, _, _ = S.find_band(sym, 200.0, 20.0)
    assert abs(y2 - 200) <= 2, y2
    assert y2 - h2 / 2 <= 195 and y2 + h2 / 2 >= 206, (y2, h2)

    # Nothing to find: the click stays where it was put rather than being walked
    # onto whatever is nearest.  The gate is a soft one -- a blank lane with
    # shading on it reads three to four times its own grain, with the old narrow
    # baseline as well as this one, and measuring the peak above the lane's
    # median instead refuses 31 of the 160 bands in the ClC-7 session, GAPDH
    # loading controls among them, because a 35-row panel is mostly band.  So
    # only an empty lane is promised here.
    y3, h3, _, snr3 = S.find_band(np.full(n, 40.0, np.float32), 200.0, 30.0)
    assert h3 is None and snr3 < 3 and y3 == 200, (y3, h3, snr3)

def test_a_crooked_gel_is_read_off_its_bands_and_straightened():
    """The rows of bands say what the lanes cannot, and say it the same way.

    A gel laid on the scanner a couple of degrees off has both: its rows of
    bands run downhill across it and its lanes drift sideways going down, by the
    one angle.  The lean is read off the lanes, which needs a pattern down the
    whole height; a blot with a few rows of bands on it has none -- that is the
    case this is for -- and then the bands are all there is to read.  The two
    have to agree in sign, because the fallback hands one to the other, and a
    sign the wrong way round doubles the lean instead of taking it off.
    """
    import math
    h, w = 500, 600
    deg = 2.5

    # Built, not rotated: rows of bands running downhill to the right is what
    # clockwise means here, and the whole chain of signs hangs off this picture.
    sl = math.tan(math.radians(deg))
    bands = np.full((h, w), 210, np.uint8)
    for y0 in (120, 250, 380):
        for x in range(30, w - 30):
            bands[int(round(y0 + sl * (x - w / 2))) - 6:][:12, x] = 40
    got, sure = S.band_tilt(bands)
    assert sure and abs(got - deg) < 0.4, (got, sure)

    # Straightening is that angle back the other way, and then there is nothing
    # left to take off.
    again, _ = S.band_tilt(S.oriented(bands, tilt=-got).astype(np.uint8))
    assert abs(again) < 0.4, (got, again)

    # A whole blot, upright, then turned clockwise by the same angle.
    rng = np.random.default_rng(3)
    gel = np.full((h, w), 215, np.uint8)
    for i in range(10):
        x0 = 40 + i * 58
        for y0 in (120, 250, 380):
            if (i + y0) % 7 == 3:
                continue                                  # not every lane ran everything
            gel[y0 - 7:y0 + 7, x0 - 20:x0 + 20] = int(rng.integers(40, 110))
    crooked = S.oriented(gel, tilt=deg).astype(np.uint8)

    # Three rows of bands and nothing else down the height: this is the picture
    # the lanes cannot be read on, and it says so rather than inventing a lean.
    assert S.lane_skew(crooked, True) == (0.0, 0.0)
    got, sure = S.band_tilt(crooked)
    assert sure and abs(got - deg) < 0.4, (got, sure)

    def drift(u8):
        """How far the lane pattern moved between the top and the bottom of the
        picture, + to the right going down."""
        def prof(a):
            a = 255.0 - a.astype(np.float32)
            a = a - np.median(a, axis=1, keepdims=True)
            np.clip(a, 0, None, out=a)
            return a.sum(0)
        top, bot = prof(u8[40:150]), prof(u8[350:460])
        lags = np.arange(-40, 41)
        return -lags[int(np.argmax([np.dot(np.roll(bot, int(l)), top) for l in lags]))]

    assert drift(crooked) < -8, drift(crooked)            # turned clockwise, so: left
    # What the fallback writes into leanL and leanR, and the only thing that
    # makes it worth writing: put it through the straightener and the drift is
    # gone.  The other sign is the same error twice.
    lean = -h * math.tan(math.radians(got))
    assert abs(drift(S.deskew(crooked, lean, lean))) <= 2, drift(S.deskew(crooked, lean, lean))
    assert abs(drift(S.deskew(crooked, -lean, -lean))) > 8
    # Worth writing, and the test of it: the shear deepens the gaps between the
    # lanes, because the lanes were turned along with the bands.
    assert S.lane_relief(S.deskew(crooked, lean, lean)) > S.lane_relief(crooked) * 1.02

    # The other gel the bands look identical on: one that ran downhill with its
    # lanes upright.  Nothing about the rows of bands separates the two, so the
    # shear is what separates them -- here it fills the gaps in instead, and
    # must not be kept.  Unchecked, this is a lane grid leaning across bands
    # that do not lean, on every blot that did not run level.
    uneven = np.full((h, w), 215, np.uint8)
    for i in range(10):
        x0 = 40 + i * 58
        for y0 in (120, 250, 380):
            if (i + y0) % 7 == 3:
                continue
            yy = int(round(y0 + sl * (x0 - w / 2)))
            uneven[yy - 7:yy + 7, x0 - 20:x0 + 20] = int(rng.integers(40, 110))
    assert S.lane_skew(uneven, True) == (0.0, 0.0)
    deg2, sure2 = S.band_tilt(uneven)
    assert sure2 and abs(deg2 - deg) < 0.4, (deg2, sure2)
    bad = -h * math.tan(math.radians(deg2))
    assert S.lane_relief(S.deskew(uneven, bad, bad)) < S.lane_relief(uneven)


def test_a_tight_crop_does_not_make_every_band_vanish():
    """A strip cropped close around one band still has bands on it.

    `find_band` reads a band's height against a rolling minimum down the whole
    lane, which is the only baseline it has while it is still looking.  A
    loading control is cropped to a couple of band-heights, so that minimum sits
    on the band and nothing stands out of anything -- 19 boxes of one figure
    wore "no band found" over bands plainly there, a whole GAPDH row among them.
    What is measured here is the reading that replaced it: the lane's own
    background, and the rule that a box holding its lane's darkest row is on
    that lane's band whatever the ratio says.
    """
    rng = np.random.default_rng(11)
    h, w, lane = 30, 300, 100                      # three lanes, 30 rows: a control strip
    sig = rng.normal(400, 12, (h, w)).astype(np.float32)
    for i in range(3):
        sig[13:21, i * lane + 15:(i + 1) * lane - 15] += 9000
    flat = np.zeros_like(sig, bool)
    on = [{"id": f"on{i}", "x0": i * lane + 10, "x1": (i + 1) * lane - 10, "y": 17, "h": 10}
          for i in range(3)]
    for m in S.measure_bands(sig, flat, on):
        assert m["onPeak"], m
        assert m["snr"] > 3, m                      # was under 3 on the rolling minimum

    # A box on blank membrane in a lane whose band is elsewhere is still empty,
    # which is the whole point of the flag.
    off = S.measure_bands(sig, flat, [{"id": "off", "x0": 10, "x1": 90, "y": 4, "h": 7}])[0]
    assert not off["onPeak"], off
    assert off["snr"] < 3, off

    # And the ratio is reported whether or not the box was searched for, or it
    # goes stale the moment the box is moved.
    assert S.measure_bands(sig, flat, on[:1])[0]["snr"] is not None


def test_nothing_in_the_picture_is_not_an_angle():
    """Blank membrane is level at every angle, and must say so rather than pick."""
    flat = np.full((400, 500), 200, np.uint8)
    deg, sure = S.band_tilt(flat)
    assert not sure, deg
    noise = (np.random.default_rng(7).normal(200, 3, (400, 500))).clip(0, 255).astype(np.uint8)
    deg, sure = S.band_tilt(noise)
    assert not sure or abs(deg) < 0.4, (deg, sure)


def test_the_figure_pdf_is_exactly_the_page_and_still_text():
    """A vector PDF, drawn by a browser, at the millimeter the figure says.

    Two things can go quietly wrong here.  The browser can rasterize -- which is
    what macOS's own `sips -s format pdf` does, to a JPEG, and what would make
    this export worthless -- so the text has to still come back out as text.
    And Chrome rounds the paper to its own 1/300 inch grid: 183 x 240 mm comes
    out 183.13 x 239.86, which is both the wrong size and a page with the
    bottom edge of the figure hanging off it.  `exact_page` writes the box
    again; if that stops happening, this fails by a tenth of a millimeter.
    """
    if not S.find_chrome():
        print("  (skipped: no Chrome, Chromium or Edge on this machine)")
        return
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" width="183mm" height="240mm" '
           'viewBox="0 0 183 240">'
           '<rect x="0" y="0" width="183" height="240" fill="none" stroke="#f00" '
           'stroke-width="0.2"/>'
           '<text x="6" y="238" font-size="7" font-family="Arial">bottom edge</text>'
           '</svg>')
    pdf = S.svg_to_pdf(svg, 183, 240)
    assert pdf[:5] == b"%PDF-", pdf[:16]

    import io

    import pypdf
    page = pypdf.PdfReader(io.BytesIO(pdf)).pages[0]
    w = float(page.mediabox.width) / 72 * 25.4
    h = float(page.mediabox.height) / 72 * 25.4
    assert abs(w - 183) < 0.01 and abs(h - 240) < 0.01, (w, h)
    # The text is text, and the bottom of the figure is inside the page it is
    # drawn on -- the box is anchored to the top, so a height left at Chrome's
    # would cut this line off.
    assert "bottom edge" in page.extract_text(), repr(page.extract_text())
    assert float(page.mediabox.bottom) < 0.1, page.mediabox


if __name__ == "__main__":
    for name, fn in sorted(vars().items()):
        if name.startswith("test_"):
            print(name, "...", flush=True)
            fn()
    print("ok")
