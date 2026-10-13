'use strict';
/* purifig — the three panel types that make a purification figure, and the
   shared units they are drawn in.
 *
 * Everything is millimeters.  The canvas viewBox is in mm, font sizes are held
 * in points and converted here, so a panel laid out at 85 mm is 85 mm in the
 * exported SVG and in the PDF the journal makes of it.
 *
 * app.js owns the document and the canvas; this file owns what a gel, a
 * chromatogram and a purification table look like, and what their inspectors
 * offer.  The two talk through PF.
 */

/* Filled in by app.js.  Declared here because this file loads first. */
const PF = {
  doc: null,          // the live document
  render: null,       // redraw the canvas
  inspector: null,    // redraw the side panel
  api: null,          // POST json, throw the server's message
  hint: null,         // the banner under the toolbar
  select: null,       // select one node by id
  pick: null,         // arm a click-on-the-panel picker
  source: null,       // a source image by id
  croppingNode: null, // the id of the panel being cropped by hand, if any
};

const PT = 0.352778;                 // mm per typographic point
const FONT = 'Arial, Helvetica, sans-serif';

const esc = s => String(s ?? '').replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 9);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const r2 = v => Math.round(v * 100) / 100;
const r3 = v => Math.round(v * 1000) / 1000;
const r4 = v => Math.round(v * 10000) / 10000;
const nn = v => (v === null || v === undefined || v === '' || !isFinite(v)) ? null : Number(v);

/** A text element in figure units.  pt in, mm out. */
function txt(x, y, s, o = {}) {
  // Nought point is how a panel says "keep this text in the data but do not
  // print it" -- a loading control's lane labels, say, which pair the lanes but
  // would only repeat the row above.  `||` read that as no size given and drew
  // it at seven, over a neighbor that had been given no room for it.
  const pt = o.pt ?? 7;
  if (!(pt > 0)) return '';
  const a = o.anchor || 'middle';
  const rot = o.rotate ? ` transform="rotate(${o.rotate} ${r3(x)} ${r3(y)})"` : '';
  const weight = o.bold ? ' font-weight="600"' : '';
  const style = o.italic ? ' font-style="italic"' : '';
  const fill = o.fill || '#000';
  return `<text x="${r3(x)}" y="${r3(y)}" font-family="${FONT}" font-size="${r3(pt * PT)}"` +
         ` text-anchor="${a}" fill="${fill}"${weight}${style}${rot}>${esc(s)}</text>`;
}

/** Multi-line text, lines stacked downward from y. */
function txtLines(x, y, lines, o = {}) {
  const lh = (o.pt ?? 7) * PT * (o.lineHeight || 1.2);
  return lines.map((l, i) => txt(x, y + i * lh, l, o)).join('');
}

const line = (x1, y1, x2, y2, w = 0.25, c = '#000', extra = '') =>
  `<line x1="${r3(x1)}" y1="${r3(y1)}" x2="${r3(x2)}" y2="${r3(y2)}" stroke="${c}" stroke-width="${r3(w)}" stroke-linecap="butt"${extra}/>`;

const rect = (x, y, w, h, o = {}) =>
  `<rect x="${r3(x)}" y="${r3(y)}" width="${r3(Math.max(0, w))}" height="${r3(Math.max(0, h))}"` +
  ` fill="${o.fill || 'none'}" stroke="${o.stroke || 'none'}" stroke-width="${r3(o.strokeMm ?? 0.25)}"` +
  (o.dash ? ` stroke-dasharray="${o.dash}"` : '') + (o.opacity != null ? ` opacity="${o.opacity}"` : '') + '/>';

/* =======================================================================
   GEL / BLOT
   ======================================================================= */

const LANE_ROLES = ['sample', 'ladder', 'lysate', 'load', 'loading control', 'flow-through',
                    'wash', 'eluate', 'SEC fraction', 'blank'];

/** Lanes that hold no sample, so cutting a gel in two on one of them loses
 *  nothing: it is the seam and goes to neither part. */
const SEAM_ROLES = ['ladder', 'blank'];

/** The other panels showing the same crop of the same scan and none of the same
 *  lanes: the parts a gel was cut into.  Read off the panels rather than
 *  recorded, so a part re-cropped to a different piece of the scan stops being
 *  one -- which is exactly when the claim would stop being true. */
function gelPartsOf(n, nodes) {
  const box = c => c ? `${c.x},${c.y},${c.w},${c.h}` : '-';
  return nodes.filter(x => x !== n && x.type === 'gel' && x.src === n.src &&
                           box(x.crop) === box(n.crop) &&
                           x.lanes.length === n.lanes.length &&
                           n.lanes.some(l => !l.excised) &&
                           x.lanes.some(l => !l.excised) &&
                           !x.lanes.some((l, i) => !l.excised && !n.lanes[i].excised));
}

/** The SEC fractions a gel carries, in lane order, as the collector labeled
 *  them.  This is the link between the two panels: the gel says which fractions
 *  it ran, and the chromatogram colors those and no others.  Nothing is stored
 *  twice, so the two cannot come to disagree. */
//: The lane's label *is* its fraction -- one field, which is what the brace
//: ties to the chromatogram and what prints under the lane.  `fraction` was a
//: second field for the same number and is only read now to keep sessions
//: saved while it existed.
const fracLabel = l => String(l.label || l.fraction || '').trim();

function gelFractions(n) {
  if (!n || n.type !== 'gel') return [];
  return n.lanes
    .filter(l => !l.excised && l.role === 'SEC fraction' && fracLabel(l))
    .map(l => ({ lane: l, label: fracLabel(l) }));
}

function gelNode(x, y) {
  return {
    id: uid(), type: 'gel', x: r2(x), y: r2(y), w: 60, h: 34,
    src: null, crop: null, rotate: 0, flipH: false, flipV: false,
    levels: { black: 0, white: 65535, gamma: 1, invert: false },
    href: null, imgW: 0, imgH: 0,
    leanL: 0, leanR: 0,                  // lane drift at each edge, px across the height
    lanes: [], ladder: { on: true, side: 'left', pt: 5.5, lw: 0.22, marks: [] }, fit: null,
    bands: [],
    splice: { gap: 1.0, rule: true, ruleMm: 0.3 },
    labelPt: 6, labelAngle: 0, labelGap: 1.2, showNumbers: false,
    frame: true, framePt: 0.25,
    title: '', titlePt: 6.5,
    // what the panel *is*, which the caption and the manifest read
    kind: 'SDS-PAGE',          // SDS-PAGE | native PAGE | western blot | ...
    acrylamide: '', reducing: true,
    stain: '', antibody: '', secondary: '', detection: '', exposure: '',
    membraneId: '',            // strips cut from one membrane share this
    stripNote: '',
    ...gelExtras(),
  };
}

/** The parts of a gel panel added for blots and for quantification.  Kept in
 *  one place so a figure saved before they existed can be brought up to date
 *  by filling in whatever it lacks, and nothing it has is touched. */
function gelExtras() {
  return {
    // A second picture of the same membrane, taken in the same frame: for a
    // western, the white-light image in which the prestained ladder shows and
    // the chemiluminescence does not.  { src, levels, href, k } — `k` is its
    // size over the signal's, 2 when the signal was binned 2×2.
    marker: null,
    // what the panel draws: the signal, the white light, the two multiplied, or
    // the signal with the ladder lane taken from the white light -- which is
    // how a western is read, since the prestained ladder is only in the one and
    // the bands are only in the other.
    view: 'signal',            // signal | marker | merge | ladder
    // The fine angle, clockwise degrees, applied before the quarter turns and
    // in place: nobody lays a gel on the scanner square, and no number of
    // quarter turns fixes two degrees.
    tilt: 0,
    // The region another panel shows of this one, in this picture's pixels, and
    // whether to outline it.  Only a supplementary sheet's whole-blot panels
    // carry one: a sheet of uncropped blots exists to say which part of each
    // went into the figure, and one that does not say it is just more pictures.
    cropBox: null, showCrop: true,
    // Draw the whole picture rather than the block of lanes on it.  A panel is
    // normally cut to its lanes, which is right for a figure -- what is beside
    // the outermost lane is scanner bed.  A supplementary sheet of whole blots
    // is the case where the membrane's own edges are the point.
    showAll: false,
    // The blank strip down each side of a piece with no comb, in lanes.  Ten
    // lanes means ten lanes: laid edge to edge, two of the ten are margin.
    margin: 0.5,
    // Rows of the crop to show, top to bottom, each its own strip.  Empty shows
    // the whole height.  In the crop's own pixels, like everything else here.
    strips: [], stripGap: 1.0, stripLabelSide: 'right',
    // Densitometry.  A row is one protein measured across the lanes — the
    // target, or the loading control it is divided by — with one box height
    // shared by every lane, because a box sized to each band on its own makes
    // lanes incomparable.  A band is one box: which row, which lane, where.
    quant: { method: 'border', border: 3, inset: 0.05, rows: [], bands: [] },
  };
}

/** Fill in whatever an older gel panel lacks.  Called on everything opened. */
function upgradeGel(n) {
  if (!n || n.type !== 'gel') return n;
  const x = gelExtras();
  for (const k of Object.keys(x)) if (n[k] === undefined) n[k] = x[k];
  const q = n.quant;
  if (!q.rows) q.rows = [];
  if (!q.bands) q.bands = [];
  if (q.method === undefined) q.method = 'border';
  if (q.border === undefined) q.border = 3;
  if (q.inset === undefined) q.inset = 0.05;
  return n;
}

/** Which lanes survive, grouped into runs of originally-adjacent lanes. */
function gelRuns(n) {
  const runs = [];
  let cur = null;
  n.lanes.forEach((l, i) => {
    if (l.excised) { cur = null; return; }
    if (cur && cur.lastIndex === i - 1) { cur.lanes.push(l); cur.lastIndex = i; }
    else { cur = { lanes: [l], firstIndex: i, lastIndex: i }; runs.push(cur); }
  });
  return runs;
}

/** Geometry for one gel: scale, per-run and per-lane placement, total width.
 *  Scale is uniform.  Squeezing the width to fill a slot after cutting lanes
 *  out would change the apparent mobility of every band in the panel, so the
 *  height drives and the width follows. */
/** Half the sideways drift of a lane edge at `xmm`, in mm: the boundary sits
 *  that far to the left of its stored position at the top of the panel and that
 *  far to the right at the bottom.
 *
 *  Interpolated across the width, because the two sides of a gel do not lean by
 *  the same amount — the lanes fan, and the block is a different width at the
 *  bottom than at the top.  `leanL`/`leanR` are in source pixels across the
 *  whole height, the unit the record prints and the inspector edits: a gradient
 *  of 0.062 is not a number anyone can picture. */
function gelSkew(n, L, xmm) {
  return gelLeanAt(n, gelXpx(n, L, xmm)) * L.s / 2;
}

/** The lean at crop column `xpx`, in source pixels across the height.
 *
 *  Interpolated by where a lane *is on the gel*, between the outer edges of the
 *  block of lanes — not by where it happens to be drawn.  The two differ as
 *  soon as a lane is cut out: the lanes beyond the splice are drawn further
 *  left than they ran, and interpolating by the drawing gave them the lean of a
 *  lane they were never next to. */
function gelLeanAt(n, xpx) {
  const ll = n.leanL ?? n.lean ?? 0, lr = n.leanR ?? n.lean ?? 0;
  if (!n.lanes || !n.lanes.length) return ll;
  const a = n.lanes[0].x0, b = n.lanes[n.lanes.length - 1].x1;
  const t = b > a ? clamp((xpx - a) / (b - a), 0, 1) : 0;
  return ll + (lr - ll) * t;
}

/** The crop column drawn at `xmm`, across the splices. */
function gelXpx(n, L, xmm) {
  const x = xmm - n.x, s = L.s || 1;
  for (const seg of L.segs) if (x <= seg.xmm + seg.wmm + 1e-6) return seg.x0 + (x - seg.xmm) / s;
  const last = L.segs[L.segs.length - 1];
  return last ? last.x0 + (x - last.xmm) / s : x / s;
}

/** The lean as the backend takes it: at the two edges of the scan, between
 *  which it interpolates, rather than at the edges of the block of lanes.
 *  Carried out to the edges in a straight line, so the boundaries it measures
 *  along are the ones drawn, at every lane. */
function serverLean(n) {
  const ll = n.leanL ?? n.lean ?? 0, lr = n.leanR ?? n.lean ?? 0;
  if (!n.lanes || !n.lanes.length || !n.imgW) return { leanL: ll, leanR: lr };
  const a = n.lanes[0].x0, b = n.lanes[n.lanes.length - 1].x1;
  if (!(b > a)) return { leanL: ll, leanR: lr };
  const at = x => ll + (lr - ll) * (x - a) / (b - a);
  return { leanL: r3(at(0)), leanR: r3(at(n.imgW - 1)) };
}

/** How far a lane edge at `xmm` sits from its mid-height position at crop row
 *  `ypx`, in mm: −gelSkew at the top of the crop, +gelSkew at the bottom.  A
 *  strip cut from the middle of a leaning gel keeps the lean it has there. */
function gelShift(n, L, xmm, ypx) {
  return (2 * ypx / (n.imgH || 1) - 1) * gelSkew(n, L, xmm);
}

/** The printed width of one lane, in mm, or 0 for "sized by hand".
 *
 *  It lives on the *page*, not the panel, because the point of it is that it is
 *  one number for the whole sheet -- and because `doc.page` is what the figure
 *  and the supplementary sheet swap between them, so the whole membranes keep
 *  being drawn to the page's width while the figure's blots are drawn to their
 *  lanes.  A panel can still say `laneMm: 0` to opt out, which is what the
 *  supplement's copies do. */
function gelLaneMm(n) {
  const own = nn(n.laneMm);
  if (own !== null && own !== undefined) return Math.max(0, own);
  const pg = (PF.doc && PF.doc.page) || null;
  return Math.max(0, (pg && nn(pg.laneMm)) || 0);
}

function gelLayout(n) {
  const runs = gelRuns(n);
  const gap = n.splice.gap || 0;
  // Pinned, the lane is the constant and the panel is drawn at whatever
  // magnification puts its *average* lane at that width -- average because the
  // lanes of one gel are not all the same number of pixels wide, and no panel
  // may be stretched to make them so: a gel is scaled uniformly or every
  // apparent mobility in it changes.  Blots photographed at different
  // magnifications then print at one lane pitch, which is what makes two of
  // them comparable, exactly as a fixed bar width does for two graphs.
  // Not a loading control: its height is its blot's business.  `gelSyncControls`
  // fits it against the blot's lane *centers*, which is a stricter thing than a
  // mean lane width -- the two strips went through one comb, so their spacing
  // agrees to a fraction of a percent even where the hand-drawn lane widths do
  // not, and taking the mean width here instead would walk the pair out of
  // register by a tenth of a millimeter across nine lanes.  Pinning the blot
  // pins the control, through the blot.
  const pin = gelBlotOf(n) ? 0 : gelLaneMm(n);
  if (pin > 0 && n.imgH) {
    const ls = runs.flatMap(r => r.lanes);
    const mean = ls.reduce((a, l) => a + (l.x1 - l.x0), 0) / (ls.length || 1);
    if (mean > 0) n.h = r4(pin / mean * n.imgH);
  }
  const s = n.imgH ? n.h / n.imgH : 0;
  let cursor = 0;
  const segs = runs.map((run, i) => {
    let x0 = run.lanes[0].x0, x1 = run.lanes[run.lanes.length - 1].x1;
    // `showAll` widens the one segment to the whole picture; the lanes keep
    // their own positions inside it, being measured from the segment's start.
    if (n.showAll && runs.length === 1) { x0 = 0; x1 = n.imgW || x1; }
    const seg = { x0, x1, xmm: cursor, wmm: (x1 - x0) * s, run, spliceBefore: i > 0 };
    run.lanes.forEach(l => {
      l._xmm = cursor + (l.x0 - x0) * s;
      l._wmm = (l.x1 - l.x0) * s;
    });
    cursor += seg.wmm + gap;
    return seg;
  });
  const totalW = Math.max(0, cursor - (segs.length ? gap : 0));
  return { s, segs, totalW, runs, kept: runs.flatMap(r => r.lanes) };
}

/** The rows of the crop the panel shows, and where on the panel each lands.
 *
 *  With no strips, the whole crop.  With strips, each one's rows, stacked top
 *  to bottom with a gap between — at the gel's own scale, because a strip is
 *  part of the membrane shown at the magnification of the rest of it, not a
 *  close-up.  So the height handle still sets the whole gel's height in mm,
 *  and a strip is as tall as its share of that. */
function gelRows(n, L) {
  L = L || gelLayout(n);
  const H = n.imgH || 0;
  const strips = (n.strips || []).filter(s => nn(s.y0) !== null && nn(s.y1) !== null && s.y1 > s.y0);
  if (!strips.length || !H) return [{ y0: 0, y1: H, top: 0, hmm: n.h, strip: null, i: 0 }];
  let cursor = 0;
  return strips.map((s, i) => {
    const y0 = clamp(s.y0, 0, H), y1 = clamp(s.y1, y0 + 1, H);
    const r = { y0, y1, top: cursor, hmm: (y1 - y0) * L.s, strip: s, i };
    cursor += r.hmm + (nn(n.stripGap) ?? 1);
    return r;
  });
}

/** How tall the panel is drawn: the whole gel, or its strips and the gaps. */
function gelDrawnH(n) {
  const rows = gelRows(n), last = rows[rows.length - 1];
  return last.top + last.hmm;
}

/** Keep a panel's magnification when its crop changes.
 *
 *  A gel is drawn at `n.h / n.imgH` millimeters per picture pixel, so holding
 *  `n.h` still while the crop shrank magnified whatever was left: a strip cut
 *  down to one band came back seventeen times life size, and uncropping it
 *  squeezed the whole scan into that one band's height.  The panel is resized to
 *  the new crop instead, which is what a crop is -- less of the same picture,
 *  not a close-up of it.
 *
 *  `Ha` and `Hb` are the picture's height before and after, and `dy` is where
 *  the old top row has landed in the new picture.  The panel moves by it so that
 *  trimming the top edge does not slide the blot up the figure.  Not with
 *  strips: what sits at the panel's top is then the first strip, which has just
 *  been put back on its own rows of the scan and so holds itself.
 */
function gelKeepScale(n, Ha, Hb, dy) {
  const s = n.h / (Ha || 1);
  // No floor under the height.  One put here -- six millimeters, copied from
  // the resize handle, where it stops a drag reaching zero -- fired on the very
  // panels this is for: a one-band strip drawn 4.7 mm came back *taller* than
  // it went in, at a scale of its own.  What stops a crop reaching nothing is
  // the sixteen-pixel minimum on the crop itself, and sixteen pixels of a gel
  // are as tall as sixteen pixels of a gel.
  // Four places, not the two a page coordinate is kept to: a crop dragged by
  // hand comes through here on every mouse move, each one reading back the
  // height the last one wrote, so a rounding is not made once but a few hundred
  // times over, and at a hundredth of a millimeter a step that walks the scale
  // off a small panel by a visible amount.
  n.h = r4(s * Hb);
  if (!(n.strips || []).length) n.y = r2(n.y - dy * s);
}

/** Where crop row `ypx` is drawn, in mm below the panel's top — or null when
 *  it falls in no strip, which is to say it is not on the figure at all. */
function gelYmm(n, ypx, rows, L) {
  L = L || gelLayout(n);
  for (const r of rows || gelRows(n, L)) {
    if (ypx >= r.y0 - 1e-6 && ypx <= r.y1 + 1e-6) return r.top + (ypx - r.y0) * L.s;
  }
  return null;
}

/** The crop row under a point `ymm` below the panel's top, or null in a gap. */
function gelYpx(n, ymm, rows, L) {
  L = L || gelLayout(n);
  for (const r of rows || gelRows(n, L)) {
    if (ymm >= r.top - 1e-6 && ymm <= r.top + r.hmm + 1e-6) return r.y0 + (ymm - r.top) / (L.s || 1);
  }
  return null;
}

/** The picture the panel draws: the signal, the white-light image, or the two
 *  multiplied.  While the ladder is being clicked the white light is shown
 *  whatever the setting, since that is the picture the ladder is in; while
 *  bands are being measured, the signal, since that is what is measured. */
/** What a panel is showing at this moment: its own setting, unless something
 *  is overriding it — the ladder being clicked, or the luminescence hidden. */
function gelView(n) {
  return (PF.viewOverride && PF.viewOverride(n)) || n.view || 'signal';
}

function gelHref(n) {
  const v = gelView(n);
  const uri = v === 'marker' && n.marker && n.marker.href ? n.marker.href
            : v === 'merge' && n.mergeHref ? n.mergeHref
            : n.href;
  return uri ? PF.imgUrl(uri) : uri;
}

/** The ladder marks that land in a strip, with where they land.
 *
 *  One tick per size: two ladders run on one gel are two readings of the same
 *  standard, not two standards, and the scale beside the panel is a scale. */
function gelShownMarks(n, rows, L) {
  const seen = new Set();
  return n.ladder.marks.map(m => ({ m, ymm: gelYmm(n, m.y, rows, L) }))
                       .filter(x => x.ymm !== null)
                       .filter(({ m }) => {
                         const k = m.label || (m.kDa > 0 ? String(m.kDa) : null);
                         if (k === null || !seen.has(k)) { if (k !== null) seen.add(k); return true; }
                         return false;
                       });
}

/** The lanes carrying size standards. */
function gelLadderLanes(n) {
  return n.lanes.filter(l => !l.excised && l.role === 'ladder');
}

/** The angle to turn the picture by so that equivalent rungs of two ladders sit
 *  at the same height — clockwise degrees, null when there is no pair to read.
 *
 *  Two standards run at the two ends of a gel are the best straight edge there
 *  is on it: the same protein, the same run, so the line through the two is
 *  level exactly when the gel is.  Sizes marked in both are the pairs, and the
 *  middle pair decides, so one rung clicked on the wrong band does not. */
function gelLevelTilt(n) {
  const by = new Map();
  (n.ladder.marks || []).forEach(m => {
    if (!(m.kDa > 0) || m.y == null || m.x == null) return;
    if (!by.has(m.kDa)) by.set(m.kDa, []);
    by.get(m.kDa).push(m);
  });
  const apart = Math.max(20, (n.imgW || 0) * 0.05);
  const angles = [];
  by.forEach(list => {
    list.sort((a, b) => a.x - b.x);
    const a = list[0], b = list[list.length - 1];
    // The same ladder marked twice is not two ladders.
    if (b.x - a.x >= apart) angles.push(Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI);
  });
  if (!angles.length) return null;
  angles.sort((p, q) => p - q);
  return r2(angles[(angles.length - 1) >> 1]);
}

/** The size bar: how thick it is drawn, how long, and how far out the number
 *  beside it then sits.  A bar as long as it is thick is a blob, so a thicker
 *  bar is drawn longer with it, keeping the 6:1 of the default pair -- and the
 *  numbers step out of its way rather than being written over it. */
function gelLadderBar(n) {
  const lw = n.ladder.lw || 0.22;
  const len = Math.max(1.4, r2(lw * 6));
  return { lw, len, out: r2(0.6 + len + 0.5) };
}

/** How far the size scale reaches out from the gel on one side, in mm, so a
 *  strip label on the same side can stand clear of it. */
function gelScaleReach(n, side, rows, L) {
  if (!n.ladder.on || !n.ladder.marks.length) return 0;
  const sides = n.ladder.side === 'both' ? ['left', 'right'] : [n.ladder.side || 'left'];
  if (!sides.includes(side)) return 0;
  const shown = gelShownMarks(n, rows, L);
  if (!shown.length) return 0;
  const labels = shown.map(x => x.m.label || String(x.m.kDa)).concat([n.ladder.unit || 'kDa']);
  return gelLadderBar(n).out + Math.max(0, ...labels.map(s => textWmm(s, n.ladder.pt)));
}

/** Where a strip's label goes: beside the strip, outside the size scale when
 *  both are on the same side, centered on the strip's height. */
function gelStripLabelAt(n, r, L, rows) {
  const right = (n.stripLabelSide || 'right') === 'right';
  const reach = gelScaleReach(n, right ? 'right' : 'left', rows, L);
  const lines = String(r.strip.label).split('\n');
  const lh = n.labelPt * PT * 1.15;
  return {
    x: right ? n.x + L.totalW + 1.2 + reach : n.x - 1.2 - reach,
    y: n.y + r.top + r.hmm / 2 - (lines.length - 1) * lh / 2 + n.labelPt * PT * 0.35,
    lines, anchor: right ? 'start' : 'end',
  };
}

function gelDefs(n) {
  if (!n.href) return '';
  const L = gelLayout(n), rows = gelRows(n, L);
  // A quadrilateral, not a rectangle: the lanes of a leaning gel are cut along
  // the lanes, so an excised one takes its own column with it rather than a
  // vertical slice of itself and two of its neighbors.  Each edge gets its own
  // lean, so a fanned block stays fanned — and each strip its own part of it.
  let out = '';
  rows.forEach((r, j) => L.segs.forEach((seg, i) => {
    const yt = n.y + r.top, yb = yt + r.hmm;
    const quad = (x, w) => `${r3(x + gelShift(n, L, x, r.y0))},${r3(yt)} ` +
                           `${r3(x + w + gelShift(n, L, x + w, r.y0))},${r3(yt)} ` +
                           `${r3(x + w + gelShift(n, L, x + w, r.y1))},${r3(yb)} ` +
                           `${r3(x + gelShift(n, L, x, r.y1))},${r3(yb)}`;
    out += `<clipPath id="gc${n.id}_${i}_${j}"><polygon points="${quad(n.x + seg.xmm, seg.wmm)}"/></clipPath>`;
    // The ladder lane on its own, for the panel that draws that one lane from
    // the white light.  Nested inside the segment's clip when it is used, so a
    // lane belonging to another segment is cut away without having to be found.
    if (gelView(n) === 'ladder') gelLadderLanes(n).forEach((l, m) => {
      out += `<clipPath id="gl${n.id}_${i}_${j}_${m}">` +
             `<polygon points="${quad(n.x + l._xmm, l._wmm)}"/></clipPath>`;
    });
  }));
  return out;
}

function renderGel(n) {
  let out = '';
  const cropping = PF.croppingNode && PF.croppingNode() === n.id;
  if (cropping) {
    const src = PF.source && PF.source(n.src);
    if (src && src.preview) return renderGelCrop(n, src);
  }
  const href = gelHref(n);
  if (!href) {
    out += rect(n.x, n.y, n.w, n.h, { fill: '#f2f2f2', stroke: '#bbb', dash: '1.5 1.2' });
    out += txt(n.x + n.w / 2, n.y + n.h / 2, 'no image — pick a file in the inspector',
               { pt: 5.5, fill: '#888' });
    return out;
  }

  const L = gelLayout(n), rows = gelRows(n, L);
  n.w = r2(L.totalW);
  const H = rows[rows.length - 1].top + rows[rows.length - 1].hmm;

  // The image itself, one draw per run and strip, each clipped to its own
  // piece and shifted so the right columns and rows show through.
  rows.forEach((r, j) => {
    L.segs.forEach((seg, i) => {
      const ox = n.x + seg.xmm - seg.x0 * L.s, oy = n.y + r.top - r.y0 * L.s;
      const tile = u => `<image href="${u}" x="${r3(ox)}" y="${r3(oy)}" width="${r3(n.imgW * L.s)}" ` +
                        `height="${r3(n.imgH * L.s)}" preserveAspectRatio="none"/>`;
      out += `<g clip-path="url(#gc${n.id}_${i}_${j})">${tile(href)}</g>`;
      // And the ladder lane again, from the white light: the prestained ladder
      // is in that picture and not in the luminescence, and the two are one
      // frame, so the lane lands where the lane is.  The rest of the panel is
      // the signal and nothing has been multiplied into it.
      if (gelView(n) === 'ladder' && n.marker && n.marker.href) {
        const mh = PF.imgUrl(n.marker.href);
        gelLadderLanes(n).forEach((l, m) => {
          out += `<g clip-path="url(#gc${n.id}_${i}_${j})">` +
                 `<g clip-path="url(#gl${n.id}_${i}_${j}_${m})">${tile(mh)}</g></g>`;
        });
      }
      if (n.frame) out += rect(n.x + seg.xmm, n.y + r.top, seg.wmm, r.hmm,
                               { stroke: '#000', strokeMm: n.framePt });
    });

    // A splice is a claim about the figure, so it is drawn, not implied by a
    // gap someone might read as layout.  White gutter, hairline both sides.
    if (n.splice.rule) {
      const yt = n.y + r.top, yb = yt + r.hmm;
      L.segs.forEach(seg => {
        if (!seg.spliceBefore) return;
        const g = n.splice.gap || 0;
        const x = n.x + seg.xmm;
        out += rect(x - g, yt, g, r.hmm, { fill: '#fff' });
        out += line(x - g, yt, x - g, yb, n.splice.ruleMm, '#000');
        out += line(x, yt, x, yb, n.splice.ruleMm, '#000');
      });
    }
  });

  // The region the figure uses, outlined on the whole blot.  One segment and one
  // row only: a spliced or stripped panel shows several pieces of the picture,
  // and there is no one rectangle on it to draw.
  if (n.cropBox && n.showCrop !== false && L.segs.length === 1 && rows.length === 1) {
    const seg = L.segs[0], r = rows[0];
    const ox = n.x + seg.xmm - seg.x0 * L.s, oy = n.y + r.top - r.y0 * L.s;
    // Four corners rather than a rectangle: on a panel that was turned to level
    // it, the region the figure uses is a rotated rectangle, and its bounding
    // box would claim more of the membrane than the figure actually shows.
    const pts = n.cropBox.map(([x, y]) => `${r3(ox + x * L.s)},${r3(oy + y * L.s)}`).join(' ');
    out += `<polygon points="${pts}" fill="none" stroke="#c62f34" stroke-width="0.35"/>`;
  }

  // Size marks, from the ladder.  A wide gel is easier to read against a scale
  // at both ends than by tracking a band right across it, so `both` draws the
  // same marks twice rather than making you choose a side.  A mark in no strip
  // is not drawn: a strip shows the sizes it contains and no others.
  const shown = n.ladder.on ? gelShownMarks(n, rows, L) : [];
  if (shown.length) {
    const sides = n.ladder.side === 'both' ? ['left', 'right'] : [n.ladder.side || 'left'];
    const bar = gelLadderBar(n);
    sides.forEach(which => {
      const left = which === 'left';
      const tx = left ? n.x - 0.6 : n.x + L.totalW + 0.6;
      const lx = left ? n.x - bar.out : n.x + L.totalW + bar.out;
      shown.forEach(({ m, ymm }) => {
        const y = n.y + ymm;
        out += line(left ? tx - bar.len : tx, y, left ? tx : tx + bar.len, y, bar.lw, '#000');
        out += txt(lx, y + n.ladder.pt * PT * 0.35,
                   m.label || String(m.kDa), { pt: n.ladder.pt, anchor: left ? 'end' : 'start' });
      });
      const yUnit = n.y + Math.min(...shown.map(x => x.ymm)) - n.ladder.pt * PT * 0.9;
      out += txt(lx, yUnit, n.ladder.unit || 'kDa',
                 { pt: n.ladder.pt, anchor: left ? 'end' : 'start' });
    });
  }

  // What each strip is — the antibody, usually — beside it.
  rows.forEach(r => {
    if (!r.strip || !r.strip.label) return;
    const t = gelStripLabelAt(n, r, L, rows);
    out += txtLines(t.x, t.y, t.lines, { pt: n.labelPt, anchor: t.anchor, lineHeight: 1.15 });
  });

  // Lane labels, above the panel.
  const lp = n.labelPt * PT;
  L.kept.forEach((l, i) => {
    const cx = n.x + l._xmm + l._wmm / 2;
    if (l.label) {
      const yb = n.y - n.labelGap;
      if (n.labelAngle) {
        out += txt(cx, yb, l.label, { pt: n.labelPt, anchor: 'start', rotate: -Math.abs(n.labelAngle) });
      } else {
        const lines = String(l.label).split('\n');
        out += txtLines(cx, yb - (lines.length - 1) * lp * 1.15, lines,
                        { pt: n.labelPt, lineHeight: 1.15 });
      }
    }
    if (n.showNumbers) out += txt(cx, n.y + H + lp * 1.15, String(i + 1), { pt: n.labelPt * 0.9 });
  });

  // Band annotations: a tick beside the lane and a label.
  n.bands.forEach(b => {
    const l = n.lanes.find(x => x.id === b.lane);
    if (!l || l.excised || l._xmm === undefined) return;
    const ymm = gelYmm(n, b.y, rows, L);
    if (ymm === null) return;
    const y = n.y + ymm;
    const x = n.x + l._xmm + l._wmm;
    out += line(x + 0.3, y, x + 1.4, y, 0.22, '#000');
    out += txt(x + 1.8, y + n.labelPt * PT * 0.35, b.label, { pt: n.labelPt * 0.92, anchor: 'start' });
  });

  if (n.title) {
    out += txt(n.x + L.totalW / 2, gelTitleY(n), n.title, { pt: n.titlePt, bold: true });
  }
  return out;
}

/** The interface-only overlay: lane boundaries and ladder handles.  Drawn into
 *  the layer that export strips, so none of it can reach a figure. */
/** The whole scan with the crop drawn on it, for cropping by hand.
 *
 *  The panel normally shows the cropped render, which is exactly the thing you
 *  cannot crop by eye — you would be dragging the edges of a picture whose
 *  surroundings are not on screen.  So while cropping, the panel shows the full
 *  frame from the source preview instead, dims what is being cut away, and puts
 *  the crop back only when you leave.
 *
 *  It is drawn as large as the page will hold, in the middle of it, rather than
 *  at the panel's own size.  The panel's height is the height of the *crop*, so
 *  a strip cut down to one band drew the whole 1024-row scan in six millimeters
 *  and its crop rectangle in a quarter of one -- thinner than the handles that
 *  resize it.  A crop once cut too tight could then never be dragged back out. */
function gelCropView(n, src) {
  const pg = (PF.doc && PF.doc.page) || { w: 183, h: 240 };
  // The scan at the panel's own magnification, so the blot inside the crop
  // rectangle is the size it is in the figure and cropping does not resize what
  // is being judged.  A crop's pixels are the scan's pixels, so `n.h / n.imgH`
  // -- millimeters per crop pixel -- is millimeters per scan pixel too.  The
  // panel's height over the *scan's* height is what was wrong before: on a
  // strip cut to one band that drew the whole scan 5.9 mm across, with a crop
  // rectangle thinner than the handles that resize it.
  //
  // ponytail: no cap at the page edge, because a cap is the opposite of what is
  // being asked for -- it would fire on exactly the magnified panels whose size
  // most wants leaving alone.  A figure panel is printed near life size and
  // draws its whole scan 81 to 154 mm across, inside the page; a supplementary
  // whole-membrane panel is drawn three times larger and spills to about 440 mm,
  // so its scan runs off both sides.  The crop rectangle is what the handles are
  // on and it sits where the panel sits, on the paper, and `full frame` uncrops
  // in one click without dragging to an edge that is off it.  Cap it against
  // the page only if reaching a scan corner by hand turns out to matter on
  // those panels.
  let s = n.imgH ? n.h / n.imgH : Math.min(pg.w / src.w, pg.h / src.h);
  const c = n.crop || { x: 0, y: 0, w: src.w, h: src.h };
  // Anchored on the panel, not centered on the page.  Centering it was a jump:
  // the blot was the right size and in the wrong place, which is no better than
  // the wrong size.  `renderGel` draws picture pixel (segs[0].x0, rows[0].y0) at
  // the panel's own corner, so the crop view puts that same pixel at that same
  // corner and the blot does not move at all -- what was cropped away simply
  // appears around it.  The first lane and the first strip, because that is what
  // the panel's corner is: the crop's left margin is not drawn in the figure,
  // and with strips the top of the panel is the first strip, not the crop's top.
  let ax = 0, ay = 0;
  if (n.lanes && n.splice) {
    const L = gelLayout(n);
    if (L.segs.length) ax = L.segs[0].x0;
    ay = gelRows(n, L)[0].y0;
  }
  let x0 = n.x - (c.x + ax) * s, y0 = n.y - (c.y + ay) * s;
  // Held where it was for the whole crop, so an edge lands exactly where it is
  // let go of.  `ax` and `ay` say where the panel's corner falls inside the
  // crop, and the lanes they are read from are only moved onto the new crop
  // when the drag ends -- so working the anchor out again on every mouse move
  // slid the picture under the cursor instead of moving the outline: dragging
  // the left edge leftwards left the handle standing where it was and grew the
  // rectangle out to the right.  The two agree the moment cropping opens and
  // again the moment it closes, which is why freezing the first is right.
  const held = PF.cropHold && PF.cropHold(n);
  if (held) ({ s, x0, y0 } = held);
  const W = src.w * s, H = src.h * s;
  return { s, W, H, x0, y0, c,
           X: px => x0 + px * s, Y: py => y0 + py * s };
}

/** The picture to crop on: whichever of the two the panel is showing.  They are
 *  one frame, so the crop is the same region of the membrane either way — and
 *  cropping is exactly when the white light is wanted, because it is the picture
 *  that shows where a membrane stops.  Switching to the signal the moment the
 *  outline appeared left a field of seven membranes to be cut out of a picture
 *  in which six of them are blank. */
function gelCropHref(n, src) {
  const v = gelView(n);
  const m = v !== 'signal' && n.marker && PF.source && PF.source(n.marker.src);
  return PF.imgUrl(m && m.preview ? m.preview : src.preview);
}

function renderGelCrop(n, src) {
  const v = gelCropView(n, src);
  const { c, x0, y0 } = v, cx = v.X(c.x), cy = v.Y(c.y), cw = c.w * v.s, ch = c.h * v.s;
  let out = `<image href="${gelCropHref(n, src)}" x="${r3(x0)}" y="${r3(y0)}" ` +
            `width="${r3(v.W)}" height="${r3(v.H)}" preserveAspectRatio="none"/>`;
  const dim = { fill: '#0b0d10', opacity: 0.55 };
  out += rect(x0, y0, v.W, cy - y0, dim);
  out += rect(x0, cy + ch, v.W, y0 + v.H - (cy + ch), dim);
  out += rect(x0, cy, cx - x0, ch, dim);
  out += rect(cx + cw, cy, x0 + v.W - (cx + cw), ch, dim);
  out += rect(cx, cy, cw, ch, { stroke: '#fff', strokeMm: 0.3 });
  out += rect(cx, cy, cw, ch, { stroke: '#0b0d10', strokeMm: 0.12, dash: '1.2 1.2' });
  out += txt(cx + cw / 2, cy - 0.9,
             `${Math.round(c.w)} × ${Math.round(c.h)} px of ${src.w} × ${src.h}`,
             { pt: 5, fill: '#fff' });
  return out;
}

/** The lowest point a chromatogram panel draws to: past its tick numbers, its
 *  axis title, and the fraction bar when that is the thing underneath.  A brace
 *  hung from a fixed offset lands straight through the axis title, which is
 *  what this exists to stop. */
function chromBottom(n) {
  const pt = n.fontPt;
  const title = n.y + n.h + Math.max(n.tickMm + pt * PT * 2.4,
                                     fracBar(n, pt).below + pt * PT * 1.05);
  return title + pt * PT * 0.35;                 // clear the descenders
}

/** The membrane the figure's crop is on, as a crop of its own.
 *
 *  Which piece is decided by where the middle of the crop lies, because a crop
 *  is always inside the membrane it came off; a crop that then reaches over a
 *  cut line takes in the neighbor it reaches, since showing three quarters of
 *  what the figure used is worse than showing two strips. */
function membraneFor(pieces, c) {
  const mx = c.x + c.w / 2, my = c.y + c.h / 2;
  const home = (pieces || []).find(p => mx >= p.x && mx <= p.x + p.w &&
                                        my >= p.y && my <= p.y + p.h);
  if (!home) return null;
  let x0 = home.x, y0 = home.y, x1 = home.x + home.w, y1 = home.y + home.h;
  pieces.forEach(p => {
    if (p.sheet !== home.sheet) return;
    // A quarter of the neighbor or a quarter of the panel, not a pixel of
    // either.  A crop drawn by hand stops a hair past the membrane it was drawn
    // on, and taking in the strip under that hair put two blots on a
    // supplementary panel that is about one.
    const over = Math.max(0, Math.min(c.x + c.w, p.x + p.w) - Math.max(c.x, p.x)) *
                 Math.max(0, Math.min(c.y + c.h, p.y + p.h) - Math.max(c.y, p.y));
    if (over > 0.25 * Math.min(p.w * p.h, c.w * c.h)) {
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x + p.w); y1 = Math.max(y1, p.y + p.h);
    }
  });
  return { x: r2(x0), y: r2(y0), w: r2(x1 - x0), h: r2(y1 - y0) };
}

/** The title's baseline.  One straight line of lane labels clears in 1.9 label
 *  heights, which is where it has always sat; a second line, or a slanted row,
 *  reaches higher, and the title goes above whatever the labels actually do. */
function gelTitleY(n) {
  const lp = n.labelPt * PT;
  const kept = n.lanes.filter(l => !l.excised);
  let above = lp * 1.9;
  if (kept.some(l => l.label)) {
    const lines = Math.max(1, ...kept.map(l => String(l.label || '').split('\n').length));
    above = Math.max(above, (lines - 1) * lp * 1.15 + lp * 1.9);
    if (n.labelAngle)
      above = Math.max(above, Math.max(0, ...kept.map(l => textWmm(l.label || '', n.labelPt)))
                              * Math.sin(Math.abs(n.labelAngle) * Math.PI / 180) + lp * 1.2);
  }
  return n.y - n.labelGap - above;
}

/** The highest point a gel panel draws to: its lane labels, and its title above
 *  them.  Multi-line labels and an angled row both reach further than one line,
 *  so this asks the labels rather than assuming. */
function gelTop(n) {
  const lp = n.labelPt * PT;
  const kept = n.lanes.filter(l => !l.excised);
  const lines = Math.max(1, ...kept.map(l => String(l.label || '').split('\n').length));
  let top = n.y - n.labelGap - (kept.some(l => l.label) ? lines * lp * 1.15 : 0);
  if (n.labelAngle && kept.some(l => l.label)) {
    const longest = Math.max(0, ...kept.map(l => String(l.label || '').length));
    top = Math.min(top, n.y - n.labelGap - longest * n.labelPt * PT * 0.62
                        * Math.sin(Math.abs(n.labelAngle) * Math.PI / 180));
  }
  if (n.title) top = Math.min(top, gelTitleY(n) - n.titlePt * PT);
  return top;
}

function renderGelOverlay(n, active) {
  if (!n.href || !active) return '';
  // While the outline is being dragged the panel is showing the whole scan, and
  // the lane boundaries belong to the crop — drawing them over the full frame
  // puts them in the wrong place and invites dragging the wrong thing.
  if (PF.croppingNode && PF.croppingNode() === n.id) return '';
  const L = gelLayout(n), rows = gelRows(n, L);
  let out = '';
  // A lane, or any column of it, from crop row a to crop row b: a
  // quadrilateral that leans the way the lanes do at those rows.
  const para = (x, w, r, a = r.y0, b = r.y1) => {
    const yt = n.y + r.top + (a - r.y0) * L.s, yb = n.y + r.top + (b - r.y0) * L.s;
    return `${r3(x + gelShift(n, L, x, a))},${r3(yt)} ${r3(x + w + gelShift(n, L, x + w, a))},${r3(yt)} ` +
           `${r3(x + w + gelShift(n, L, x + w, b))},${r3(yb)} ${r3(x + gelShift(n, L, x, b))},${r3(yb)}`;
  };
  rows.forEach(r => {
    n.lanes.forEach(l => {
      if (l.excised) return;
      const x = n.x + l._xmm, w = l._wmm;
      const roleCol = l.role === 'ladder' ? '#4cb782'
                    : l.role === 'loading control' ? '#d99a4e'
                    : '#e5484d';
      out += `<polygon points="${para(x, w, r)}" fill="none" stroke="${roleCol}" ` +
             `stroke-width="0.12" opacity="0.75"/>`;
      out += `<polygon class="lanehit" data-lane="${l.id}" points="${para(x, w, r)}" fill="transparent"/>`;
    });
    // The outer edges get handles too, and say so: dragging one sets where the
    // whole block of lanes starts or stops, which is the thing you actually
    // want when the outermost "lane" is half gel margin.
    const first = L.kept[0];
    if (first) {
      out += `<polygon class="lanedge end" data-edge="${first.id}" data-end="0" ` +
             `points="${para(n.x + first._xmm - 0.5, 1, r)}" fill="transparent" style="cursor:ew-resize"/>`;
    }
    L.kept.forEach((l, i) => {
      const last = i === L.kept.length - 1;
      out += `<polygon class="lanedge${last ? ' end' : ''}" data-edge="${l.id}"` +
             (last ? ' data-end="1"' : '') +
             ` points="${para(n.x + l._xmm + l._wmm - 0.5, 1, r)}" fill="transparent" style="cursor:ew-resize"/>`;
    });
    // A strip's top and bottom are grips: drag one to show more or less of
    // the membrane there.
    if (r.strip) {
      [[r.top, 0], [r.top + r.hmm, 1]].forEach(([y, end]) => {
        out += `<rect class="stripedge" data-strip="${r.strip.id}" data-end="${end}" ` +
               `x="${r3(n.x)}" y="${r3(n.y + y - 0.45)}" width="${r3(L.totalW)}" height="0.9" ` +
               `fill="transparent" style="cursor:ns-resize"/>`;
      });
    }
  });

  // The boxes the bands were measured in, in their row's color, with each
  // one's share of the strongest band in its row.  Interface only: the numbers
  // belong in the quantification panel, not on the blot.
  const q = n.quant;
  if (q && q.bands.length) {
    const most = {};
    q.bands.forEach(b => { if (isFinite(b.net)) most[b.row] = Math.max(most[b.row] || 0, b.net); });
    q.bands.forEach(b => {
      const l = n.lanes.find(x => x.id === b.lane);
      const row = q.rows.find(x => x.id === b.row);
      if (!l || !row || l.excised || l._xmm === undefined) return;
      const [bx0, bx1] = quantBoxX(n, l);
      const x = n.x + l._xmm + (bx0 - l.x0) * L.s, w = (bx1 - bx0) * L.s;
      const a = b.y - b.h / 2, z = b.y + b.h / 2;
      const col = quantColour(n, row);
      rows.forEach(r => {
        const ya = Math.max(a, r.y0), yz = Math.min(z, r.y1);
        if (yz <= ya) return;
        // The box is also the grip that moves it: a band found by searching is
        // found at the darkest row near the click, which on a smear or a
        // doublet is not always the row meant, and there was no way to say so.
        out += `<polygon class="bandhit" data-band="${b.id}" points="${para(x, w, r, ya, yz)}" ` +
               `fill="${col}" fill-opacity="0.08" stroke="${col}" stroke-width="0.16" ` +
               `style="cursor:ns-resize"/>`;
      });
      const ymm = gelYmm(n, clamp(a, 0, n.imgH), rows, L);
      if (ymm === null) return;
      const said = b.sat ? 'sat' : b.weak ? '?' :
                   isFinite(b.net) && most[b.row] > 0 ? `${Math.round(b.net / most[b.row] * 100)}` : '…';
      out += `<text x="${r3(x + w / 2)}" y="${r3(n.y + ymm - 0.35)}" font-family="${FONT}" ` +
             `font-size="1.5" text-anchor="middle" fill="${col}" font-weight="600" ` +
             `pointer-events="none">${esc(said)}</text>`;
    });
  }
  return out;
}

/* ---- gel helpers used by the inspector ---- */

function gelAutoLanes(n, count) {
  const w = n.imgW || 1000;
  const lanes = [];
  for (let i = 0; i < count; i++) {
    lanes.push({ id: uid(), label: '', role: 'sample', excised: false,
                 x0: Math.round(w * i / count), x1: Math.round(w * (i + 1) / count),
                 load: '', fraction: '' });
  }
  return lanes;
}

/** log10(kDa) against relative mobility, fitted to the marks that have both. */
function gelFit(n) {
  const pts = n.ladder.marks.filter(m => m.kDa > 0 && m.y != null)
                            .map(m => [m.y / (n.imgH || 1), Math.log10(m.kDa)]);
  if (pts.length < 2) return null;
  const N = pts.length;
  const sx = pts.reduce((a, p) => a + p[0], 0), sy = pts.reduce((a, p) => a + p[1], 0);
  const sxx = pts.reduce((a, p) => a + p[0] * p[0], 0);
  const sxy = pts.reduce((a, p) => a + p[0] * p[1], 0);
  const den = N * sxx - sx * sx;
  if (Math.abs(den) < 1e-12) return null;
  const m = (N * sxy - sx * sy) / den, b = (sy - m * sx) / N;
  const mean = sy / N;
  let ssr = 0, sst = 0;
  pts.forEach(p => { const pred = m * p[0] + b; ssr += (p[1] - pred) ** 2; sst += (p[1] - mean) ** 2; });
  return { m, b, r2: sst > 0 ? 1 - ssr / sst : 1, n: N };
}

function gelMwAt(n, ypx) {
  const f = n.fit || gelFit(n);
  if (!f) return null;
  const ys = n.ladder.marks.filter(m => m.kDa > 0).map(m => m.y);
  if (ys.length && (ypx < Math.min(...ys) - 1e-9 || ypx > Math.max(...ys) + 1e-9)) return null;
  return Math.pow(10, f.m * (ypx / (n.imgH || 1)) + f.b);
}

/** A size for a band, bounded by the ladder rather than extrapolated past it. */
function gelMwLabel(n, ypx) {
  const f = n.fit || gelFit(n);
  if (!f) return null;
  const mw = gelMwAt(n, ypx);
  if (mw !== null) return `≈${mw >= 100 ? Math.round(mw) : r2(mw)} kDa`;
  const marks = n.ladder.marks.filter(m => m.kDa > 0);
  if (!marks.length) return null;
  const top = marks.reduce((a, b) => (a.y < b.y ? a : b));
  const bot = marks.reduce((a, b) => (a.y > b.y ? a : b));
  return ypx < top.y ? `> ${top.kDa} kDa` : `< ${bot.kDa} kDa`;
}

/** The ladder's rungs that have a size, top to bottom. */
function gelSizedMarks(n) {
  return n.ladder.marks.filter(m => m.kDa > 0 && m.y != null).sort((a, b) => a.y - b.y);
}

/** The crop row a size runs to, read off the ladder itself: straight in
 *  log(size) between the two rungs either side of it, which follows a gradient
 *  gel where one line through every rung does not.  Null outside the ladder:
 *  a strip is not cut at an extrapolated size any more than a band is sized
 *  by one. */
function gelYForKDa(n, kDa) {
  const ms = gelSizedMarks(n);
  if (ms.length < 2 || !(kDa > 0)) return null;
  const v = Math.log10(kDa);
  for (let i = 0; i < ms.length - 1; i++) {
    const la = Math.log10(ms[i].kDa), lb = Math.log10(ms[i + 1].kDa);
    if (v <= Math.max(la, lb) + 1e-9 && v >= Math.min(la, lb) - 1e-9) {
      const t = Math.abs(la - lb) < 1e-12 ? 0 : (la - v) / (la - lb);
      return ms[i].y + t * (ms[i + 1].y - ms[i].y);
    }
  }
  return null;
}

/** The size at a crop row, by the same rule, or null outside the ladder. */
function gelKDaAtY(n, ypx) {
  const ms = gelSizedMarks(n);
  for (let i = 0; i < ms.length - 1; i++) {
    const a = ms[i], b = ms[i + 1];
    if (ypx >= a.y - 1e-9 && ypx <= b.y + 1e-9 && b.y > a.y) {
      const t = (ypx - a.y) / (b.y - a.y);
      return Math.pow(10, Math.log10(a.kDa) + t * (Math.log10(b.kDa) - Math.log10(a.kDa)));
    }
  }
  return null;
}

const kDaStr = v => (v >= 100 ? String(Math.round(v)) : String(r2(Math.round(v * 10) / 10)));

/** What a strip covers, in sizes where the ladder reaches and in words where
 *  it does not. */
function stripRange(n, s) {
  const at = y => (y <= 0.5 ? 'top' : y >= (n.imgH || 0) - 0.5 ? 'bottom'
                   : (v => (v === null ? `row ${Math.round(y)}` : kDaStr(v)))(gelKDaAtY(n, y)));
  return `${at(s.y0)}–${at(s.y1)}`;
}

/* ---- densitometry ---- */

const QUANT_TARGET_COLOURS = ['#e5484d', '#4c9be8', '#8e6cc9', '#4cb782', '#c9489b'];
const QUANT_CONTROL_COLOUR = '#d99a4e';

function quantColour(n, row) {
  if (row.role === 'loading control') return QUANT_CONTROL_COLOUR;
  const i = n.quant.rows.filter(r => r.role !== 'loading control').indexOf(row);
  return QUANT_TARGET_COLOURS[Math.max(0, i) % QUANT_TARGET_COLOURS.length];
}

/** The box a band is measured in, across its lane: the lane less an inset at
 *  each side, so a boundary set a little generously does not take in the edge
 *  of the lane next door.  In crop pixels at mid-height; the lean does the
 *  rest, on the canvas and in the measurement alike. */
function quantBoxX(n, lane) {
  const w = lane.x1 - lane.x0, k = clamp(nn(n.quant.inset) ?? 0.05, 0, 0.45);
  return [lane.x0 + w * k, lane.x1 - w * k];
}

/** Lanes a band can be measured in: not the ladder, not a blank. */
const quantLane = l => l.role !== 'ladder' && l.role !== 'blank';

/** The `row` of a box that is not a band but the whole lane, floor to ceiling.
 *  It is a sentinel rather than a row of its own because every row is a protein
 *  you clicked on, and this one is everything you did not. */
const WHOLE_LANE = '__lane';

/** Whether a band is clipped enough to throw its lane away: more than
 *  `satTol` percent of its box sitting at the camera's limit.  All or nothing
 *  dropped a lane missing one pixel exactly as hard as one missing a third of
 *  its band, and on a set of blots exposed to the limit that is most of the
 *  lanes.  A band with no area recorded is dropped on any clipping at all. */
function quantClipped(b, q) {
  return !!b && b.sat > ((nn(q.satTol) ?? 2) / 100) * (b.area || 1);
}

/** One gel's measurements, lane by lane: each row's band, each target over the
 *  loading control in the same lane, and — where the whole lane has been
 *  measured too — what fraction of that lane the first target band is.
 *
 *  That fraction is the purity, with the usual caveat attached to it wherever it
 *  is printed: it is a fraction of the *stain*, and dye per milligram differs
 *  between proteins. */
function gelQuantLanes(n) {
  const q = n.quant, rows = q.rows;
  const ctrl = rows.find(r => r.role === 'loading control');
  const target = rows.find(r => r.role === 'target');
  return n.lanes.map((l, i) => {
    const by = {};
    rows.forEach(r => { by[r.id] = q.bands.find(b => b.row === r.id && b.lane === l.id) || null; });
    const c = ctrl && by[ctrl.id];
    const ratios = {};
    rows.forEach(r => {
      const b = by[r.id];
      if (r === ctrl || !b || !c || !isFinite(b.net) || !(c.net > 0)) return;
      ratios[r.id] = b.net / c.net;
    });
    const whole = q.bands.find(b => b.row === WHOLE_LANE && b.lane === l.id) || null;
    const tb = target && by[target.id];
    const purity = (whole && tb && isFinite(tb.net) && whole.net > 0)
      ? tb.net / whole.net * 100 : null;
    return { lane: l, index: i, by, ratios, whole, purity };
  });
}

/* =======================================================================
   CHROMATOGRAM
   ======================================================================= */

/* Standards kits, so the calibration is a dropdown rather than seven numbers
   retyped from a manual each time. */
const STANDARD_KITS = {
  'Bio-Rad gel filtration standard': [
    { name: 'Thyroglobulin', kDa: 670 }, { name: 'γ-globulin', kDa: 158 },
    { name: 'Ovalbumin', kDa: 44 }, { name: 'Myoglobin', kDa: 17 },
    { name: 'Vitamin B12', kDa: 1.35 },
  ],
  'Cytiva HMW kit': [
    { name: 'Thyroglobulin', kDa: 669 }, { name: 'Ferritin', kDa: 440 },
    { name: 'Aldolase', kDa: 158 }, { name: 'Conalbumin', kDa: 75 },
    { name: 'Ovalbumin', kDa: 44 },
  ],
  'Cytiva LMW kit': [
    { name: 'Conalbumin', kDa: 75 }, { name: 'Ovalbumin', kDa: 44 },
    { name: 'Carbonic anhydrase', kDa: 29 }, { name: 'Ribonuclease A', kDa: 13.7 },
    { name: 'Aprotinin', kDa: 6.5 },
  ],
};

/* ---- the columns -----------------------------------------------------------
   What the manufacturer publishes about each column, so a calibration can be
   read against what the column can actually separate rather than only against
   the standards that happened to be run.

   `src` says where a row came from, because the difference matters when a
   number reaches a figure:

     'datasheet'  transcribed from the Cytiva data file cited in `ref`
     'catalog'  the family's published characteristics, not from a data file
                  in hand — worth checking against your own column's papers

   V0 is in neither.  It is not a published constant: it depends on how the bed
   settled and it drifts as the column ages, which is why every column ships with
   a certificate giving its own.  The value here is 0.33 × CV, which is where
   these beds usually land, and it is marked as an estimate everywhere it is
   used — including in `Integrity…` — until you replace it with the one you
   measured with blue dextran.  Kav is a ratio of differences from V0, so an
   assumed V0 moves every mass on the panel. */

const CV_VOID = 0.33;                    // where a settled Superdex/Superose bed lands
const DEFAULT_COLUMN = 'Superose 6 Increase 10/300 GL';

function col(o) {
  return { v0: r2((o.cv || 0) * CV_VOID), v0From: 'estimate', ...o };
}

const COLUMNS = {
  // Transcribed from the data file the numbers below are cited to.
  'Superdex 200 Increase 10/300 GL': col({
    bed: '10 × 300 mm', cv: 24, vt: 24, range: [10e3, 600e3], exclusion: 1.3e6,
    flow: 0.75, flowMax: 1.8, pMax: 3.0, plates: 48000, sample: [25, 500],
    code: '28990944', src: 'datasheet', ref: 'Cytiva 16542, Superdex 200 Increase' }),
  'Superdex 200 Increase 5/150 GL': col({
    bed: '5 × 150 mm', cv: 3.0, vt: 3.0, range: [10e3, 600e3], exclusion: 1.3e6,
    flow: 0.45, flowMax: 0.75, pMax: 3.0, plates: 42000, sample: [4, 50],
    code: '28990945', src: 'datasheet', ref: 'Cytiva 16542, Superdex 200 Increase' }),
  'Superdex 200 Increase 3.2/300': col({
    bed: '3.2 × 300 mm', cv: 2.4, vt: 2.4, range: [10e3, 600e3], exclusion: 1.3e6,
    flow: 0.075, flowMax: 0.15, pMax: 2.0, plates: 48000, sample: [4, 50],
    code: '28990946', src: 'datasheet', ref: 'Cytiva 16542, Superdex 200 Increase' }),

  // Family characteristics.  Bed sizes follow the column names; the separation
  // ranges are the resins' published ones.  No data file in hand for these, so
  // the efficiency and pressure figures are left out rather than guessed.
  'Superose 6 Increase 10/300 GL': col({
    bed: '10 × 300 mm', cv: 24, vt: 24, range: [5e3, 5e6], exclusion: 4e7,
    flow: 0.75, code: '29091596', src: 'catalogue' }),
  'Superose 6 Increase 5/150 GL': col({
    bed: '5 × 150 mm', cv: 3.0, vt: 3.0, range: [5e3, 5e6], exclusion: 4e7,
    flow: 0.45, code: '29091597', src: 'catalogue' }),
  'Superose 6 Increase 3.2/300': col({
    bed: '3.2 × 300 mm', cv: 2.4, vt: 2.4, range: [5e3, 5e6], exclusion: 4e7,
    flow: 0.075, code: '29091598', src: 'catalogue' }),
  'Superdex 75 Increase 10/300 GL': col({
    bed: '10 × 300 mm', cv: 24, vt: 24, range: [3e3, 70e3],
    flow: 0.75, code: '29148721', src: 'catalogue' }),
  'Superdex 75 Increase 5/150 GL': col({
    bed: '5 × 150 mm', cv: 3.0, vt: 3.0, range: [3e3, 70e3],
    flow: 0.45, code: '29148722', src: 'catalogue' }),
  'Superdex 75 Increase 3.2/300': col({
    bed: '3.2 × 300 mm', cv: 2.4, vt: 2.4, range: [3e3, 70e3],
    flow: 0.075, code: '29148723', src: 'catalogue' }),
  'Superdex 30 Increase 10/300 GL': col({
    bed: '10 × 300 mm', cv: 24, vt: 24, range: [100, 10e3],
    flow: 0.75, code: '29219757', src: 'catalogue' }),
  'Superdex 200 pg 16/600': col({
    bed: '16 × 600 mm', cv: 120, vt: 120, range: [10e3, 600e3], exclusion: 1.3e6,
    flow: 1.0, src: 'catalogue' }),
  'Superdex 75 pg 16/600': col({
    bed: '16 × 600 mm', cv: 120, vt: 120, range: [3e3, 70e3],
    flow: 1.0, src: 'catalogue' }),
  'Superdex 200 pg 26/600': col({
    bed: '26 × 600 mm', cv: 320, vt: 320, range: [10e3, 600e3], exclusion: 1.3e6,
    flow: 2.6, src: 'catalogue' }),

  'custom': { cv: 0, v0: 0, vt: 0, v0From: 'entered', src: 'yours' },
};

/** Just the numbers a run works in, for seeding a panel.  The rest of the entry
 *  stays in the library and is looked up by name: copying it onto every panel
 *  would duplicate a reference table into the saved figure and let the two
 *  disagree.  Flow is deliberately not here — the recommended rate is not the
 *  rate that was run, and a .RES knows the difference. */
function columnDefaults(name) {
  const c = COLUMNS[name] || COLUMNS.custom;
  return { cv: c.cv, v0: c.v0, vt: c.vt };
}

/** What is known about the column now, after any editing.  A column the user has
 *  typed over is no longer the catalog entry, and the record should say so. */
function columnFacts(c) {
  const base = COLUMNS[c.name] || COLUMNS.custom;
  const edited = ['cv', 'vt'].some(k => nn(c[k]) !== null && Math.abs(c[k] - base[k]) > 1e-6);
  return {
    ...base,
    v0From: nn(c.v0) !== null && Math.abs(c.v0 - (base.v0 ?? -1)) > 1e-6 ? 'measured' : base.v0From,
    edited,
  };
}

const TRACE_COLOURS = ['#000000', '#c62f34', '#5f6772', '#2c7fb8', '#c8935f'];

function chromNode(x, y) {
  return {
    id: uid(), type: 'chrom', x: r2(x), y: r2(y), w: 70, h: 42,
    traces: [], source: '',
    title: '', titlePt: 7,
    xlabel: 'Elution volume (mL)', ylabel: 'A₂₈₀ (mAU)', y2label: '',
    auto: true, xmin: 0, xmax: 24, ymin: 0, ymax: 100, y2min: 0, y2max: 100,
    normalise: 'none',
    fontPt: 6.5, axisMm: 0.25, tickMm: 1.1, traceMm: 0.4,
    frame: 'lb',                         // which axes get a spine
    column: { name: DEFAULT_COLUMN, ...columnDefaults(DEFAULT_COLUMN), flow: 0.5, buffer: '' },
    marks: { v0: true, vt: false, inject: true },
    inject: null,                        // where the sample went on, in the run's own frame
    run: null,                           // what the instrument recorded about the run
    // The fraction bar is a scale to read the trace against, not a second
    // figure competing with it: small and gray, so a tube number is there when
    // you look for it and out of the way when you are not.
    fractions: { on: true, marks: [], pooled: null, pt: 4, every: 1, height: 2.2,
                 fill: '#767676', side: 'top', shade: '#2b6cb0' },
    peaks: [],
    calib: { on: false, kit: 'Cytiva HMW kit', standards: [], fit: null },
    expect: '',                          // a construct panel whose species to mark
    rough: false,                        // the column-specification mass scale
    ratio: null,                         // A260/A280 at the peak, when both exist
  };
}

function chromScales(n) {
  let xmin = n.xmin, xmax = n.xmax, ymin = n.ymin, ymax = n.ymax,
      y2min = n.y2min, y2max = n.y2max;
  const on = n.traces.filter(t => t.on !== false && t.pts && t.pts.length);
  if (n.auto && on.length) {
    xmin = Math.min(...on.map(t => t.pts[0][0]));
    xmax = Math.max(...on.map(t => t.pts[t.pts.length - 1][0]));
    const L = on.filter(t => t.axis !== 'right'), R = on.filter(t => t.axis === 'right');
    const span = ts => {
      const ys = ts.flatMap(t => t.pts.map(p => normY(t, p[1], n)));
      if (!ys.length) return [0, 1];
      let lo = Math.min(...ys), hi = Math.max(...ys);
      const pad = (hi - lo) * 0.06 || 1;
      return [lo > 0 && lo < pad * 3 ? 0 : lo - pad, hi + pad];
    };
    [ymin, ymax] = span(L);
    [y2min, y2max] = span(R);
  }
  const X = v => n.x + (v - xmin) / ((xmax - xmin) || 1) * n.w;
  const Y = v => n.y + n.h - (v - ymin) / ((ymax - ymin) || 1) * n.h;
  const Y2 = v => n.y + n.h - (v - y2min) / ((y2max - y2min) || 1) * n.h;
  return { X, Y, Y2, xmin, xmax, ymin, ymax, y2min, y2max };
}

function normY(t, v, n) {
  if (n.normalise === 'max' && t._max) return v / t._max * 100;
  return v;
}

function niceTicks(lo, hi, target = 5) {
  const span = (hi - lo) || 1;
  const raw = span / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) || mag * 10;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) out.push(r3(v));
  return out;
}

function chromKav(n, ve) {
  const { v0, vt } = n.column;
  if (!(vt > v0)) return null;
  return (ve - v0) / (vt - v0);
}

function chromFit(n) {
  const pts = n.calib.standards.filter(s => nn(s.ve) !== null && nn(s.kDa))
    .map(s => [chromKav(n, Number(s.ve)), Math.log10(Number(s.kDa))])
    .filter(p => p[0] !== null && isFinite(p[0]));
  if (pts.length < 2) return null;
  const N = pts.length;
  const sx = pts.reduce((a, p) => a + p[0], 0), sy = pts.reduce((a, p) => a + p[1], 0);
  const sxx = pts.reduce((a, p) => a + p[0] * p[0], 0);
  const sxy = pts.reduce((a, p) => a + p[0] * p[1], 0);
  const den = N * sxx - sx * sx;
  if (Math.abs(den) < 1e-12) return null;
  const m = (N * sxy - sx * sy) / den, b = (sy - m * sx) / N;
  const mean = sy / N;
  let ssr = 0, sst = 0;
  pts.forEach(p => { const pr = m * p[0] + b; ssr += (p[1] - pr) ** 2; sst += (p[1] - mean) ** 2; });
  return { m, b, r2: sst > 0 ? 1 - ssr / sst : 1, n: N };
}

/** The volume a mass should come off at: the calibration read backwards.
 *
 *  Null outside the masses the standards actually cover, for the same reason
 *  `chromMwAt` refuses one outside them: a line fitted between 44 and 669 kDa
 *  does not know where 4 kDa elutes, and the arithmetic will answer anyway. */
function chromVeFor(n, kDa) {
  const f = n.calib.fit || chromFit(n);
  const { v0, vt } = n.column;
  if (!f || !(vt > v0) || !(kDa > 0) || Math.abs(f.m) < 1e-9) return null;
  const kav = (Math.log10(kDa) - f.b) / f.m;
  const ks = n.calib.standards.map(s => chromKav(n, Number(s.ve)))
                              .filter(v => v !== null && isFinite(v));
  if (ks.length && (kav < Math.min(...ks) - 1e-9 || kav > Math.max(...ks) + 1e-9)) return null;
  return v0 + kav * (vt - v0);
}

/** What the construct on this page should put on this column.
 *
 *  The coupling a purification figure is usually missing.  The construct panel
 *  already knows what the chain weighs and what cutting it leaves; the column
 *  has already been told what a mass elutes at.  So the volume each species
 *  *should* appear at is arithmetic, and a peak that is not at it is the
 *  finding -- an oligomer, an aggregate, an uncleaved tag -- rather than
 *  something to be worked out later with a ruler.
 *
 *  Only ever from a real calibration.  The rough scale is kept off peak labels
 *  for a reason, and a mark that says "the monomer is here" is a peak label. */
function chromExpected(n) {
  const doc = PF.doc;
  const cn = doc && doc.nodes.find(x => x.id === n.expect && x.type === 'construct');
  if (!cn) return [];
  return constructSpecies(cn)
    .map(sp => ({ ...sp, ve: chromVeFor(n, sp.da / 1000) }))
    .filter(sp => sp.ve !== null);
}

/** Mass from the calibration, or null outside the range the standards cover.
 *  A peak in the void is not a 1778 kDa protein; it is a peak in the void, and
 *  a curve fitted between 44 and 669 kDa has nothing to say about it. */
function chromMwAt(n, ve) {
  const f = n.calib.fit || chromFit(n);
  const k = chromKav(n, ve);
  if (!f || k === null) return null;
  const ks = n.calib.standards.map(s => chromKav(n, Number(s.ve)))
                              .filter(v => v !== null && isFinite(v));
  if (ks.length && (k < Math.min(...ks) - 1e-9 || k > Math.max(...ks) + 1e-9)) return null;
  return Math.pow(10, f.m * k + f.b);
}

/** What to print: a number inside the range, a bound outside it, null if there
 *  is no calibration at all. */
/* ---- the rough scale -------------------------------------------------------
   A mass scale from the column's specification alone, for when no standards
   were run.  The model is the crudest one there is: the resin's published
   fractionation range, read as a straight line in log(Mr) against Kav with the
   top of the range at Kav 0 and the bottom at Kav 1.

   Against real standards on a Superdex 200 Increase 10/300 it lands within
   1.7× across the range, so ±2× is the honest claim.  It also inherits the V0
   in use, which is usually itself an estimate — two approximations stacked.

   It is therefore drawn dim, labeled on the figure as what it is, and kept out
   of peak labels entirely: reading a mass off a coarse scale shows you how
   coarse it is, while printing "90 kDa" beside a peak does not. */

const ROUGH_INK = '#c9c9c9';

//: Expected volumes are a prediction, not a measurement, and are drawn in one
//: color of their own so a reader is never in doubt which is which.
const EXPECT_INK = '#2b6cb0';

function roughFit(n) {
  const F = columnFacts(n.column);
  if (!F.range || !(n.column.vt > n.column.v0)) return null;
  return { hi: Math.log10(F.range[1] / 1000), lo: Math.log10(F.range[0] / 1000) };
}

/** Where a mass would come off, by the rough model.  null outside the range. */
function roughVeFor(n, kDa) {
  const f = roughFit(n);
  if (!f) return null;
  const kav = (f.hi - Math.log10(kDa)) / (f.hi - f.lo);
  if (kav < 0 || kav > 1) return null;
  return n.column.v0 + kav * (n.column.vt - n.column.v0);
}

/** The mass at a volume, by the rough model.  For the inspector, never a label. */
function roughMwAt(n, ve) {
  const f = roughFit(n), kav = chromKav(n, ve);
  if (!f || kav === null || kav < 0 || kav > 1) return null;
  return Math.pow(10, f.hi - kav * (f.hi - f.lo));
}

/** Round masses across the resin's range: 1, 2, 5 per decade. */
function roughTicks(n) {
  const F = columnFacts(n.column);
  if (!F.range) return [];
  const lo = F.range[0] / 1000, hi = F.range[1] / 1000, out = [];
  for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) {
    for (const m of [1, 2, 5]) {
      const v = m * Math.pow(10, e);
      if (v >= lo - 1e-9 && v <= hi + 1e-9) out.push(v);
    }
  }
  return out;
}

/** Why a mass read off this calibration should be distrusted, or null.
 *
 *  Distinct from refusing to give one at all.  Outside the standards, the fit
 *  has nothing to say and `chromMwAt` returns null.  Inside the standards but
 *  outside what the resin separates, the arithmetic still produces a number —
 *  and it is that number, plausible and wrong, that ends up in a paper.  A
 *  peak past the exclusion limit is not a large protein; it is the void. */
function chromMwCaveat(n, ve) {
  const mw = chromMwAt(n, ve);
  if (mw === null) return null;
  const f = columnFacts(n.column), da = mw * 1000;
  if (f.exclusion && da > f.exclusion)
    return `past this column's exclusion limit (${r2(f.exclusion / 1000)} kDa) — it eluted in the void`;
  if (f.range && da < f.range[0])
    return `below the range this resin separates (${r2(f.range[0] / 1000)}–${r2(f.range[1] / 1000)} kDa)`;
  if (f.range && da > f.range[1])
    return `above the range this resin separates (${r2(f.range[0] / 1000)}–${r2(f.range[1] / 1000)} kDa)`;
  return null;
}

function chromMwLabel(n, ve) {
  const f = n.calib.fit || chromFit(n);
  const k = chromKav(n, ve);
  if (!f || k === null) return null;
  const mw = chromMwAt(n, ve);
  // Two decimals on a mass read off a Kav line is precision the method does not
  // have — a globular-standard curve is good to about a tenth of the answer, so
  // "89.99 kDa" says something about the arithmetic rather than the protein.
  if (mw !== null) return `${mw >= 10 ? Math.round(mw) : r2(mw)} kDa`;
  const withVe = n.calib.standards.filter(s => nn(s.ve) !== null);
  if (!withVe.length) return null;
  const biggest = withVe.reduce((a, b) => (Number(a.kDa) > Number(b.kDa) ? a : b));
  const smallest = withVe.reduce((a, b) => (Number(a.kDa) < Number(b.kDa) ? a : b));
  return k < chromKav(n, Number(biggest.ve)) ? `> ${biggest.kDa} kDa` : `< ${smallest.kDa} kDa`;
}

function traceValueAt(t, v) {
  if (!t || !t.pts || !t.pts.length) return null;
  let best = t.pts[0], bd = Math.abs(t.pts[0][0] - v);
  for (const p of t.pts) { const d = Math.abs(p[0] - v); if (d < bd) { bd = d; best = p; } }
  return best[1];
}

/** Where the fraction bar sits, and how deep it is.
 *
 *  Fractions read best along the *top*, against the peaks they were cut from,
 *  where the eye is already looking; the bottom is left to the volume axis.
 *  Both sides are drawn from the same three numbers so nothing can drift: the
 *  rule the ticks hang off, the far end of a tick, and the label's baseline —
 *  which is below the ticks on the bottom and above them on the top, because
 *  text grows away from the plot either way. */
function fracBar(n, pt) {
  const fr = n.fractions, h = fr.height;
  const top = (fr.side || 'top') === 'top';
  const rule = top ? n.y - pt * PT * 0.9 : n.y + n.h + pt * PT * 1.6;
  const tick = rule + (top ? -h * 0.55 : h * 0.55);
  const deep = pt * PT * (top ? 0.9 : 1.6) + h * 0.55
             + fr.pt * PT * (top ? 1.15 : 1.0) + (top ? 0.7 : 0);
  return {
    top, rule, tick,
    label: tick + (top ? -fr.pt * PT * 0.35 : fr.pt * PT * 1.0),
    // How far the bar reaches beyond the plot, for whatever has to clear it:
    // the axis title below, the calibration ticks above.
    above: fr.on && fr.marks.length && top ? deep : 0,
    below: fr.on && fr.marks.length && !top ? deep : 0,
  };
}

/** The top of everything drawn above the plot: the fraction bar when it is up
 *  there, then the standards ticks.  A title has to clear both, and the panel's
 *  own y is the top of the *plot*, not of the drawing. */
function chromTop(n, pt) {
  let top = n.y - fracBar(n, pt).above;
  if (n.calib.on && n.calib.standards.some(s => nn(s.ve) !== null)) top -= 3.4;
  return top;
}

/** Which of this trace's fractions to shade, and over what volume each runs.
 *
 *  Taken from the gel a brace points at: that brace already claims "these
 *  fractions are those lanes", so the coloring is the same claim made in ink
 *  rather than a second list to keep in step.  A fraction the gel does not name
 *  is not shaded, however many of its neighbors are. */
function chromShadedFractions(n) {
  const doc = PF.doc;
  if (!doc || !n.fractions.on || !n.fractions.marks.length) return [];
  const wanted = new Set();
  doc.edges.forEach(e => {
    // Either direction: which end you happened to click first is not a claim
    // about anything, and a brace drawn the other way round silently doing
    // nothing is a worse answer than reading it the way it was plainly meant.
    if (e.kind !== 'brace') return;
    const other = e.from === n.id ? e.to : e.to === n.id ? e.from : null;
    if (!other) return;
    gelFractions(doc.nodes.find(x => x.id === other && x.type === 'gel'))
      .forEach(f => wanted.add(f.label));
  });
  if (!wanted.size) return [];
  const marks = n.fractions.marks;
  const out = [];
  marks.forEach((m, i) => {
    if (!wanted.has(String(m.label).trim())) return;
    const next = marks[i + 1];
    // A fraction runs from its own mark to the next one; the last one runs to
    // wherever the collector stopped, which is the end of the trace.
    out.push({ label: m.label, v0: m.v, v1: next ? next.v : m.v });
  });
  return out;
}

function renderChrom(n) {
  const S = chromScales(n);
  const pt = n.fontPt;
  let out = '';

  // Fraction bar, under the axis: the thing that ties this panel to the gel.
  const fr = n.fractions;
  const F = fracBar(n, pt);

  // The fractions a gel downstream of this trace actually ran, if a brace says
  // so.  Each is shaded over its own interval — the volume between its mark and
  // the next — so a set with holes in it (12, 13, 15, 16, 17) is drawn with the
  // holes, rather than as one block from the first to the last.  A gap in what
  // was loaded is a fact about the experiment, not a rendering inconvenience.
  const shown = chromShadedFractions(n);
  if (n.title) {
    out += txt(n.x, chromTop(n, pt) - 0.9, n.title,
               { pt: n.titlePt, bold: true, anchor: 'start' });
  }
  if (fr.on && fr.pooled) {
    const a = S.X(fr.pooled[0]), b = S.X(fr.pooled[1]);
    out += rect(a, n.y, b - a, n.h, { fill: '#c62f34', opacity: 0.10 });
  }
  shown.forEach(seg => {
    const a = S.X(seg.v0), b = S.X(seg.v1);
    if (b <= n.x || a >= n.x + n.w) return;
    out += rect(Math.max(a, n.x), n.y, Math.min(b, n.x + n.w) - Math.max(a, n.x), n.h,
                { fill: fr.shade || '#2b6cb0', opacity: 0.14 });
  });

  // Axes.
  if (n.frame.includes('l')) out += line(n.x, n.y, n.x, n.y + n.h, n.axisMm);
  if (n.frame.includes('b')) out += line(n.x, n.y + n.h, n.x + n.w, n.y + n.h, n.axisMm);
  if (n.frame.includes('r')) out += line(n.x + n.w, n.y, n.x + n.w, n.y + n.h, n.axisMm);
  if (n.frame.includes('t')) out += line(n.x, n.y, n.x + n.w, n.y, n.axisMm);

  niceTicks(S.xmin, S.xmax).forEach(v => {
    const x = S.X(v);
    if (x < n.x - 0.01 || x > n.x + n.w + 0.01) return;
    out += line(x, n.y + n.h, x, n.y + n.h + n.tickMm, n.axisMm);
    out += txt(x, n.y + n.h + n.tickMm + pt * PT * 0.95, String(v), { pt });
  });
  niceTicks(S.ymin, S.ymax).forEach(v => {
    const y = S.Y(v);
    if (y < n.y - 0.01 || y > n.y + n.h + 0.01) return;
    out += line(n.x - n.tickMm, y, n.x, y, n.axisMm);
    out += txt(n.x - n.tickMm - 0.5, y + pt * PT * 0.35, String(v), { pt, anchor: 'end' });
  });
  // A fraction bar underneath hangs below the axis, so the axis title has to
  // clear it — sized from the very numbers the bar is drawn with rather than
  // from a guess, because with 35 tubes under a 70 mm panel the title otherwise
  // lands inside the bar and neither can be read.
  out += txt(n.x + n.w / 2,
             n.y + n.h + Math.max(n.tickMm + pt * PT * 2.4, F.below + pt * PT * 1.05),
             n.xlabel, { pt });
  out += txt(n.x - n.tickMm - 5.2, n.y + n.h / 2, n.ylabel,
             { pt, rotate: -90 });

  const rightOn = n.traces.some(t => t.on !== false && t.axis === 'right');
  if (rightOn) {
    niceTicks(S.y2min, S.y2max).forEach(v => {
      const y = S.Y2(v);
      if (y < n.y - 0.01 || y > n.y + n.h + 0.01) return;
      out += line(n.x + n.w, y, n.x + n.w + n.tickMm, y, n.axisMm);
      out += txt(n.x + n.w + n.tickMm + 0.5, y + pt * PT * 0.35, String(v), { pt, anchor: 'start' });
    });
    if (n.y2label) out += txt(n.x + n.w + n.tickMm + 5.0, n.y + n.h / 2, n.y2label, { pt, rotate: 90 });
  }

  // V0 / Vt.
  if (n.marks.v0 && n.column.v0 > 0) {
    const x = S.X(n.column.v0);
    if (x >= n.x && x <= n.x + n.w) {
      out += line(x, n.y, x, n.y + n.h, 0.2, '#666', ' stroke-dasharray="1 1"');
      out += txt(x, n.y - 0.5, 'V₀', { pt: pt * 0.92, fill: '#444' });
    }
  }
  if (n.marks.vt && n.column.vt > 0) {
    const x = S.X(n.column.vt);
    if (x >= n.x && x <= n.x + n.w) {
      out += line(x, n.y, x, n.y + n.h, 0.2, '#666', ' stroke-dasharray="1 1"');
      out += txt(x, n.y - 0.5, 'Vt', { pt: pt * 0.92, fill: '#444' });
    }
  }

  // Where the sample actually went on.  A UNICORN run counts volume from the
  // start of the method, not from the injection, so every peak sits this much
  // further right than the volume the column saw.  Drawing it states which
  // frame the axis is in rather than leaving a reader to assume the usual one.
  if (n.marks.inject && n.inject && n.inject.offset && n.inject.v > 0) {
    const x = S.X(n.inject.v);
    if (x >= n.x && x <= n.x + n.w) {
      out += line(x, n.y, x, n.y + n.h, 0.2, '#666', ' stroke-dasharray="0.6 0.6"');
      out += txt(x, n.y - 0.5, 'inject', { pt: pt * 0.92, fill: '#444' });
    }
  }

  // Where the construct on this page should come off.  Dashed like V0 and Vt,
  // because it is the same kind of thing: a volume the column was told about
  // rather than a volume anything was measured at.
  // Stacked rather than dropped when two land close together, which is the
  // usual case and not an awkward one: a construct and the protein it cleaves
  // into differ by a tag, and a tag is a millimeter of elution volume.  A
  // dashed line with no label beside it says nothing at all.
  const rows = [];
  chromExpected(n).forEach(sp => {
    const x = S.X(sp.ve);
    if (x < n.x || x > n.x + n.w) return;
    out += line(x, n.y, x, n.y + n.h, 0.18, EXPECT_INK, ' stroke-dasharray="1.6 0.9"');
    const label = `${sp.label} ${kDa(sp)}`;
    const half = textWmm(label, pt * 0.86, false) / 2;
    let r = rows.findIndex(right => x - half > right + 0.3);
    if (r < 0) { r = rows.length; rows.push(0); }
    rows[r] = x + half;
    out += txt(x, n.y + pt * PT * (1.05 + r * 1.15), label, { pt: pt * 0.86, fill: EXPECT_INK });
  });

  // Calibration ticks along the top: where the standards came off.
  if (n.calib.on) {
    const top = n.y - F.above;                 // above the fraction bar, if there is one
    n.calib.standards.filter(s => nn(s.ve) !== null).forEach(s => {
      const x = S.X(Number(s.ve));
      if (x < n.x || x > n.x + n.w) return;
      out += line(x, top - 1.5, x, top - 0.4, 0.22, '#000');
      out += txt(x, top - 1.9, String(s.kDa), { pt: pt * 0.85 });
    });
  }

  // The rough mass scale, drawn before the traces so it sits behind them and
  // reads as background rather than as data.
  if (n.rough && roughFit(n)) {
    const rpt = pt * 0.78;
    const cap = 'kDa — column range only, ±2×';
    // The caption sits at the right end, so tick labels have to stop short of
    // it — the last one is otherwise printed straight through the middle of it.
    const capLeft = n.x + n.w - cap.length * rpt * PT * 0.52 - 1.0;
    let last = -1e9;
    // Big masses come off first, so the scale runs backwards against the axis.
    // Walk it left to right, or the collision test rejects everything after the
    // first label it draws.
    roughTicks(n)
      .map(kDa => ({ kDa, ve: roughVeFor(n, kDa) }))
      .filter(t => t.ve !== null)
      .sort((a, b) => a.ve - b.ve)
      .forEach(({ kDa, ve }) => {
        const x = S.X(ve);
        if (x < n.x + 0.2 || x > n.x + n.w - 0.2) return;
        out += line(x, n.y, x, n.y + n.h, 0.12, ROUGH_INK);
        const half = String(kDa).length * rpt * PT * 0.3;
        if (x - half > last + 0.3 && x + half < capLeft) {
          out += txt(x, n.y + rpt * PT * 1.05, String(kDa), { pt: rpt, fill: ROUGH_INK });
          last = x + half;
        }
      });
    // The figure has to say what the scale is, not only look faint: dimness
    // travels badly through a photocopier and not at all through a redraw.
    out += txt(n.x + n.w, n.y + rpt * PT * 1.05, cap,
               { pt: rpt, fill: ROUGH_INK, anchor: 'end' });
  }

  // The curves.
  n.traces.forEach(t => {
    if (t.on === false || !t.pts || t.pts.length < 2) return;
    const Yf = t.axis === 'right' ? S.Y2 : S.Y;
    const d = t.pts.map((p, i) => `${i ? 'L' : 'M'}${r3(S.X(p[0]))},${r3(Yf(normY(t, p[1], n)))}`).join('');
    out += `<path d="${d}" fill="none" stroke="${t.color}" stroke-width="${r3(t.width || n.traceMm)}"` +
           (t.dash ? ` stroke-dasharray="${t.dash}"` : '') +
           ` stroke-linejoin="round" clip-path="url(#cc${n.id})"/>`;
  });

  // Fraction ticks.
  if (fr.on && fr.marks.length) {
    const grey = fr.fill || '#767676';        // older figures have no color saved
    out += line(n.x, F.rule, n.x + n.w, F.rule, 0.2, grey);
    let lastRight = -1e9;                     // right edge of the last label drawn
    fr.marks.forEach((m, i) => {
      const x = S.X(m.v);
      if (x < n.x - .01 || x > n.x + n.w + .01) return;
      const pooled = (fr.pooled && m.v >= fr.pooled[0] && m.v <= fr.pooled[1]) ||
                     shown.some(seg => Math.abs(seg.v0 - m.v) < 1e-9);
      out += line(x, F.rule, x, F.tick, 0.2, grey);
      if (pooled) out += rect(x, Math.min(F.rule, F.tick),
                              (S.X(fr.marks[i + 1] ? fr.marks[i + 1].v : m.v) - x),
                              Math.abs(F.tick - F.rule), { fill: '#c62f34', opacity: 0.18 });
      if (i % (fr.every || 1) === 0 && m.label) {
        // Draw it only if it clears the last one drawn.  The numbers are spaced
        // to fit, but a collector writes "Waste" at the end, and one long label
        // should neither overlap its neighbors nor thin out the whole bar to
        // make room for itself.
        const half = String(m.label).length * fr.pt * PT * 0.30;
        if (x - half > lastRight + 0.25) {
          out += txt(x, F.label, m.label, { pt: fr.pt, fill: grey });
          lastRight = x + half;
        }
      }
    });
  }

  // Peak annotations.
  n.peaks.forEach(p => {
    const x = S.X(p.v);
    if (x < n.x || x > n.x + n.w) return;
    const t = n.traces.find(t => t.id === p.trace) || n.traces.find(t => t.on !== false);
    const yv = traceValueAt(t, p.v);
    const Yf = t && t.axis === 'right' ? S.Y2 : S.Y;
    const y = yv === null ? n.y : Yf(normY(t, yv, n));
    const lines = [];
    if (p.label) lines.push(p.label);
    if (p.showV) lines.push(`${r2(p.v)} mL`);
    if (p.showMW) { const l = chromMwLabel(n, p.v); if (l) lines.push(l); }
    if (p.showRatio) { const r = chromRatio(n, p.v); if (r) lines.push(`A₂₆₀/A₂₈₀ ${r2(r)}`); }
    if (!lines.length) return;
    const lh = pt * PT * 1.15;
    out += line(x, y - 0.6, x, y - 1.6, 0.2);
    out += txtLines(x, y - 2.0 - (lines.length - 1) * lh, lines, { pt, lineHeight: 1.15 });
  });

  return out;
}

function chromRatio(n, v) {
  const a280 = n.traces.find(t => /280/.test(t.name));
  const a260 = n.traces.find(t => /260/.test(t.name));
  if (!a280 || !a260) return null;
  const y280 = traceValueAt(a280, v), y260 = traceValueAt(a260, v);
  if (!y280) return null;
  return y260 / y280;
}

function chromDefs(n) {
  return `<clipPath id="cc${n.id}"><rect x="${r3(n.x)}" y="${r3(n.y - 2)}" ` +
         `width="${r3(n.w)}" height="${r3(n.h + 2)}"/></clipPath>`;
}

/* =======================================================================
   PURIFICATION TABLE
   ======================================================================= */

const TABLE_PRESET = {
  cols: [
    { key: 'step', label: 'Step', align: 'start', w: 26 },
    { key: 'vol', label: 'Volume\n(mL)', align: 'end', w: 13 },
    { key: 'total', label: 'Total protein\n(mg)', align: 'end', w: 16 },
    { key: 'target', label: 'Target\n(mg)', align: 'end', w: 13 },
    { key: 'purity', label: 'Purity\n(%)', align: 'end', w: 12 },
    { key: 'yield', label: 'Yield\n(%)', align: 'end', w: 12 },
  ],
  // The example numbers add up: target is the purity of the total and yield is
  // against the first step, so the table a new panel starts from is the same
  // table `from the figure` would derive.  They did not add up before, and a
  // starting point that contradicts its own arithmetic teaches the wrong thing.
  rows: [
    { step: 'Clarified lysate', vol: '45', total: '820', target: '16.4', purity: '2', yield: '100' },
    { step: 'StrepTrap HP', vol: '9', total: '31', target: '13.95', purity: '45', yield: '85' },
    { step: '3C cleavage / rIMAC', vol: '11', total: '17', target: '11.05', purity: '65', yield: '67' },
    { step: 'Superose 6 Increase', vol: '2.0', total: '7.4', target: '7.03', purity: '95', yield: '43' },
  ],
};

function tableNode(x, y) {
  return {
    id: uid(), type: 'table', x: r2(x), y: r2(y), w: 92, h: 24,
    cols: JSON.parse(JSON.stringify(TABLE_PRESET.cols)),
    rows: JSON.parse(JSON.stringify(TABLE_PRESET.rows)),
    derive: true,                        // take what the figure already knows
    fontPt: 6, headPt: 6, rowMm: 3.4, pad: 1.2,
    rules: 'booktabs',                   // booktabs | all | none
    ruleMm: 0.3, title: '',
  };
}

/** What a purification table prints: the cells typed into it, with whatever the
 *  figure already knows put over the top.  Nothing is written back, so turning
 *  this off brings every typed number straight back.
 *
 *  A step is matched to an A280 reading by *name*, the way a quantification
 *  pairs lanes across blots -- by what a thing is called rather than by an id,
 *  so re-reading the spectrophotometer file keeps every row in its place.  That
 *  panel has the volume and the milligrams already.
 *
 *  Target and yield are then arithmetic, and arithmetic is where a typed table
 *  goes wrong: a yield column nobody recomputed after the mg column changed is
 *  the error that reaches proof, and it reaches it looking plausible.  Purity is
 *  left as typed -- nothing on the page measures it.
 *
 *  `_from` records which cells came from where, for the inspector and the
 *  record; it is not a column key, so nothing draws it. */
function tableRows(n) {
  if (!n.derive) return n.rows;
  const nodes = (PF.doc && PF.doc.nodes) || [];
  const reads = new Map();
  nodes.forEach(x => {
    if (x.type !== 'nanodrop') return;
    const k = proteinConstants(x.protein);
    (x.readings || []).forEach(r => {
      const name = String(r.sample || '').trim().toLowerCase();
      // The first reading of a name wins: a sample measured twice is one step,
      // and silently averaging two readings would hide that they disagree.
      if (name && !reads.has(name))
        reads.set(name, { v: readingValues(r, k), vol: nn(r.vol), panel: x.title || 'the A₂₈₀ panel' });
    });
  });

  // And the purity, from a gel whose whole lanes have been measured: the step's
  // name is the lane's label there.  One gel: two gels measuring one step is a
  // question about which, and the table is not the place to answer it.
  const pure = new Map();
  let g0 = '';
  nodes.forEach(x => {
    if (x.type !== 'gel' || pure.size) return;
    gelQuantLanes(x).forEach(q => {
      const name = String(q.lane.label || '').trim().toLowerCase();
      if (name && q.purity !== null && !pure.has(name)) pure.set(name, q.purity);
    });
    if (pure.size) g0 = `${x.title || 'the gel'}, band over whole lane`;
  });

  const rows = n.rows.map(r => {
    const o = { ...r, _from: {} };
    const m = reads.get(String(r.step || '').trim().toLowerCase());
    if (m) {
      if (m.vol !== null) { o.vol = String(r2(m.vol)); o._from.vol = m.panel; }
      if (m.v.mg !== null && m.v.mg !== undefined) { o.total = String(r2(m.v.mg)); o._from.total = m.panel; }
    }
    const g = pure.get(String(r.step || '').trim().toLowerCase());
    if (g !== undefined) { o.purity = String(g >= 10 ? Math.round(g) : r2(g)); o._from.purity = g0; }
    const tot = nn(o.total), pur = nn(o.purity);
    if (tot !== null && pur !== null) { o.target = String(r2(tot * pur / 100)); o._from.target = 'total × purity'; }
    return o;
  });

  const first = nn(rows.length && rows[0].target);
  if (first) rows.forEach((r, i) => {
    const t = nn(r.target);
    if (t === null) return;
    r.yield = String(Math.round(t / first * 100));
    if (i) r._from.yield = `against ${rows[0].step || 'the first step'}`;
  });
  return rows;
}

function renderTable(n) { return drawTable(n, n.cols, tableRows(n)); }

/** Draw a table of `cols` over `rows`.  Both table panels use this: the
 *  purification summary types its numbers, the A280 panel derives them, and
 *  neither should look different from the other on the page. */
function drawTable(n, cols, rows) {
  const pt = n.fontPt, lh = n.rowMm;
  const totalW = cols.reduce((a, c) => a + (c.w || 16), 0);
  const scale = n.w / (totalW || 1);
  let out = '';
  let y = n.y;
  if (n.title) { out += txt(n.x, y, n.title, { pt: n.headPt, bold: true, anchor: 'start' }); y += lh; }

  const headLines = Math.max(...cols.map(c => String(c.label).split('\n').length));
  const headH = headLines * n.headPt * PT * 1.15 + n.pad;
  const top = y;

  let cx = n.x;
  cols.forEach(c => {
    const w = (c.w || 16) * scale;
    const ax = c.align === 'end' ? cx + w - n.pad : c.align === 'middle' ? cx + w / 2 : cx + n.pad * 0.4;
    const lines = String(c.label).split('\n');
    out += txtLines(ax, top + n.headPt * PT, lines,
                    { pt: n.headPt, bold: true, anchor: c.align === 'end' ? 'end' : c.align === 'middle' ? 'middle' : 'start', lineHeight: 1.15 });
    cx += w;
  });

  const bodyTop = top + headH;
  if (n.rules !== 'none') {
    out += line(n.x, top - n.pad * 0.6, n.x + n.w, top - n.pad * 0.6, n.ruleMm);
    out += line(n.x, bodyTop, n.x + n.w, bodyTop, n.ruleMm * 0.66);
  }

  rows.forEach((r, i) => {
    const ry = bodyTop + (i + 1) * lh - lh * 0.28;
    let x = n.x;
    cols.forEach(c => {
      const w = (c.w || 16) * scale;
      const ax = c.align === 'end' ? x + w - n.pad : c.align === 'middle' ? x + w / 2 : x + n.pad * 0.4;
      out += txt(ax, ry, r[c.key] ?? '',
                 { pt, anchor: c.align === 'end' ? 'end' : c.align === 'middle' ? 'middle' : 'start' });
      x += w;
    });
    if (n.rules === 'all' && i < rows.length - 1)
      out += line(n.x, bodyTop + (i + 1) * lh, n.x + n.w, bodyTop + (i + 1) * lh, n.ruleMm * 0.4, '#999');
  });

  const bot = bodyTop + rows.length * lh;
  if (n.rules !== 'none') out += line(n.x, bot, n.x + n.w, bot, n.ruleMm);
  n.h = r2(bot - n.y);
  return out;
}

/* ---- the A280 table --------------------------------------------------------
   What a spectrophotometer measured, and what that means in mg/mL — with the
   constant that converts between them stated on the panel rather than assumed.
   A NanoDrop set to "1 Abs = 1 mg/mL" reports a number two or three times wrong
   for most proteins, and the reading itself never says so. */

const ND_COLS = [
  { key: 'sample', label: 'Sample', w: 26, align: 'start', always: true },
  { key: 'a280', label: 'A₂₈₀', w: 13, align: 'end', always: true },
  { key: 'dil', label: 'dil.', w: 9, align: 'end' },
  { key: 'mgml', label: 'mg/mL', w: 14, align: 'end', always: true },
  { key: 'uM', label: 'µM', w: 13, align: 'end' },
  { key: 'vol', label: 'mL', w: 10, align: 'end' },
  { key: 'mg', label: 'mg', w: 11, align: 'end' },
  { key: 'ratio', label: 'A₂₆₀/\nA₂₈₀', w: 12, align: 'end' },
];

function nanodropNode(x, y) {
  return {
    id: uid(), type: 'nanodrop', x: r2(x), y: r2(y), w: 96, h: 22,
    title: '',
    protein: { name: '', seq: '', mw: null, eps: null, a01: null, cys: 'reduced' },
    readings: [],
    show: { dil: true, uM: true, vol: false, mg: false, ratio: false },
    header: true,                        // the constants line under the title
    dp: { a280: 3, mgml: 2, uM: 1, mg: 2 },
    fontPt: 6, headPt: 6, rowMm: 3.4, pad: 1.2,
    rules: 'booktabs', ruleMm: 0.3,
  };
}

/** The line that says how absorbance became concentration.  Without it the
 *  table is a column of numbers nobody can check; with it, anyone can. */
function nanodropHeadline(n) {
  const k = proteinConstants(n.protein);
  if (k.a01 === null) return 'no extinction coefficient — paste a sequence or type A 0.1%';
  const bits = [];
  if (n.protein.name) bits.push(n.protein.name);
  if (k.pp) bits.push(`${k.pp.n} aa`);
  if (k.mw) bits.push(`${r2(k.mw / 1000)} kDa`);
  if (k.eps !== null) bits.push(`ε₂₈₀ ${Math.round(k.eps)} M⁻¹cm⁻¹`);
  bits.push(`A 0.1% ${r3(k.a01)}`);
  if (k.pp && n.protein.cys === 'cystine') bits.push('cystines');
  return bits.join(' · ');
}

function renderNanodrop(n) {
  const k = proteinConstants(n.protein);
  const d = n.dp;
  const rows = n.readings.map(r => {
    const v = readingValues(r, k);
    const f = (x, p) => (x === null || x === undefined) ? '' : x.toFixed(p);
    return {
      sample: r.sample || '',
      a280: f(nn(r.a280), d.a280),
      dil: nn(r.dil) ? String(nn(r.dil)) : '',
      mgml: f(v.mgml, d.mgml),
      uM: f(v.uM, d.uM),
      vol: nn(r.vol) !== null ? String(nn(r.vol)) : '',
      mg: f(v.mg, d.mg),
      ratio: f(v.ratio, 2),
    };
  });

  // A column nobody filled in is a heading over nothing.  Turning one on and
  // leaving it empty is a choice; being handed an empty one by an export that
  // never recorded a dilution is not.
  const cols = ND_COLS.filter(c => (c.always || n.show[c.key]) &&
                                   (c.always || rows.some(r => r[c.key] !== '')));

  let out = '';
  let top = n.y;
  if (n.title) { out += txt(n.x, top, n.title, { pt: n.headPt, bold: true, anchor: 'start' }); top += n.rowMm; }
  if (n.header) {
    out += txt(n.x, top, nanodropHeadline(n), { pt: n.fontPt * 0.88, anchor: 'start', fill: '#767676' });
    top += n.rowMm * 0.9;
  }
  // The title and the constants line are drawn above; the shim must not draw a
  // second title of its own.
  const shim = { ...n, y: top, title: '' };
  out += drawTable(shim, cols, rows);
  n.h = r2(shim.h + (top - n.y));
  return out;
}


/* =======================================================================
   QUANTIFICATION
   =======================================================================

   A band's signal means nothing on its own: it depends on how much was loaded
   and how long the film was exposed.  So each lane's target is divided by the
   loading control in the same lane — which takes out the loading — and each
   blot is then expressed relative to one of its own conditions, which takes
   out the exposure.  Only then can blots be put side by side, and only then is
   a mean across them a mean of the same quantity.

   The panel holds no numbers.  It names the replicate gels and the rows to
   read, and everything it draws is computed from the bands measured on those
   gels, so correcting a box on a replicate corrects the bar it feeds. */

function quantNode(x, y) {
  return {
    // `h` is the plotting area, labels outside it.  30.48 mm is 1.2 in, the
    // same value axis labkit prints (`AXES_LENGTH_MM`) and every other app
    // draws, taken from the lab's own ephys notebook -- `figsize=(0.25*18,
    // 1.2)` in `ClC-7 2025.ipynb`.  Whatever the number, it is the SAME number
    // in every panel -- a plot stretched to its panel draws the same
    // difference tall here and short in the next one, and a reader comparing
    // the two is comparing two scales.  `w` comes from the bar width, see
    // `quantFit`.
    id: uid(), type: 'quant', x: r2(x), y: r2(y), w: 44, h: 30.48,
    gels: [],                  // the replicate blots, in order
    // Where each replicate's loading control was measured, when it was not
    // measured on the blot itself.  A western's loading control is a second
    // exposure -- the membrane reprobed, or a strip of it probed on its own --
    // so it is a second picture, and a panel holds one picture.  Parallel to
    // `gels`; '' means the control is on the blot, which is the gel case.
    controls: [],
    target: '', control: '',   // row names read on every replicate; '' = the first of each
    // What is compared across the lanes: how much of the band there is, or how
    // far down the gel it ran.  A shift is a result in its own right — a
    // cleaved, degraded or differently glycosylated protein is the same protein
    // at another apparent size — and it is measured off the same boxes.
    // `share` is the third: how much of the protein is in this band, with
    // every target row on the blot adding up to 100% in each lane.  A protein
    // that runs as a precursor, an intermediate and a mature form is measured
    // that way and no other -- the processing is the result, and how much was
    // loaded cancels inside the lane, so it needs no loading control.
    readout: 'intensity',      // intensity | size | share
    useControl: true,          // divide by the loading control
    norm: 'ref',               // ref | mean | none — then relative to what
    ref: '',                   // the condition set to 1; '' = the first
    match: 'label',            // lanes pair up across blots by label, or by position
    // Two lanes of one condition on one blot: two preparations run side by side,
    // or one preparation loaded twice.  Only the person who loaded it knows
    // which, and the answer changes n and every error bar, so it is asked
    // rather than assumed.
    repeats: 'separate',       // separate | averaged
    keepSaturated: false,      // a clipped band gives a ratio that is wrong
    satTol: 2,                 // ... but a pixel or two at the limit does not
    error: 'sd',               // sd | sem
    bars: true, points: true,
    title: '', titlePt: 6.5, fontPt: 6.5, axisMm: 0.25, tickMm: 1.1,
    ylabel: '', barFill: '#c8c8c8',
    // One bar is the same width on the page whatever the condition count, and
    // the panel is only as wide as the bars need -- see `quantFit`.  0 hands
    // the width back to `w`, which is how this drew before.
    barMm: 3.94,
    // '' is the single `barFill` this panel has always used.  A palette name
    // from LK.PALETTES colors the conditions in order instead, the same wheel
    // the exported matplotlib figures use.
    palette: '',
    // A per-condition color by name, which beats both.  Written by hand for a
    // figure whose colors are already settled elsewhere -- a ClC-7 mutant is
    // one color across every figure of the paper, and that is a name-to-hex
    // scheme, not a wheel.
    colours: {},
    // Quartile boxes instead of a bar and an error bar: the shape of what was
    // measured, not a mean with a tolerance round it.
    box: false,
    // Bars across instead of up: the conditions then read down the left margin
    // in plain horizontal type, which is what long names want.
    horizontal: false,
  };
}

function quantGels(q) {
  const doc = PF.doc;
  return (q.gels || []).map(id => doc && doc.nodes.find(n => n.id === id && n.type === 'gel'))
                       .filter(Boolean);
}

/** The panel a replicate's loading control was measured on, when that is not
 *  the replicate itself.  Null means the blot itself carries it. */
function quantControlGel(q, r) {
  const id = (q.controls || [])[r];
  if (!id) return null;
  const doc = PF.doc;
  return (doc && doc.nodes.find(n => n.id === id && n.type === 'gel')) || null;
}

/** The blot a panel is the loading control for, if it is one. */
function gelBlotOf(n) {
  const doc = PF.doc;
  if (!doc) return null;
  for (const q of doc.nodes) {
    if (q.type !== 'quant') continue;
    const i = (q.controls || []).indexOf(n.id);
    if (i >= 0) return doc.nodes.find(x => x.id === (q.gels || [])[i] && x.type === 'gel') || null;
  }
  return null;
}

/** Put every loading control at its blot's scale, and its lanes on the blot's.
 *
 *  Not the same pixel scale: a control is a second exposure of a *second strip*,
 *  and here six of the seven were photographed separately, so one shot's
 *  magnification says nothing about another's -- Na/K ATPase n2 was taken 35%
 *  closer than the blot it sits under.  What the two pictures share is the
 *  membrane: both strips were cut from one gel, through one comb, so the lane
 *  spacing is a ruler laid on both of them and matching it is what makes a
 *  millimeter of figure mean the same on each.
 *
 *  Least squares for the two things that are free -- how many millimeters a
 *  control pixel is worth, and where the panel sits -- against the blot's lane
 *  centers.  Both at once: the span alone leaves a few percent on the table and
 *  would nudge the pairs that are already right.
 *
 *  Returns the panels it moved. */
/** Panels in reading order: down the page, then left to right across a row.
 *
 *  A row is still a row when one panel in it was nudged by hand.  Sorting on
 *  `y` alone lettered a row of four LAMP2 panels (O) (P) (Q) (R) for panels
 *  sitting at x 79, 12, 40 and 129 mm, because one of the four had been left
 *  0.15 mm high -- and those letters are what the caption and the supplementary
 *  sheet are written from.  Everything within `tol` of the top of the row it
 *  opened belongs to that row; nothing in a figure is a new row a millimetre
 *  below the last one, because it would be drawn on top of it.
 */
function readingOrder(nodes, tol = 1) {
  const ns = [...nodes].sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const row = new Map();
  let top = -Infinity;
  for (const n of ns) {
    if (n.y > top + tol) top = n.y;
    row.set(n, top);
  }
  return ns.sort((a, b) => (row.get(a) - row.get(b)) || (a.x - b.x));
}

function gelSyncControls() {
  const doc = PF.doc;
  if (!doc) return [];
  const moved = [];
  doc.nodes.forEach(q => {
    if (q.type !== 'quant') return;
    (q.gels || []).forEach((gid, i) => {
      const g = doc.nodes.find(x => x.id === gid && x.type === 'gel');
      const c = quantControlGel(q, i);
      if (!g || !c || c === g || !g.imgH || !c.imgH || !c.h || !g.h) return;
      const G = gelLayout(g).kept, C = gelLayout(c).kept;
      const k = Math.min(G.length, C.length);
      if (k < 2) return;
      // The control's lane centers in its own pixels from its first lane, and
      // the blot's in millimeters across the page.  Lane k of one is lane k of
      // the other: the two pictures are of one gel, loaded once.
      // `_xmm` is a lane's offset from the panel's left edge and grows with the
      // scale, so dividing it back out gives the control's own picture pixels.
      const sc = (c.h / c.imgH) || 1;
      let su = 0, sT = 0, suu = 0, suT = 0;
      for (let j = 0; j < k; j++) {
        const u = (C[j]._xmm + C[j]._wmm / 2) / sc;
        const T = g.x + G[j]._xmm + G[j]._wmm / 2;
        su += u; sT += T; suu += u * u; suT += u * T;
      }
      const den = k * suu - su * su;
      if (!den) return;
      const s = (k * suT - su * sT) / den;            // mm per control pixel
      if (!(s > 0) || !isFinite(s)) return;
      const h = r4(s * c.imgH), x = r2((sT - s * su) / k);
      if (Math.abs(h - c.h) < 5e-4 && Math.abs(x - c.x) < 5e-3) return;
      c.h = h; c.x = x;
      moved.push(c);
    });
  });
  return moved;
}

/** The lane of the control panel holding the same sample as `l` of the target.
 *  Matched the way lanes are matched across blots -- by label, or by position
 *  -- and when a label is used more than once on one blot, the n-th lane of
 *  that label on the target is the n-th of it on the control: the two pictures
 *  are of one gel, so the order is the same and the repeats are not pooled. */
function quantMateLane(cg, l, g, q, p) {
  const kept = cg.lanes.filter(quantLane);
  if (q.match === 'position') return kept[p] || null;
  const key = x => String(x.label || '').trim().toLowerCase();
  const k = key(l);
  if (!k) return kept[p] || null;
  const mine = g.lanes.filter(quantLane).filter(x => key(x) === k).indexOf(l);
  const hits = kept.filter(x => key(x) === k);
  // No mate is no mate.  Falling back to the one lane of that label would pair
  // both of a condition's lanes with the same control lane and report it as two
  // measurements, which is the silent version of the mistake this exists to
  // avoid -- so the lane drops out and the panel says which one.
  return hits[mine] || null;
}

/** What a replicate is called in a table: its title, else its file. */
function repName(g, i) {
  if (g.title) return g.title;
  const s = PF.source && PF.source(g.src);
  if (s) return s.name.replace(/\.[^.]+$/, '');
  return i >= 0 ? `blot ${i + 1}` : 'the control panel';
}

/** A replicate's row for a protein: by name, because the name is what says
 *  which protein it is.  A blot with no row of that name but exactly one of
 *  that role is taken to be the same protein under another spelling, and the
 *  panel says it did so. */
function quantPickRow(g, name, role, notes, who) {
  const rows = g.quant.rows;
  const key = String(name || '').trim().toLowerCase();
  const exact = key && rows.find(r => String(r.name || '').trim().toLowerCase() === key);
  if (exact) return exact;
  const same = rows.filter(r => (role === 'loading control') === (r.role === 'loading control'));
  if (same.length === 1) {
    if (key) notes.push(`${who}: no row called “${name}”, so its only ${role} row, ` +
                        `“${same[0].name || 'unnamed'}”, was read instead`);
    return same[0];
  }
  return null;
}

const mean = vs => vs.reduce((a, b) => a + b, 0) / vs.length;

/** Everything the panel draws, computed from the gels it names. */
function quantData(q) {
  const gels = quantGels(q);
  const D = { gels, conditions: [], reps: [], summary: {}, issues: [], excluded: [],
              repeated: [], target: '', control: '', ref: null };
  if (!gels.length) return D;
  const g0 = gels[0];
  const t0 = g0.quant.rows.find(r => r.role !== 'loading control');
  const c0 = g0.quant.rows.find(r => r.role === 'loading control');
  D.readout = ['size', 'share'].includes(q.readout) ? q.readout : 'intensity';
  D.target = q.target || (t0 && t0.name) || '';
  // Nothing divides a position, and a share already divides by the lane's own
  // total, so neither one has a loading control.
  D.control = D.readout !== 'intensity' ? ''
            : (q.useControl === false ? '' : (q.control || (c0 && c0.name) || ''));
  const order = [];

  gels.forEach((g, r) => {
    const who = repName(g, r);
    const cg = quantControlGel(q, r) || g;
    const rep = { gel: g, name: who, control: cg === g ? null : cg, vals: {}, rows: [] };
    D.reps.push(rep);
    const tRow = quantPickRow(g, D.target, 'target', D.issues, who);
    // Every band the protein runs as, which is what a share is a share of.
    const tRows = g.quant.rows.filter(r => r.role !== 'loading control');
    if (D.readout === 'share' && tRows.length < 2)
      D.issues.push(`${who}: only one band is measured, so it is all of itself`);
    const cRow = D.control ? quantPickRow(cg, D.control, 'loading control', D.issues, who) : null;
    if (!tRow) { D.issues.push(`${who}: nothing measured for ${D.target || 'a target'}`); return; }
    if (D.control && !cRow) D.issues.push(`${who}: no loading control measured, so none of it can be normalized`);
    const lanes = g.lanes.filter(quantLane);
    const got = {};
    lanes.forEach((l, p) => {
      const tb = g.quant.bands.find(b => b.row === tRow.id && b.lane === l.id);
      if (!tb) return;
      const key = q.match === 'position' ? `lane ${p + 1}`
                : (String(l.label || '').trim() || `lane ${g.lanes.indexOf(l) + 1}`);
      const cl = cRow ? (cg === g ? l : quantMateLane(cg, l, g, q, p)) : null;
      const cb = (cRow && cl) ? cg.quant.bands.find(b => b.row === cRow.id && b.lane === cl.id) : null;
      const row = { lane: l, key, t: tb, c: cb, value: null, why: [] };
      if (tb.weak) row.why.push('no band found — measured at the row');
      if (D.readout === 'size') {
        // Read off this blot's own ladder at the row the band was found on.
        // It is per lane: the box height is shared across a row so the lanes
        // stay comparable, but where the box sits is each band's own, and that
        // is the whole measurement.  Between the two rungs either side, in
        // log(size), so a gradient gel is followed rung by rung.
        row.value = gelKDaAtY(g, tb.y);
        if (row.value === null) row.why.push('past the end of the ladder, so it has no size');
      } else if (D.readout === 'share') {
        // The bands this protein runs as are the whole of it, so each is a
        // percentage of their sum in that lane.  A band below background counts
        // as none of it rather than as a negative amount of it.
        row.set = tRows.map(r => g.quant.bands.find(b => b.row === r.id && b.lane === l.id))
                       .filter(b => b && isFinite(b.net));
        const tot = row.set.reduce((a, b) => a + Math.max(0, b.net), 0);
        if (row.set.length < tRows.length)
          row.why.push(`only ${row.set.length} of the ${tRows.length} bands are measured in this lane`);
        if (tot > 0) row.value = 100 * tb.net / tot;
        else row.why.push('none of the bands is above background in this lane');
      } else if (D.control) {
        if (cg !== g && !cl) row.why.push(`no lane of this sample on ${repName(cg, -1)}`);
        else if (!cb || !isFinite(cb.net)) row.why.push('no loading control in this lane' +
                                                        (cg === g ? '' : ` on ${repName(cg, -1)}`));
        else if (!(cb.net > 0)) row.why.push('loading control is not above background');
        else row.value = tb.net / cb.net;
      } else {
        row.value = tb.net;
      }
      // A clipped band is the wrong height but not in the wrong place, so
      // saturation is a reason to drop how much there is and not where it ran.
      // A clipped band anywhere in the set spoils the whole share, not just its
      // own bar: it is the denominator as well as a numerator.
      const clipped = D.readout === 'size' ? []
                    : D.readout === 'share'
                      ? (row.set || []).filter(b => quantClipped(b, q))
                          .map(b => (tRows.find(r => r.id === b.row) || {}).name || 'a band')
                    : (quantClipped(tb, q) ? ['target'] : []).concat(quantClipped(cb, q) ? ['loading control'] : []);
      if (clipped.length) row.why.push(`${clipped.join(' and ')} saturated`);
      if (row.value !== null && !isFinite(tb.net)) row.value = null;
      if (clipped.length && !q.keepSaturated && row.value !== null) {
        D.excluded.push(`${who}, ${key}: ${clipped.join(' and ')} saturated`);
        row.held = row.value;          // what it would have been, for the record
        row.value = null;
        row.dropped = true;
      }
      rep.rows.push(row);
      if (!order.includes(key)) order.push(key);
      if (row.value !== null) (got[key] = got[key] || []).push(row.value);
    });
    // Two lanes of one condition on one blot: each is kept, and `raw` is their
    // mean.  The mean is what the blot is normalized *by* -- a blot divides by
    // one number however many times the reference was loaded -- while what goes
    // into the plot is set by `repeats`, because only the person who loaded the
    // gel knows whether side-by-side lanes are two preparations or one.
    Object.entries(got).forEach(([k, vs]) => {
      rep.vals[k] = { raw: mean(vs), each: vs, lanes: vs.length };
      if (vs.length > 1) D.repeated.push(`${who}: ${k} is in ${vs.length} lanes`);
    });
  });

  D.conditions = order;
  // `D.refs` is what the arithmetic divides by; `D.ref` is the same thing as a
  // name to print, so every "relative to ..." in the app reads one field and
  // says "WT1 + WT2" without knowing there are two of them.
  if (q.norm === 'ref') {
    D.refs = quantRefs(q, order);
    D.ref = D.refs.length > 1 ? `the mean of ${D.refs.join(' + ')}` : D.refs[0] || null;
  }
  D.reps.forEach(rep => {
    let by = 1;
    // Kilodaltons over kilodaltons is not a quantity, so a size is reported as
    // it was measured and nothing is set to 1.
    if (D.readout !== 'intensity') by = 1;       // a kilodalton and a percentage are both already absolute
    else if (q.norm === 'ref') {
      // Every chosen control has to be on the blot.  A blot carrying one of two
      // controls would be divided by that one while its neighbour is divided by
      // the pair's mean, and the two blots would no longer be on one scale --
      // which is the whole reason anything is divided at all.
      const missing = D.refs.filter(r => !(rep.vals[r] && rep.vals[r].raw > 0));
      const vs = D.refs.map(r => rep.vals[r]).filter(v => v && v.raw > 0).map(v => v.raw);
      by = missing.length || !vs.length ? NaN : mean(vs);
      if (!isFinite(by) && Object.keys(rep.vals).length) {
        D.issues.push(`${rep.name}: no usable ${missing.join(' or ') || D.ref} lane ` +
                      'to be relative to, so it is left out');
      }
    } else if (q.norm === 'mean') {
      const vs = Object.values(rep.vals).map(v => v.raw);
      by = vs.length ? mean(vs) : NaN;
    }
    rep.by = by;
    Object.values(rep.vals).forEach(v => {
      v.norm = v.raw / by;
      v.eachNorm = v.each.map(x => x / by);
    });
  });
  if (q.norm === 'mean' && D.reps.length > 1) {
    const sets = D.reps.map(rep => Object.keys(rep.vals).sort().join('|'));
    if (new Set(sets).size > 1) {
      D.issues.push('the blots do not all carry the same conditions, so “relative to the mean” ' +
                    'is a mean of different things on different blots');
    }
  }
  D.separate = q.repeats !== 'averaged';
  order.forEach(k => {
    const pts = [];
    D.reps.forEach((rep, r) => {
      const v = rep.vals[k];
      if (!v) return;
      // `i` of `m` within the blot, so two points off one blot can be drawn
      // apart instead of one on top of the other.
      const vs = D.separate ? v.eachNorm : [v.norm];
      vs.forEach((x, i) => { if (isFinite(x)) pts.push({ r, v: x, i, m: vs.length }); });
    });
    const vs = pts.map(p => p.v), n = vs.length, m = n ? mean(vs) : NaN;
    const sd = n > 1 ? Math.sqrt(vs.reduce((a, v) => a + (v - m) ** 2, 0) / (n - 1)) : NaN;
    D.summary[k] = { pts, vals: vs, n, mean: m, sd, sem: n > 1 ? sd / Math.sqrt(n) : NaN };
  });
  return D;
}

/** The conditions a panel is relative to.  One name is the single reference
 *  this always had; a list is several controls averaged on each blot -- two
 *  healthy donors are one control, and relative to just one of them the other
 *  donor reads as an effect. */
function quantRefs(q, order) {
  const want = (Array.isArray(q.ref) ? q.ref : q.ref ? [q.ref] : []).filter(r => order.includes(r));
  return want.length ? want : (order[0] ? [order[0]] : []);
}

function quantYLabel(q, D) {
  if (q.ylabel) return q.ylabel;
  if (D.readout === 'size') return `apparent size of ${D.target || 'the band'}\n(kDa)`;
  if (D.readout === 'share') return `${D.target || 'the band'}\n(% of total)`;
  const what = D.control ? `${D.target || 'target'} / ${D.control}` : (D.target || 'signal');
  const rel = q.norm === 'ref' && D.ref ? `relative to ${D.ref}`
            : q.norm === 'mean' ? 'relative to the mean' : '';
  return rel ? `${what}\n(${rel})` : what;
}

const fmtTick = v => String(r3(v)).replace(/^-0$/, '0');

/** How much of one category a bar fills -- labkit's `plots.BAR_WIDTH`.  The
 *  two have to be the same number or a purifig bar and the same bar in an
 *  exported figure come out different sizes, silently and by a constant
 *  factor. */
const QUANT_FILL = 0.62;
// 3.94 mm a bar puts a category at 6.35 mm, which is 0.25 in -- the pitch the
// lab's ephys notebook draws at, and what labkit's `PlotSpec.bar_mm` prints.
// Keep the two equal or a purifig bar and the same bar exported come out
// different sizes, silently and by a constant factor.

/** The printed width of one bar, in mm.  Missing means 3.94, not 0: a panel
 *  saved before this existed gets the fixed width too, which is the point.
 *  An explicit 0 is the way back to stretching across `w`. */
const quantBarMm = q => (q.barMm === undefined ? 3.94 : Math.max(0, q.barMm));

/** Pin the panel's width to its bars.
 *
 *  The old sizing ran the other way -- `w` was set by hand and the bar was
 *  whatever fraction of it one category came to -- so the same bar was 10 mm
 *  wide beside two conditions and 5.3 mm beside seven, and a reader comparing
 *  two panels of one figure was comparing two scales.  Fixed, the bar is the
 *  thing that is constant and the panel is as wide as the bars need: tight.
 *
 *  This writes `w` rather than returning it so that selection, dragging and
 *  `quantInkBox` keep reading the one number they always read.  It is derived
 *  geometry, it is idempotent, and `quantLayout` is the only caller. */
function quantFit(q, k) {
  const mm = quantBarMm(q);
  // Across, the bars stack down the panel, so it is the height the conditions
  // pin and the width stays the value axis the reader compares panels on.
  const key = q.horizontal ? 'h' : 'w';
  if (mm > 0) q[key] = r2(Math.max(1, k) * mm / QUANT_FILL);
  return q[key];
}

/** What one condition's bar is filled with: a per-condition override, else the
 *  palette's color for its position, else the one `barFill`. */
function quantFillFor(q, name, i) {
  if (q.colours && q.colours[name]) return q.colours[name];
  if (q.palette && typeof LK !== 'undefined' && LK.seriesColour) return LK.seriesColour(i, q.palette);
  return q.barFill || '#c8c8c8';
}

/** The value at fraction *f* of *sorted*, interpolated between neighbours --
 *  numpy's default and R's type 7, so a box drawn here is the box drawn there. */
function quantile(sorted, f) {
  const i = (sorted.length - 1) * f, lo = Math.floor(i);
  return sorted[lo] + (sorted[Math.ceil(i)] - sorted[lo]) * (i - lo);
}

/** Positions of everything the panel draws.  The renderer and the bounding
 *  box both read this, so what is drawn and what is measured for alignment
 *  cannot drift apart. */
function quantLayout(q) {
  const D = quantData(q), pt = q.fontPt;
  const err = s => (q.error === 'sem' ? s.sem : s.sd);
  // Zero is the floor of an amount, and the floor of a size is the smallest one
  // measured: starting a kilodalton axis at zero hides the five that matter.
  let hi = 0, lo = D.readout === 'size' ? Infinity : 0;
  D.conditions.forEach(k => {
    const s = D.summary[k];
    if (!s.n) return;
    // Room for the error bar only when one is drawn: a box panel draws none,
    // and an axis stretched to a mean minus an SD it never shows runs to -5
    // where nothing was ever measured below 0.3.
    const e = !q.box && isFinite(err(s)) ? err(s) : 0;
    hi = Math.max(hi, s.mean + e, ...s.vals);
    lo = Math.min(lo, s.mean - e, ...s.vals);
  });
  if (!isFinite(lo)) lo = 0;
  if (!(hi > lo)) hi = lo + 1;
  const t0 = niceTicks(lo, hi, 4);
  const step = t0.length > 1 ? t0[1] - t0[0] : (hi - lo) / 4;
  // The axis ends on a tick, so its top is labeled rather than trailing off.
  const ymax = Math.ceil(hi / step - 1e-9) * step;
  const ymin = lo < 0 || D.readout === 'size' ? Math.floor(lo / step + 1e-9) * step : 0;
  // Across or up: one value mapper either way, so everything below places a
  // number on the value axis and a condition on the other one without caring
  // which of the two is horizontal.
  const hz = !!q.horizontal;
  const Y = v => hz ? q.x + (v - ymin) / ((ymax - ymin) || 1) * q.w
                    : q.y + q.h - (v - ymin) / ((ymax - ymin) || 1) * q.h;
  const ticks = niceTicks(ymin, ymax, 4);

  const k = Math.max(1, D.conditions.length);
  const w = quantFit(q, k), barMm = quantBarMm(q);
  const slot = w / k;
  const C = i => (hz ? q.y : q.x) + (i + 0.5) * slot;
  // Fixed: the bar is `barMm`, and `quantFit` has already made the panel the
  // right width for it.  Unpinned (barMm 0), the old behavior -- the bar is a
  // fraction of whatever one category came to, capped so two conditions in a
  // wide panel are bars and not blocks.
  const bw = barMm > 0 ? barMm : Math.min(slot * QUANT_FILL, 10);
  const wide = Math.max(0, ...D.conditions.map(c => textWmm(c, pt)));
  // Across, a condition has the whole left margin to itself and never tilts;
  // that is most of why a figure of long names is drawn this way.
  const tilt = !hz && wide > slot * 0.94;
  const xlabels = D.conditions.map((c, i) => {
    const p = C(i);
    if (hz) return { text: c, x: q.x - 1.0, y: p + pt * PT * 0.35, anchor: 'end', rotate: 0 };
    return tilt ? { text: c, x: p + pt * PT * 0.3, y: q.y + q.h + 1.2, anchor: 'end', rotate: -45 }
                : { text: c, x: p, y: q.y + q.h + 1.0 + pt * PT * 0.95, anchor: 'middle', rotate: 0 };
  });
  const tickW = Math.max(0, ...ticks.map(v => textWmm(fmtTick(v), pt)));
  const ylines = quantYLabel(q, D).split('\n');
  const lh = pt * PT * 1.15;
  const yx = q.x - q.tickMm - 0.5 - tickW - 1.2 - pt * PT * DESC;
  // Up: turned on its side, left of the tick numbers.  Across: plain type under
  // them, because the value axis is the horizontal one now.
  const ylabel = hz
    ? { lines: ylines, x: q.x + q.w / 2, y: q.y + q.h + q.tickMm + pt * PT * 2.1, lh, rotate: 0 }
    : { lines: ylines, x: yx, y: q.y + q.h / 2, lh, rotate: -90 };

  const R = D.reps.length;
  const boxOf = (vals, Yv, cx, bw, hz2) => {
    const v = [...vals].sort((a, b) => a - b);
    const a = Yv(quantile(v, 0.25)), m = Yv(quantile(v, 0.5)), b = Yv(quantile(v, 0.75));
    const near = Math.min(a, b), far = Math.max(a, b);
    const lo = Yv(v[0]), hi = Yv(v[v.length - 1]);
    return {
      ...(hz2 ? { x: near, y: cx - bw / 2, w: far - near, h: bw }
              : { x: cx - bw / 2, y: near, w: bw, h: far - near }),
      med: m, lo, hi,
      // A whisker runs from the edge of the box out to the extreme, and stops
      // there: one rule from end to end would be drawn straight through the
      // quartiles, which is the one place the box already says where the data
      // is.  Two stubs, either side, as every other box plot draws them.
      stubs: [[Math.min(lo, hi), near], [far, Math.max(lo, hi)]]
               .filter(([u, w]) => w - u > 1e-9),
    };
  };
  const groups = D.conditions.map((c, i) => {
    const s = D.summary[c], cx = C(i);
    const e = err(s), zero = Y(0), mean = s.n ? Y(s.mean) : null;
    const span = s.n ? Math.abs(mean - zero) : 0, from = s.n ? Math.min(zero, mean) : 0;
    return {
      c, cx, s, fill: quantFillFor(q, c, i),
      bar: s.n && q.bars && !q.box
        ? (hz ? { x: from, y: cx - bw / 2, w: span, h: bw }
              : { x: cx - bw / 2, y: from, w: bw, h: span })
        : null,
      // Quartiles and a median, whiskered to the extremes rather than to a
      // Tukey fence: at the three to seven blots a figure like this carries, a
      // fence calls ordinary scatter an outlier.
      box: s.n && q.box ? boxOf(s.vals, Y, cx, bw, hz) : null,
      mean,
      err: s.n > 1 && isFinite(e) && !q.box ? { y0: Y(s.mean - e), y1: Y(s.mean + e) } : null,
      pts: q.points ? s.pts.map(p => {
        // Spread by blot, so the same blot is the same place under every
        // condition, and again within the blot for lanes of one condition.
        const off = (R > 1 ? (p.r / (R - 1) - 0.5) * bw * 0.56 : 0)
                  + (p.m > 1 ? (p.i / (p.m - 1) - 0.5) * bw * 0.22 : 0);
        return hz ? { x: Y(p.v), y: cx + off, r: p.r }
                  : { x: cx + off, y: Y(p.v), r: p.r };
      }) : [],
    };
  });
  return { D, pt, Y, hz, ymin, ymax, ticks, slot, bw, w, xlabels, tilt, ylabel, groups };
}

/** One point of the graph, shaped by which blot it came from.
 *
 *  Two lanes of one condition on one blot are not two independent replicates --
 *  they share a membrane, a transfer and an exposure -- so which blot a point
 *  is from is part of reading the graph, and a legend that says it in words is
 *  read after the eye has already drawn its conclusion.  The shapes are drawn
 *  to equal area, or the blot that happened to be third would carry more ink
 *  than the first and look like more evidence. */
const MARK_SHAPES = ['circle', 'triangle', 'square', 'diamond', 'down'];

/** Half a point mark, in mm -- the default area `markGlyph` draws to. */
const GLYPH_R = Math.sqrt(0.9503 / Math.PI);

/** The hairline of paper around a point mark, in mm. */
const GLYPH_EDGE = 0.12;

function markGlyph(r, x, y, area = 0.9503, fill = '#000', edge = 0) {
  const shape = MARK_SHAPES[((r % MARK_SHAPES.length) + MARK_SHAPES.length) % MARK_SHAPES.length];
  // A hairline of paper around the mark, so marks of the bar's own color are
  // still countable where they pile up on it and where they overlap each other.
  const E = edge > 0 ? ` stroke="#fff" stroke-width="${r3(edge)}"` : '';
  const poly = pts => `<polygon points="${pts.map(([a, b]) => `${r3(a)},${r3(b)}`).join(' ')}" fill="${fill}"${E}/>`;
  if (shape === 'circle') return `<circle cx="${r3(x)}" cy="${r3(y)}" r="${r3(Math.sqrt(area / Math.PI))}" fill="${fill}"${E}/>`;
  if (shape === 'square') { const h = Math.sqrt(area) / 2;
    return `<rect x="${r3(x - h)}" y="${r3(y - h)}" width="${r3(h * 2)}" height="${r3(h * 2)}" fill="${fill}"${E}/>`; }
  if (shape === 'diamond') { const d = Math.sqrt(area / 2);
    return poly([[x, y - d], [x + d, y], [x, y + d], [x - d, y]]); }
  // An equilateral triangle about its own centroid, point up or point down.
  const a = Math.sqrt(area * 4 / Math.sqrt(3)), R = a / Math.sqrt(3), up = shape === 'triangle' ? 1 : -1;
  return poly([0, 1, 2].map(k => {
    const th = -Math.PI / 2 + k * 2 * Math.PI / 3;
    return [x + R * Math.cos(th), y + up * R * Math.sin(th)];
  }));
}

/** What each blot's points are drawn as, for the legend and the inspector. */
const markShapeName = r => MARK_SHAPES[((r % MARK_SHAPES.length) + MARK_SHAPES.length) % MARK_SHAPES.length]
                            .replace('down', 'inverted triangle');

function renderQuant(q) {
  const Lq = quantLayout(q), { D, pt, Y } = Lq;
  let out = '';
  if (!D.gels.length || !D.conditions.length) {
    out += rect(q.x, q.y, q.w, q.h, { fill: '#f7f7f7', stroke: '#bbb', dash: '1.5 1.2' });
    out += txtLines(q.x + q.w / 2, q.y + q.h / 2 - 1, D.gels.length
      ? ['nothing measured yet —', 'click bands on the blots']
      : ['no blots yet —', 'add them in the inspector'], { pt: 5.5, fill: '#888' });
    return out;
  }
  if (q.title) out += txt(q.x, q.y - 2.2, q.title, { pt: q.titlePt, bold: true, anchor: 'start' });

  const hz = Lq.hz;
  Lq.groups.forEach(g => {
    if (g.bar) out += rect(g.bar.x, g.bar.y, g.bar.w, g.bar.h, { fill: g.fill });
    if (g.box) {
      const b = g.box, cap = Lq.bw * 0.18;
      b.stubs.forEach(([u, w]) => out += hz ? line(u, g.cx, w, g.cx, q.axisMm)
                                            : line(g.cx, u, g.cx, w, q.axisMm));
      [b.lo, b.hi].forEach(e => out += hz ? line(e, g.cx - cap, e, g.cx + cap, q.axisMm)
                                          : line(g.cx - cap, e, g.cx + cap, e, q.axisMm));
      // Outline, not fill: a tinted rectangle competes for ink with the points
      // drawn on top of it, and at four blots a side the points are the figure.
      // The color is the marks', and the box is the ink around them.
      out += rect(b.x, b.y, b.w, b.h, { fill: 'none', stroke: '#000', strokeMm: q.axisMm });
      // The median is the one line of the box a reader takes a number off, so
      // it is the heavier one -- but never wider than the box itself, since
      // two replicates close together give a box thinner than a rule.
      const mw = Math.min(q.axisMm * 1.6, hz ? b.w : b.h);
      out += hz ? line(b.med, b.y, b.med, b.y + b.h, mw)
                : line(b.x, b.med, b.x + b.w, b.med, mw);
    }
    // With neither bar nor box, the mean is a short rule, so it is still there.
    if (!q.bars && !q.box && g.mean !== null)
      out += hz ? line(g.mean, g.cx - Lq.bw * 0.34, g.mean, g.cx + Lq.bw * 0.34, 0.3)
                : line(g.cx - Lq.bw * 0.34, g.mean, g.cx + Lq.bw * 0.34, g.mean, 0.3);
    // The condition's own color, outlined in paper: the marks read as the
    // same series as the bar they sit on, and the outline keeps them
    // countable both against the bar and against each other.
    g.pts.forEach(p => out += markGlyph(p.r, p.x, p.y, 0.9503, g.fill, GLYPH_EDGE));
    if (g.err) {
      const cap = Lq.bw * 0.18;
      if (hz) {
        out += line(g.err.y0, g.cx, g.err.y1, g.cx, q.axisMm);
        out += line(g.err.y0, g.cx - cap, g.err.y0, g.cx + cap, q.axisMm);
        out += line(g.err.y1, g.cx - cap, g.err.y1, g.cx + cap, q.axisMm);
      } else {
        out += line(g.cx, g.err.y0, g.cx, g.err.y1, q.axisMm);
        out += line(g.cx - cap, g.err.y0, g.cx + cap, g.err.y0, q.axisMm);
        out += line(g.cx - cap, g.err.y1, g.cx + cap, g.err.y1, q.axisMm);
      }
    }
  });

  // Axes last, so a bar starting at zero does not cover the spine.  The two
  // spines are the same two lines either way round; which of them carries the
  // numbers is what changes.
  out += line(q.x, q.y, q.x, q.y + q.h, q.axisMm);
  out += line(q.x, q.y + q.h, q.x + q.w, q.y + q.h, q.axisMm);
  if (Lq.ymin < 0)
    out += hz ? line(Y(0), q.y, Y(0), q.y + q.h, q.axisMm * 0.6, '#666')
              : line(q.x, Y(0), q.x + q.w, Y(0), q.axisMm * 0.6, '#666');
  Lq.ticks.forEach(v => {
    const a = Y(v);
    if (hz) {
      out += line(a, q.y + q.h, a, q.y + q.h + q.tickMm, q.axisMm);
      out += txt(a, q.y + q.h + q.tickMm + pt * PT * 0.95, fmtTick(v), { pt });
    } else {
      out += line(q.x - q.tickMm, a, q.x, a, q.axisMm);
      out += txt(q.x - q.tickMm - 0.5, a + pt * PT * 0.35, fmtTick(v), { pt, anchor: 'end' });
    }
  });
  Lq.xlabels.forEach(l => {
    out += txt(l.x, l.y, l.text, { pt, anchor: l.anchor, rotate: l.rotate });
  });
  const yl = Lq.ylabel;
  yl.lines.forEach((s, i) => {
    if (yl.rotate) out += txt(yl.x - (yl.lines.length - 1 - i) * yl.lh, yl.y, s, { pt, rotate: -90 });
    else out += txt(yl.x, yl.y + i * yl.lh, s, { pt });
  });
  return out;
}


/* =======================================================================
   CONSTRUCT
   =======================================================================

   What was actually expressed: the tag, the protease site, the protein, and
   where the construct starts and stops in the protein's own numbering.  Drawn
   to scale in residues, which is the one thing a cartoon assembled out of
   boxes always gets wrong -- a decahistidine tag is a fortieth of a 400-residue
   domain and gets drawn as a third of it.

   The reason this is a panel rather than a drawing is the mass.  A segment
   carries its sequence where there is one, so the figure states what the band
   on the gel should weigh, and -- where a protease cuts -- what it should weigh
   afterwards.  A segment given only a length gets an estimate at the average
   residue mass, and every number that estimate reaches is marked with a tilde
   instead of being printed as though it had been counted. */

//: The average residue mass over a typical proteome.  Used only where a segment
//: has a length and no sequence: real proteins land within a few per cent of it,
//: which is a per cent or two on the total -- enough to say which band is which,
//: not enough to print, hence the tilde everywhere it reaches.
const RES_AVG = 110;

//: Tags whose sequence is settled carry it, so their mass is counted rather than
//: estimated.  The fusion partners do not: MBP, GST and GFP each come in
//: variants differing by a linker or a few residues, and printing one version's
//: exact mass against another's construct would be worse than saying "about".
//: Paste the real sequence and the estimate goes away.
//:
//: A site's sequence is the part that STAYS on the upstream piece, because the
//: cut is taken at the end of the segment carrying it: TEV is ENLYFQ/G, so the
//: G belongs to whatever follows and is not in here.
const TAG_PRESETS = {
  'His6': { seq: 'HHHHHH' },
  'His10': { seq: 'HHHHHHHHHH' },
  'Strep-II': { seq: 'WSHPQFEK' },
  'FLAG': { seq: 'DYKDDDDK' },
  'GS linker': { seq: 'GGSGGSGGS' },
  'TEV site': { seq: 'ENLYFQ', cut: true },
  '3C site': { seq: 'LEVLFQ', cut: true },
  'thrombin site': { seq: 'LVPR', cut: true },
  'SUMO': { n: 98 },
  'MBP': { n: 370 },
  'GST': { n: 218 },
  'GFP': { n: 238 },
};

//: Pale enough to take black text and to survive being printed in gray.
const SEG_FILLS = ['#dde6f2', '#f2e6dd', '#dff0e2', '#f0dde9', '#ece7d8', '#d9ebec'];

//: What a stretch the map does not name is filled with.  It is the linker
//: between two pieces rather than a piece, so it gets one quiet color instead
//: of a place in the rotation.
const SEG_PLAIN = '#f4f4f4';

const seg = o => ({ id: uid(), name: '', seq: '', n: null, start: null,
                    fill: SEG_FILLS[0], cut: false, ...o });

function constructNode(x, y) {
  return {
    id: uid(), type: 'construct', x: r2(x), y: r2(y), w: 92, h: 14,
    title: '',
    segs: [
      seg({ name: 'His10', ...TAG_PRESETS['His10'], fill: SEG_FILLS[0] }),
      seg({ name: '3C', ...TAG_PRESETS['3C site'], fill: SEG_FILLS[1] }),
      seg({ name: 'target', n: 420, start: 1, fill: SEG_FILLS[2] }),
    ],
    map: null,                           // the plasmid map it was read from, if any
    cleaved: true,                       // was the protease actually added?
    barMm: 5, fontPt: 6, headPt: 6,
    scale: true, numbers: true, masses: true, labels: 'auto',
    stroke: '#333333', strokeMm: 0.2,
  };
}

const segSeqOf = s => cleanSeq(s.seq || '').seq;
const segLen = s => { const q = segSeqOf(s); return q ? q.length : Math.max(0, Math.round(nn(s.n) || 0)); };

/** A segment's residues, without the water that closes a chain.
 *
 *  That water belongs to the piece rather than to each of its parts: added per
 *  segment, a six-part construct comes out 90 Da heavy, which is the size of
 *  the differences this panel exists to state. */
function segResidueMass(s) {
  const q = segSeqOf(s);
  if (q) { const pp = protParam(q); return pp ? pp.mw - WATER : 0; }
  return segLen(s) * RES_AVG;
}

function piece(segs) {
  const n = segs.reduce((a, s) => a + segLen(s), 0);
  return {
    segs, n,
    da: n ? segs.reduce((a, s) => a + segResidueMass(s), 0) + WATER : 0,
    exact: segs.every(s => !segLen(s) || !!segSeqOf(s)),
  };
}

/** Whether the chain actually comes apart at this segment.
 *
 *  A protease site only breaks it when the protease was added, which is what the
 *  `cleaved` tick says: one band before the cut and two after it are the same
 *  construct, and a panel put beside the SEC run *before* cleavage should not be
 *  reporting the pieces.  A 2A breaks it either way -- the ribosome skipped the
 *  bond, there is nothing to add protease to and nothing to leave uncut. */
const segBreaks = (n, s) => !!s.cut && (n.cleaved !== false || /2A$/i.test(s.name || ''));

/** What a protease leaves.  The cut is at the end of the segment carrying it,
 *  so a site's own residues stay with the piece in front of it. */
function constructPieces(n) {
  const out = [];
  let cur = [];
  (n.segs || []).forEach(s => { cur.push(s); if (segBreaks(n, s)) { out.push(cur); cur = []; } });
  if (cur.length) out.push(cur);
  return out.filter(p => p.some(s => segLen(s))).map(piece);
}

const constructWhole = n => piece(n.segs || []);

/** One chain the server read off a plasmid map, put into a construct panel.
 *
 *  Every segment arrives with its residues, so nothing on the panel is
 *  estimated: the frame was read from the sequence rather than from a CDS
 *  feature, and the pieces are where the map's own annotation puts them. */
function constructFromChain(n, map, i) {
  const chain = map.chains[i];
  let k = 0;
  n.segs = chain.segs.map(s => seg({
    name: s.name || '', seq: s.seq, start: s.start ?? null, cut: !!s.cut,
    fill: s.name ? SEG_FILLS[k++ % SEG_FILLS.length] : SEG_PLAIN,
  }));
  n.map = { path: map.path, name: map.name, len: map.len, circular: !!map.circular,
            promoter: map.promoter, promoters: map.promoters, found: !!map.found,
            guessed: !!map.guessed,
            chain: chain.name || '', via: chain.via, of: map.chains.length };
  if (!n.title) {
    n.title = map.chains.length > 1 && chain.name ? `${map.name} — ${chain.name}` : map.name;
  }
  return n;
}

const kDa = p => (p.exact ? `${(p.da / 1000).toFixed(1)} kDa`
                          : `~${Math.round(p.da / 1000)} kDa`);

/** Where every part of the panel goes.  Shared by the drawing and by the two
 *  boxes, so what is lined up against is where the ink actually landed. */
function constructLayout(n) {
  const pt = n.fontPt;
  const segs = (n.segs || []).filter(s => segLen(s) > 0);
  const total = segs.reduce((a, s) => a + segLen(s), 0);

  let y = n.y;
  const titleY = n.title ? y + n.headPt * PT : null;
  if (n.title) y += n.headPt * PT * 1.7;

  let x = n.x;
  const box = segs.map(s => {
    const w = total ? (n.scale ? n.w * segLen(s) / total : n.w / segs.length) : 0;
    const b = { s, x, w, mid: x + w / 2 };
    x += w;
    return b;
  });

  // A name that fits in its segment is written in it; one that does not is
  // written above with a leader, because a 6-residue site is a sliver of a
  // millimeter and no font goes in it.
  const above = [];
  box.forEach(b => {
    b.inside = !!b.s.name && n.labels !== 'above' && textWmm(b.s.name, pt, false) + 1.0 <= b.w;
    if (b.s.name && !b.inside) above.push(b);
  });
  // Laid out left to right, each pushed clear of the one before it.  The leader
  // then slants, which is what says which segment a shifted label belongs to.
  let cursor = -1e9;
  above.forEach(b => {
    const half = textWmm(b.s.name, pt, false) / 2;
    b.lx = Math.max(b.mid, cursor + half + 0.7);
    cursor = b.lx + half;
  });

  const labH = above.length ? pt * PT + 1.8 : 0;
  const cutH = box.some(b => segBreaks(n, b.s)) ? 1.7 : 0;
  const barY = y + labH + cutH;
  y = barY + n.barMm;

  const numbered = n.numbers && box.some(b => nn(b.s.start) !== null);
  const numY = numbered ? (y += pt * 0.85 * PT + 0.9) : null;
  const massY = n.masses && total ? (y += pt * PT + 1.2) : null;

  return { pt, segs, box, above, total, titleY, labH, cutH, barY, numY, massY,
           h: Math.max(n.barMm, y - n.y) };
}

function renderConstruct(n) {
  const L = constructLayout(n);
  const pt = L.pt;
  n.h = r2(L.h);

  let out = '';
  if (L.titleY !== null)
    out += txt(n.x, L.titleY, n.title, { pt: n.headPt, bold: true, anchor: 'start' });

  if (!L.total)
    return out + rect(n.x, L.barY, n.w, n.barMm, { stroke: '#b9b9b9', strokeMm: 0.2, dash: '1.2 1' });

  L.above.forEach(b => {
    out += txt(b.lx, L.barY - L.cutH - 1.1, b.s.name, { pt });
    const top = L.barY - L.cutH;
    out += `<polyline points="${r3(b.lx)},${r3(top - 0.85)} ${r3(b.lx)},${r3(top - 0.55)}` +
           ` ${r3(b.mid)},${r3(top - 0.2)} ${r3(b.mid)},${r3(L.barY)}"` +
           ` fill="none" stroke="#666" stroke-width="0.13"/>`;
  });

  L.box.forEach(b => {
    out += rect(b.x, L.barY, b.w, n.barMm,
                { fill: b.s.fill || '#eeeeee', stroke: n.stroke, strokeMm: n.strokeMm });
    if (b.inside)
      out += txt(b.mid, L.barY + n.barMm / 2 + pt * PT * 0.35, b.s.name, { pt });
  });

  // The cut: an arrowhead over the boundary and a dotted line through the bar.
  L.box.filter(b => segBreaks(n, b.s)).forEach(b => {
    const cx = b.x + b.w;
    out += `<path d="M${r3(cx - 0.75)},${r3(L.barY - 1.55)} L${r3(cx + 0.75)},${r3(L.barY - 1.55)}` +
           ` L${r3(cx)},${r3(L.barY - 0.2)} Z" fill="#333333"/>`;
    out += line(cx, L.barY, cx, L.barY + n.barMm, 0.18, '#333333', ' stroke-dasharray="0.5 0.45"');
  });

  if (L.numY !== null) {
    const np = pt * 0.85;
    L.box.forEach(b => {
      const st = nn(b.s.start);
      if (st === null) return;
      const end = String(st + segLen(b.s) - 1);
      out += txt(b.x, L.numY, String(st), { pt: np, anchor: 'start', fill: '#555' });
      // Both ends only when both fit; a narrow domain keeps the one that says
      // where it starts.
      if (textWmm(String(st), np) + textWmm(end, np) + 0.8 <= b.w)
        out += txt(b.x + b.w, L.numY, end, { pt: np, anchor: 'end', fill: '#555' });
    });
  }

  if (L.massY !== null) out += txt(n.x, L.massY, constructMassLine(n), { pt, anchor: 'start' });
  return out;
}

/** What it should weigh, and what it should weigh once cut. */
/** How the chain comes apart: a protease cuts, a 2A never does.
 *
 *  Worth the word.  A 2A leaves two proteins by making the ribosome skip a
 *  bond it never formed, so there is no cleavage step, nothing to add protease
 *  to, and nothing that can be left uncut -- and a figure that says "after
 *  cleavage" over a 2A construct has described an experiment nobody ran. */
function constructBreak(n) {
  const cuts = (n.segs || []).filter(s => segBreaks(n, s) && segLen(s));
  const skip = cuts.some(s => /2A$/i.test(s.name));
  const cut = cuts.some(s => !/2A$/i.test(s.name));
  return skip && cut ? 'after cleavage and the 2A' : skip ? 'after the 2A' : 'after cleavage';
}

/** The species a construct panel describes: the chain as expressed, and each
 *  piece it comes apart into.  What a column, or a gel, is asked to show. */
function constructSpecies(cn) {
  const whole = constructWhole(cn);
  if (!whole.n) return [];
  const name = p => p.segs.filter(s => s.name && segLen(s)).map(s => s.name).join('–')
                    || `${p.n} res`;
  const pieces = constructPieces(cn);
  const out = [{ ...whole, label: cn.title || name(whole), cleaved: false }];
  if (pieces.length > 1)
    pieces.forEach(p => out.push({ ...p, label: name(p), cleaved: true, after: constructBreak(cn) }));
  return out;
}

function constructMassLine(n) {
  const whole = constructWhole(n);
  if (!whole.n) return '';
  const pieces = constructPieces(n);
  let s = kDa(whole);
  if (pieces.length > 1) s += ` → ${pieces.map(kDa).join(' + ')} ${constructBreak(n)}`;
  return s;
}


/* =======================================================================
   WHAT A PANEL OCCUPIES
   =======================================================================

   Two rectangles, because a figure has two useful ideas of where a panel is
   and lining things up wants both.

   `frameBox` is the straight element — the axis spines of a chromatogram, the
   border of a gel, the rules of a table.  It is what a reader's eye actually
   registers as the edge of a panel, and it is the one to line up when two
   panels sit one above the other: the y-axis of the trace directly over the
   left edge of the gel, whatever the tick labels happen to be doing.

   `inkBox` is everything drawn — tick numbers, axis titles, lane labels, the
   ladder scale, the fraction bar.  It is what to line up when a panel has to
   sit inside a column of a certain width, or clear of its neighbor.

   The two differ by however much furniture a panel is carrying, which on a
   chromatogram with a rotated axis title is about 8 mm.  Aligning by the wrong
   one is the usual reason a figure looks a millimeter out and nobody can say
   why. */

/** Text width in mm, measured rather than guessed.
 *
 *  A tick label is "0" or "1200" and a lane label can be "ΔTM2–3 (E273Q)"; a
 *  characters-times-a-constant estimate is out by a third on either.  The
 *  measurement is done once per string at 100 px in the same family the figure
 *  is drawn in, so it costs nothing and is right for the font actually used. */
const _measure = (() => {
  let ctx = null;
  const cache = new Map();
  return (s, pt, bold) => {
    const str = String(s ?? '');
    if (!str) return 0;
    const key = (bold ? 'b|' : 'n|') + str;
    let em = cache.get(key);
    if (em === undefined) {
      if (!ctx) {
        try { ctx = document.createElement('canvas').getContext('2d'); }
        catch (e) { ctx = null; }
      }
      if (ctx) {
        ctx.font = `${bold ? '600 ' : ''}100px ${FONT}`;
        em = ctx.measureText(str).width / 100;
      } else {
        em = str.length * 0.55;          // headless: the old estimate, flagged
      }
      if (cache.size < 4000) cache.set(key, em);
    }
    return em * pt * PT;
  };
})();

/** The lines a text node draws: its own breaks, each broken again to fit the
 *  width of the box it was given.  Without this a caption written as one
 *  sentence runs straight off the side of the page -- which is what the
 *  heading purifig writes on its own supplementary sheet did. */
function textNodeLines(n) {
  const paras = String(n.text ?? '').split('\n');
  const w = n.w - 1.6;                 // the inset the text is drawn at, both sides
  if (!(w > 0)) return paras;
  const out = [];
  for (const para of paras) {
    let line = '';
    for (const word of para.split(' ')) {
      const join = line ? line + ' ' + word : word;
      // A word wider than the box stays whole and overhangs: breaking inside
      // "beta-galactosidase" would be worse than the overhang.
      if (line && textWmm(join, n.fontPt, n.bold) > w) { out.push(line); line = word; }
      else line = join;
    }
    out.push(line);
  }
  return out;
}

/** Widest of a multi-line string. */
function textWmm(s, pt, bold) {
  return Math.max(0, ...String(s ?? '').split('\n').map(l => _measure(l, pt, bold)));
}

//: Ascent and descent as fractions of the point size.  Arial's are 0.905 and
//: 0.212; these are the same numbers rounded to what a bounding box needs.
const ASC = 0.75, DESC = 0.24;

const bx = (x0, y0, x1, y1) => ({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
const boxUnion = (a, b) => bx(Math.min(a.x, b.x), Math.min(a.y, b.y),
                               Math.max(a.x + a.w, b.x + b.w),
                               Math.max(a.y + a.h, b.y + b.h));

/** Grow a box to hold a run of text.
 *
 *  `y` is the baseline of the *first* line and further lines go below it, which
 *  is what `txtLines` does; a caller that hangs a block upward from a fixed
 *  bottom passes the top line's baseline, not the bottom one's. */
function growText(b, x, y, s, pt, anchor, bold) {
  const w = textWmm(s, pt, bold);
  if (!w) return b;
  const x0 = anchor === 'end' ? x - w : anchor === 'start' ? x : x - w / 2;
  const lines = String(s).split('\n').length;
  return boxUnion(b, bx(x0, y - pt * PT * ASC,
                        x0 + w, y + (lines - 1) * pt * PT * 1.15 + pt * PT * DESC));
}

/** The straight element: spines, borders, rules. */
function frameBox(n) {
  if (n.type === 'gel') {
    const w = n.href ? (gelLayout(n).totalW || n.w) : n.w;
    return bx(n.x, n.y, n.x + w, n.y + gelDrawnH(n));
  }
  if (n.type === 'chrom' || n.type === 'quant') return bx(n.x, n.y, n.x + n.w, n.y + n.h);
  // The bar, not the title or the mass line under it: a construct drawn over a
  // gel lines up by the thing that looks like the panel's edge.
  if (n.type === 'construct') {
    const L = constructLayout(n);
    return bx(n.x, L.barY, n.x + n.w, L.barY + n.barMm);
  }
  if (n.type === 'table' || n.type === 'nanodrop') {
    // The rule box, which starts below whatever heading lines the panel drew
    // for itself.  A table's own y is the top of its title, not of its rules.
    let top = n.y;
    if (n.title) top += n.rowMm;
    if (n.type === 'nanodrop' && n.header) top += n.rowMm * 0.9;
    return bx(n.x, top - n.pad * 0.6, n.x + n.w, n.y + n.h);
  }
  return bx(n.x, n.y, n.x + n.w, n.y + n.h);
}

/** Everything the panel draws, furniture included. */
function inkBox(n) {
  if (n.type === 'gel') return gelInkBox(n);
  if (n.type === 'chrom') return chromInkBox(n);
  if (n.type === 'quant') return quantInkBox(n);
  if (n.type === 'construct') {
    const L = constructLayout(n);
    let b = frameBox(n);
    if (L.titleY !== null) b = growText(b, n.x, L.titleY, n.title, n.headPt, 'start', true);
    // A shifted label can hang past the right-hand end of the bar.
    L.above.forEach(a => { b = growText(b, a.lx, L.barY - L.cutH - 1.1, a.s.name, L.pt, 'middle'); });
    if (L.numY !== null) b = growText(b, n.x, L.numY, '0', L.pt * 0.85, 'start');
    if (L.massY !== null) b = growText(b, n.x, L.massY, constructMassLine(n), L.pt, 'start');
    return b;
  }
  if (n.type === 'table' || n.type === 'nanodrop') {
    let b = bx(n.x, n.y, n.x + n.w, n.y + n.h);
    if (n.title) b = growText(b, n.x, n.y, n.title, n.headPt, 'start', true);
    return boxUnion(b, frameBox(n));
  }
  // A panel letter is 8 mm of box around 2 mm of letter, and a text label is a
  // box its text does not fill.  Lining those up by the box would line up
  // nothing anybody can see, so what counts is the glyphs — plus the rect, when
  // the panel is one that draws a rect.
  const drawn = n.fill !== 'none' || n.stroke !== 'none';
  let b = drawn ? bx(n.x, n.y, n.x + n.w, n.y + n.h) : null;
  const lines = textNodeLines(n);
  const lh = n.fontPt * PT * 1.2;
  const x = n.align === 'start' ? n.x + 0.8 : n.align === 'end' ? n.x + n.w - 0.8 : n.x + n.w / 2;
  const y0 = n.y + n.h / 2 - (lines.length - 1) * lh / 2 + n.fontPt * PT * 0.35;
  const wide = Math.max(0, ...lines.map(l => textWmm(l, n.fontPt, n.bold)));
  if (!wide) return b || frameBox(n);
  const x0 = n.align === 'start' ? x : n.align === 'end' ? x - wide : x - wide / 2;
  const t = bx(x0, y0 - n.fontPt * PT * ASC,
               x0 + wide, y0 + (lines.length - 1) * lh + n.fontPt * PT * DESC);
  return b ? boxUnion(b, t) : t;
}

function gelInkBox(n) {
  const L = n.href ? gelLayout(n) : null;
  const W = L ? (L.totalW || n.w) : n.w;
  const Hd = gelDrawnH(n);
  let b = bx(n.x, n.y, n.x + W, n.y + Hd);
  if (!L) return b;
  const rows = gelRows(n, L);
  b = boxUnion(b, bx(n.x, gelTop(n), n.x + W, n.y + Hd));

  // The size scale, on either side or both — as far as the marks that are
  // actually shown reach, which with strips may be fewer than the ladder has.
  ['left', 'right'].forEach(side => {
    const reach = gelScaleReach(n, side, rows, L);
    if (!reach) return;
    b = side === 'left' ? boxUnion(b, bx(n.x - reach, b.y, n.x, n.y + Hd))
                        : boxUnion(b, bx(n.x, b.y, n.x + W + reach, n.y + Hd));
  });
  rows.forEach(r => {
    if (!r.strip || !r.strip.label) return;
    const t = gelStripLabelAt(n, r, L, rows);
    b = growText(b, t.x, t.y, t.lines.join('\n'), n.labelPt, t.anchor);
  });

  const lp = n.labelPt * PT;
  L.kept.forEach((l, i) => {
    const cx = n.x + l._xmm + l._wmm / 2;
    if (l.label && !n.labelAngle) {
      const lines = String(l.label).split('\n').length;
      b = growText(b, cx, n.y - n.labelGap - (lines - 1) * lp * 1.15, l.label, n.labelPt, 'middle');
    }
    if (l.label && n.labelAngle) {
      // Rotated up and to the right from the lane center: the run reaches as
      // far right as its own length, foreshortened.
      const run = textWmm(l.label, n.labelPt) * Math.cos(Math.abs(n.labelAngle) * Math.PI / 180);
      b = boxUnion(b, bx(cx, gelTop(n), cx + run, n.y));
    }
    if (n.showNumbers)
      b = growText(b, cx, n.y + Hd + lp * 1.15, String(i + 1), n.labelPt * 0.9, 'middle');
  });

  n.bands.forEach(bd => {
    const l = n.lanes.find(x => x.id === bd.lane);
    if (!l || l.excised || l._xmm === undefined) return;
    const ymm = gelYmm(n, bd.y, rows, L);
    if (ymm === null) return;
    b = growText(b, n.x + l._xmm + l._wmm + 1.8, n.y + ymm + n.labelPt * PT * 0.35,
                 bd.label, n.labelPt * 0.92, 'start');
  });

  if (n.title)
    b = growText(b, n.x + W / 2, gelTitleY(n), n.title, n.titlePt, 'middle', true);
  return b;
}

function chromInkBox(n) {
  const S = chromScales(n), pt = n.fontPt;
  let b = bx(n.x, n.y, n.x + n.w, n.y + n.h);

  // Down to the axis title's descenders, up past the fraction bar and the
  // standards ticks: the two ends the brace already asks about, reused rather
  // than restated so they cannot drift apart.
  b = boxUnion(b, bx(n.x, chromTop(n, pt), n.x + n.w, chromBottom(n)));

  niceTicks(S.xmin, S.xmax).forEach(v => {
    const x = S.X(v);
    if (x < n.x - 0.01 || x > n.x + n.w + 0.01) return;
    b = growText(b, x, n.y + n.h + n.tickMm + pt * PT * 0.95, String(v), pt, 'middle');
  });
  niceTicks(S.ymin, S.ymax).forEach(v => {
    const y = S.Y(v);
    if (y < n.y - 0.01 || y > n.y + n.h + 0.01) return;
    b = growText(b, n.x - n.tickMm - 0.5, y + pt * PT * 0.35, String(v), pt, 'end');
  });
  b = growText(b, n.x + n.w / 2, chromBottom(n) - pt * PT * DESC, n.xlabel, pt, 'middle');
  // Rotated a quarter turn: the ascenders reach sideways, so the label is as
  // wide as one line is tall and as tall as the string is long.
  if (n.ylabel) {
    const x = n.x - n.tickMm - 5.2, half = textWmm(n.ylabel, pt) / 2;
    b = boxUnion(b, bx(x - pt * PT * ASC, n.y + n.h / 2 - half,
                        x + pt * PT * DESC, n.y + n.h / 2 + half));
  }

  if (n.traces.some(t => t.on !== false && t.axis === 'right')) {
    niceTicks(S.y2min, S.y2max).forEach(v => {
      const y = S.Y2(v);
      if (y < n.y - 0.01 || y > n.y + n.h + 0.01) return;
      b = growText(b, n.x + n.w + n.tickMm + 0.5, y + pt * PT * 0.35, String(v), pt, 'start');
    });
    if (n.y2label) {
      const x = n.x + n.w + n.tickMm + 5.0, half = textWmm(n.y2label, pt) / 2;
      b = boxUnion(b, bx(x - pt * PT * DESC, n.y + n.h / 2 - half,
                          x + pt * PT * ASC, n.y + n.h / 2 + half));
    }
  }

  // Fraction numbers overhang the ends of the bar by half a label.
  const fr = n.fractions;
  if (fr.on && fr.marks.length) {
    const F = fracBar(n, pt);
    fr.marks.forEach((m, i) => {
      if (i % (fr.every || 1) || !m.label) return;
      const x = S.X(m.v);
      if (x < n.x - 0.01 || x > n.x + n.w + 0.01) return;
      b = growText(b, x, F.label, m.label, fr.pt, 'middle');
    });
  }

  // Peak labels sit above the curve, which at the top of the plot is above the
  // plot; V0/Vt/inject sit just above the frame.
  n.peaks.forEach(p => {
    const x = S.X(p.v);
    if (x < n.x || x > n.x + n.w) return;
    const t = n.traces.find(t => t.id === p.trace) || n.traces.find(t => t.on !== false);
    const yv = traceValueAt(t, p.v);
    const Yf = t && t.axis === 'right' ? S.Y2 : S.Y;
    const y = yv === null ? n.y : Yf(normY(t, yv, n));
    const lines = [];
    if (p.label) lines.push(p.label);
    if (p.showV) lines.push(`${r2(p.v)} mL`);
    if (p.showMW) { const l = chromMwLabel(n, p.v); if (l) lines.push(l); }
    if (p.showRatio) { const r = chromRatio(n, p.v); if (r) lines.push(`A₂₆₀/A₂₈₀ ${r2(r)}`); }
    if (!lines.length) return;
    b = growText(b, x, y - 2.0 - (lines.length - 1) * pt * PT * 1.15,
                 lines.join('\n'), pt, 'middle');
  });
  if ((n.marks.v0 && n.column.v0 > 0) || (n.marks.vt && n.column.vt > 0) ||
      (n.marks.inject && n.inject && n.inject.offset && n.inject.v > 0))
    b = boxUnion(b, bx(n.x, n.y - 0.5 - pt * 0.92 * PT * ASC, n.x + n.w, n.y));

  if (n.title) b = growText(b, n.x, chromTop(n, pt) - 0.9, n.title, n.titlePt, 'start', true);
  return b;
}

function quantInkBox(q) {
  const Lq = quantLayout(q), pt = Lq.pt;
  let b = bx(q.x, q.y, q.x + q.w, q.y + q.h);
  if (!Lq.D.gels.length || !Lq.D.conditions.length) return b;
  Lq.ticks.forEach(v => {
    const a = Lq.Y(v);
    b = Lq.hz ? growText(b, a, q.y + q.h + q.tickMm + pt * PT * 0.95, fmtTick(v), pt, 'middle')
              : growText(b, q.x - q.tickMm - 0.5, a + pt * PT * 0.35, fmtTick(v), pt, 'end');
  });
  Lq.xlabels.forEach(l => {
    if (!l.rotate) { b = growText(b, l.x, l.y, l.text, pt, l.anchor); return; }
    // Forty-five degrees down and to the left of where it ends.
    const run = textWmm(l.text, pt) * Math.SQRT1_2, up = pt * PT * ASC * Math.SQRT1_2;
    b = boxUnion(b, bx(l.x - run - up, l.y - up, l.x + up, l.y + run + pt * PT * DESC));
  });
  const yl = Lq.ylabel;
  yl.lines.forEach((s, i) => {
    if (!yl.rotate) { b = growText(b, yl.x, yl.y + i * yl.lh, s, pt, 'middle'); return; }
    const x = yl.x - (yl.lines.length - 1 - i) * yl.lh, half = textWmm(s, pt) / 2;
    b = boxUnion(b, bx(x - pt * PT * ASC, yl.y - half, x + pt * PT * DESC, yl.y + half));
  });
  if (q.title) b = growText(b, q.x, q.y - 2.2, q.title, q.titlePt, 'start', true);
  return b;
}
