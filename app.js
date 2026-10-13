'use strict';
/* purifig — a print-accurate canvas for protein purification overview figures.
 *
 * Document units are millimeters throughout and the SVG viewBox is in mm, so
 * what you lay out is what exports at journal size.  Font sizes are held in
 * points and converted at render time.  Exported SVG carries live text.
 *
 * The one rule the whole app is built around: the figure and the record of how
 * the figure was made are the same object.  A crop, a window, an excised lane
 * and a splice are all document state, so `Integrity…` is a report rather than
 * a thing anyone has to remember to keep.
 */

const PRESETS = [
  ['Nature 1-col', 89, 180], ['Nature 2-col', 183, 240],
  ['Cell 1-col', 85, 180], ['Cell 2-col', 174, 240],
  ['eLife full', 170, 240], ['PNAS 2-col', 178, 230],
  ['JBC 2-col', 178, 230], ['Slide 16:9', 254, 143],
];

const $ = s => document.querySelector(s);
const HANDLE_PX = 7;

/* ================= state ================= */

let doc, view, sel, mode, pending, editing, drag, marquee;
let backend = { ok: false };

function blankDoc(w = 183, h = 240) {
  return {
    page: { w, h },
    meta: { title: '', protein: '', construct: '', tag: '', host: '', notes: '' },
    sources: [], nodes: [], edges: [],
  };
}

function reset(d) {
  doc = d;
  if (!doc.sources) doc.sources = [];
  if (!doc.meta) doc.meta = blankDoc().meta;
  if (!doc.other) doc.other = null;
  if (!doc.sheet) doc.sheet = 'figure';
  // The sheet that is not showing gets the same upgrades, or switching to one
  // saved before a field existed would hand the renderer a panel from an older
  // version of the program.
  [...doc.nodes, ...(doc.other ? doc.other.nodes : [])].forEach(n => {
    upgradeGel(n);
    // The picture a panel carries was made from some crop and turn whether or
    // not the file wrote that down, and it is the panel's own crop and turn.
    // Without the record the first nudge of a crop edge reads as a different
    // scan, and the lanes — fitted to the bands by hand — are stretched across
    // the full width on one drag.
    if (n.type === 'gel' && !n.geom && n.href && source(n.src)) n.geom = gelGeom(n, source(n.src));
    // A construct saved before the tick existed was drawn cleaved, so the box has
    // to open ticked: an unticked box over a panel reporting two pieces is a lie.
    if (n.type === 'construct' && n.cleaved === undefined) n.cleaved = true;
  });
  PF.doc = doc;
  // A loading control drawn at its own scale says the band is a different size
  // than the blot does, so the figure is put right on the way in rather than
  // waiting for somebody to drag a height handle.  A no-op on a file already in
  // step, and on every file with no loading control on its own panel.
  gelSyncControls();
  sel = new Set();
  mode = 'select';
  pending = null;
  editing = null;
  drag = marquee = null;
  clearHistory();
  fitView();
  syncSheetUi();
}


/* ================= history ================= */

/** Undo works on snapshots of the whole document, because that is the only
 *  description of "before" that cannot drift out of step with what an edit
 *  actually did — and this app edits the document from a dozen places.
 *
 *  A snapshot shares two kinds of value with the live document instead of
 *  copying them.  Strings share for free in JS, which matters here because a
 *  gel panel carries its rendered PNG as half a megabyte of base64.  A trace's
 *  point array is shared deliberately: it is replaced wholesale whenever it
 *  changes and never edited in place, so it is frozen on the way past to keep
 *  that true.  Copying those on every keystroke is what makes a naive snapshot
 *  stack unusable on a real figure. */
const HISTORY_MAX = 80;
const history = { past: [], future: [], key: null, at: 0 };

function cloneDoc(v, key) {
  if (v === null || typeof v !== 'object') return v;
  if (key === 'pts') return Object.isFrozen(v) ? v : Object.freeze(v);
  if (Array.isArray(v)) return v.map(x => cloneDoc(x, key));
  const out = {};
  for (const k in v) out[k] = cloneDoc(v[k], k);
  return out;
}

const snapshot = () => ({ doc: cloneDoc(doc), sel: [...sel] });

function restore(s) {
  doc = cloneDoc(s.doc);
  PF.doc = doc;
  sel = new Set(s.sel.filter(id => node(id) || edge(id)));
  drag = marquee = null;
  if (editing) { editing = null; editorEl.style.display = 'none'; }
  // An undo can cross between the figure and the supplementary sheet, and can
  // put back a different page size, so the toolbar is told which is showing.
  syncSheetUi();
  render(); inspector();
}

/** Record the state *before* an edit.
 *
 *  `key` coalesces a run of edits into one step: typing a caption, or nudging a
 *  color picker, is one thing to undo rather than forty.  A different key, or
 *  a pause, starts a new step; pass nothing for an edit that is its own step. */
function mark(key) {
  const now = Date.now();
  touch();
  if (key && key === history.key && now - history.at < 900) { history.at = now; return; }
  history.past.push(snapshot());
  if (history.past.length > HISTORY_MAX) history.past.shift();
  history.future.length = 0;
  history.key = key || null;
  history.at = now;
}

/** Take back the step just marked, for an action that turned out to change
 *  nothing — a canceled prompt, or a button that only arms a canvas click.
 *  An undo that visibly does nothing is worse than no undo. */
function unmark() {
  history.past.pop();
  history.key = null;
}

function undo() {
  if (!history.past.length) return hint('Nothing to undo.');
  history.future.push(snapshot());
  restore(history.past.pop());
  history.key = null;
  hint(`Undone — ${history.past.length} step${history.past.length === 1 ? '' : 's'} left.`);
}

function redo() {
  if (!history.future.length) return hint('Nothing to redo.');
  history.past.push(snapshot());
  restore(history.future.pop());
  history.key = null;
  hint(`Redone — ${history.future.length} step${history.future.length === 1 ? '' : 's'} forward.`);
}

/** A new document is not an edit of the old one, so nothing before it is worth
 *  stepping back into. */
function clearHistory() {
  history.past.length = history.future.length = 0;
  history.key = null;
}

const node = id => doc.nodes.find(n => n.id === id);
const edge = id => doc.edges.find(e => e.id === id);
const source = id => doc.sources.find(s => s.id === id);
const selNodes = () => doc.nodes.filter(n => sel.has(n.id));
const selEdges = () => doc.edges.filter(e => sel.has(e.id));

function newNode(type, x, y) {
  if (type === 'gel') return gelNode(x, y);
  // A blot is a gel panel that knows it is a blot: it offers the white-light
  // image beside the signal, and the record and the caption call it a western.
  if (type === 'blot') return { ...gelNode(x, y), kind: 'western blot' };
  if (type === 'chrom') return chromNode(x, y);
  if (type === 'table') return tableNode(x, y);
  if (type === 'nanodrop') return nanodropNode(x, y);
  if (type === 'quant') return quantNode(x, y);
  if (type === 'construct') return constructNode(x, y);
  const base = { id: uid(), type, x: r2(x), y: r2(y), fontPt: 7, bold: false,
                 align: 'center', fill: '#ffffff', stroke: '#000000',
                 strokeMm: 0.25, radius: 0, w: 34, h: 12, text: 'Step' };
  if (type === 'text') return { ...base, h: 8, text: 'Label', fill: 'none', stroke: 'none' };
  if (type === 'panel') return { ...base, w: 8, h: 8, text: 'A', fontPt: 9, bold: true,
                                 align: 'start', fill: 'none', stroke: 'none' };
  return base;
}

function newEdge(kind, from, to) {
  return { id: uid(), kind, from, to, stroke: '#000000', strokeMm: 0.25,
           arrowhead: kind !== 'brace', label: '', labelPt: 6, labelDy: -1.2,
           drop: 0.5 };
}

/* ================= geometry ================= */

function bbox(n) {
  if (n.type === 'gel' && n.href) {
    const L = gelLayout(n);
    return { x: n.x, y: n.y, w: L.totalW, h: gelDrawnH(n) };
  }
  return { x: n.x, y: n.y, w: n.w, h: n.h };
}

/** Set how tall a gel is drawn.  With strips that is their share of the whole
 *  gel's height plus the gaps between them, so the whole-gel height is worked
 *  back from it: the strips stay at the gel's own scale however it is sized. */
function gelSetDrawnH(n, H) {
  const rows = gelRows(n);
  const was = n.h;
  if (!rows[0].strip) n.h = Math.max(6, H);
  else {
    const span = rows.reduce((a, r) => a + (r.y1 - r.y0), 0);
    const gaps = (rows.length - 1) * (nn(n.stripGap) ?? 1);
    n.h = r2(Math.max(6, (Math.max(2, H - gaps)) * (n.imgH || 1) / (span || 1)));
  }
  // A loading control is sized by its blot's lane spacing and has no scale of
  // its own, so the handle on one sizes the blot by the same factor and the
  // control is then put back from it; dragging it against the blot would snap.
  const blot = gelBlotOf(n);
  if (blot && was > 0) blot.h = r4(blot.h * n.h / was);
  gelSyncControls();
}

/** A panel entirely off the page is on the pasteboard: kept, measured, drawn
 *  on screen, and left out of the figure — which is what a pasteboard is in
 *  any layout program.  It is where replicate blots live that feed a
 *  quantification but are not themselves shown. */
function offPage(n) {
  const b = frameBox(n);
  return b.x >= doc.page.w || b.y >= doc.page.h || b.x + b.w <= 0 || b.y + b.h <= 0;
}

function anchor(n, side) {
  const b = bbox(n);
  if (side === 'l') return [b.x, b.y + b.h / 2];
  if (side === 'r') return [b.x + b.w, b.y + b.h / 2];
  if (side === 't') return [b.x + b.w / 2, b.y];
  return [b.x + b.w / 2, b.y + b.h];
}

function pickSides(A, B) {
  const a = bbox(A), b = bbox(B);
  const dx = (b.x + b.w / 2) - (a.x + a.w / 2);
  const dy = (b.y + b.h / 2) - (a.y + a.h / 2);
  if (Math.abs(dy) >= Math.abs(dx)) return dy > 0 ? ['b', 't'] : ['t', 'b'];
  return dx > 0 ? ['r', 'l'] : ['l', 'r'];
}

function edgeGeom(e) {
  const A = node(e.from), B = node(e.to);
  if (!A || !B) return null;
  const [sa, sb] = pickSides(A, B);
  const p = anchor(A, sa), q = anchor(B, sb);
  if (e.kind === 'elbow') {
    const mid = (sa === 'b' || sa === 't') ? [p[0], (p[1] + q[1]) / 2] : [(p[0] + q[0]) / 2, p[1]];
    const mid2 = (sa === 'b' || sa === 't') ? [q[0], (p[1] + q[1]) / 2] : [(p[0] + q[0]) / 2, q[1]];
    return { d: `M${r3(p[0])},${r3(p[1])} L${r3(mid[0])},${r3(mid[1])} L${r3(mid2[0])},${r3(mid2[1])} L${r3(q[0])},${r3(q[1])}`,
             mid: [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2], head: [q, mid2] };
  }
  return { d: `M${r3(p[0])},${r3(p[1])} L${r3(q[0])},${r3(q[1])}`,
           mid: [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2], head: [q, p] };
}

/** The bracket that says "these fractions are those lanes".
 *  Spans the pooled region of a chromatogram at the top and the full lane
 *  block of a gel at the bottom, so the correspondence is drawn rather than
 *  left to the reader to infer from horizontal position. */
function braceGeom(e) {
  let A = node(e.from), B = node(e.to);
  if (!A || !B) return null;
  // The brace runs from the trace down to the lanes.  Drawn the other way round
  // it means the same thing, so it is turned round rather than drawn upside
  // down through the two panels.
  if (A.type === 'gel' && B.type === 'chrom') [A, B] = [B, A];
  let x0, x1, y0;
  if (A.type === 'chrom') {
    const S = chromScales(A);
    // Span the fractions the gel below actually ran, not the whole pooled range:
    // the bracket claims which volumes became which lanes, and one wider than
    // the lanes it points at is a wider claim than the truth.
    const segs = chromShadedFractions(A);
    const p = A.fractions && A.fractions.pooled;
    if (segs.length) {
      x0 = S.X(Math.min(...segs.map(g => g.v0)));
      x1 = S.X(Math.max(...segs.map(g => g.v1)));
    } else {
      x0 = p ? S.X(p[0]) : A.x;
      x1 = p ? S.X(p[1]) : A.x + A.w;
    }
    y0 = chromBottom(A) + 1.0;
  } else {
    const b = bbox(A); x0 = b.x; x1 = b.x + b.w; y0 = b.y + b.h;
  }
  const b = bbox(B);
  const y1 = (B.type === 'gel' ? gelTop(B) : b.y) - 1.0;
  // At the gel end, span only the lanes that hold fractions.  A gel usually
  // carries a ladder and a load lane too, and bracketing those as though they
  // came off the column says something that is not so.
  let mx0 = b.x, mx1 = b.x + b.w;
  if (B.type === 'gel') {
    const fl = gelFractions(B);
    if (fl.length) {
      gelLayout(B);                      // lays out _xmm/_wmm on the lanes
      const xs = fl.map(f => f.lane._xmm).filter(v => v !== undefined);
      const ws = fl.map(f => f.lane._wmm);
      if (xs.length) {
        mx0 = B.x + Math.min(...xs);
        mx1 = B.x + Math.max(...fl.map((f, i) => f.lane._xmm + ws[i]));
      }
    }
  }
  // Where the crossbar sits between the two, as a fraction of the gap.  Yours to
  // drag: how much room there is between the panels is a layout question, and
  // halfway is only a starting guess.
  const t = clamp(nn(e.drop) === null ? 0.5 : e.drop, 0.05, 0.95);
  const mid = y0 + (y1 - y0) * t;
  return {
    d: `M${r3(x0)},${r3(y0)} L${r3(x0)},${r3(mid)} L${r3(mx0)},${r3(mid)} L${r3(mx0)},${r3(y1)}` +
       ` M${r3(x1)},${r3(y0)} L${r3(x1)},${r3(mid)} L${r3(mx1)},${r3(mid)} L${r3(mx1)},${r3(y1)}` +
       ` M${r3(mx0)},${r3(mid)} L${r3(mx1)},${r3(mid)}`,
    mid: [(mx0 + mx1) / 2, mid], head: null,
    bar: { x0: Math.min(mx0, x0), x1: Math.max(mx1, x1), y: mid, y0, y1 },
  };
}

/* ================= view ================= */

//: Measured once a frame, not four times.  `getBoundingClientRect` makes the
//: browser lay the page out before it answers, and `pxPerMm` asks for it from
//: the page rect, the pasteboard cards, the overlay and the zoom label — that
//: last one *after* the markup has been replaced, so it paid for a whole fresh
//: layout every frame.  The canvas only changes size when the window does;
//: `render()` and the resize listener drop the reading.
let canvasRect = null;

function canvasSize() {
  if (canvasRect) return canvasRect;
  const r = $('#canvas').getBoundingClientRect();
  // A zero-sized canvas is the pane hidden or the first layout not yet done.
  // Caching that would make the boot-time retry in `fitView` loop forever.
  if (!(r.width > 1 && r.height > 1)) return { w: r.width, h: r.height };
  return (canvasRect = { w: r.width, h: r.height });
}
function pxPerMm() { const m = canvasCTM(); return m ? m.a : canvasSize().w / view.w; }

function fitView() {
  const c = canvasSize();
  // The canvas can still be zero-sized when this runs at boot, and dividing by
  // that scale gives a viewBox of zero -- a blank page and no way back.
  if (!(c.w > 1 && c.h > 1)) {
    view = view || { x: 0, y: 0, w: doc.page.w, h: doc.page.h };
    requestAnimationFrame(() => { fitView(); render(); });
    return;
  }
  const pad = 14;
  const scale = Math.min((c.w - pad * 2) / doc.page.w, (c.h - pad * 2) / doc.page.h);
  const w = c.w / scale, h = c.h / scale;
  view = { x: (doc.page.w - w) / 2, y: (doc.page.h - h) / 2, w, h };
}

/** Keep the viewBox aspect equal to the canvas aspect, so `preserveAspectRatio`
 *  never letterboxes and one screen pixel keeps meaning one mm times zoom. */
function matchAspect() {
  const c = canvasSize();
  if (!(c.w > 1 && c.h > 1) || !view || !(view.w > 0)) return;
  view.h = view.w * (c.h / c.w);
}

/** How the browser is actually mapping the canvas, millimeters to screen.
 *
 *  Not the ratio of the two widths.  The viewBox is fitted with `meet`, so when
 *  the view's shape and the canvas's drift apart the picture is scaled to fit
 *  and letterboxed, and that ratio then overstates the scale and ignores the
 *  margin.  They do drift: `matchAspect` only runs on a window resize, while
 *  the inspector and the panes beside the canvas change its width without one.
 *  It was 2.3% out here, which is a crop edge landing a millimeter and a half
 *  from the cursor -- and further out the further it was dragged, so an outline
 *  could not be put where it was wanted however carefully it was aimed. */
function canvasCTM() {
  const m = $('#canvas').getScreenCTM();
  return m && m.a > 0 && m.d > 0 ? m : null;
}

function toDoc(ev) {
  // No transform is the pane hidden, or a drop arriving before the first
  // layout; going on would put a NaN-positioned node in the document, which
  // cannot be seen, selected or moved.  Fall back to the middle.
  const m = canvasCTM();
  if (!m) return [view.x + view.w / 2, view.y + view.h / 2];
  return [(ev.clientX - m.e) / m.a, (ev.clientY - m.f) / m.d];
}

function snapv(v) { return $('#snap').checked ? Math.round(v * 2) / 2 : r2(v); }

/* ================= rendering ================= */

/* ---- the pictures, as URLs the browser can keep ---- */

//: A picture in the document is a data URI: the whole crop, base64, half a
//: megabyte of it.  `render()` rewrites the canvas markup on every mouse move
//: and a gel puts its picture in once per strip and splice, so a drag was
//: re-parsing and re-decoding several megabytes of base64 per frame -- 8 ms of
//: a 16 ms budget on three blots, and worse on more.  Behind a blob URL the
//: same bytes are a forty-character string the browser already has decoded.
//:
//: The data URI stays on the node, because that is what a saved session and an
//: exported SVG carry; `exportSvgString` puts it back on the way out.
const imgBlobs = new Map();    // data URI -> blob URL
const imgSrcs = new Map();     // blob URL  -> data URI

function imgUrl(href) {
  if (!href || href.slice(0, 5) !== 'data:') return href;
  const had = imgBlobs.get(href);
  if (had) return had;
  const comma = href.indexOf(',');
  const meta = href.slice(5, comma);
  if (!meta.endsWith(';base64')) return href;
  const bin = atob(href.slice(comma + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: meta.slice(0, -7) }));
  imgBlobs.set(href, url); imgSrcs.set(url, href);
  if (imgBlobs.size > 12) sweepImgUrls();
  return url;
}

/** Let go of the blobs for pictures the document no longer holds — every
 *  contrast change makes a new one, and each is a copy of the bytes. */
function sweepImgUrls() {
  const live = new Set();
  doc.nodes.forEach(n => {
    live.add(n.href); live.add(n.mergeHref);
    if (n.marker) live.add(n.marker.href);
  });
  doc.sources.forEach(s => live.add(s.preview));
  imgBlobs.forEach((url, key) => {
    if (live.has(key)) return;
    URL.revokeObjectURL(url);
    imgBlobs.delete(key); imgSrcs.delete(url);
  });
}

function renderGrid() {
  if (!$('#grid').checked) return '';
  let out = '';
  for (let x = 0; x <= doc.page.w; x += 10)
    out += line(x, 0, x, doc.page.h, 0.08, 'rgba(128,140,155,.45)');
  for (let y = 0; y <= doc.page.h; y += 10)
    out += line(0, y, doc.page.w, y, 0.08, 'rgba(128,140,155,.45)');
  return `<g id="lg">${out}</g>`;
}

function renderNode(n) {
  if (n.type === 'gel') return renderGel(n);
  if (n.type === 'chrom') return renderChrom(n);
  if (n.type === 'table') return renderTable(n);
  if (n.type === 'nanodrop') return renderNanodrop(n);
  if (n.type === 'quant') return renderQuant(n);
  if (n.type === 'construct') return renderConstruct(n);
  let out = '';
  if (n.fill !== 'none' || n.stroke !== 'none')
    out += `<rect x="${r3(n.x)}" y="${r3(n.y)}" width="${r3(n.w)}" height="${r3(n.h)}" rx="${r3(n.radius || 0)}"` +
           ` fill="${n.fill}" stroke="${n.stroke}" stroke-width="${r3(n.strokeMm)}"/>`;
  const lines = textNodeLines(n);
  const lh = n.fontPt * PT * 1.2;
  const x = n.align === 'start' ? n.x + 0.8 : n.align === 'end' ? n.x + n.w - 0.8 : n.x + n.w / 2;
  const y0 = n.y + n.h / 2 - (lines.length - 1) * lh / 2 + n.fontPt * PT * 0.35;
  out += txtLines(x, y0, lines, { pt: n.fontPt, bold: n.bold, lineHeight: 1.2,
                                  anchor: n.align === 'start' ? 'start' : n.align === 'end' ? 'end' : 'middle' });
  return out;
}

function markerId(c) { return 'ah' + String(c).replace(/[^a-z0-9]/gi, ''); }

function renderDefs() {
  const cols = new Set(doc.edges.filter(e => e.arrowhead).map(e => e.stroke));
  let out = [...cols].map(c =>
    `<marker id="${markerId(c)}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5.5"` +
    ` markerHeight="5.5" orient="auto-start-reverse"><path d="M0,1 L10,5 L0,9 z" fill="${c}"/></marker>`).join('');
  doc.nodes.forEach(n => {
    if (n.type === 'gel') out += gelDefs(n);
    if (n.type === 'chrom') out += chromDefs(n);
  });
  return `<defs>${out}</defs>`;
}

function renderEdge(e) {
  const g = e.kind === 'brace' ? braceGeom(e) : edgeGeom(e);
  if (!g) return '';
  const head = e.arrowhead && g.head ? ` marker-end="url(#${markerId(e.stroke)})"` : '';
  let out = `<path d="${g.d}" fill="none" stroke="${e.stroke}" stroke-width="${r3(e.strokeMm)}"` +
            ` stroke-linejoin="round"${head}/>`;
  if (e.label) out += txt(g.mid[0], g.mid[1] + e.labelDy, e.label, { pt: e.labelPt });
  return out;
}

//: The eight grips on a crop rectangle: where each sits on it, and which edges
//: it moves.  `l/t/r/b` are the sides this handle drags.
const CROP_HANDLES = [
  { fx: 0,   fy: 0,   cur: 'nwse-resize', e: 'lt' },
  { fx: 0.5, fy: 0,   cur: 'ns-resize',   e: 't'  },
  { fx: 1,   fy: 0,   cur: 'nesw-resize', e: 'rt' },
  { fx: 1,   fy: 0.5, cur: 'ew-resize',   e: 'r'  },
  { fx: 1,   fy: 1,   cur: 'nwse-resize', e: 'rb' },
  { fx: 0.5, fy: 1,   cur: 'ns-resize',   e: 'b'  },
  { fx: 0,   fy: 1,   cur: 'nesw-resize', e: 'lb' },
  { fx: 0,   fy: 0.5, cur: 'ew-resize',   e: 'l'  },
];

function renderOverlay() {
  let out = '';
  const ppm = pxPerMm();
  const k = ppm > 0 ? 1 / ppm : 0.1;      // zero before the first layout pass
  const hs = HANDLE_PX * k;
  doc.nodes.forEach(n => {
    if (n.type === 'gel') out += renderGelOverlay(n, sel.has(n.id));
    // No selection box on the panel being cropped: it is drawn elsewhere on the
    // page while the crop is open, and the box would be left behind on its own.
    if (!sel.has(n.id) || (mode === 'crop' && pending && pending.node === n.id)) return;
    const b = bbox(n);
    out += rect(b.x, b.y, b.w, b.h, { stroke: '#f2f5f8', strokeMm: k, dash: `${3 * k} ${2 * k}` });
    // A gel sized by its lanes has no size of its own to drag: the handles are
    // left off rather than left there to snap back on the next draw.
    if (n.type === 'gel' && gelLaneMm(n) > 0) return;
    [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]].forEach(([hx, hy], i) => {
      out += `<rect class="handle" data-h="${i}" data-n="${n.id}" x="${r3(hx - hs / 2)}" y="${r3(hy - hs / 2)}"` +
             ` width="${r3(hs)}" height="${r3(hs)}" fill="#f2f5f8" stroke="#1a1d21" stroke-width="${r3(k)}"/>`;
    });
  });
  // Crop handles: eight on the rectangle, plus the inside of it for moving the
  // whole window without resizing it.
  if (mode === 'crop' && pending) {
    const n = node(pending.node), src = n && source(n.src);
    if (n && src && src.preview) {
      const v = gelCropView(n, src), c = v.c;
      const x0 = v.X(c.x), y0 = v.Y(c.y), w = c.w * v.s, h = c.h * v.s;
      out += `<rect class="crophit" data-n="${n.id}" x="${r3(x0)}" y="${r3(y0)}" ` +
             `width="${r3(w)}" height="${r3(h)}" fill="transparent" style="cursor:move"/>`;
      CROP_HANDLES.forEach((g, i) => {
        const hx = x0 + g.fx * w, hy = y0 + g.fy * h;
        out += `<rect class="crophandle" data-h="${i}" data-n="${n.id}" ` +
               `x="${r3(hx - hs / 2)}" y="${r3(hy - hs / 2)}" width="${r3(hs)}" height="${r3(hs)}" ` +
               `fill="#f2f5f8" stroke="#0b0d10" stroke-width="${r3(k)}" style="cursor:${g.cur}"/>`;
      });
    }
  }

  doc.edges.forEach(e => {
    if (!sel.has(e.id)) return;
    const g = e.kind === 'brace' ? braceGeom(e) : edgeGeom(e);
    if (!g) return;
    out += `<path d="${g.d}" fill="none" stroke="#f2f5f8" stroke-width="${r3(k * 2.5)}" opacity=".55"/>`;
    // A grip on the crossbar: drag it to set how far the brace hangs.
    if (g.bar) {
      const cx = (g.bar.x0 + g.bar.x1) / 2;
      out += `<rect class="bracebar" data-edge="${e.id}" x="${r3(g.bar.x0)}" ` +
             `y="${r3(g.bar.y - hs * 0.7)}" width="${r3(g.bar.x1 - g.bar.x0)}" ` +
             `height="${r3(hs * 1.4)}" fill="transparent" style="cursor:ns-resize"/>`;
      out += `<rect class="handle" data-edge="${e.id}" x="${r3(cx - hs / 2)}" ` +
             `y="${r3(g.bar.y - hs / 2)}" width="${r3(hs)}" height="${r3(hs)}" ` +
             `fill="#f2f5f8" stroke="#1a1d21" stroke-width="${r3(k)}" style="cursor:ns-resize"/>`;
    }
  });
  if (marquee) {
    const x = Math.min(marquee.x0, marquee.x1), y = Math.min(marquee.y0, marquee.y1);
    out += rect(x, y, Math.abs(marquee.x1 - marquee.x0), Math.abs(marquee.y1 - marquee.y0),
                { fill: 'rgba(229,72,77,.14)', stroke: '#e5484d', strokeMm: k });
  }
  // A blot held over a graph it is not yet part of: the graph lights up, and
  // letting go adds it as a replicate rather than dropping the blot on top.
  if (drag && drag.onto) {
    const q = node(drag.onto), b = q && inkBox(q);
    if (b) {
      out += rect(b.x - 2, b.y - 2, b.w + 4, b.h + 4,
                  { fill: 'rgba(0,140,90,.10)', stroke: '#0a8f5a', strokeMm: k * 2, dash: '3 2' });
      out += txt(b.x - 2, b.y - 3.4, 'add as a replicate',
                 { pt: Math.max(1.7, 9 * k) / PT, fill: '#0a8f5a', anchor: 'start' });
    }
  }
  return `<g id="lu">${out}</g>`;
}

/** A white card behind each panel on the pasteboard, so its black labels can
 *  be read against the dark around the page — and a word above it saying it
 *  is not in the figure, because it is laid out exactly like one that is. */
function renderCards() {
  const k = 1 / (pxPerMm() || 1);
  return doc.nodes.filter(offPage).map(n => {
    const b = inkBox(n), pad = 2.5;
    const used = n.type === 'gel' && doc.nodes.some(q => q.type === 'quant' && q.gels.includes(n.id));
    return `<rect x="${r3(b.x - pad)}" y="${r3(b.y - pad)}" width="${r3(b.w + pad * 2)}" ` +
           `height="${r3(b.h + pad * 2)}" fill="#ffffff" stroke="rgba(150,160,175,.7)" ` +
           `stroke-width="${r3(k)}" stroke-dasharray="${r3(4 * k)} ${r3(3 * k)}"/>` +
           `<text x="${r3(b.x - pad)}" y="${r3(b.y - pad - 1.2)}" font-family="${FONT}" ` +
           `font-size="${r3(Math.max(1.6, 9 * k))}" fill="rgba(150,160,175,.95)">` +
           `${used ? 'replicate — quantified, not in the figure' : 'pasteboard — not in the figure'}</text>`;
  }).join('');
}

function render() {
  canvasRect = null;
  const c = $('#canvas');
  c.setAttribute('viewBox', `${r3(view.x)} ${r3(view.y)} ${r3(view.w)} ${r3(view.h)}`);
  const page = `<g id="lb"><rect x="0" y="0" width="${doc.page.w}" height="${doc.page.h}" fill="#ffffff"` +
               ` stroke="rgba(150,160,175,.7)" stroke-width="${r3(1 / pxPerMm())}"/>${renderCards()}</g>`;
  c.innerHTML = renderDefs() + page + renderGrid() +
    doc.edges.map(renderEdge).join('') +
    // One group per panel: it costs nothing here, and it means an exported SVG
    // opens in Illustrator as a figure made of panels rather than as nine
    // hundred loose paths.
    doc.nodes.map(n => `<g data-node="${n.id}">${renderNode(n)}</g>`).join('') +
    renderOverlay();
  $('#zoomLabel').textContent = Math.round(pxPerMm() / (96 / 25.4) * 100) + '%';
  syncEditor();
}

/* ================= hit testing ================= */

function hitNode(p) {
  for (let i = doc.nodes.length - 1; i >= 0; i--) {
    const b = bbox(doc.nodes[i]);
    if (p[0] >= b.x - 0.5 && p[0] <= b.x + b.w + 0.5 && p[1] >= b.y - 0.5 && p[1] <= b.y + b.h + 0.5)
      return doc.nodes[i];
  }
  return null;
}

function hitEdge(p) {
  const tol = 1.4;
  for (const e of doc.edges) {
    const g = e.kind === 'brace' ? braceGeom(e) : edgeGeom(e);
    if (!g) continue;
    if (Math.hypot(g.mid[0] - p[0], g.mid[1] - p[1]) < tol * 2) return e;
  }
  return null;
}

/* ================= interaction ================= */

/** Leave crop mode and put the panel back to showing its crop. */
/** Leave crop mode and put the cropped render back.
 *
 *  Returns a promise, because the render it asks the backend for is what the
 *  panel will be showing afterwards and an exporter has to wait for it. */
function endCrop() {
  if (mode !== 'crop') return Promise.resolve();
  const n = pending && node(pending.node);
  mode = 'select'; pending = null;
  $('#canvas').classList.remove('cropping');
  hint('');
  return (n ? refreshGelImage(n) : Promise.resolve())
    .then(() => { render(); inspector(); });
}

function setMode(m, kind) {
  mode = m; pending = kind ? { kind, from: null } : null;
  $('#canvas').classList.toggle('connecting', m === 'connect');
  $('#canvas').classList.toggle('picking', m === 'pick');
}

/** The one-line status bar.  `action` puts a button in it and stops the bar
 *  from timing out: an offer nobody saw is not an offer. */
function hint(msg, warn, action) {
  const el = $('#hint');
  clearTimeout(hint._t);
  el.textContent = msg || '';
  el.classList.toggle('show', !!msg);
  el.classList.toggle('warn', !!warn);
  if (action) {
    const b = document.createElement('button');
    b.className = 'hintact';
    b.textContent = action.label;
    b.onclick = () => { el.classList.remove('show'); action.fn(); };
    el.append(' ', b);
    // "not now", not "discard": the autosave stays where it is and is offered
    // again next time, because one stray click should not be able to throw
    // away the only copy of an evening's work.
    const x = document.createElement('button');
    x.className = 'hintact ghost';
    x.textContent = 'not now';
    x.onclick = () => { el.classList.remove('show'); if (action.dismiss) action.dismiss(); };
    el.append(' ', x);
    return;
  }
  if (msg) hint._t = setTimeout(() => el.classList.remove('show'), 5200);
}

/** Arm a click-on-the-gel picker.  kind: 'ladder' | 'band' | 'quant' */
function armPick(nodeId, kind, extra) {
  setMode('pick');
  pending = { pick: kind, node: nodeId, extra };
  const n = node(nodeId);
  const white = kind === 'ladder' && n && n.marker && n.marker.href;
  if (kind === 'quant') {
    const row = n && n.quant.rows.find(r => r.id === extra);
    hint(`Click the ${row ? row.name || 'band' : 'band'} in each lane to measure it — ` +
         `shift-click to measure it in every lane at once. Esc when done, ` +
         `then drag any box up or down to put it where you want it.`);
  } else {
    hint(kind === 'ladder'
      ? `Click each size standard band${white ? ' — this is the white-light image, where the ladder is' : ' on the gel'}. ` +
        `Type its size in the list. Esc when done.`
      : 'Click the band to annotate. Esc when done.');
  }
  render();
}

/** The white light is the layer under the signal, so hiding the signal is what
 *  shows it.  Held with H, or latched with the toolbar's tick; never stored on
 *  the panel, because looking at the membrane is not an edit of the figure. */
let peekHeld = false;
const peeking = () => peekHeld || $('#peekWhite').checked;

/** The signal back on, if it was off, so that whatever takes a copy of the
 *  canvas takes the figure.  Returns whether anything moved. */
function unpeek() {
  if (!peeking()) return false;
  peekHeld = false;
  $('#peekWhite').checked = false;
  return true;
}

/** What a gel shows, whatever its own setting: while a picker is armed on it,
 *  the white light for the ladder, since that is where the ladder is, and the
 *  signal for measuring, since that is what is measured; and otherwise the
 *  white light for as long as the luminescence is hidden. */
function viewOverride(n) {
  if (mode === 'pick' && pending && pending.node === n.id) {
    if (pending.pick === 'ladder' && n.marker && n.marker.href) return 'marker';
    if (pending.pick === 'quant') return 'signal';
  }
  if (peeking() && n.marker && n.marker.href) return 'marker';
  return null;
}

/** The lane under a point on a gel panel, allowing for the lean at that row. */
function laneAt(n, L, xmm, ypx) {
  const x = xmm - gelShift(n, L, xmm, ypx);
  return L.kept.find(l => x >= n.x + l._xmm && x <= n.x + l._xmm + l._wmm) || null;
}

/** The graph a blot is being held over, if it is one the graph has not got.
 *  Dragging the blot onto the graph is how a replicate joins it: the reading is
 *  "this blot belongs to that plot", which is the thing being said, and it beats
 *  finding the plot, opening a fold and picking the blot out of a menu by name.
 *  The ink box, not the plotting frame, so the tick and axis labels are part of
 *  the target — they are most of a small graph's area. */
function dropTarget(drag, p) {
  const moving = drag.orig.map(o => node(o.id)).filter(Boolean);
  if (moving.length !== 1 || moving[0].type !== 'gel') return null;
  const g = moving[0];
  const over = doc.nodes.filter(x => x.type === 'quant' && !x.gels.includes(g.id)).filter(x => {
    const b = inkBox(x);
    return p[0] >= b.x - 2 && p[0] <= b.x + b.w + 2 && p[1] >= b.y - 2 && p[1] <= b.y + b.h + 2;
  });
  return over.length ? over[over.length - 1].id : null;      // the topmost one
}

$('#stage').addEventListener('mousedown', ev => {
  if (ev.button === 1 || ev.altKey) {
    const start = toDoc(ev), v0 = { ...view };
    drag = { kind: 'pan', start, v0 };
    ev.preventDefault();
    return;
  }
  // Control and drag moves the panel, whatever is lying on top of it.  A gel is
  // covered edge to edge by its own grips — a hit strip per lane, a handle per
  // boundary, the crop rectangle, the strip edges — so there was nowhere on one
  // left to take hold of and the only way to move it was to find a millimeter of
  // margin.  Control goes past all of them, and past pick mode too, which is
  // when a panel most often turns out to be in the wrong place.
  if (ev.ctrlKey && (ev.button === 0 || ev.button === 2)) {
    const p = toDoc(ev), n = hitNode(p);
    if (n) {
      ev.preventDefault();
      if (!sel.has(n.id)) { sel.clear(); sel.add(n.id); }
      drag = { kind: 'move', start: p, orig: selNodes().map(x => ({ id: x.id, x: x.x, y: x.y })) };
      render(); inspector();
      return;
    }
  }
  if (ev.button !== 0) return;
  const p = toDoc(ev);

  if (mode === 'pick' && pending && pending.pick) {
    const n = node(pending.node);
    if (n && n.href) {
      const L = gelLayout(n);
      // Through the strips, if there are any: a click in the gap between two
      // is on no part of the membrane and does nothing.
      const ypx = gelYpx(n, p[1] - n.y, null, L);
      if (ypx === null || !isFinite(ypx)) return;   // never let a bad click into the document
      if (pending.pick === 'quant') { quantClick(n, pending.extra, p[0], ypx, ev.shiftKey); return; }
      mark();
      if (pending.pick === 'ladder') {
        // Which lane it was clicked in, so that two standards run on one gel can
        // be told apart — and the picture leveled by the pair of them.
        const lad = laneAt(n, L, p[0], ypx);
        n.ladder.marks.push({ kDa: 0, y: r2(ypx), label: '',
                              x: lad ? r2((lad.x0 + lad.x1) / 2) : null });
        n.ladder.marks.sort((a, b) => a.y - b.y);
        // Where the rungs were read is part of the record: a size read off the
        // white light is only as good as that image's register with the signal.
        n.ladder.from = viewOverride(n) === 'marker' ? 'white light' : 'signal';
      } else {
        const l = laneAt(n, L, p[0], ypx) || L.kept[0];
        if (l) n.bands.push({ id: uid(), lane: l.id, y: r2(ypx), label: '' });
      }
      render(); inspector();
    }
    return;
  }

  if (mode === 'connect') {
    const n = hitNode(p);
    if (!n) return;
    if (!pending.from) { pending.from = n.id; hint('Now click the target.'); return; }
    if (n.id !== pending.from) {
      mark();
      doc.edges.push(newEdge(pending.kind, pending.from, n.id));
      setMode('select'); hint(''); render(); inspector();
    }
    return;
  }

  const target = ev.target;
  if (target.dataset.edge && (target.classList.contains('bracebar') ||
      (target.classList.contains('handle') && edge(target.dataset.edge)))) {
    const e = edge(target.dataset.edge), g = braceGeom(e);
    if (e && g && g.bar) {
      drag = { kind: 'brace', e, start: p, span: g.bar.y1 - g.bar.y0,
               drop0: nn(e.drop) === null ? 0.5 : e.drop };
      return;
    }
  }
  if (target.classList.contains('crophandle') || target.classList.contains('crophit')) {
    const n = node(target.dataset.n), src = source(n.src);
    const c = n.crop || { x: 0, y: 0, w: src.w, h: src.h };
    drag = { kind: 'crop', n, src, c0: { ...c }, start: p,
             edge: target.classList.contains('crophit') ? 'move'
                   : CROP_HANDLES[+target.dataset.h].e };
    return;
  }
  if (target.classList.contains('handle')) {
    const n = node(target.dataset.n);
    drag = { kind: 'resize', n, h: +target.dataset.h, start: p, b0: bbox(n) };
    return;
  }
  if (target.classList.contains('stripedge')) {
    const owner = doc.nodes.find(n => n.type === 'gel' &&
                                      (n.strips || []).some(s => s.id === target.dataset.strip));
    if (!owner) return;
    const s = owner.strips.find(x => x.id === target.dataset.strip);
    drag = { kind: 'strip', n: owner, s, end: +target.dataset.end, start: p, y0: s.y0, y1: s.y1 };
    return;
  }
  if (target.classList.contains('lanedge')) {
    const owner = doc.nodes.find(n => n.lanes && n.lanes.some(l => l.id === target.dataset.edge));
    // A handle left over from a document that has since been replaced belongs to
    // no lane; grabbing it should do nothing rather than throw.
    if (!owner) return;
    const idx = owner.lanes.findIndex(l => l.id === target.dataset.edge);
    // Shift turns the same grip into an angle: the further from mid-height you
    // took hold, the more leverage you have, which is how a real one would work.
    // Mid-height of the *gel*, read through the strips, since a strip from the
    // bottom of the membrane is all leverage and no middle.
    const gy = gelYpx(owner, p[1] - owner.y);
    const u = gy === null || !owner.imgH ? 0 : gy / owner.imgH * 2 - 1;
    const side = (p[0] - owner.x) < (owner.w || 1) / 2 ? 'leanL' : 'leanR';
    if (ev.shiftKey && Math.abs(u) > 0.25) {
      drag = { kind: 'lean', n: owner, start: p, side, lean0: owner[side] || 0, u };
    } else if (target.dataset.end !== undefined) {
      // An outer edge moves the whole block: the lanes are uniform, so setting
      // where the row of them starts and stops sets every boundary between.
      const kept = owner.lanes.filter(l => !l.excised);
      drag = { kind: 'block', n: owner, start: p, which: +target.dataset.end,
               a0: kept[0].x0, b0: kept[kept.length - 1].x1 };
    } else {
      drag = { kind: 'lane', n: owner, idx, start: p, x0: owner.lanes[idx].x1 };
    }
    return;
  }
  // A measured box, dragged up or down its own lane.  A click searches for the
  // darkest row near it, which on a smear or a doublet is not always the band
  // meant, and until now the only way to disagree was to click again and be
  // searched again.  Vertical only: which lane a box is in is `b.lane`, and its
  // sides come from the lane, so there is nothing sideways to say.
  if (target.classList.contains('bandhit')) {
    const owner = doc.nodes.find(x => x.type === 'gel' &&
                                      x.quant.bands.some(b => b.id === target.dataset.band));
    if (!owner) return;
    const b = owner.quant.bands.find(x => x.id === target.dataset.band);
    drag = { kind: 'band', n: owner, b, start: p, y0: b.y };
    return;
  }
  if (target.classList.contains('lanehit')) {
    const owner = doc.nodes.find(n => n.lanes && n.lanes.some(l => l.id === target.dataset.lane));
    if (owner && sel.has(owner.id)) {
      inspectorFocusLane = target.dataset.lane;
      inspector();
      const el = document.querySelector(`.lane[data-lane="${inspectorFocusLane}"] input.lbl`);
      if (el) { el.focus(); el.select(); }
      return;
    }
  }

  const n = hitNode(p);
  const e = n ? null : hitEdge(p);
  const id = n ? n.id : e ? e.id : null;
  if (!id) {
    if (!ev.shiftKey) sel.clear();
    marquee = { x0: p[0], y0: p[1], x1: p[0], y1: p[1] };
    drag = { kind: 'marquee' };
    render(); inspector();
    return;
  }
  if (ev.shiftKey) sel.has(id) ? sel.delete(id) : sel.add(id);
  else if (!sel.has(id)) { sel.clear(); sel.add(id); }
  if (n) drag = { kind: 'move', start: p, orig: selNodes().map(x => ({ id: x.id, x: x.x, y: x.y })) };
  render(); inspector();
});

window.addEventListener('mousemove', ev => {
  if (!drag) return;
  const p = toDoc(ev);
  // A drag is one step, taken at the first movement that changes anything: a
  // click that only selects should not leave an empty step behind, and forty
  // mousemoves should not leave forty.
  if (!drag.marked && ['move', 'resize', 'lane', 'lean', 'block', 'brace', 'strip', 'band'].includes(drag.kind)) {
    drag.marked = true;
    mark();
  }
  if (drag.kind === 'pan') {
    view.x = drag.v0.x - (p[0] - drag.start[0]);
    view.y = drag.v0.y - (p[1] - drag.start[1]);
    render(); return;
  }
  if (drag.kind === 'marquee') {
    marquee.x1 = p[0]; marquee.y1 = p[1];
    render(); return;
  }
  if (drag.kind === 'move') {
    const dx = p[0] - drag.start[0], dy = p[1] - drag.start[1];
    drag.orig.forEach(o => { const n = node(o.id); n.x = snapv(o.x + dx); n.y = snapv(o.y + dy); });
    drag.onto = dropTarget(drag, p);
    render(); return;
  }
  if (drag.kind === 'lean') {
    const n = drag.n, L = gelLayout(n);
    if (L.s) { n[drag.side] = r2(drag.lean0 + 2 * (p[0] - drag.start[0]) / (L.s * drag.u)); n.leanManual = true; }
    render(); return;
  }
  if (drag.kind === 'block') {
    const n = drag.n, L = gelLayout(n);
    const dx = (p[0] - drag.start[0]) / (L.s || 1);
    let a = drag.a0, b = drag.b0;
    if (drag.which === 0) a = clamp(drag.a0 + dx, 0, drag.b0 - n.lanes.length * 4);
    else b = clamp(drag.b0 + dx, drag.a0 + n.lanes.length * 4, n.imgW);
    const cuts = [];
    for (let i = 0; i <= n.lanes.length; i++) cuts.push(Math.round(a + (b - a) * i / n.lanes.length));
    n.lanes.forEach((l, i) => { l.x0 = cuts[i]; l.x1 = cuts[i + 1]; });
    render(); return;
  }
  if (drag.kind === 'lane') {
    const n = drag.n, L = gelLayout(n);
    const px = drag.x0 + (p[0] - drag.start[0]) / (L.s || 1);
    const l = n.lanes[drag.idx], nx = n.lanes[drag.idx + 1];
    const lo = l.x0 + 4, hi = nx ? nx.x1 - 4 : n.imgW;
    l.x1 = Math.round(clamp(px, lo, hi));
    if (nx) nx.x0 = l.x1;
    render(); return;
  }
  if (drag.kind === 'brace') {
    const span = drag.span || 1;
    drag.e.drop = r3(clamp(drag.drop0 + (p[1] - drag.start[1]) / span, 0.05, 0.95));
    render(); return;
  }
  if (drag.kind === 'strip') {
    // In crop pixels, at the gel's own scale.  The strip's place on the panel
    // is set by the ones above it, so dragging its top edge moves where it
    // starts on the membrane rather than where it sits on the page.
    const { n, s } = drag, L = gelLayout(n);
    const d = (p[1] - drag.start[1]) / (L.s || 1);
    if (drag.end === 0) s.y0 = Math.round(clamp(drag.y0 + d, 0, s.y1 - 4));
    else s.y1 = Math.round(clamp(drag.y1 + d, s.y0 + 4, n.imgH));
    render(); return;
  }
  if (drag.kind === 'band') {
    // In crop pixels, at the gel's own scale, like every other grip on a gel.
    // The centre is kept on the picture and no further: the box itself may hang
    // off the bottom row, which `measure_bands` clips and reports as `edge`,
    // and a band sitting on the edge of the frame is a fact about the blot.
    const { n, b } = drag, L = gelLayout(n);
    b.y = r2(clamp(drag.y0 + (p[1] - drag.start[1]) / (L.s || 1), 0, n.imgH || 0));
    render(); return;
  }
  if (drag.kind === 'crop') {
    const { n, src, c0, edge } = drag;
    const s = gelCropView(n, src).s || 1;      // the scale the outline is drawn at
    const dx = (p[0] - drag.start[0]) / s, dy = (p[1] - drag.start[1]) / s;   // in source px
    const MIN = 16;
    let { x, y, w, h } = c0;
    if (edge === 'move') {
      x = clamp(c0.x + dx, 0, src.w - c0.w);
      y = clamp(c0.y + dy, 0, src.h - c0.h);
    } else {
      if (edge.includes('l')) { const nx = clamp(c0.x + dx, 0, c0.x + c0.w - MIN); w = c0.x + c0.w - nx; x = nx; }
      if (edge.includes('r')) { w = clamp(c0.w + dx, MIN, src.w - c0.x); }
      if (edge.includes('t')) { const ny = clamp(c0.y + dy, 0, c0.y + c0.h - MIN); h = c0.y + c0.h - ny; y = ny; }
      if (edge.includes('b')) { h = clamp(c0.h + dy, MIN, src.h - c0.y); }
    }
    n.crop = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
    render(); return;
  }
  if (drag.kind === 'resize') {
    const n = drag.n, b = drag.b0;
    const dx = p[0] - drag.start[0], dy = p[1] - drag.start[1];
    if (n.type === 'gel') {
      // Uniform only.  Stretching a gel horizontally changes every apparent
      // mobility in it, so the height is the handle and the width follows.
      const H = Math.max(6, snapv(drag.h < 2 ? b.h - dy : b.h + dy));
      gelSetDrawnH(n, H);
      if (drag.h === 0 || drag.h === 1) n.y = snapv(b.y + (b.h - gelDrawnH(n)));
    } else {
      const right = drag.h === 1 || drag.h === 3, bottom = drag.h >= 2;
      let w = right ? b.w + dx : b.w - dx, h = bottom ? b.h + dy : b.h - dy;
      w = Math.max(4, snapv(w)); h = Math.max(3, snapv(h));
      n.w = w; n.h = h;
      if (!right) n.x = snapv(b.x + b.w - w);
      if (!bottom) n.y = snapv(b.y + b.h - h);
    }
    render(); return;
  }
});

window.addEventListener('mouseup', () => {
  // Only finish something that was actually started.  This fires for every
  // release anywhere in the window, and rebuilding the inspector on one takes
  // the control being clicked out of the document with it — a native select
  // popup dies the instant its element is replaced, which is why the column
  // menu opened and blinked shut again.
  if (!drag && !marquee) return;

  if (drag && drag.kind === 'marquee' && marquee) {
    const x0 = Math.min(marquee.x0, marquee.x1), x1 = Math.max(marquee.x0, marquee.x1);
    const y0 = Math.min(marquee.y0, marquee.y1), y1 = Math.max(marquee.y0, marquee.y1);
    if (Math.abs(x1 - x0) > 0.6 || Math.abs(y1 - y0) > 0.6)
      doc.nodes.forEach(n => {
        const b = bbox(n);
        if (b.x >= x0 && b.x + b.w <= x1 && b.y >= y0 && b.y + b.h <= y1) sel.add(n.id);
      });
  }
  // Dropped on a graph: the blot joins it as a replicate and goes back where it
  // was.  It has to go back — a blot left lying on the graph covers the thing it
  // was just added to, and the gesture meant "this belongs there", not "put it
  // there".  One undo takes back both, the drag having marked a step already.
  if (drag && drag.kind === 'move' && drag.onto) {
    const q = node(drag.onto), g = node(drag.orig[0].id);
    if (q && g) {
      if (!drag.marked) mark();
      drag.orig.forEach(o => { const n = node(o.id); n.x = o.x; n.y = o.y; });
      q.gels.push(g.id);
      sel = new Set([q.id]);
      hint(`${repName(g, q.gels.length - 1)} is replicate ${q.gels.length} of this quantification. ` +
           `⌘Z takes it back out.`);
    }
  }
  // A band's box follows its lane, so moving a boundary or the lean moves the
  // boxes too, and what is in them has to be measured again.
  if (drag && drag.marked && ['lane', 'lean', 'block'].includes(drag.kind)) {
    refreshLaneDensitometry(drag.n);
    quantRemeasure(drag.n);
  }
  // Where it was put, not where a search would put it: being dragged is the
  // whole point.  `quantRemeasure` measures every box on the blot in place,
  // which is one request and saves saying it twice.
  if (drag && drag.marked && drag.kind === 'band') quantRemeasure(drag.n);
  // The crop is followed live on the preview, which costs nothing; the panel
  // itself is re-rendered from the original array once, when you let go.
  if (drag && drag.kind === 'crop') refreshGelImage(drag.n).then(() => { render(); inspector(); });
  marquee = null; drag = null;
  render(); inspector();
});

// Control-click is also how a Mac asks for a context menu, which would come up
// over the panel being dragged.
$('#stage').addEventListener('contextmenu', ev => { if (ev.ctrlKey) ev.preventDefault(); });

$('#stage').addEventListener('wheel', ev => {
  ev.preventDefault();
  if (!(ev.ctrlKey || ev.metaKey)) {        // two-finger pan; pinch/ctrl zooms
    const vw = $('#stage').clientWidth || 1, u = view.w / vw;
    view.x += ev.deltaX * u; view.y += ev.deltaY * u;
    render();
    return;
  }
  const p = toDoc(ev);
  const k = Math.exp(ev.deltaY * 0.0022);
  const w = clamp(view.w * k, 8, doc.page.w * 8);
  const s = w / view.w;
  view.x = p[0] - (p[0] - view.x) * s;
  view.y = p[1] - (p[1] - view.y) * s;
  view.w = w; view.h = view.h * s;
  render();
}, { passive: false });

$('#stage').addEventListener('dblclick', ev => {
  const n = hitNode(toDoc(ev));
  if (n && (n.type === 'box' || n.type === 'text' || n.type === 'panel')) beginEdit(n.id);
});

/* ---- inline editor ---- */

const editorEl = document.createElement('textarea');
editorEl.id = 'editor';
$('#stage').appendChild(editorEl);

function beginEdit(id) {
  editing = id;
  const n = node(id);
  editorEl.value = n.text || '';
  editorEl.style.display = 'block';
  syncEditor();
  editorEl.focus(); editorEl.select();
}
function endEdit() {
  if (!editing) return;
  const n = node(editing);
  if (n && n.text !== editorEl.value) { mark(); n.text = editorEl.value; }
  editing = null;
  editorEl.style.display = 'none';
  render(); inspector();
}
editorEl.addEventListener('blur', endEdit);
editorEl.addEventListener('keydown', ev => {
  if (ev.key === 'Escape') { editing = null; editorEl.style.display = 'none'; render(); }
  if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) endEdit();
  ev.stopPropagation();
});
function syncEditor() {
  if (!editing) return;
  const n = node(editing);
  if (!n) { editorEl.style.display = 'none'; editing = null; return; }
  const m = canvasCTM();
  if (!m) return;
  const k = m.a;
  const r = $('#canvas').getBoundingClientRect();
  // Through the same transform as the text it sits on top of, letterbox margin
  // and all, or the box is beside the words it is editing.
  const sx = n.x * k + m.e - r.left, sy = n.y * m.d + m.f - r.top;
  editorEl.style.left = sx + 'px';
  editorEl.style.top = sy + 'px';
  editorEl.style.width = (n.w * k) + 'px';
  editorEl.style.height = (n.h * k) + 'px';
  editorEl.style.fontSize = (n.fontPt * PT * k) + 'px';
  editorEl.style.fontWeight = n.bold ? '600' : '400';
}

/* ---- keys ---- */

window.addEventListener('keydown', ev => {
  if (ev.target.matches('input, textarea, select')) return;
  const meta = ev.metaKey || ev.ctrlKey;
  if (meta && ev.key.toLowerCase() === 'z') {
    ev.preventDefault(); ev.shiftKey ? redo() : undo(); return;
  }
  if (meta && ev.key.toLowerCase() === 'y') { ev.preventDefault(); redo(); return; }
  if (meta && ev.key.toLowerCase() === 's') { ev.preventDefault(); saveSession(ev.shiftKey); return; }
  if (meta && ev.key.toLowerCase() === 'o') { ev.preventDefault(); openSession(); return; }
  if (meta && ev.key.toLowerCase() === 'd') { ev.preventDefault(); mark(); duplicate(); return; }
  if (meta && ev.key.toLowerCase() === 'a') {
    ev.preventDefault(); doc.nodes.forEach(n => sel.add(n.id)); render(); inspector(); return;
  }
  if (ev.key === 'Escape') {
    if (mode === 'crop') { const was = pending.node; endCrop(); undo(); sel = new Set([was]); render(); inspector(); return; }
    setMode('select'); hint(''); render(); return;
  }
  if (ev.key === 'Enter' && mode === 'crop') { ev.preventDefault(); endCrop(); return; }
  if (ev.key === 'Delete' || ev.key === 'Backspace') {
    ev.preventDefault();
    if (!sel.size) return;
    mark();
    doc.nodes = doc.nodes.filter(n => !sel.has(n.id));
    doc.edges = doc.edges.filter(e => !sel.has(e.id) && node(e.from) && node(e.to));
    sel.clear(); render(); inspector(); return;
  }
  const add = { g: 'gel', w: 'blot', c: 'chrom', p: 'table', d: 'nanodrop', q: 'quant',
                s: 'construct', n: 'box', t: 'text', a: 'panel' }[ev.key];
  if (add) { addNode(add); return; }
  const conn = { 1: 'arrow', 2: 'elbow', 3: 'brace' }[ev.key];
  if (conn) { setMode('connect', conn); hint('Click the source panel, then the target.'); return; }
  if (ev.key === '0') { fitView(); render(); }
  // Held, so it reads as one look rather than a setting: let go and the signal
  // is back.  The tick in the toolbar is the same thing kept on.
  if (ev.key === 'h' && !peekHeld) { peekHeld = true; render(); }
});

window.addEventListener('keyup', ev => {
  if (ev.key === 'h' && peekHeld) { peekHeld = false; render(); }
});

function addNode(type, at, opts = {}) {
  if (opts.mark !== false) mark();
  const x = at ? at[0] : view.x + view.w * 0.22;
  const y = at ? at[1] : view.y + view.h * 0.22;
  const n = newNode(type, snapv(x), snapv(y));
  doc.nodes.push(n);
  sel = new Set([n.id]);
  render(); inspector();
  return n;
}

/** A standalone copy of a panel.  Everything that names a lane has to name the
 *  copy's lane, or the copy's band labels and measured boxes point back into
 *  the original and follow it when it is edited. */
function copyNode(n) {
  const c = { ...JSON.parse(JSON.stringify(n)), id: uid() };
  if (!c.lanes) return c;
  const map = {};
  c.lanes = c.lanes.map(l => { const id = uid(); map[l.id] = id; return { ...l, id }; });
  (c.bands || []).forEach(b => { b.id = uid(); b.lane = map[b.lane] || b.lane; });
  if (c.quant) c.quant.bands.forEach(b => { b.id = uid(); b.lane = map[b.lane] || b.lane; });
  (c.strips || []).forEach(s => { s.id = uid(); });
  return c;
}

function duplicate() {
  const copies = selNodes().map(n => ({ ...copyNode(n), x: r2(n.x + 4), y: r2(n.y + 4) }));
  doc.nodes.push(...copies);
  sel = new Set(copies.map(c => c.id));
  render(); inspector();
}

/* ================= the supplementary sheet ================= */

/*  The figure and the sheet of whole blots that goes with it are two canvases
 *  in one document.  Rather than teach the renderer, the inspector, the export,
 *  the alignment, the pasteboard and the undo stack about a second page, the two
 *  swap places: `doc.nodes`, `doc.edges` and `doc.page` are always whichever
 *  canvas is showing and the other waits in `doc.other`, so everything that
 *  reads the document keeps working and exports what is in front of you.
 *
 *  `doc.sources` is not swapped.  Both canvases draw the same scans, and a
 *  supplementary blot pointing at its own copy of an image would be a second
 *  copy of the evidence, free to drift away from the first.
 */

function showSheet(which) {
  if (which === doc.sheet) return;
  const keep = { page: doc.page, nodes: doc.nodes, edges: doc.edges, view: { ...view } };
  const o = doc.other || { page: { ...doc.page }, nodes: [], edges: [], view: null };
  doc.page = o.page; doc.nodes = o.nodes; doc.edges = o.edges;
  doc.other = keep;
  doc.sheet = which;
  sel = new Set();
  pending = null; mode = 'select';
  if (o.view) view = o.view; else fitView();
  syncSheetUi();
  render(); inspector();
}

function syncSheetUi() {
  const b = $('#sheet');
  if (b) {
    b.textContent = doc.sheet === 'supp' ? 'supplementary' : 'figure';
    b.classList.toggle('primary', doc.sheet === 'supp');
    b.title = doc.sheet === 'supp'
      ? 'Showing the supplementary sheet of whole blots — click for the figure'
      : 'Showing the figure — click for the supplementary sheet of whole blots';
  }
  syncPage();
}

/** A panel that shows less of its scan than there is: cropped, or with lanes
 *  cut out of it, or showing only a window of kilodaltons.  Those are the ones
 *  a journal wants the whole of. */
function gelIsCut(n) {
  const s = source(n.src);
  if (!s) return false;
  const c = n.crop;
  return (!!c && (c.w < s.w - 1 || c.h < s.h - 1)) ||
         n.lanes.some(l => l.excised) || (n.strips || []).length > 0;
}

/** The membrane pieces in a panel's white light, in the signal picture's own
 *  pixels — the same finder `split membranes` uses, asked of the same picture.
 *  One imager field holds every blot on the tray, so `seen` asks once per scan. */
async function membranesOf(n, seen) {
  const m = n.marker && source(n.marker.src);
  if (!m || !m.server || !backend.ok) return null;
  if (!seen.has(m.id)) {
    const k = n.marker.k || 1;
    seen.set(m.id, api('/api/image/membranes', { path: m.path })
      .then(r => r.pieces.map(p => ({ sheet: p.sheet, x: p.x / k, y: p.y / k,
                                      w: p.w / k, h: p.h / k })))
      .catch(() => null));
  }
  return seen.get(m.id);
}

/** Build the supplementary sheet from the figure: one whole-blot panel per
 *  cropped gel, processed exactly as the figure's is.
 *
 *  The twin is the figure's panel with the crop taken off, so it inherits the
 *  levels, the γ, the quarter turns and the fine angle without any of them
 *  being restated -- and `refreshGelImage` carries the lanes, their labels, the
 *  rungs and the band labels back onto the whole frame through the same
 *  arithmetic that moves them when a crop is dragged.  What the figure hid comes
 *  back: lanes cut out of it are put back in, a strip becomes the whole
 *  membrane again, and the picture is drawn to its own edges rather than to the
 *  block of lanes on it.  A blot with a white light shows its marker lanes from
 *  that picture, since the point of the sheet is to show the standards running
 *  beside the bands.
 */
async function buildSupplementary() {
  if (doc.sheet !== 'figure') return hint('Switch to the figure first — the sheet is built from it.', true);
  const cut = figurePanels().filter(n => n.type === 'gel' && n.src && gelIsCut(n));
  if (!cut.length) return hint('No cropped gel or blot panels in the figure, so there is nothing ' +
                               'to show the whole of.', true);
  const letters = new Map(figurePanels().map((n, i) => [n.id, panelLetter(i)]));
  mark();
  const W = doc.page.w - 28, gap = 8;
  const made = [];
  const seen = new Map();
  let whole = 0;
  let y = 18;
  for (const n of cut) {
    const src = source(n.src);
    const t = copyNode(n);
    t.geom = (n.geom && n.geom.src === src.id) ? n.geom : gelGeom(n, src);
    // The whole *membrane*, not the whole field of view: one imager picture
    // holds the whole tray, and eight blots each shown with the other seven
    // beside it is not what an uncropped blot means.  Only a picture with no
    // white light, or one where nothing stands out from the tray, falls back to
    // the whole frame.
    const c0 = n.crop || { x: 0, y: 0, w: src.w, h: src.h };
    t.crop = membraneFor(await membranesOf(n, seen), c0);
    if (!t.crop) whole++;
    const t0 = t.crop || { x: 0, y: 0, w: src.w, h: src.h };
    // A panel cut down by its lanes or its strips rather than by its crop is
    // already the whole membrane, and an outline round it would only retrace
    // the panel's own border.
    t.showCrop = c0.x > t0.x + 1 || c0.y > t0.y + 1 ||
                 c0.x + c0.w < t0.x + t0.w - 1 || c0.y + c0.h < t0.y + t0.h - 1;
    t.strips = [];
    t.lanes.forEach(l => { l.excised = false; });
    t.showAll = true;
    // Whole membranes are drawn to the page's width, not to their lanes: this
    // sheet is there to show everything that was on the film, at whatever size
    // that takes.  The sheets keep their own `page`, but a figure panel's own
    // `laneMm` would be copied with it, so it is cleared here as well.
    t.laneMm = 0;
    t.cropBox = null;
    if (t.marker && t.marker.src) t.view = 'ladder';
    t.title = `(${letters.get(n.id)}) ${n.title || n.kind}`.trim();
    try {
      await refreshGelImage(t);
    } catch (err) {
      hint(`${t.title}: ${err.message}`, true);
      continue;
    }
    // The region the figure shows, on the membrane: the crop's four corners on
    // the scan, put back into this panel's own pixels.  Strips cut the figure
    // panel down to its band rows without touching its crop, so the rows are
    // what it shows and the crop is only where they are measured from -- an
    // outline round the whole crop would claim a strip of membrane the figure
    // never prints.  First row to last, which is the one box a run of strips
    // has; the gaps between them are the panel's own, not the membrane's.
    const fr = gelRows(n), cy0 = c0.y + fr[0].y0, cy1 = c0.y + fr[fr.length - 1].y1;
    t.cropBox = [[c0.x, cy0], [c0.x + c0.w, cy0],
                 [c0.x + c0.w, cy1], [c0.x, cy1]]
      .map(([x, y2]) => fromScan(t.geom, x, y2).map(r2));
    t.h = r2(W / (t.imgW || 1) * (t.imgH || 1));
    // The membrane is wider than the piece of it the figure showed, so the lanes
    // sit closer together here than they did there: slant labels that no longer
    // fit between them rather than printing them over one another.
    // Each label against its own lane: one badly fitted narrow lane with `A` in
    // it is not a reason to slant a row where everything else fits.
    if (t.lanes.some(l => l.label &&
                     textWmm(l.label, t.labelPt) > (l.x1 - l.x0) * t.h / (t.imgH || 1)))
      t.labelAngle = 60;
    t.x = 14; t.y = 0;
    const k = inkBox(t);          // the title, and a slanted label, hang above t.y
    t.y = r2(y - k.y);
    y += k.h + gap;
    made.push(t);
  }
  if (!made.length) return unmark();
  const count = made.length;               // counted before the heading joins them
  const page = { w: doc.page.w, h: Math.max(doc.page.h, Math.ceil(y + 10)) };
  doc.other = { page, nodes: [], edges: [], view: null };
  showSheet('supp');
  doc.page = page;
  doc.nodes = made;
  doc.nodes.unshift({
    ...newNode('text', 14, 8), w: W, h: 6, align: 'start',
    text: (doc.meta.title ? `Supplementary to ${doc.meta.title}. ` : 'Supplementary. ') +
          'Whole membranes, processed as in the figure' +
          (made.some(t => t.view === 'ladder') ? ', with the size marker lanes in white light' : '') +
          (made.some(t => t.showCrop) ? '; the region the figure uses is outlined.' : '.'),
  });
  fitView();
  render(); inspector();
  hint(`${count} whole blot${count === 1 ? '' : 's'} on the supplementary sheet` +
       (whole ? `, ${whole} of them the whole picture because no membrane stood out from the tray` : '') +
       `. The button in the toolbar switches back to the figure.`);
}

/* ================= aligning ================= */

/** Line panels up against each other.
 *
 *  Two references, because a panel has two edges and figures want both.
 *
 *  `frame` is the straight element — a chromatogram's axis spines, a gel's
 *  border, a table's rules.  It is the edge a reader sees, and lining it up is
 *  what makes a column of panels look like a column: the y-axis of the trace
 *  directly over the left edge of the gel below it, regardless of how wide the
 *  tick numbers happen to be.
 *
 *  `ink` is everything drawn, furniture included.  That is the one to use when
 *  a panel has to fit a column of a given width, or clear its neighbor, since
 *  what overhangs is exactly what collides.
 *
 *  Either way the target is the outermost panel in the selection — align left
 *  goes to the leftmost, align bottom to the bottommost — and centering uses the
 *  middle of what the selection spans.  Every box is a plain translation of the
 *  panel's own x and y, so a single offset moves it exactly. */

const ALIGN_EDGES = {
  left:    ['x', b => b.x,           'min'],
  hcentre: ['x', b => b.x + b.w / 2, 'mid'],
  right:   ['x', b => b.x + b.w,     'max'],
  top:     ['y', b => b.y,           'min'],
  vcentre: ['y', b => b.y + b.h / 2, 'mid'],
  bottom:  ['y', b => b.y + b.h,     'max'],
};

let alignRef = 'frame';                  // frame | ink

const panelBox = n => (alignRef === 'ink' ? inkBox(n) : frameBox(n));

function alignSelection(which) {
  const ns = selNodes();
  const [axis, at, pick] = ALIGN_EDGES[which] || [];
  if (!axis) return unmark();
  if (ns.length < 2) { hint('Select two or more panels to line up.', true); return unmark(); }

  // Boxes are read before anything moves: aligning to a target that shifts
  // under the first panel moved is how "align left" ends up as a staircase.
  const boxes = ns.map(panelBox);
  let target;
  if (pick === 'mid') {
    const lo = Math.min(...boxes.map(b => (axis === 'x' ? b.x : b.y)));
    const hi = Math.max(...boxes.map(b => (axis === 'x' ? b.x + b.w : b.y + b.h)));
    target = (lo + hi) / 2;
  } else {
    const vs = boxes.map(at);
    target = pick === 'min' ? Math.min(...vs) : Math.max(...vs);
  }

  let moved = 0;
  ns.forEach((n, i) => {
    const d = target - at(boxes[i]);
    if (Math.abs(d) < 0.005) return;
    n[axis] = r2(n[axis] + d);
    moved++;
  });
  render(); inspector();
  if (!moved) { hint('Already lined up.'); return unmark(); }
  const said = { left: 'left edges', right: 'right edges', top: 'top edges',
                 bottom: 'bottom edges', hcentre: 'centres', vcentre: 'middles' }[which];
  hint(`${said} lined up — ${moved} panel${moved === 1 ? '' : 's'} moved, ` +
       `by ${alignRef === 'ink' ? 'everything drawn' : 'the straight element'}.`);
}

/* ================= backend ================= */

async function api(url, body) {
  const r = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({ error: r.statusText }));
  if (!r.ok || j.error) throw new Error(j.error || r.statusText);
  return j;
}

async function pingBackend() {
  const dot = $('#backend');
  try {
    const h = await api('/api/health');
    backend = { ok: true, ...h };
    dot.className = 'dot up';
    dot.title = `backend up — tifffile ${h.tifffile || 'missing'}, pillow ${h.pillow || 'missing'}`;
  } catch {
    backend = { ok: false };
    dot.className = 'dot down';
    dot.title = 'backend not reachable — PNG/JPEG only, no 16-bit TIFF, no densitometry';
  }
}

/* ================= images ================= */

/** Load a file the server can see: full bit depth, real statistics. */
async function openSourceByPath(path, kind) {
  const info = await api('/api/image/open', { path });
  const src = {
    id: uid(), name: info.name, path, kind: kind || 'gel',
    w: info.w, h: info.h, bits: info.bits, note: info.note,
    preview: info.preview, hist: info.hist,
    rangeLo: info.rangeLo, rangeHi: info.rangeHi,
    dataLo: info.min, dataHi: info.max,
    p01: info.p01, p999: info.p999, saturatedFraction: info.saturatedFraction,
    darkBands: info.darkBands, suggest: info.suggest,
    membraneId: '', server: true,
  };
  doc.sources.push(src);
  return src;
}

/** A dropped PNG/JPEG.  8-bit by definition, and leveled in the browser. */
function openSourceFromFile(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        const px = ctx.getImageData(0, 0, c.width, c.height).data;
        const hist = new Array(256).fill(0);
        let n = 0;
        for (let i = 0; i < px.length; i += 4) {
          const v = Math.round(0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]);
          hist[v]++; n++;
        }
        let mode = 0;
        hist.forEach((c, i) => { if (c > hist[mode]) mode = i; });
        const src = {
          id: uid(), name: file.name, path: null, kind: 'gel',
          w: c.width, h: c.height, bits: 8, note: 'loaded in the browser (8-bit)',
          preview: fr.result, hist, rangeLo: 0, rangeHi: 255,
          p01: 0, p999: 255, saturatedFraction: 0,
          darkBands: mode > 128, membraneId: '', server: false,
          dataLo: 0, dataHi: 255,
          suggest: { black: 0, white: 255, gamma: 1, invert: mode <= 128 },
        };
        doc.sources.push(src);
        resolve(src);
      };
      img.onerror = () => reject(new Error('could not decode that image'));
      img.src = fr.result;
    };
    fr.onerror = () => reject(new Error('could not read that file'));
    fr.readAsDataURL(file);
  });
}

/* ---- where a panel's picture sits on its scan ---- */

/** The crop and the turn and flips a panel's picture was made with, recorded
 *  at every render so the next one can tell what moved. */
function gelGeom(n, src) {
  const c = n.crop || { x: 0, y: 0, w: src.w, h: src.h };
  return { src: src.id, x: c.x, y: c.y, w: c.w, h: c.h,
           rotate: (((n.rotate || 0) % 360) + 360) % 360, tilt: r2(n.tilt || 0),
           flipH: !!n.flipH, flipV: !!n.flipV };
}
const picW = g => ((g.rotate / 90) % 2 ? g.h : g.w);
const picH = g => ((g.rotate / 90) % 2 ? g.w : g.h);

/** A point turned clockwise about the middle of the crop: the fine angle, which
 *  is applied in place, so the frame keeps the crop's own width and height. */
function spin(x, y, cx, cy, deg) {
  const a = deg * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a), dx = x - cx, dy = y - cy;
  return [cx + dx * c - dy * sn, cy + dx * sn + dy * c];
}

/** Put a new panel beside the one it came from and on top of nothing.  A graph
 *  drawn over the blot it measures has to be dragged off it before either can be
 *  read, and the old placement — right of the blot, then clamped onto the page —
 *  landed squarely on it whenever the blot was wide or near the right margin.
 *  Right of it first, then left, then under, then over, then anywhere on the
 *  page: the pasteboard is not an option, because a panel there is left out of
 *  the export.  Ink boxes, not frames, since a graph's tick and axis labels hang
 *  outside its plotting area and are most of what collides.  False if nothing
 *  fits, and the caller says so rather than pretending. */
function placeClear(q, near, gap = 5) {
  const page = doc.page, m = 5;
  q.x = 0; q.y = 0;
  // Layout is translation-invariant, so one ink box at the origin gives the
  // offset and size at every position, and the search is arithmetic.
  const k0 = inkBox(q), b = inkBox(near);
  const others = doc.nodes.filter(x => x !== q && !offPage(x)).map(inkBox);
  const fits = (X, Y) => {
    const k = { x: X + k0.x, y: Y + k0.y, w: k0.w, h: k0.h };
    return k.x >= m && k.y >= m && k.x + k.w <= page.w - m && k.y + k.h <= page.h - m &&
           !others.some(o => k.x < o.x + o.w + gap && o.x < k.x + k.w + gap &&
                             k.y < o.y + o.h + gap && o.y < k.y + k.h + gap);
  };
  const put = (X, Y) => { q.x = r2(X); q.y = r2(Y); return true; };
  // Where the ink would have to start, for the ink to land where it is wanted.
  const ink = { l: X => X - k0.x, t: Y => Y - k0.y };
  const tries = [
    [ink.l(b.x + b.w + gap), ink.t(b.y)],                  // right of it, tops level
    [ink.l(b.x - gap - k0.w), ink.t(b.y)],                 // left of it
    [ink.l(b.x), ink.t(b.y + b.h + gap)],                  // under it
    [ink.l(b.x), ink.t(b.y - gap - k0.h)],                 // over it
  ];
  for (const [X, Y] of tries) if (fits(X, Y)) return put(X, Y);
  for (let Y = m; Y + k0.h <= page.h - m; Y += 4)
    for (let X = m; X + k0.w <= page.w - m; X += 4)
      if (fits(ink.l(X), ink.t(Y))) return put(ink.l(X), ink.t(Y));
  put(clamp(ink.l(b.x + b.w + gap), ink.l(m), ink.l(page.w - m - k0.w)),
      clamp(ink.t(b.y), ink.t(m), ink.t(page.h - m - k0.h)));
  return false;
}

/** A point in a panel's picture — crop pixels, after turning and flipping — on
 *  the scan it came from.  The picture is made by cropping, then turning
 *  clockwise a quarter at a time, then flipping, so this undoes them in the
 *  opposite order. */
function toScan(g, x, y) {
  let w = picW(g), h = picH(g);
  if (g.flipH) x = w - x;
  if (g.flipV) y = h - y;
  for (let i = 0; i < (g.rotate / 90) % 4; i++) {
    [x, y] = [y, w - x];                 // one clockwise quarter, undone
    [w, h] = [h, w];
  }
  if (g.tilt) [x, y] = spin(x, y, g.w / 2, g.h / 2, -g.tilt);
  return [x + g.x, y + g.y];
}

/** A point on the scan, in a panel's picture. */
function fromScan(g, x, y) {
  x -= g.x; y -= g.y;
  if (g.tilt) [x, y] = spin(x, y, g.w / 2, g.h / 2, g.tilt);
  let w = g.w, h = g.h;
  for (let i = 0; i < (g.rotate / 90) % 4; i++) {
    [x, y] = [h - y, x];                 // one clockwise quarter
    [w, h] = [h, w];
  }
  if (g.flipH) x = w - x;
  if (g.flipV) y = h - y;
  return [x, y];
}

/** Keep what was placed on a panel's picture on the same part of the scan
 *  when the crop moves.
 *
 *  Lanes, rungs, labeled bands, measured boxes and strips are all held in the
 *  crop's own pixels, so a crop that starts forty rows lower leaves every one
 *  of them forty rows out — silently, on a figure that still looks plausible.
 *  They are moved back onto the part of the scan they were placed on.  The
 *  lanes are held at mid-height and lean, so a crop that changes height moves
 *  mid-height along the lean too, and the lean itself, being pixels across
 *  the height, is rescaled to keep the slope the gel actually has.
 *
 *  A turn or a flip is a different picture, with every lane running another
 *  way; that is reported rather than guessed at.  Returns what happened. */
function regeom(n, a, b) {
  if (!['rotate', 'flipH', 'flipV'].every(k => a[k] === b[k])) return 'turned';
  // The fine angle compared against nought, not against nothing: a panel
  // rendered before there was one has no `tilt` in its record, and reading that
  // as a change would clear every rung and box on the next contrast tweak.
  if ((a.tilt || 0) !== (b.tilt || 0)) {
    // A rigid turn of the same frame about its middle, so a rung that knows
    // which lane it is in turns with the band it was clicked on and is kept.
    // Which matters: leveling by two ladders is *done* with rungs, and
    // clearing them made the button destroy its own input.  Nothing else
    // recorded has an x to turn it by — a band label and a measured box are a
    // row in a lane, a strip is a horizontal band of the whole picture — and
    // after the turn none of those rows is horizontal any more.
    const H = picH(b);
    n.ladder.marks = n.ladder.marks.filter(m => {
      if (m.x == null) return false;
      const [x, y] = fromScan(b, ...toScan(a, m.x, m.y));
      m.x = r2(x); m.y = r2(y);
      return y >= 0 && y <= H;             // a rung turned out of frame is gone
    });
    return 'spun';
  }
  const [dx, dy] = fromScan(b, ...toScan(a, 0, 0));
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9 && a.w === b.w && a.h === b.h) return 'same';
  const Ha = picH(a) || 1, Hb = picH(b), Wb = picW(b);
  gelKeepScale(n, Ha, Hb, dy);
  // Worked out for every lane before any of them moves: the lean at a lane
  // depends on where the block of lanes is.
  const at = n.lanes.map(l => [l.x0, l.x1].map(x => x + dx + gelLeanAt(n, x) / Ha * (Hb / 2 - Ha / 2 - dy)));
  n.lanes.forEach((l, i) => {
    const [x0, x1] = at[i];
    l.x0 = Math.round(clamp(x0, 0, Wb - 2));
    l.x1 = Math.round(clamp(Math.max(x1, x0 + 2), l.x0 + 2, Wb));
  });
  n.leanL = r2((n.leanL || 0) * Hb / Ha);
  n.leanR = r2((n.leanR || 0) * Hb / Ha);
  n.ladder.marks.forEach(m => { m.y = r2(m.y + dy); });
  n.bands.forEach(x => { x.y = r2(x.y + dy); });
  n.quant.bands.forEach(x => { x.y = r2(x.y + dy); });
  n.strips.forEach(s => {
    s.y0 = r2(clamp(s.y0 + dy, 0, Hb - 4));
    s.y1 = r2(clamp(s.y1 + dy, s.y0 + 4, Hb));
  });
  return 'moved';
}

/** Render a gel node's crop at its current levels.  Server if it can, canvas
 *  if it must; either way the numbers in `levels` are the record. */
async function refreshGelImage(n) {
  const src = source(n.src);
  if (!src) return;
  const crop = n.crop || { x: 0, y: 0, w: src.w, h: src.h };
  const was = n.geom || null, now = gelGeom(n, src), before = [n.imgW, n.imgH];
  const had0 = n.ladder.marks.length;   // counted before regeom turns any of them
  if (src.server && backend.ok) {
    const r = await api('/api/image/render', {
      // No cap: the panel embeds the crop at the resolution it was scanned at.
      // A gel is evidence, and a resample is a quiet edit of it — the bands get
      // an interpolation kernel run over them that nothing afterwards records.
      // It also put the *worse* picture in the better path: a dropped PNG has
      // always gone in at full crop resolution in the browser, so only 16-bit
      // TIFFs off disk were losing anything.  What it costs is figure size,
      // which is visible; what it cost was print resolution, which was not.
      path: src.path, crop, rotate: n.rotate, tilt: n.tilt, flipH: n.flipH, flipV: n.flipV,
      levels: n.levels, maxPx: 0,
    });
    n.href = r.png; n.imgW = r.w; n.imgH = r.h;
    n.clip = { low: r.clippedLow, high: r.clippedHigh, linear: r.linear };
  } else {
    const r = await clientRender(src, n, crop, n.levels);
    n.href = r.png; n.imgW = r.w; n.imgH = r.h;
    n.clip = r.clip;
  }
  let moved = null;
  if (!n.lanes.length) await autoLanes(n, 10);
  else if (was && was.src === now.src) moved = regeom(n, was, now);
  // A panel from before positions were tracked: unchanged size means an
  // unchanged picture, which is the common case — a contrast change — and the
  // one where stretching the lanes to the full width would undo a block the
  // user had dragged into place.
  else if (!was && before[0] === n.imgW && before[1] === n.imgH) moved = 'same';
  else rescaleLanes(n);                  // a different scan: keep the layout, fit it to the width
  n.geom = now;
  if (moved === 'turned' || moved === 'spun') {
    // Every lane now runs another way: find them again, and clear what was
    // read off the old picture rather than leave it pointing at nothing.  A
    // fine angle keeps the rungs, which regeom has already turned with it.
    const lost = moved === 'spun' ? had0 - n.ladder.marks.length : n.ladder.marks.length;
    const had = lost + n.bands.length + n.quant.bands.length + n.strips.length;
    if (moved === 'turned') n.ladder.marks = [];
    n.bands = []; n.quant.bands = []; n.strips = [];
    n.quant.rows.forEach(r => { r.h = null; });
    n.leanManual = false;
    await autoLanes(n, n.lanes.length || 10);
    if (had) hint(moved === 'spun'
      ? `Turning the picture moved the rungs with it and the lanes were found again; the band labels, ` +
        `strips and measurements were cleared${lost ? `, as were ${lost} rung${lost > 1 ? "s" : ""} with no lane recorded` : ''}. ` +
        `⌘Z puts them back.`
      : 'Turning the picture changed which way the lanes run, so they were found again ' +
        'and the ladder, band labels, strips and measurements were cleared. ⌘Z puts them back.', true);
  }
  n.fit = gelFit(n);
  await refreshMarker(n);
  await refreshMerge(n);
  if (moved === 'moved' && n.quant.bands.length) await quantRemeasure(n);
}

/** The white-light picture, cut and turned exactly as the signal is.  It was
 *  taken in the same frame — at `k` times the signal's size, when the signal
 *  was binned — so the signal's crop scaled by `k` is the same region of the
 *  membrane.  Rendered at its own full resolution, like the signal. */
function markerCrop(n) {
  const sig = source(n.src), k = (n.marker && n.marker.k) || 1;
  const c = n.crop || { x: 0, y: 0, w: sig.w, h: sig.h };
  return { x: c.x * k, y: c.y * k, w: c.w * k, h: c.h * k };
}

async function refreshMarker(n) {
  const m = n.marker, src = m && source(m.src);
  if (!src || !source(n.src)) return;
  if (src.server && backend.ok) {
    const r = await api('/api/image/render', {
      path: src.path, crop: markerCrop(n), rotate: n.rotate, tilt: n.tilt, flipH: n.flipH, flipV: n.flipV,
      levels: m.levels, maxPx: 0,
    });
    m.href = r.png;
  } else if (src.preview) {
    m.href = (await clientRender(src, n, markerCrop(n), m.levels)).png;
  }
}

/** The white light multiplied onto the signal, when that is what the panel
 *  shows.  Otherwise there is no composite to keep, and none is kept. */
async function refreshMerge(n) {
  const m = n.marker, msrc = m && source(m.src), src = source(n.src);
  if (n.view !== 'merge' || !msrc || !src) { n.mergeHref = null; return; }
  if (src.server && msrc.server && backend.ok) {
    const r = await api('/api/image/render', {
      path: src.path, crop: n.crop || { x: 0, y: 0, w: src.w, h: src.h },
      rotate: n.rotate, tilt: n.tilt, flipH: n.flipH, flipV: n.flipV, levels: n.levels, maxPx: 0,
      overlay: { path: msrc.path, crop: markerCrop(n), levels: m.levels },
    });
    n.mergeHref = r.png;
  } else if (n.href && m.href) {
    n.mergeHref = await clientMultiply(n.href, m.href, n.imgW, n.imgH);
  }
}

/** The same product in the browser, on the signal's grid. */
function clientMultiply(a, b, w, h) {
  const load = s => new Promise((res, rej) => {
    const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = s;
  });
  return Promise.all([load(a), load(b)]).then(([A, B]) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.drawImage(A, 0, 0, w, h);
    ctx.globalCompositeOperation = 'multiply';
    ctx.drawImage(B, 0, 0, w, h);
    return c.toDataURL('image/png');
  });
}

function rescaleLanes(n) {
  const span = n.lanes[n.lanes.length - 1].x1 - n.lanes[0].x0;
  if (!span || Math.abs(span - n.imgW) < 2) return;
  const k = n.imgW / span, x00 = n.lanes[0].x0;
  n.lanes.forEach(l => { l.x0 = Math.round((l.x0 - x00) * k); l.x1 = Math.round((l.x1 - x00) * k); });
}

function clientRender(src, n, crop, levels) {
  levels = levels || n.levels;
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const rot = ((n.rotate | 0) / 90) % 4;
      const cw = Math.max(1, Math.round(crop.w)), ch = Math.max(1, Math.round(crop.h));
      const c = document.createElement('canvas');
      c.width = rot % 2 ? ch : cw; c.height = rot % 2 ? cw : ch;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.save();
      ctx.translate(c.width / 2, c.height / 2);
      // Flip set before turn, so it happens after it: a canvas applies the last
      // transform to the drawing first, and the server crops, turns, then flips.
      // Mirrored the other way round, a turn comes out backwards.
      ctx.scale(n.flipH ? -1 : 1, n.flipV ? -1 : 1);
      ctx.rotate(rot * Math.PI / 2 + (n.tilt || 0) * Math.PI / 180);
      ctx.drawImage(img, crop.x, crop.y, cw, ch, -cw / 2, -ch / 2, cw, ch);
      ctx.restore();
      const id = ctx.getImageData(0, 0, c.width, c.height);
      const d = id.data;
      const { black, white, gamma, invert } = levels;
      const span = (white - black) || 1;
      let lo = 0, hi = 0, total = c.width * c.height;
      const lut = new Uint8ClampedArray(256);
      for (let v = 0; v < 256; v++) {
        let t = clamp((v - black) / span, 0, 1);
        if (gamma && Math.abs(gamma - 1) > 1e-6) t = Math.pow(t, 1 / gamma);
        if (invert) t = 1 - t;
        lut[v] = Math.round(t * 255);
      }
      for (let i = 0; i < d.length; i += 4) {
        const v = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
        if (v <= black) lo++; if (v >= white) hi++;
        d[i] = d[i + 1] = d[i + 2] = lut[v]; d[i + 3] = 255;
      }
      ctx.putImageData(id, 0, 0);
      resolve({ png: c.toDataURL('image/png'), w: c.width, h: c.height,
                clip: { low: lo / total, high: hi / total,
                        linear: Math.abs((gamma || 1) - 1) < 1e-6 } });
    };
    img.src = src.preview;
  });
}

/** Ask the server where the lanes are, or fall back to an even split. */
async function autoLanes(n, count) {
  const src = source(n.src);
  const keep = n.lanes.map(l => ({ id: l.id, label: l.label, role: l.role, excised: l.excised,
                                   load: l.load, fraction: l.fraction }));
  let bounds = null;
  if (src && src.server && backend.ok) {
    try {
      const r = await api('/api/image/lanes', {
        path: src.path, crop: n.crop || { x: 0, y: 0, w: src.w, h: src.h },
        rotate: n.rotate, tilt: n.tilt, flipH: n.flipH, flipV: n.flipV, levels: n.levels,
        nLanes: count, darkBands: !n.levels.invert ? src.darkBands : !src.darkBands,
        // A blot, or a gel someone cut: no comb, because the wells are not on
        // the piece.  The crop is then the whole of it and the lanes run edge
        // to edge, rather than stopping where the last lane that ran did.
        membrane: isBlot(n) || !!n.stripNote,
        // The blank strip down each side of such a piece, in lanes, so ten
        // lanes is ten lanes and not eight and two margins.
        margin: n.margin,
      });
      bounds = r.lanes;
      // How far the lanes lean, measured on the scan.  The boundaries above are
      // given at mid-height; this is what tilts them the rest of the way.
      // A lean set by hand survives a change of lane count: you corrected it
      // once and re-counting the lanes is not a reason to throw that away.
      if (!n.leanManual) { n.leanL = r2(r.leanL || 0); n.leanR = r2(r.leanR || 0); }
      n.density = r.profiles.map(p => ({ integrated: p.integrated, fraction: p.fractionOfGel }));
    } catch (err) { hint('lane finding failed: ' + err.message, true); }
  }
  if (!bounds) bounds = await clientLanes(n, count);
  // A lane keeps its identity by position, as it keeps its label and role:
  // a band labeled or measured in lane 3 is still in lane 3 after the lanes
  // are found again, rather than orphaned by a fresh id.
  n.lanes = bounds.map(([x0, x1], i) => ({
    id: keep[i] ? keep[i].id : uid(), x0, x1,
    label: keep[i] ? keep[i].label : '', role: keep[i] ? keep[i].role : 'sample',
    excised: keep[i] ? keep[i].excised : false,
    load: keep[i] ? keep[i].load : '', fraction: keep[i] ? keep[i].fraction : '',
  }));
  // Fewer lanes than before: what was in the ones that went has nowhere to be.
  const ids = new Set(n.lanes.map(l => l.id));
  n.bands = n.bands.filter(b => ids.has(b.lane));
  if (n.quant) {
    n.quant.bands = n.quant.bands.filter(b => ids.has(b.lane));
    // Every boundary may have moved, and a box is its lane less an inset.
    if (n.quant.bands.length) await quantRemeasure(n);
  }
  // A loading control is fitted to its blot's lane spacing, which is the thing
  // that just changed.  Without this the fit was only redone on opening the
  // file or dragging a height handle, so lanes found again left the control
  // standing where the old spacing had put it.
  gelSyncControls();
}

/** The lanes you have, at one pitch, fitted to the bands in them.
 *
 *  Not the same as finding them again: which lane is which stays as it is, and
 *  only the grid is re-fitted.  It is what is left when the column signal
 *  cannot be read at all — a blown-out membrane edge outweighs every band on
 *  the strip — and it is the only thing that puts a control under its blot,
 *  since a control strip is placed by a shift and a scale and so can never be
 *  made to match a blot whose lanes are unequal. */
async function evenLanes(n) {
  const src = source(n.src);
  if (!src || !src.server || !backend.ok || n.lanes.length < 4) return;
  try {
    const r = await api('/api/image/lanes', {
      path: src.path, crop: n.crop || { x: 0, y: 0, w: src.w, h: src.h },
      rotate: n.rotate, tilt: n.tilt, flipH: n.flipH, flipV: n.flipV, levels: n.levels,
      darkBands: !n.levels.invert ? src.darkBands : !src.darkBands,
      leanL: n.leanL, leanR: n.leanR,
      even: true,
      lanes: n.lanes.map(l => [l.x0, l.x1]),
      // A blank or a ladder lane has no band to fit to and must not be fitted to.
      roles: n.lanes.map(l => l.role || 'sample'),
    });
    r.lanes.forEach(([x0, x1], i) => { n.lanes[i].x0 = x0; n.lanes[i].x1 = x1; });
    n.density = r.profiles.map(p => ({ integrated: p.integrated, fraction: p.fractionOfGel }));
  } catch (err) { hint('evening the lanes failed: ' + err.message, true); return; }
  // Boxes are cut out of the lanes, and the control is fitted to their spacing.
  await refreshLaneDensitometry(n);
}

/** The no-server fallback: cut at the quietest column near each even boundary.
 *  Reads the rendered panel rather than the source, so it sees the same bands
 *  the figure will show. */
function clientLanes(n, count) {
  const even = () => gelAutoLanes(n, count).map(l => [l.x0, l.x1]);
  if (!n.href || count < 2) return Promise.resolve(even());
  return new Promise(resolve => {
    const img = new Image();
    img.onerror = () => resolve(even());
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      // Bands are dark in the render by the time we get here, whichever way
      // they came off the imager, because the invert is already applied.
      const sig = new Float32Array(c.width);
      for (let y = 0; y < c.height; y++)
        for (let x = 0; x < c.width; x++)
          sig[x] += 255 - d[(y * c.width + x) * 4];
      const pitch = c.width / count, cuts = [0];
      for (let i = 1; i < count; i++) {
        const lo = Math.max(1, Math.floor(i * pitch - pitch * 0.35));
        const hi = Math.min(c.width - 1, Math.ceil(i * pitch + pitch * 0.35));
        let best = lo;
        for (let x = lo; x < hi; x++) if (sig[x] < sig[best]) best = x;
        cuts.push(best);
      }
      cuts.push(c.width);
      const k = (n.imgW || c.width) / c.width;
      resolve(cuts.slice(0, -1).map((x, i) => [Math.round(x * k), Math.round(cuts[i + 1] * k)]));
    };
    img.src = n.href;
  });
}

async function refreshLaneDensitometry(n) {
  const src = source(n.src);
  if (!src || !src.server || !backend.ok) return;
  try {
    const r = await api('/api/image/lanes', {
      path: src.path, crop: n.crop || { x: 0, y: 0, w: src.w, h: src.h },
      rotate: n.rotate, tilt: n.tilt, flipH: n.flipH, flipV: n.flipV, levels: n.levels,
      lanes: n.lanes.map(l => [l.x0, l.x1]),
      // Measure along the lanes at whatever angle they are set to, so a lean
      // corrected by hand is the one the densitometry is taken at.
      // Always the lean the boundaries are drawn with, hand-set or measured:
      // densitometry taken along a different angle from the one on screen is a
      // number for lanes nobody can see.
      ...serverLean(n),
      darkBands: !n.levels.invert ? src.darkBands : !src.darkBands,
    });
    n.density = r.profiles.map(p => ({ integrated: p.integrated, fraction: p.fractionOfGel }));
    inspector();
  } catch { /* densitometry is a nicety; a failure should not block editing */ }
  // The boxes are cut out of the lanes and sheared along them, so a boundary
  // moved or a lean changed is different pixels measured.  Everything that
  // moves a lane ends up here, which makes it the one place to say so.
  await quantRemeasure(n);
  // And a loading control is fitted to its blot's lane spacing, which is what
  // just changed.  Said here for the same reason: a control left standing on
  // the old spacing is the misalignment, and it came back through evening a
  // blot's lanes because only `autoLanes` had been taught to re-fit.
  gelSyncControls();
}

/* ================= measuring bands ================= */

/** Whether a picture's bands are dark on light in the original data — which is
 *  what the backend needs to know to count more protein as more signal.  From
 *  the file, not from the display: an inverted display changes what the figure
 *  looks like and nothing about the data. */
const darkInData = src => !!(src && src.darkBands);

/** What the backend needs to find this gel's picture and its lanes. */
function quantBase(n) {
  const src = source(n.src);
  return {
    path: src.path, crop: n.crop || { x: 0, y: 0, w: src.w, h: src.h },
    rotate: n.rotate, tilt: n.tilt, flipH: n.flipH, flipV: n.flipV, ...serverLean(n),
    darkBands: darkInData(src), method: n.quant.method || 'border',
    border: n.quant.border ?? 3,
  };
}

/** A scan picked in the browser with no server running has no path the
 *  backend can read.  Its bytes are still in the document, though, so once the
 *  server is up they are handed across and the scan becomes an ordinary one. */
async function serverSource(src) {
  if (!src) throw new Error('no image');
  if (src.server) return src;
  if (!backend.ok) throw new Error('measuring bands needs the server running');
  if (!/^data:/.test(src.preview || '')) throw new Error(`${src.name} is no longer available to measure`);
  const blob = await (await fetch(src.preview)).blob();
  const r = await fetch(`/api/image/upload?name=${encodeURIComponent(src.name)}`,
                        { method: 'POST', body: blob });
  const info = await r.json().catch(() => ({ error: r.statusText }));
  if (!r.ok || info.error) throw new Error(info.error || r.statusText);
  Object.assign(src, { path: info.path, server: true, dropped: true, bits: info.bits,
                       darkBands: info.darkBands, rangeLo: info.rangeLo, rangeHi: info.rangeHi,
                       saturatedFraction: info.saturatedFraction });
  return src;
}

/** Measure bands on a gel, and write what came back onto them.  `find` moves
 *  each box onto the band nearest it first, which is what a click is for. */
async function quantMeasure(n, bands, find, reach) {
  if (!bands.length) return [];
  await serverSource(source(n.src));
  const req = bands.map(b => {
    const l = n.lanes.find(x => x.id === b.lane);
    // The row's height, not the box's.  `b.h` is what came back, which is the
    // box clipped to the picture where one runs off it — so asking again with
    // that number shrinks the box for good, and a row of boxes that had one
    // height has one of them permanently smaller than the rest.  The whole-lane
    // boxes have no row and carry their own height, which is the picture.
    const row = n.quant.rows.find(r => r.id === b.row);
    const [x0, x1] = quantBoxX(n, l);
    return { id: b.id, x0, x1, y: b.y, h: (row && row.h) || b.h || null, find: !!find, reach };
  });
  const r = await api('/api/image/quant', { ...quantBase(n), bands: req });
  const by = Object.fromEntries(r.bands.map(x => [x.id, x]));
  bands.forEach(b => {
    const m = by[b.id];
    if (!m || m.error) { b.net = NaN; b.error = m ? m.error : 'not measured'; return; }
    Object.assign(b, { y: m.y, h: m.h, net: m.net, raw: m.raw, bg: m.bg, area: m.area,
                       peak: m.peak, sat: m.sat, edge: m.edge });
    delete b.error;
    // Every measure, not only a search: a box that was measured where it was
    // clicked, and then moved onto its band, kept the "?" forever.  A box
    // holding the darkest row of its lane is on the band whatever the ratio is.
    b.snr = m.snr;
    b.weak = m.snr !== undefined && m.snr !== null && m.snr < 3 && !m.onPeak;
  });
  n.quant.satLevel = r.satLevel;
  n.quant.satWhy = r.satWhy;
  n.quant.signal = r.signal;
  n.quant.bits = r.bits;
  return bands;
}

/** A click on a band.  The first one in a row sets the box's height from the
 *  band itself; every later one uses that height, because boxes of different
 *  sizes take in different fractions of their bands and the lanes stop being
 *  comparable — on the test blots, lanes whose boxes were each fitted to their
 *  own band came out 2–3% apart where one shared box put every lane within
 *  half a percent of the truth. */
async function quantClick(n, rowId, xmm, ypx, every) {
  const row = n.quant.rows.find(r => r.id === rowId);
  if (!row) return;
  const L = gelLayout(n);
  const lane = laneAt(n, L, xmm, ypx);
  if (!lane) return;
  if (!quantLane(lane)) {
    hint(`That is the ${lane.role} lane — there is nothing in it to quantify.`, true);
    return;
  }
  mark();
  const was = n.quant.bands;
  n.quant.bands = was.filter(b => !(b.row === row.id && b.lane === lane.id));
  const b = { id: uid(), row: row.id, lane: lane.id, y: r2(ypx), h: row.h || null, net: NaN };
  n.quant.bands.push(b);
  render();
  try {
    await quantMeasure(n, [b], true);
    // The row takes its height from the first band that could actually be
    // seen; a click on nothing fits a box to nothing.  Anything already in the
    // row is brought to that height, so the row keeps one box size.
    if (!row.h && !b.weak) {
      row.h = b.h;
      const off = n.quant.bands.filter(x => x.row === row.id && x !== b && x.h !== row.h);
      off.forEach(x => { x.h = row.h; });
      if (off.length) await quantMeasure(n, off, false);
    }
    if (every) await quantEvery(n, row, b.y);
    else if (b.weak) hint('No band stands out of the noise there — it was measured where you clicked. ' +
                         'Esc, then drag the box, to move it by hand.', true);
  } catch (err) {
    // Nothing measured is nothing to keep: the box goes, and so does the step.
    n.quant.bands = was;
    unmark();
    hint('Could not measure that band: ' + err.message, true);
  }
  render(); inspector();
}

/** The same band in every lane that has not got one yet: each box starts at
 *  the row the band ran to in the lane already measured, and moves onto the
 *  nearest band within a few per cent of the gel's height.  The lanes were
 *  straightened along the lean first, so "the same row" means the same row. */
async function quantEvery(n, row, yRef) {
  const have = new Set(n.quant.bands.filter(b => b.row === row.id).map(b => b.lane));
  const ys = n.quant.bands.filter(b => b.row === row.id && isFinite(b.y)).map(b => b.y);
  const y = yRef ?? (ys.length ? ys.reduce((a, v) => a + v, 0) / ys.length : null);
  if (y === null) { hint('Click the band in one lane first; the rest follow from it.', true); return 0; }
  if (!row.h) {
    hint('Click the band first in a lane where it can be seen — its box sets the size for every lane.', true);
    return 0;
  }
  const lanes = n.lanes.filter(l => !l.excised && quantLane(l) && !have.has(l.id));
  const fresh = lanes.map(l => ({ id: uid(), row: row.id, lane: l.id, y: r2(y), h: row.h, net: NaN }));
  n.quant.bands.push(...fresh);
  render();
  await quantMeasure(n, fresh, true, Math.max(8, (n.imgH || 400) * 0.04));
  const weak = fresh.filter(b => b.weak).length;
  hint(`${fresh.length} lane${fresh.length === 1 ? '' : 's'} measured` +
       (have.size ? `, ${have.size} kept as you placed ${have.size === 1 ? 'it' : 'them'}` : '') +
       (weak ? `; in ${weak} no band stood out of the noise, so ${weak === 1 ? 'it was' : 'they were'} ` +
               `measured at the row — which is a measurement of nothing much, and fair to report as such` : '') + '.');
  return fresh.length;
}

/** The whole of each lane as one box, floor to ceiling.
 *
 *  Purity is the target band over this, so the two are measured the same way --
 *  the same picture, the same background rule, the same inset at the lane's
 *  sides -- and the only thing that differs is the height.  Nothing is skipped
 *  inside it: the well, the dye front and everything smeared between them are
 *  all stain in that lane, and a purity that quietly left some of them out would
 *  be a better-looking number for no reason anyone could check. */
async function quantWholeLanes(n) {
  const H = n.imgH || 0;
  if (!H) { unmark(); hint('There is no picture in this panel to measure.', true); return; }
  const lanes = n.lanes.filter(l => !l.excised && quantLane(l));
  if (!lanes.length) { unmark(); hint('No lane here holds a sample.', true); return; }
  n.quant.bands = n.quant.bands.filter(b => b.row !== WHOLE_LANE);
  const fresh = lanes.map(l => ({ id: uid(), row: WHOLE_LANE, lane: l.id,
                                  y: r2(H / 2), h: H, net: NaN }));
  n.quant.bands.push(...fresh);
  render();
  await quantMeasure(n, fresh, false);
  const got = gelQuantLanes(n).filter(x => x.purity !== null).length;
  hint(`${fresh.length} whole lane${fresh.length === 1 ? '' : 's'} measured` +
       (got ? `, and the target band is a measured fraction of ${got === 1 ? 'it' : `each of ${got}`} — ` +
              `a fraction of the stain, not of the protein, since dye per milligram differs between proteins`
            : `. Click the target band in a lane and the purity follows`) + '.');
}

/** Measure every box on a gel again where it stands — after a lane boundary,
 *  the lean, the crop, or the way background is taken has changed. */
async function quantRemeasure(n) {
  if (!n || n.type !== 'gel' || !n.quant.bands.length) return;
  const ok = n.quant.bands.filter(b => n.lanes.some(l => l.id === b.lane));
  try {
    await quantMeasure(n, ok, false);
  } catch (err) {
    hint('Could not measure the bands again: ' + err.message, true);
  }
  render(); inspector();
}

/* ================= chromatograms ================= */

/** A panel with no title of its own takes the name of the file it came from.
 *  Which run a trace is is the first thing anyone asks of a figure with more
 *  than one on it, and the file already knows. */
function titleFromSource(n) {
  if (!n.title && n.source) n.title = n.source.split('/').pop().replace(/\.[^.]+$/, '');
}

async function openChromByPath(nodeId, path) {
  const r = await api('/api/chrom/open', { path });
  const n = node(nodeId);
  n.source = path;
  const frac = fractionColumn(r.fractions);
  applyTraces(n, r.curves.map(c => ({ name: c.name, unit: c.unit, xunit: c.xunit, pts: c.points })),
              frac ? frac.marks : [], r.run);
  titleFromSource(n);
  render(); inspector();
  hint(`${r.curves.length} curves, ${n.fractions.marks.length} fraction marks` +
       (r.run && r.run.id ? ' \u2014 UNICORN .RES' : '') +
       (n.inject && n.inject.offset ? `, injected at ${r2(n.inject.raw)} mL.` : '.'));
}

/** Decode a text export, honoring the UTF-16 a UNICORN one is written in.
 *  `File.text()` assumes UTF-8 and turns one into mojibake. */
function decodeTrace(buf) {
  const b = new Uint8Array(buf);
  if (b[0] === 0xFF && b[1] === 0xFE) return new TextDecoder('utf-16le').decode(b);
  if (b[0] === 0xFE && b[1] === 0xFF) return new TextDecoder('utf-16be').decode(b);
  let zeros = 0, look = Math.min(b.length, 1024);
  for (let i = 1; i < look; i += 2) if (b[i] === 0) zeros++;
  if (zeros > look / 4) return new TextDecoder('utf-16le').decode(b);   // no BOM, still UTF-16
  return new TextDecoder('utf-8').decode(b);
}

/* Column names UNICORN uses for event marks rather than for data.  They have
   to be recognized by name: a fraction column whose labels happen to be "1",
   "2", "3" parses as a perfectly good curve otherwise, and lands on the plot
   as a staircase. */
const MARK_COLUMN = /fraction|inject|run\s*log|logbook|event|break/i;

/** A number, or null — strict, the way the backend's reader is.
 *
 *  `parseFloat` stops at the first character it cannot use, so it reads
 *  "260/280" as 260, "2026-09-04" as 2026 and "12 mAU" as 12.  Every one of
 *  those turns a heading or a date into a measurement, which is how a header row
 *  comes to look like data and a table comes to be read as the wrong thing
 *  entirely.  A cell is a number or it is not. */
const numOr = v => {
  const t = String(v ?? '').trim().replace(',', '.');
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return null;
  const f = +t;
  return isFinite(f) ? f : null;
};

/** Thin a curve for the canvas, keeping each bucket's extremes.  Plain
 *  decimation drops peak maxima, and a chromatogram is mostly a statement
 *  about peak maxima. */
function thin(pts, target = 1400) {
  if (pts.length <= target) return pts;
  const out = [], buckets = Math.floor(target / 2);
  for (let b = 0; b < buckets; b++) {
    const a = Math.floor(b * pts.length / buckets), z = Math.floor((b + 1) * pts.length / buckets);
    if (z <= a) continue;
    let lo = a, hi = a;
    for (let i = a; i < z; i++) { if (pts[i][1] < pts[lo][1]) lo = i; if (pts[i][1] > pts[hi][1]) hi = i; }
    const [p, q] = lo <= hi ? [lo, hi] : [hi, lo];
    out.push(pts[p]);
    if (q !== p) out.push(pts[q]);
  }
  return out;
}

/** A chromatography export, parsed in the browser — the no-server path.
 *
 *  Handles the UNICORN ASCII layout as well as a plain table: two header rows,
 *  then one *pair* of columns per curve, each pair carrying its own volume
 *  axis because the curves are not sampled together.  Anything that assumes a
 *  single shared x column silently mangles this, which is why the shape is
 *  detected rather than assumed. */
/** Split one row, honoring the quotes UNICORN wraps its text cells in.  A plain
 *  `split` leaves them on: the fraction labels reach the figure as \"2\" rather
 *  than 2, and any quoted field holding the separator is torn in half. */
function splitRow(line, sep) {
  const out = [];
  let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch !== '"') cur += ch;
      else if (line[i + 1] === '"') { cur += '"'; i++; }        // "" is one quote
      else quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Is this the paired layout — one (x, value) pair per curve?  The tell is that
 *  every even column is a volume that only ever goes up.  A fraction or
 *  injection pair holds a handful of rows against the curves' tens of thousands,
 *  so a column with too few numbers *abstains* rather than voting the layout
 *  down, and the units row corroborates: in a paired export every even column
 *  carries the same volume unit. */
function pairedLayout(body, units, width) {
  if (width < 4) return false;
  let votes = 0;
  const even = [];
  for (let c = 0; c < width - 1; c += 2) {
    let seen = 0, last = null;
    for (const r of body) {
      const v = numOr(r[c]);
      if (v === null) continue;
      if (last !== null && v < last - 1e-9) return false;   // an x that goes backwards is not an x
      last = v; seen++;
    }
    if (seen >= 3) votes++;
    even.push(String(units[c] || '').trim().toLowerCase());
  }
  if (!votes) return false;
  const kinds = new Set(even);
  if (even.some(u => u) && kinds.size > 1) return false;    // not one quantity
  return votes >= 2 || (kinds.size === 1 && !!even[0]);
}

function parseTraceText(text, n) {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length);
  if (!lines.length) throw new Error('the file is empty');
  const tabs = (lines[0].match(/\t/g) || []).length;
  const semis = (lines[0].match(/;/g) || []).length;
  const commas = (lines[0].match(/,/g) || []).length;
  const sep = tabs >= Math.max(commas, semis) ? '\t' : semis > commas ? ';' : ',';
  const rows = lines.map(l => splitRow(l, sep));
  const width = Math.max(...rows.map(r => r.length));
  rows.forEach(r => { while (r.length < width) r.push(''); });

  const firstData = rows.findIndex(r => numOr(r[0]) !== null && r.slice(1).some(c => numOr(c) !== null));
  if (firstData < 0) throw new Error('no numeric rows — is this a chromatogram export?');
  // UNICORN writes the run name, then the curve names, then the units; a plain
  // CSV writes one row of names.  Counting from the bottom reads both — and
  // reads the three-row export that a fixed "row 0 is names" rule labels
  // "Chrom.1" the whole way across.
  const header = rows.slice(0, firstData);
  const names = header.length >= 2 ? header[header.length - 2] : (header[0] || []);
  const units = header.length >= 2 ? header[header.length - 1] : [];
  const body = rows.slice(firstData);
  const paired = pairedLayout(body, units, width);

  const curves = [], markCols = [];
  const push = (name, unit, xunit, pts) => {
    if (pts.length > 2) curves.push({ name, unit: resUnit(unit), xunit: resUnit(xunit), pts: thin(pts) });
  };

  if (paired) {
    for (let c = 0; c < width - 1; c += 2) {
      const name = String(names[c] || names[c + 1] || `curve ${c / 2 + 1}`).trim();
      const unit = String(units[c + 1] || '').trim();
      const marksOnly = MARK_COLUMN.test(name + ' ' + unit);
      const pts = [], labels = [];
      for (const r of body) {
        const x = numOr(r[c]);
        if (x === null) continue;
        const raw = String(r[c + 1] ?? '').trim();
        // The position is the mark.  An injection writes its volume with an
        // empty label, and dropping it loses the one number that says which
        // zero the x axis has.
        if (marksOnly) { labels.push({ v: x, label: raw }); continue; }
        const y = numOr(r[c + 1]);
        if (y === null) { if (raw) labels.push({ v: x, label: raw }); }
        else pts.push([x, y]);
      }
      if (labels.length && !pts.length) markCols.push({ name, marks: labels });
      else push(name, unit, String(units[c] || 'mL').trim(), pts);
    }
  } else {
    for (let c = 1; c < width; c++) {
      const name = String(names[c] || `curve ${c}`).trim();
      const unit = String(units[c] || '').trim();
      if (MARK_COLUMN.test(name + ' ' + unit)) {
        const labels = [];
        body.forEach(r => {
          const x = numOr(r[0]), raw = String(r[c] ?? '').trim();
          if (x !== null && raw) labels.push({ v: x, label: raw });
        });
        if (labels.length) markCols.push({ name, marks: labels });
        continue;
      }
      const pts = [];
      for (const r of body) {
        const x = numOr(r[0]), y = numOr(r[c]);
        if (x !== null && y !== null) pts.push([x, y]);
      }
      push(name, unit, String(units[0] || 'mL').trim(), pts);
    }
  }
  if (!curves.length) throw new Error('parsed the file but found no curves');
  const frac = fractionColumn(markCols), inj = injectColumn(markCols);
  applyTraces(n, curves, frac ? frac.marks : [], inj === null ? null : { inject: inj });
  return { curves: curves.length, fractions: frac ? frac.marks.length : 0, paired, inject: inj };
}

/** Injection, run log and fractions are all mark columns, but only one of them
 *  belongs on the fraction bar; merging them puts "Sample Application" between
 *  tubes 3 and 4. */
function fractionColumn(cols) {
  return cols.find(m => /frac|tube|well/i.test(m.name)) ||
         cols.find(m => !/inject|run\s*log|logbook|event/i.test(m.name)) || null;
}

function injectColumn(cols) {
  const c = cols.find(m => /inject/i.test(m.name));
  return c && c.marks.length ? c.marks[0].v : null;
}

/** Put parsed curves onto a chromatogram node.  Shared by the backend path and
 *  the in-browser one, so a file loaded either way lands identically. */
/* ---- UNICORN .RES -------------------------------------------------------
   The file the instrument writes: a short header, a directory of 344-byte
   entries, then one block per curve or event list, little-endian throughout.
   Reading it here as well as in the backend keeps the promise that a dropped
   file works with the server down, and saves the export step entirely. */
const RES_ENTRY = 0x158, RES_DESC = 78, RES_MARK = 180, RES_CURVE = 0x1401;
const RES_MARK_SUBS = { 0x0444: 'fractions', 0x0446: 'inject', 0x0448: 'logbook' };
// How UNICORN spells two units it writes, against how they are spelled on a
// figure axis.  Both reach print, so the capitals go back on, whichever reader
// the file came through.
const RES_UNITS = { mAu: 'mAU', ml: 'mL', l: 'L' };
const resUnit = u => RES_UNITS[u] || u;

function resStr(u8, off, n) {
  const stop = Math.min(off + n, u8.length);
  let end = off, s = '';
  while (end < stop && u8[end] !== 0) end++;
  for (let i = off; i < end; i++) s += String.fromCharCode(u8[i]);   // latin-1
  return s.trim();
}

/** The axis descriptors at the head of a block: 0x80 marks an x, 0x40 a y. */
function resAxes(dv, u8, off) {
  const out = [];
  for (let a = off + 6; a + RES_DESC <= u8.length && dv.getUint16(a, true) === RES_DESC;
       a += RES_DESC) {
    out.push({ kind: u8[a + 3], name: resStr(u8, a + 4, 40),
               unit: resStr(u8, a + 0x2C, 18), factor: dv.getFloat64(a + 0x3E, true) });
  }
  return out;
}

/** Which axis the stored x integers are counted in.

    A curve block offers both "Acc. Time" (min) and "Acc. Volume" (ml), but the
    data holds one integer per point, so only one of those factors is right and
    the header does not say which.  The event lists do say: every mark records
    its time *and* its volume.  So take the axis under which the curve still
    reaches every mark — reading a 70 min run as 29 min leaves the last logbook
    entry off the end of the trace, which is the tell.  With no marks to check
    against, prefer millilitres; a size-exclusion column is read in volume. */
function resPickX(axes, xmaxRaw, spans) {
  const cands = axes.filter(a => a.kind === 0x80 && a.factor > 0);
  if (!cands.length) throw new Error('curve block has no x axis');
  const fits = cands.filter(a => {
    const need = spans[a.unit.toLowerCase()];
    return need === undefined || xmaxRaw * a.factor >= need - 1e-6;
  });
  const pool = fits.length ? fits : cands;
  return pool.find(a => /^m?l$/i.test(a.unit)) || pool[pool.length - 1];
}

function parseResBuffer(buf, n) {
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  if (!(u8[0] === 0x11 && u8[1] === 0x47 && u8[2] === 0x11 && u8[3] === 0x47))
    throw new Error('not a UNICORN .RES file');

  const count = dv.getUint32(4, true), dirOff = dv.getUint32(8, true), entries = [];
  for (let i = 0; i < count; i++) {
    const o = dirOff + i * RES_ENTRY;
    if (o + RES_ENTRY > u8.length) break;
    const name = resStr(u8, o + 6, 0x120);
    if (!name) continue;
    const size = dv.getUint32(o + 0x12E, true), off = dv.getUint32(o + 0x136, true),
          start = dv.getUint32(o + 0x13A, true);
    if (size <= start || off + size > u8.length) continue;
    entries.push({ name, sub: dv.getUint16(o + 4, true), off, size, start });
  }

  // The event lists first: they fix how far the run got, which is what settles
  // the x axis for the curves.
  const events = {}, spans = {};
  entries.forEach(e => {
    const kind = RES_MARK_SUBS[e.sub];
    if (!kind) return;
    const rows = events[kind] || (events[kind] = []);
    for (let i = 0, k = Math.floor((e.size - e.start) / RES_MARK); i < k; i++) {
      const o = e.off + e.start + i * RES_MARK, label = resStr(u8, o + 16, 160);
      if (!label) continue;
      const t = dv.getFloat64(o, true), v = dv.getFloat64(o + 8, true);
      rows.push({ t: r3(t), v: r3(v), label });
      spans.min = Math.max(spans.min || 0, t);
      spans.ml = Math.max(spans.ml || 0, v);
    }
  });

  const curves = [];
  let xaxis = null;
  entries.forEach(e => {
    if (e.sub !== RES_CURVE) return;
    const axes = resAxes(dv, u8, e.off), y = axes.find(a => a.kind === 0x40);
    const k = Math.floor((e.size - e.start) / 8), base = e.off + e.start;
    if (k < 2 || !y) return;
    const xax = resPickX(axes, dv.getInt32(base + (k - 1) * 8, true), spans);
    xaxis = xax;
    const pts = new Array(k);
    for (let i = 0; i < k; i++) {
      pts[i] = [r4(dv.getInt32(base + i * 8, true) * xax.factor),
                r4(dv.getInt32(base + i * 8 + 4, true) * y.factor)];
    }
    // The y descriptor's own name is overwritten in place by the instrument and
    // comes out as debris ("0", "annel 2"), so the curve is named from the
    // directory: "2026Sep04no002:10_UV" is the UV trace of run no002.
    curves.push({ name: e.name.split('_').pop(), unit: resUnit(y.unit),
                  xunit: resUnit(xax.unit) || 'mL', pts: thin(pts) });
  });
  if (!curves.length) throw new Error('read the .RES directory but found no curves in it');

  const log = events.logbook || [];
  // Same field names the backend's reader returns, so applyTraces cannot tell
  // which of the two read the file.
  const meta = { id: ((entries.find(e => e.name.includes(':')) || {}).name || '').split(':')[0],
                 logbook: log, xaxis: xaxis ? `${xaxis.name} (${xaxis.unit})` : '' };
  if (events.inject && events.inject.length) meta.inject = events.inject[0].v;
  log.forEach(r => {
    const started = /^Method Run\s+([\d.]+,\s*[\d:]+)/.exec(r.label);
    if (started) meta.started = started[1];
    const flow = /^Flow\s+([\d.]+)\s*ml\/min/i.exec(r.label);
    if (flow && meta.flow === undefined) meta.flow = Number(flow[1]);
  });

  applyTraces(n, curves, events.fractions || [], meta);
  return { curves: curves.length, fractions: (events.fractions || []).length,
           res: true, meta };
}

const SUBS = '\u2080\u2081\u2082\u2083\u2084\u2085\u2086\u2087\u2088\u2089';
const sub = str => str.replace(/\d/g, d => SUBS[+d]);

/** Move the x axis between the two frames a UNICORN run has: the method's own
 *  accumulated volume, and volume counted from the injection.  V0, Vt and every
 *  standards kit are column volumes measured from the injection, so reading them
 *  against a method-frame trace puts every Kav — and so every mass — out by the
 *  injection volume.  The shift is applied to the stored numbers rather than at
 *  draw time, so only one frame is ever in play and there is nothing to mix up. */
function rebaseChrom(n, toInject) {
  if (!n.inject || n.inject.rebased === !!toInject) return;
  const d = (toInject ? -1 : 1) * n.inject.raw;
  n.traces.forEach(t => { t.pts = t.pts.map(q => [r3(q[0] + d), q[1]]); });
  n.fractions.marks = n.fractions.marks.map(m => ({ ...m, v: r3(m.v + d) }));
  if (n.fractions.pooled) n.fractions.pooled = n.fractions.pooled.map(v => r3(v + d));
  n.peaks.forEach(q => { if (nn(q.v) !== null) q.v = r3(Number(q.v) + d); });
  n.calib.standards.forEach(t => { if (nn(t.ve) !== null) t.ve = r3(Number(t.ve) + d); });
  if (!n.auto) { n.xmin = r3(n.xmin + d); n.xmax = r3(n.xmax + d); }
  n.inject.v = r3(n.inject.v + d);
  n.inject.rebased = !!toInject;
  n.calib.fit = null;                    // the standards moved; the fit must be redone
}

/** How many tubes to skip between fraction labels.  A 35-tube run under a 70 mm
 *  panel wants a label every 2 mm; they collide into a gray smear.  Label as
 *  many as will fit across the stretch the collector actually ran for, and no
 *  more.  The median label length sets the spacing, so one "Waste" at the end
 *  does not thin out the whole bar. */
function fracLabelStep(n) {
  const m = n.fractions.marks;
  if (m.length < 3) return 1;
  const pts = (n.traces.find(t => t.pts && t.pts.length > 1) || {}).pts;
  const axis = pts ? pts[pts.length - 1][0] - pts[0][0] : 0;
  const span = m[m.length - 1].v - m[0].v;
  const mm = n.w * (axis > 0 ? Math.min(1, span / axis) : 1);
  const lens = m.map(t => String(t.label).length).sort((a, b) => a - b);
  const wide = lens[lens.length >> 1] * n.fractions.pt * PT * 0.62 + 0.9;
  return Math.max(1, Math.ceil(m.length / Math.max(1, Math.floor(mm / wide))));
}

function applyTraces(n, curves, fractionMarks, meta) {
  n.traces = curves.map((c, i) => {
    let max = -Infinity;
    for (const p of c.pts) if (p[1] > max) max = p[1];
    return {
      id: uid(), name: c.name, unit: c.unit || '', on: i < 2,
      // Which axis a curve belongs on is a question about its unit, not its
      // name: "UV_CUT_TEMP@100,BASEM" is a baseline in mAU and belongs with the
      // absorbance it was subtracted from, whatever the word TEMP suggests.
      axis: /cond|%\s*b|conc|press|temp/i.test(c.name) && !/^m?au$/i.test(c.unit || '')
            ? 'right' : 'left',
      color: TRACE_COLOURS[i % TRACE_COLOURS.length],
      dash: /cond/i.test(c.name) ? '1.6 1.2' : '', width: 0,
      pts: c.pts, _max: max,
    };
  });
  // Claim a wavelength only when the file states one.  An AKTAprime records the
  // trace as plain "UV": the wavelength is set by the filter in the monitor, not
  // by the software, so it is not in the file, and labeling that curve A280
  // would invent the one number a reader is most likely to take on trust.
  const uv = n.traces.find(t => /280/.test(t.name)) || n.traces.find(t => /uv|abs/i.test(t.name));
  if (uv) {
    uv.on = true;
    const wl = (/(\d{3})/.exec(uv.name) || [])[1];
    n.ylabel = `${wl ? 'A' + sub(wl) : 'Absorbance'} (${uv.unit || 'mAU'})`;
  }
  if (fractionMarks && fractionMarks.length) {
    n.fractions.marks = fractionMarks.map(m => ({ v: m.v, label: m.label }));
    n.fractions.on = true;
    n.fractions.every = fracLabelStep(n);
  }
  n.xlabel = `Elution volume (${(curves[0] && curves[0].xunit) || 'mL'})`;
  const right = n.traces.find(t => t.axis === 'right');
  if (right && !n.y2label) n.y2label = right.name + (right.unit ? ` (${right.unit})` : '');

  if (meta) {
    if (meta.flow) n.column.flow = meta.flow;
    if (meta.inject != null) {
      const pts = (curves[0] || {}).pts || [];
      const span = pts.length > 1 ? Math.abs(pts[pts.length - 1][0] - pts[0][0]) : 0;
      // A method that starts at the injection records it at ~0.  Marking that is
      // clutter, and warning about a frame that is already right is worse than
      // clutter — so only an injection far enough along the run to move a Kav
      // counts as an offset.
      const offset = span > 0 && meta.inject > span * 0.005;
      n.inject = { v: meta.inject, raw: meta.inject, rebased: false, offset };
    }
    n.run = { id: meta.id || '', started: meta.started || '',
              xaxis: meta.xaxis || '', logbook: meta.logbook || [] };
  }
}

/* ================= inspector ================= */

const NUM = 'num', STR = 'str', BOOL = 'bool', COL = 'col';
let inspectorFocusLane = null;

function row(label, key, kind, extra = '') {
  return `<div class="row"><label>${label}</label>` + ctl(key, kind, extra) + `</div>`;
}
function ctl(key, kind, extra = '') {
  if (kind === BOOL) return `<input type="checkbox" data-k="${key}" data-t="bool" ${extra}>`;
  if (kind === COL) return `<input type="color" data-k="${key}" data-t="str" ${extra}>`;
  if (kind === NUM) return `<input type="number" data-k="${key}" data-t="num" ${extra}>`;
  if (kind === 'sel') return `<select data-k="${key}" data-t="str">${extra}</select>`;
  if (kind === 'area') return `<textarea data-k="${key}" data-t="str" rows="2" ${extra}></textarea>`;
  return `<input type="text" data-k="${key}" data-t="str" ${extra}>`;
}
const opts = (list, v) => list.map(o =>
  `<option value="${esc(o)}"${String(o) === String(v) ? ' selected' : ''}>${esc(o)}</option>`).join('');
const btn = (act, label, cls = '') => `<button data-act="${act}" class="${cls}">${label}</button>`;

/** Which folds are open, so rebuilding the inspector does not shut them.  The
 *  panel is written out again from scratch on every click, and the `open` in the
 *  markup is only what a fold does the first time it is seen -- after a crop
 *  exists the crop fold's default is shut, so it folded away under the hand that
 *  was cropping with it, once per click. */
const foldOpen = new Map();
const foldKey = d => d.querySelector('summary').textContent.trim();
const keepFolds = box => box.querySelectorAll('details.fold')
  .forEach(d => foldOpen.set(foldKey(d), d.open));
const restoreFolds = box => box.querySelectorAll('details.fold')
  .forEach(d => { if (foldOpen.has(foldKey(d))) d.open = foldOpen.get(foldKey(d)); });

function inspector() {
  const box = $('#inspector');
  keepFolds(box);
  const ns = selNodes(), es = selEdges();
  if (!ns.length && !es.length) { box.innerHTML = emptyInspector(); restoreFolds(box); fillInspector(); bindInspector(); return; }

  let h = '';
  if (ns.length === 1) {
    const n = ns[0];
    h += `<h3>${{ chrom: 'chromatogram', nanodrop: 'A\u2082\u2088\u2080 table', quant: 'quantification',
                  gel: isBlot(n) ? 'blot' : 'gel' }[n.type] || n.type}</h3>`;
    h += `<div class="btnrow">${btn('front', 'front')}${btn('back', 'back')}${btn('dup', 'duplicate')}${btn('del', 'delete')}</div>`;
    h += `<div class="row tight"><label>x</label>${ctl('x', NUM, 'step="0.5"')}<label>y</label>${ctl('y', NUM, 'step="0.5"')}</div>`;
    h += sizeRow(n);
    if (n.type === 'gel') h += gelInspector(n);
    else if (n.type === 'chrom') h += chromInspector(n);
    else if (n.type === 'table') h += tableInspector(n);
    else if (n.type === 'nanodrop') h += nanodropInspector(n);
    else if (n.type === 'quant') h += quantInspector(n);
    else if (n.type === 'construct') h += constructInspector(n);
    else h += boxInspector(n);
  } else if (ns.length > 1) {
    h += `<h3>${ns.length} panels</h3>`;
    h += `<div class="btnrow">${btn('dup', 'duplicate')}${btn('del', 'delete')}</div>`;
    h += alignInspector();
  }
  if (es.length) {
    const e = es[0];
    h += `<h3>${e.kind}</h3>`;
    h += `<div class="btnrow">${btn('delEdge', 'delete')}</div>`;
    h += row('label', 'label', STR);
    h += row('font pt', 'labelPt', NUM, 'step="0.5"');
    h += row('width mm', 'strokeMm', NUM, 'step="0.05"');
    h += row('colour', 'stroke', COL);
    if (e.kind !== 'brace') h += row('arrowhead', 'arrowhead', BOOL);
    else {
      h += `<div class="row tight"><label>crossbar</label>${ctl('drop', NUM, 'step="0.05" min="0.05" max="0.95"')}
            ${btn('braceMid', 'center')}</div>`;
      h += `<div class="note">How far down the gap between the two panels the bracket
            hangs, 0 to 1 — or drag the bar itself. The ends stop short of the axis title
            above and the lane labels below, so it cannot land on either.</div>`;
    }
  }
  box.innerHTML = h;
  restoreFolds(box);
  fillInspector();
  bindInspector();
}

/** How big the panel is, in millimeters, right under where it is.
 *
 *  Half the panels here have no free size to set, and the point of the row is
 *  to say which number is actually theirs: a table is as tall as its rows, a
 *  construct as tall as its bar, a gel as wide as its lanes, and a gel whose
 *  lane width is pinned for the whole sheet has neither — which is also why it
 *  has no drag handles, and why looking for them is how you end up asking
 *  where the size is set. */
function sizeRow(n) {
  const b = bbox(n);
  if (n.type === 'gel') {
    const pin = gelLaneMm(n);
    if (pin > 0)
      return `<div class="row tight"><label>size</label>
        <span class="derived">${r2(b.w)} × ${r2(b.h)} mm</span></div>
        <div class="note">Drawn to <b>${r2(pin)} mm</b> a lane — <b>lane mm</b>, with nothing
        selected, sizes every blot on the sheet at once, and both of these follow from it.
        Set it to <b>0</b> to size this panel by hand.</div>`;
    return `<div class="row tight"><label>height mm</label>
      ${ctl('drawnH', NUM, `step="0.5" min="6" value="${r2(b.h)}"`)}
      <span class="derived">${r2(b.w)} mm wide</span></div>
      <div class="note">A gel is scaled uniformly or every apparent mobility in it changes,
      so the height is the one to set and the width follows.</div>`;
  }
  if (['table', 'nanodrop', 'construct'].includes(n.type))
    return `<div class="row tight"><label>width mm</label>${ctl('w', NUM, 'step="1"')}
      <span class="derived">${r2(b.h)} mm tall</span></div>
      <div class="note">As tall as what is in it.</div>`;
  return `<div class="row tight"><label>w</label>${ctl('w', NUM, 'step="0.5"')}
    <label>h</label>${ctl('h', NUM, 'step="0.5"')}</div>`;
}

function emptyInspector() {
  const g = doc.nodes.filter(n => n.type === 'gel').length;
  const c = doc.nodes.filter(n => n.type === 'chrom').length;
  const lanePin = nn(doc.page.laneMm) || 0;
  const sheet = doc.sheet === 'supp'
    ? `<div class="note" style="margin-bottom:10px"><b>The supplementary sheet.</b> Whole blots, each
       processed exactly as its figure panel is, with the region the figure uses outlined. It is a
       canvas like any other — move, resize, relabel and export it the same way. <b>figure</b> in the
       toolbar switches back.<div class="btnrow" style="margin-top:6px">${btn('rebuildSupp', 'rebuild from the figure')}</div>
       Rebuilding replaces what is here, so anything arranged by hand is lost; one undo brings it back.</div>`
    : '';
  return `<div class="empty">${sheet}Nothing selected.
    <div class="note" style="margin-top:10px">
      <b>g</b> gel &nbsp; <b>w</b> western blot &nbsp; <b>c</b> chromatogram<br>
      <b>p</b> purification table &nbsp; <b>d</b> A₂₈₀ table &nbsp; <b>q</b> quantification<br>
      <b>n</b> box &nbsp; <b>t</b> text &nbsp; <b>a</b> panel letter<br>
      <b>1</b> arrow &nbsp; <b>2</b> elbow &nbsp; <b>3</b> fractions→lanes brace<br>
      <b>0</b> fit &nbsp; ⌘-scroll zoom &nbsp; alt-drag pan<br>
      <b>⌘Z</b> undo &nbsp; <b>⇧⌘Z</b> redo<br>
      shift-drag a lane boundary to angle them<br>
      <b>ctrl-drag</b> moves a panel from anywhere on it<br>
      drag a blot onto a graph to add it as a replicate<br>
      drop a PNG, a UNICORN .RES or an export anywhere
    </div>
    <div class="note" style="margin-top:8px">${g} gel/blot, ${c} chromatogram panels,
      ${doc.sources.length} source image${doc.sources.length === 1 ? '' : 's'}.</div>
    <h3 style="margin-top:12px">figure</h3>
    ${row('title', 'meta.title', STR)}
    ${row('protein', 'meta.protein', STR)}
    ${row('construct', 'meta.construct', STR)}
    ${row('tag', 'meta.tag', STR)}
    ${row('expressed in', 'meta.host', STR)}
    ${doc.sheet === 'supp' ? '' : `
    <h3 style="margin-top:12px">blots</h3>
    ${row('lane mm', 'page.laneMm', NUM, 'step="0.5" min="0" placeholder="0"')}
    <div class="note">${lanePin > 0
      ? `Every blot is drawn so that its <b>average</b> lane is this wide, so blots
         photographed at different magnifications print at one lane pitch — what a fixed
         bar width does for two graphs. Average, because the lanes of one gel are not all
         the same width and none of them may be stretched to match: a gel is scaled
         uniformly or every apparent mobility in it changes. The height handles are off
         while this is set, since the height is the lanes'. <b>0</b> gives them back.`
      : `Each blot is as tall as it was dragged, so the same four lanes come out one width
         on one panel and twice that on the next. Set this and they are all drawn to one
         lane; <b>3.94</b> is what a bar is.`}</div>`}
  </div>`;
}

/* ---- aligning ---- */

//: What each button lines up, and what it says it does when you hover it.
const ALIGN_BUTTONS = [
  ['left', 'left', 'Left edges to the leftmost panel'],
  ['hcentre', 'centre', 'Centers to the middle of the selection, horizontally'],
  ['right', 'right', 'Right edges to the rightmost panel'],
  ['top', 'top', 'Top edges to the topmost panel'],
  ['vcentre', 'middle', 'Centers to the middle of the selection, vertically'],
  ['bottom', 'bottom', 'Bottom edges to the bottommost panel'],
];

function alignInspector() {
  const rows = [ALIGN_BUTTONS.slice(0, 3), ALIGN_BUTTONS.slice(3)].map(row =>
    `<div class="btnrow">` + row.map(([e, label, tip]) =>
      `<button data-act="align" data-edge="${e}" title="${tip}">${label}</button>`).join('') +
    `</div>`).join('');
  return `<h3>align</h3>
    <div class="row tight"><label>by</label>
      <select id="alignRef">
        <option value="frame"${alignRef === 'frame' ? ' selected' : ''}>the straight element</option>
        <option value="ink"${alignRef === 'ink' ? ' selected' : ''}>everything drawn</option>
      </select></div>
    ${rows}
    <div class="note">The <b>straight element</b> is the axis spines of a trace, the
      border of a gel, the rules of a table — the edge the eye reads, and the one to
      use for a column of panels. <b>Everything drawn</b> takes in the tick numbers,
      axis titles, lane labels and ladder scale, which is what to use when a panel has
      to fit a given width or clear its neighbor.</div>`;
}

/* ---- gel ---- */

function gelInspector(n) {
  const src = source(n.src);
  let h = '';
  const flags = [];
  if (n.levels.gamma && Math.abs(n.levels.gamma - 1) > 1e-6)
    flags.push(['warn', 'non-linear (γ ≠ 1)']);
  if (n.clip && n.clip.high > 0.005) flags.push(['warn', `${(n.clip.high * 100).toFixed(1)}% clipped white`]);
  if (n.clip && n.clip.low > 0.02) flags.push(['warn', `${(n.clip.low * 100).toFixed(0)}% clipped black`]);
  const cuts = n.lanes.filter(l => l.excised).length;
  if (cuts) flags.push(['accent', `${cuts} lane${cuts === 1 ? '' : 's'} excised`]);
  const splices = gelLayout(n).segs.filter(s => s.spliceBefore).length;
  if (splices) flags.push([n.splice.rule ? 'ok' : 'bad', `${splices} splice${splices === 1 ? '' : 's'}${n.splice.rule ? ' marked' : ' UNMARKED'}`]);
  if (src && !src.server) flags.push(['', '8-bit browser load']);
  if (src && src.saturatedFraction > 0.001) flags.push(['bad', 'source is saturated']);
  if (flags.length) h += `<div class="flags">` +
    flags.map(([k, t]) => `<span class="badge ${k}">${esc(t)}</span>`).join('') + `</div>`;

  const blot = isBlot(n);
  const msrc = n.marker && source(n.marker.src);
  h += `<div class="btnrow">${btn('pickImage', src ? (blot ? 'change signal…' : 'change image…')
                                                  : (blot ? 'load signal…' : 'load image…'), 'primary')}` +
       (blot ? btn('pickMarker', msrc ? 'change white light…' : 'load white light…', src && !msrc ? 'primary' : '') : '') +
       `</div>`;
  if (src) {
    h += `<div class="status">${blot ? 'signal: ' : ''}${esc(src.name)} · ${src.w}×${src.h} px · ${src.bits}-bit` +
         (src.note ? ` · ${esc(src.note)}` : '') + `</div>`;
  }
  if (src && src.missing) {
    h += `<div class="note warn">The scan is no longer at <b>${esc(src.path || '')}</b>.
          The panel still draws — it carries its own rendered image — but re-cropping,
          re-leveling and lane finding all need the original. <b>Relink…</b> points this
          session at the file where it is now and keeps the crop, the levels and the
          lanes.</div>`;
    h += `<div class="btnrow">${btn('relink', 'relink…', 'primary')}</div>`;
  }
  if (msrc) {
    h += `<div class="status">white light: ${esc(msrc.name)} · ${msrc.w}×${msrc.h} px · ${msrc.bits}-bit · ` +
         `${Math.abs(n.marker.k - 1) < 1e-6 ? 'same frame as the signal' : `${r3(n.marker.k)}× the signal’s size`}</div>`;
    if (msrc.missing) {
      h += `<div class="note warn">The white-light image is no longer at <b>${esc(msrc.path || '')}</b>.</div>`;
      h += `<div class="btnrow">${btn('relinkMarker', 'relink white light…', 'primary')}</div>`;
    }
    h += `<div class="row"><label>show</label><select data-k="view" data-t="str">` +
         [['signal', 'the signal'], ['marker', 'the white light'], ['merge', 'both, multiplied'],
          ['ladder', 'the signal, ladder lane in white light']]
           .map(([v, t]) => `<option value="${v}"${n.view === v ? ' selected' : ''}>${t}</option>`).join('') +
         `</select></div>`;
    if (n.view === 'merge') {
      h += `<div class="note">A composite: the white light multiplied onto the signal, on the
            signal’s grid. It shows the prestained ladder where it really ran beside the
            bands, and the record declares it as a composite.</div>`;
    }
    if (n.view === 'ladder') {
      const nl = n.lanes.filter(l => !l.excised && l.role === 'ladder').length;
      h += `<div class="note${nl ? '' : ' warn'}">The lane${nl === 1 ? '' : 's'} marked
            <b>ladder</b> in the list below ${nl === 1 ? 'is' : 'are'} drawn from the white
            light; every other lane is the signal, untouched and unmultiplied. The two
            pictures are one frame, so the lane lands where the lane is. This is a
            composite and the record says which lane came from where.
            ${nl ? '' : 'No lane is marked <b>ladder</b> yet, so nothing is being replaced.'}</div>`;
    }
    h += `<div class="row tight"><label>white light</label>${ctl('marker.levels.black', NUM, 'step="16" title="black point"')}
          ${ctl('marker.levels.white', NUM, 'step="16" title="white point"')}</div>
          <div class="btnrow"><label class="chk" title="for a white-light export that came out light-on-dark">
          ${ctl('marker.levels.invert', BOOL)} invert</label>${btn('markerAuto', 'auto')}${btn('markerApply', 'apply', 'primary')}</div>`;
  } else if (blot && src) {
    h += `<div class="note">The prestained ladder shows in the <b>white-light</b> picture and
          not in the chemiluminescence. Load the white-light image of this membrane — taken
          in the same frame, at the same session — and the size standards are read from
          it.</div>`;
  }
  h += row('panel is', 'kind', 'sel', opts(['SDS-PAGE', 'native PAGE', 'western blot',
    'Coomassie gel', 'silver stain', 'in-gel fluorescence', 'dot blot'], n.kind));
  h += row('title', 'title', STR);

  h += `<details class="fold" ${src && !n.crop ? 'open' : ''}><summary>crop, rotate, contrast</summary>`;
  const cropping = mode === 'crop' && pending && pending.node === n.id;
  h += `<div class="btnrow">${btn('cropDrag', cropping ? 'done' : 'crop…', cropping ? 'primary' : '')}${btn('autoCrop', 'find the gel')}${btn('cropReset', 'full frame')}
        ${btn('rot90', '⟳ 90°')}${btn('flipH', '⇋')}</div>`;
  if (src) {
    h += `<div class="row"><label>angle °</label>${ctl('tilt', NUM, 'step="0.1" min="-45" max="45"')}</div>`;
    h += `<div class="btnrow">${btn('straighten', 'straighten')}${btn('tiltZero', 'square')}</div>`;
    const pair = gelLevelTilt(n);
    h += `<div class="note">Clockwise degrees, on top of the quarter turns. <b>straighten</b> ` +
         (pair !== null
           ? `levels the two ladders: it turns the picture by ${r2(-pair)}°, which puts each size
              marked in both at one height.`
           : `reads the rows of bands and lays them level. Mark the same sizes on a second
              ladder and it levels those two instead, which is the better measurement.`) +
         ` The picture is resampled — the frame keeps the crop’s own size, so the corners
           go and everything on it keeps its place — and the record says by how much.</div>`;
    h += `<div class="row"><label>show</label><label class="chk">${ctl('showAll', BOOL)} the whole picture</label></div>`;
    h += `<div class="note">A panel is normally cut to its block of lanes, because what lies beyond
          the outermost lane is scanner bed. Ticked, it is drawn to the picture’s own edges instead
          — which is what a whole blot for the supplementary sheet has to show.</div>`;
    if (n.cropBox) {
      h += `<div class="row"><label>region used</label><label class="chk">${ctl('showCrop', BOOL)} outline it</label></div>`;
      h += `<div class="note">The part of this blot the figure shows, drawn as it really sits — four
            corners, so a panel turned to level it outlines the region the figure uses rather than a
            larger upright box around it.</div>`;
    }
  }
  if (src) {
    h += `<div class="hist" id="hist"></div>`;
    h += `<div class="row tight"><label>black</label>${ctl('levels.black', NUM, `step="${src.bits === 8 ? 1 : 16}"`)}
          <label>white</label>${ctl('levels.white', NUM, `step="${src.bits === 8 ? 1 : 16}"`)}</div>`;
    h += row('γ', 'levels.gamma', NUM, 'step="0.05" min="0.1" max="4"');
    h += row('invert', 'levels.invert', BOOL);
    h += `<div class="btnrow">${btn('autoLevels', 'auto')}${btn('fullLevels', 'full range')}${btn('applyLevels', 'apply', 'primary')}</div>`;
    h += `<div class="note">Adjusted for the whole panel at once, on the original
          ${src.bits}-bit data. γ ≠ 1 is a non-linear adjustment and has to be declared.</div>`;
  }
  h += `</details>`;

  h += `<details class="fold" ${n.href ? 'open' : ''}><summary>lanes</summary>`;
  h += `<div class="row"><label>how many</label><input type="number" id="nLanes" min="1" max="40"
        value="${n.lanes.length || 10}" step="1"><button data-act="relayLanes">set</button>
        <button data-act="evenLanes" title="Keep these lanes, make them one pitch">even up</button></div>`;
  if (isBlot(n) || n.stripNote) {
    h += `<div class="row"><label>side margin</label>${ctl('margin', NUM, 'step="0.1" min="0" max="3"')}
          <span class="derived">lanes</span></div>`;
    h += `<div class="note">A piece with no comb has no wells to read the block off, so the
          lanes are laid across the whole of it — and laid edge to edge, two of ten lanes
          are the blank strip down each side. This is that strip, in lanes: ten lanes at
          half a lane of margin is eleven pitches across the piece. Applies when the lanes
          are found.</div>`;
  }
  h += `<div class="row tight"><label>lean L / R</label>${ctl('leanL', NUM, 'step="1"')}
        ${ctl('leanR', NUM, 'step="1"')}</div>`;
  h += `<div class="btnrow">${btn('leanAuto', n.leanManual ? 're-measure lean' : 'measured')}
        ${btn('leanZero', 'upright')}</div>`;
  const fan = r2((n.leanR || 0) - (n.leanL || 0));
  if (Math.abs(fan) > 4) {
    h += `<div class="note">The lanes fan: the block is ${r2(Math.abs(fan))} px
          ${fan > 0 ? 'wider' : 'narrower'} at the bottom than at the top.</div>`;
  }
  h += `<div class="note">Drag a boundary on the canvas to nudge it, or
        <b>shift-drag</b> one to change the angle — of the left or right side, whichever
        you grabbed nearer. <b>lean</b> is how far the lanes drift sideways from top to
        bottom, in source pixels; the two sides differ because gels fan. Measured off the
        scan when the lanes are found, and yours to correct. Click a lane to jump to its
        row.</div>`;
  h += `<div class="lanes">`;
  n.lanes.forEach((l, i) => {
    const d = n.density && n.density[i];
    h += `<div class="lane ${l.excised ? 'cut' : ''} ${inspectorFocusLane === l.id ? 'on' : ''}" data-lane="${l.id}">
        <span class="n">${i + 1}</span>
        <input class="lbl" data-lane="${l.id}" data-lk="label" value="${esc(l.label)}"
               placeholder="${l.role === 'SEC fraction' ? 'fraction' : 'label'}"
               title="${l.role === 'SEC fraction'
                 ? 'The fraction this lane holds, as the collector labeled it — this is what the brace ties to the chromatogram'
                 : 'What this lane is called under the gel'}">
        <select data-lane="${l.id}" data-lk="role">${opts(LANE_ROLES, l.role)}</select>
        <button data-act="cut" data-lane="${l.id}" title="${l.excised ? 'put this lane back' : 'excise this lane and mark the splice'}">${l.excised ? '↺' : '✂'}</button>
        ${i > 0 ? `<button data-act="splitAt" data-lane="${l.id}" title="cut the gel in two here — ${
          SEAM_ROLES.includes(l.role) ? `this ${l.role} lane goes to neither part`
                                      : 'this lane starts the second part'}">∥</button>` : ''}
      </div>`;
    if (d && !l.excised) h += `<div class="note" style="margin:-2px 0 3px 22px">${(d.fraction * 100).toFixed(1)}% of gel density</div>`;
  });
  h += `</div>`;
  h += `<div class="btnrow">${btn('lanesAZ', 'label A,B,C…')}${btn('lanesNum', 'label 1,2,3…')}${btn('lanesFrac', 'label from fractions…')}</div>`;
  h += row('label pt', 'labelPt', NUM, 'step="0.5" min="3"');
  h += row('label angle', 'labelAngle', NUM, 'step="15" min="0" max="90"');
  h += row('number lanes', 'showNumbers', BOOL);
  h += `</details>`;

  h += `<details class="fold" open><summary>size standards</summary>`;
  h += `<div class="btnrow">${btn('findLadder', 'find the rungs', 'primary')}
        ${btn('pickLadder', 'click bands')}${btn('ladderPreset', 'sizes…')}</div>`;
  h += `<div class="note">Mark a lane as <b>ladder</b> in the list above and the rungs are
        found for you${msrc ? ' — in the white-light image, where the prestained ladder is' : ''}.
        Sizes are the one thing the scan cannot tell you — type them, or use <b>sizes…</b>
        to fill them from the top down.</div>`;
  if (n.ladder.marks.length && n.ladder.from) {
    h += `<div class="status">rungs read off the ${n.ladder.from === 'white light' ? 'white-light image' : 'signal'}</div>`;
  }
  if (n.ladder.marks.length) {
    h += `<div class="lanes">`;
    n.ladder.marks.forEach((m, i) => {
      h += `<div class="lane"><span class="n">${i + 1}</span>
        <input class="lbl" data-mark="${i}" data-mk="kDa" type="number" step="0.1" value="${m.kDa || ''}" placeholder="kDa">
        <button data-act="delMark" data-mark="${i}">✕</button></div>`;
    });
    h += `</div>`;
  }
  if (n.fit) h += `<div class="status">log₁₀(kDa) vs Rf: r² = ${n.fit.r2.toFixed(3)} from ${n.fit.n} marks` +
                  (n.fit.r2 < 0.98 ? ` — poor, read sizes off the ladder rather than off the fit` : '') + `</div>`;
  h += row('show marks', 'ladder.on', BOOL);
  h += row('side', 'ladder.side', 'sel', opts(['left', 'right', 'both'], n.ladder.side));
  h += row('mark pt', 'ladder.pt', NUM, 'step="0.5" min="3"');
  h += row('bar mm', 'ladder.lw', NUM, 'step="0.05" min="0.05" max="2" placeholder="0.22"');
  h += `</details>`;

  h += stripsInspector(n);
  h += quantifyInspector(n);

  h += `<details class="fold"><summary>band labels</summary>`;
  h += `<div class="btnrow">${btn('pickBand', 'click a band')}</div>`;
  n.bands.forEach((b, i) => {
    const mw = gelMwLabel(n, b.y);
    h += `<div class="lane"><span class="n">${i + 1}</span>
      <input class="lbl" data-band="${b.id}" value="${esc(b.label)}" placeholder="${mw || 'label'}">
      <button data-act="delBand" data-band="${b.id}">✕</button></div>`;
  });
  h += `</details>`;

  h += `<details class="fold"><summary>splice marking</summary>`;
  h += row('gap mm', 'splice.gap', NUM, 'step="0.1" min="0"');
  h += row('rule line', 'splice.rule', BOOL);
  h += row('rule mm', 'splice.ruleMm', NUM, 'step="0.05"');
  h += `<div class="note">Excised lanes leave a marked discontinuity. Turning the rule
        off leaves a gap a reader cannot distinguish from layout — the manifest
        will say so.</div>`;
  h += `</details>`;

  h += `<details class="fold"><summary>what this blot is</summary>`;
  h += row('acrylamide', 'acrylamide', STR, 'placeholder="4–20% gradient"');
  h += row('reducing', 'reducing', BOOL);
  h += row('stain', 'stain', STR, 'placeholder="InstantBlue"');
  h += row('primary Ab', 'antibody', STR, 'placeholder="anti-FLAG M2, 1:2000"');
  h += row('secondary', 'secondary', STR);
  h += row('detection', 'detection', STR, 'placeholder="ECL, 30 s"');
  h += row('exposure', 'exposure', STR);
  h += row('membrane id', 'membraneId', STR, 'placeholder="M1"');
  h += row('strip note', 'stripNote', STR, 'placeholder="upper half, cut at 50 kDa"');
  h += `<div class="note">Panels sharing a <b>membrane id</b> are reported as strips of
        one membrane, cut before probing. Panels sharing a source file are reported
        as regions of one image.</div>`;
  h += `</details>`;

  h += row('frame', 'frame', BOOL);
  return h;
}

/** Panels that get the white-light slot: the kinds imaged on a membrane or in
 *  a gel imager, where a second picture of the same frame is what there is. */
const isBlot = n => ['western blot', 'dot blot', 'in-gel fluorescence'].includes(n.kind) || !!n.marker;

/** Strips: only some sizes of the membrane, each shown as its own strip. */
function stripsInspector(n) {
  let h = `<details class="fold"${n.strips.length ? ' open' : ''}><summary>strips — only some sizes</summary>`;
  h += `<div class="btnrow">${btn('sliceKDa', 'slice by size…', n.strips.length ? '' : 'primary')}
        ${btn('stripAdd', '+ strip')}${n.strips.length ? btn('stripsClear', 'whole gel') : ''}</div>`;
  if (!n.strips.length) {
    h += `<div class="note">Show only the sizes each antibody is about — the target at 75–50 kDa,
          the loading control at 45–35 — as separate strips, one above the other. The sizes
          are read off the ladder${n.marker ? ' in the white light' : ''}; the rest of the
          membrane stays in the source data.</div>`;
  }
  const sized = gelSizedMarks(n).length >= 2;
  n.strips.forEach((s, i) => {
    const at = y => (y <= 0.5 ? 'top' : y >= (n.imgH || 0) - 0.5 ? 'bottom'
                     : (v => (v === null ? `row ${Math.round(y)}` : kDaStr(v)))(gelKDaAtY(n, y)));
    h += `<div class="lane"><span class="n">${i + 1}</span>
      <input class="lbl" data-strip="${s.id}" data-sk="label" value="${esc(s.label || '')}" placeholder="antibody">
      <input class="lbl num" data-strip="${s.id}" data-sk="from" value="${esc(at(s.y0))}" title="top edge — a size, or “top”">
      <input class="lbl num" data-strip="${s.id}" data-sk="to" value="${esc(at(s.y1))}" title="bottom edge — a size, or “bottom”">
      <button data-act="stripDel" data-strip="${s.id}" title="remove this strip">✕</button></div>`;
    const inside = gelSizedMarks(n).filter(m => m.y >= s.y0 - 1e-6 && m.y <= s.y1 + 1e-6);
    if (sized && !inside.length) {
      h += `<div class="note warn" style="margin-left:20px">No rung of the ladder falls in this strip,
            so nothing on it says what size it shows. Widen it to take in a rung.</div>`;
    }
  });
  if (n.strips.length) {
    h += row('gap mm', 'stripGap', NUM, 'step="0.2" min="0"');
    h += row('labels at', 'stripLabelSide', 'sel', opts(['right', 'left'], n.stripLabelSide));
    h += `<div class="note">Type sizes in kDa, or drag a strip’s top or bottom edge on the canvas.
          Every strip is at the gel’s own scale, so the height handle still sizes them all together.</div>`;
  }
  return h + `</details>`;
}

const fmtVol = v => (!isFinite(v) ? '—' : Math.abs(v) >= 1e4 || (Math.abs(v) < 0.01 && v !== 0)
                     ? v.toExponential(2).replace('e+', 'e') : String(r2(v)));

/** Quantifying: rows of boxes, one row per protein, and what they measure. */
function quantifyInspector(n) {
  const q = n.quant, src = source(n.src);
  const armed = mode === 'pick' && pending && pending.pick === 'quant' && pending.node === n.id ? pending.extra : null;
  let h = `<details class="fold"${q.rows.length ? ' open' : ''}><summary>quantify bands</summary>`;
  if (!q.rows.length) {
    h += `<div class="note">Add a row for the protein you are measuring, and one for the loading
          control, then click each band. The first click sets the box to the band; every lane
          after it gets a box of the same height, so they are comparable. Shift-click measures
          the band in every lane at once, and a box can be dragged up or down afterwards if the
          search landed on the wrong row.</div>`;
  }
  q.rows.forEach(r => {
    const col = quantColour(n, r);
    const nb = q.bands.filter(b => b.row === r.id).length;
    const rb = (act, label, cls = '', tip = '') =>
      `<button data-act="${act}" data-row="${r.id}" class="${cls}" title="${tip}">${label}</button>`;
    h += `<div class="lane${armed === r.id ? ' on' : ''}">
      <span class="swatch" style="background:${col}"></span>
      <input class="lbl" data-qrow="${r.id}" data-qk="name" value="${esc(r.name || '')}" placeholder="protein">
      <select data-qrow="${r.id}" data-qk="role" title="what this row is" class="role">
        <option value="target"${r.role === 'target' ? ' selected' : ''}>target</option>
        <option value="loading control"${r.role === 'loading control' ? ' selected' : ''}>control</option></select>
      <input class="lbl num" data-qrow="${r.id}" data-qk="h" value="${r.h ?? ''}" placeholder="auto"
             title="box height in px — one height for every lane in this row">
      ${rb('qRowDel', '✕', '', 'remove this row and its boxes')}
    </div>
    <div class="btnrow" style="margin-left:20px">
      ${rb('qPick', armed === r.id ? 'done' : 'click bands', armed === r.id ? 'primary' : '',
           'click this protein’s band in each lane; shift-click for every lane')}
      ${rb('qEvery', 'every lane', '', 'the same band in every lane not yet measured')}
      ${nb ? rb('qClear', 'clear', '', 'remove this row’s boxes') : ''}
    </div>`;
  });
  const anyWhole = q.bands.some(b => b.row === WHOLE_LANE);
  h += `<div class="btnrow">${btn('qRowAdd', '+ target')}${btn('qCtrlAdd', '+ loading control')}` +
       `<button data-act="qWhole" title="${anyWhole ? 'remove the whole-lane boxes' :
          'measure every lane floor to ceiling, so the target band can be given as a fraction of it'}">` +
       `${anyWhole ? 'no whole lanes' : 'whole lanes'}</button>` +
       (q.bands.length ? btn('qRemeasure', 'measure again') : '') + `</div>`;

  if (q.bands.length) {
    const rows = q.rows;
    const ctrl = rows.find(r => r.role === 'loading control');
    const targets = rows.filter(r => r !== ctrl);
    h += `<div class="qtable"><table><tr><th></th><th>lane</th>` +
         rows.map(r => `<th style="color:${quantColour(n, r)}">${esc(r.name || r.role)}</th>`).join('') +
         (ctrl ? targets.map(r => `<th title="${esc(r.name || 'target')} ÷ ${esc(ctrl.name || 'control')}">` +
                                  `${targets.length > 1 ? esc(r.name || 'target') + ' ' : ''}÷ ctrl</th>`).join('') : '') +
         (anyWhole ? `<th title="the target band over the whole of its lane">purity</th>` : '') +
         `</tr>`;
    gelQuantLanes(n).forEach(x => {
      if (!rows.some(r => x.by[r.id])) return;
      h += `<tr><td class="n">${x.index + 1}</td><td>${esc(x.lane.label || '')}</td>` +
           rows.map(r => {
             const b = x.by[r.id];
             if (!b) return '<td></td>';
             const flag = b.sat ? ' <b class="bad" title="saturated pixels in this box">sat</b>'
                        : b.weak ? ' <b class="warn" title="no band stood out of the noise here">?</b>'
                        : b.edge ? ' <b class="warn" title="the box runs off the picture">edge</b>' : '';
             return `<td>${fmtVol(b.net)}${flag}</td>`;
           }).join('') +
           (ctrl ? targets.map(r => `<td>${x.ratios[r.id] !== undefined ? r3(x.ratios[r.id]) : ''}</td>`).join('') : '') +
           (anyWhole ? `<td>${x.purity === null ? '' : `${x.purity >= 10 ? Math.round(x.purity) : r2(x.purity)}%`}</td>` : '') +
           `</tr>`;
    });
    h += `</table></div>`;
    const sat = q.bands.filter(b => b.sat).length;
    if (sat) {
      h += `<div class="note warn">${sat} box${sat === 1 ? ' has' : 'es have'} saturated pixels in
            ${sat === 1 ? 'it' : 'them'} — the detector ran out, so the band held more than it
            recorded and any ratio built on it is wrong. A shorter exposure is the fix; the
            quantification leaves ${sat === 1 ? 'it' : 'them'} out unless told otherwise.</div>`;
    }
    if (src && src.bits === 8) {
      h += `<div class="note warn">This is an 8-bit image: 256 levels, and whatever the exporting
            software did to them first. Measure the imager’s own 16-bit file if you have it.</div>`;
    }
    if (src && /\.jpe?g$/i.test(src.name || '')) {
      h += `<div class="note warn">A JPEG has been compressed lossily — the numbers in it are
            not the ones the camera recorded.</div>`;
    }
  }
  if (anyWhole) {
    h += `<div class="note">Purity is this lane's target band over the whole of the lane,
          measured the same way with the same background rule. It is a fraction of the
          <b>stain</b>: dye per milligram differs between proteins, anything that does not
          stain is not in it, and anything that ran off the bottom is not either. Name a lane
          the way a step is named in a purification table and the number goes there.</div>`;
  }
  h += row('background', 'quant.method', 'sel', opts(['border', 'profile'], q.method));
  h += `<div class="row tight"><label>border px</label>${ctl('quant.border', NUM, 'step="1" min="1" max="20" title="height of the strip above and below each box"')}
        <label>inset</label>${ctl('quant.inset', NUM, 'step="0.05" min="0" max="0.45" title="fraction of the lane left out at each side"')}</div>`;
  h += `<div class="note">Measured on the original ${src ? src.bits + '-bit ' : ''}data: the display
        window and γ shape the figure and never a number. <b>border</b> takes the background from
        a thin strip just above and below each box in its own lane; <b>profile</b> from a rolling
        minimum down the lane, which copes better with a smear.</div>`;
  const qp = doc.nodes.filter(x => x.type === 'quant' && x.gels.includes(n.id));
  h += `<div class="btnrow">${qp.length ? btn('qOpenPanel', 'go to the quantification')
                                        : btn('qNewPanel', 'quantify replicates…', q.bands.length ? 'primary' : '')}</div>`;
  return h + `</details>`;
}

/* ---- quantification panel ---- */

function quantInspector(n) {
  const D = quantData(n);
  let h = '';
  h += row('title', 'title', STR);
  h += `<details class="fold" open><summary>blots</summary>`;
  if (!D.gels.length) {
    h += `<div class="note">Each blot is one replicate. <b>Drag a blot onto this graph</b> to add
          it — it goes back where it was and joins the list. The first is usually the one shown in
          the figure; the others can live on the pasteboard beside the page, where they are
          measured like any other panel and left out of the export.</div>`;
  }
  D.gels.forEach((g, i) => {
    const nb = g.quant.bands.length;
    h += `<div class="lane"><span class="n" title="its points are drawn as ${esc(markShapeName(i))}s">${i + 1}</span>
      <span class="lbl grow" title="${esc(repName(g, i))}${offPage(g) ? ' — on the pasteboard, not in the figure' : ' — in the figure'}">${esc(repName(g, i))}</span>
      <span class="derived tight" title="boxes measured on this blot">${nb || 'none'}</span>
      <button data-act="qnSelGel" data-gel="${g.id}" title="go to this blot">→</button>
      <button data-act="qnDelGel" data-gel="${g.id}" title="take it out of this quantification">✕</button></div>`;
    if ((n.readout || 'intensity') === 'intensity' && n.useControl !== false) {
      const cg = quantControlGel(n, i);
      const others = doc.nodes.filter(x => x.type === 'gel' && x.id !== g.id && !n.gels.includes(x.id));
      h += `<div class="row sub"><label>its control</label><select data-act="qnCtrlGel" data-i="${i}">` +
           `<option value="">on the blot itself</option>` +
           others.map(x => `<option value="${x.id}"${cg && cg.id === x.id ? ' selected' : ''}>${esc(repName(x, -1))}</option>`).join('') +
           (cg && !others.some(x => x.id === cg.id) ? `<option value="${cg.id}" selected>${esc(repName(cg, -1))}</option>` : '') +
           `</select></div>`;
    }
  });
  if (D.reps.some(r => r.control)) {
    h += `<div class="note">A loading control probed as its own exposure is its own panel, and the
          lanes are matched to the blot's the same way they are matched between blots. The panel it
          reads is left out of the figure unless you place it there.</div>`;
  }
  const spare = doc.nodes.filter(x => x.type === 'gel' && !n.gels.includes(x.id));
  h += `<div class="btnrow">${btn('qnLoadRep', 'load replicate…', 'primary')}` +
       (spare.length ? `<select id="qnAddGel"><option value="">add a panel…</option>` +
         spare.map(g => `<option value="${g.id}">${esc(repName(g, 0))}</option>`).join('') + `</select>` : '') +
       `</div>`;
  if (D.gels.length) {
    h += `<div class="note">Drag another blot onto the graph to add it, or use the menu. A replicate
          loaded with the button arrives on the pasteboard with the first blot’s lanes, labels and
          rows already set: drag its outer lane boundaries into place, then click its bands.</div>`;
  }
  h += `</details>`;

  if (D.gels.length) {
    const names = role => [...new Set(D.gels.flatMap(g => g.quant.rows
      .filter(r => (role === 'loading control') === (r.role === 'loading control')).map(r => r.name || '')))];
    h += `<details class="fold" open><summary>what is compared</summary>`;
    h += `<div class="row"><label>target</label><select data-k="target" data-t="str">` +
         `<option value="">${esc(D.target || 'the first target row')}</option>` +
         names('target').filter(Boolean).map(s => `<option${s === n.target ? ' selected' : ''}>${esc(s)}</option>`).join('') +
         `</select></div>`;
    h += `<div class="row"><label>measure</label><select data-k="readout" data-t="str">` +
         [['intensity', 'how much — signal'], ['share', 'how much of the protein — % of all its bands'],
          ['size', 'how far — apparent size in kDa']]
           .map(([v, t]) => `<option value="${v}"${(n.readout || 'intensity') === v ? ' selected' : ''}>${t}</option>`).join('') +
         `</select></div>`;
    if (n.readout === 'share') {
      h += `<div class="note">Every target row on a blot adds up to 100% in each lane, and this
            one’s percentage of it is what is plotted — a precursor, an intermediate and a mature
            form, or a modified band against the unmodified one. How much was loaded cancels
            inside the lane, so there is no loading control and nothing is set to 1; a loading
            control row is still ignored. Measure every band of the protein in every lane, or the
            lanes are percentages of different things.</div>`;
    }
    if (n.readout === 'size') {
      h += `<div class="note">Read off each blot’s own ladder, at the row the band was found on,
            between the two rungs either side. Nothing divides it and nothing is set to 1 — a
            size is not a ratio — so the blots need their sizes typed before this says anything.
            The axis does not start at zero, because a size is a scale and not an amount.</div>`;
    }
    if ((n.readout || 'intensity') === 'intensity') h += `<div class="row"><label>÷ loading ctrl</label><select id="qnControl">` +
         `<option value="">${esc(D.control && n.useControl !== false && !n.control ? D.control : 'the first control row')}</option>` +
         names('loading control').filter(Boolean).map(s =>
           `<option${n.useControl !== false && s === n.control ? ' selected' : ''}>${esc(s)}</option>`).join('') +
         `<option value="__none"${n.useControl === false ? ' selected' : ''}>nothing — raw signal</option></select></div>`;
    if ((n.readout || 'intensity') === 'intensity') {
      h += `<div class="row"><label>relative to</label><select id="qnRel">` +
         `<option value="ref"${n.norm === 'ref' ? ' selected' : ''}>the controls below, in each blot</option>` +
         `<option value="mean"${n.norm === 'mean' ? ' selected' : ''}>the mean of each blot</option>` +
         `<option value="none"${n.norm === 'none' ? ' selected' : ''}>nothing</option></select></div>`;
      // Several may be ticked: two wild-type donors are one control, and the
      // blot is divided by their mean rather than by whichever came first.
      if (n.norm === 'ref') h += `<div class="row wrap"><label>control</label>` +
         D.conditions.map(c => `<label class="chk"><input type="checkbox" class="qnRef" ` +
           `data-cond="${esc(c)}"${(D.refs || []).includes(c) ? ' checked' : ''}> ${esc(c)}</label>`).join('') +
         `</div>`;
    }
    h += row('lanes match', 'match', 'sel', opts(['label', 'position'], n.match));
    if (D.repeated.length) {
      h += row('repeated lanes', 'repeats', 'sel',
               `<option value="separate">are replicates</option>` +
               `<option value="averaged">are one measurement</option>`);
      h += `<div class="note">${esc(D.repeated.join('; '))}. Two lanes of one condition on one blot are
            two preparations run side by side, or one preparation loaded twice — the first is a
            replicate and counts towards n, the second is a repeat measurement of the same thing and
            is averaged into one point. Nothing in the picture tells them apart, so this says which.
            Either way the blot is normalised by their mean.</div>`;
    }
    h += `<div class="row tight"><label>error bars</label>${ctl('error', 'sel', opts(['sd', 'sem'], n.error))}
          <label class="chk">${ctl('bars', BOOL)} bars</label>
          <label class="chk">${ctl('points', BOOL)} points</label>
          <label class="chk">${ctl('box', BOOL)} box</label></div>`;
    if (n.readout !== 'size') {
      h += `<div class="row"><label>saturated</label><label class="chk">${ctl('keepSaturated', BOOL)} keep them</label></div>`;
      if (!n.keepSaturated) h += `<div class="row"><label>allowed %</label>${ctl('satTol', NUM,
        'step="1" min="0" max="100" title="a lane is left out when more than this much of a box sits at the camera\'s limit; a pixel or two costs the integral less than the background estimate does"')}</div>`;
    }
    if ((n.readout || 'intensity') === 'intensity' && n.norm === 'none' && D.gels.length > 1) {
      h += `<div class="note warn">Nothing is set to 1, so each blot keeps its own exposure — the
            points from different blots are not on one scale, and a mean across them is not a
            mean of one quantity.</div>`;
    }
    if ((n.readout || 'intensity') === 'intensity' && n.norm === 'ref') {
      h += (D.refs || []).length > 1
        ? `<div class="note">Each blot is divided by ${esc(D.ref)} on that blot, so those bars
            average 1 by construction — what is left of their spread is how far apart the
            controls are, and the rest of it has gone into every other bar.</div>`
        : `<div class="note">Each blot is divided by its own ${esc(D.ref || 'reference')} lane, so
            that bar is 1 with no spread by construction — its variation has gone into every
            other bar.</div>`;
    }
    h += `</details>`;

    h += `<details class="fold" open><summary>the numbers</summary>`;
    h += `<div class="qtable"><table><tr><th>condition</th><th>n</th><th>mean</th>` +
         `<th>${n.error === 'sem' ? 'SEM' : 'SD'}</th>` +
         D.reps.map((rep, i) => `<th title="${esc(rep.name)}">${i + 1}</th>`).join('') + `</tr>`;
    D.conditions.forEach(c => {
      const s = D.summary[c];
      const e = n.error === 'sem' ? s.sem : s.sd;
      h += `<tr><td>${esc(c)}</td><td>${s.n}</td><td>${isFinite(s.mean) ? r3(s.mean) : '—'}</td>` +
           `<td>${isFinite(e) ? r3(e) : ''}</td>` +
           D.reps.map(rep => {
             const v = rep.vals[c];
             const row = rep.rows.find(x => x.key === c);
             if (v && D.separate && v.each.length > 1) {
               const each = v.eachNorm.filter(isFinite);
               if (each.length) return `<td title="${each.length} lanes on this blot, counted separately">` +
                                       `${each.map(r3).join(' · ')}</td>`;
             }
             if (v && isFinite(v.norm)) return `<td>${r3(v.norm)}</td>`;
             return `<td class="dim" title="${esc(row ? row.why.join('; ') : 'not measured')}">${row && row.dropped ? 'out' : '—'}</td>`;
           }).join('') + `</tr>`;
    });
    h += `</table></div>`;
    D.excluded.forEach(s => { h += `<div class="note warn">Left out: ${esc(s)}.</div>`; });
    D.issues.forEach(s => { h += `<div class="note warn">${esc(s)}.</div>`; });
    if (D.gels.length < 3) {
      const most = Math.max(0, ...D.conditions.map(c => D.summary[c].n));
      h += `<div class="note">${D.gels.length === 1 ? 'One blot' : 'Two blots'}` +
           (most > D.gels.length
             ? `, ${most} points at most — lanes of one blot are not independent of one another,
                however they were loaded, so this is not ${most} replicates.`
             : `: a mean of ${D.gels.length === 1 ? 'one is a single measurement'
                                                 : 'two has a spread that means little'}.`) +
           ` Three independent blots is the usual minimum.</div>`;
    }
    h += `<div class="btnrow">${btn('qnNumbers', 'numbers…')}</div>`;
    h += `</details>`;
  }

  const barMm = quantBarMm(n), pinned = barMm > 0;
  // The width shown has to be the width that will be drawn, not the one left
  // over from before the conditions changed: `quantFit` is what the renderer
  // uses, and `D` is already in hand.
  quantFit(n, D.conditions.length);

  // Across, the conditions pin the height and the value axis is the width, so
  // which box is a readout and which number is "the axis" swap over.
  const across = !!n.horizontal, vKey = across ? 'w' : 'h', vLen = n[vKey] || 0;
  h += `<details class="fold"><summary>axes</summary>`;
  h += row('y label', 'ylabel', 'area', `placeholder="${esc(quantYLabel({ ...n, ylabel: '' }, D))}"`);
  h += `<div class="row"><label class="chk">${ctl('horizontal', BOOL)} bars across</label></div>`;
  // Pinned, the bars' axis would be overwritten by the next draw, so it is
  // shown as what it is: a readout, not a control.
  const box = k => (pinned && k !== vKey)
    ? `<span class="derived tight" title="set by the bar width, below">${r2(n[k])} mm</span>`
    : ctl(k, NUM, 'step="1"');
  h += `<div class="row tight"><label>w</label>${box('w')}<label>h</label>${box('h')}</div>`;
  // The value axis is read against the next panel, so it is the same length in
  // every one of them or the figure carries two scales -- the other half of
  // the bar-width rule.  Said here because it stays typeable: a panel really
  // does sometimes want to be longer, and this is the number it starts from.
  if (Math.abs(vLen - 30.48) > 0.05)
    h += `<div class="note">The plot is <b>${r2(vLen)} mm</b> of ${across ? 'x' : 'y'}, not the
          <b>30.48 mm</b> (1.2 in) a new panel gets. Two panels of one figure
          want the same length, or the same difference looks bigger in one
          of them.</div>`;
  h += row('font pt', 'fontPt', NUM, 'step="0.5"');
  h += `</details>`;

  h += `<details class="fold"><summary>bars</summary>`;
  h += row('bar mm', 'barMm', NUM, `step="0.5" min="0" value="${r2(barMm)}"`);
  h += `<div class="note">${pinned
    ? `One bar is this wide on the page whatever the condition count, and the panel
       is only as wide as the bars need. That is what makes two panels of one figure
       comparable. <b>0</b> stretches them across <b>w</b> instead.`
    : `The bars stretch across <b>w</b>, so the same bar is one width beside two
       conditions and another beside seven — two panels of a figure then carry two
       scales. Type a width in mm to fix it.`}</div>`;
  h += row('colors', 'palette', 'sel',
           `<option value=""${n.palette ? '' : ' selected'}>one color</option>` +
           opts(Object.keys(LK.PALETTES), n.palette));
  // A condition named in `colours` is that color whatever the palette says, so
  // the swatches have to be shown for those too or the panel looks unexplained.
  const named = Object.keys(n.colours || {}).filter(c => D.conditions.includes(c));
  if (!n.palette && !named.length) {
    h += row('bar color', 'barFill', COL);
  } else {
    h += `<div class="row"><label>order</label><span class="swatches">` +
         D.conditions.map((c, i) => `<i class="sw" style="background:${esc(quantFillFor(n, c, i))}" ` +
           `title="${esc(c)} — ${esc(quantFillFor(n, c, i))}"></i>`).join('') +
         `</span></div>`;
    h += `<div class="note">${named.length
      ? `${named.length} of the conditions are colored by name — ${esc(named.join(', '))} —
         which beats the palette and the one bar color. The rest take ${n.palette
           ? `the scheme's colors in plot order` : `the bar color`}.`
      : `The conditions take the scheme's colors in the order they are
         plotted — the same wheel an exported figure uses, so the panel on the canvas is
         the color the figure will be.`}</div>`;
  }
  h += `</details>`;
  return h;
}

/* ---- chromatogram ---- */

function chromInspector(n) {
  let h = '';
  h += `<div class="btnrow">${btn('pickChrom', n.source ? 'change run…' : 'load run…', 'primary')}${btn('pasteCsv', 'paste CSV…')}</div>`;
  h += row('title', 'title', STR, 'placeholder="the file\u2019s name"');
  if (n.source) h += `<div class="status">${esc(n.source.split('/').pop())} · ${n.traces.length} curves</div>`;

  h += `<details class="fold" open><summary>curves</summary>`;
  n.traces.forEach(t => {
    h += `<div class="lane">
      <input type="checkbox" data-trace="${t.id}" data-tk="on" ${t.on !== false ? 'checked' : ''}>
      <input class="lbl" data-trace="${t.id}" data-tk="name" value="${esc(t.name)}">
      <input type="color" data-trace="${t.id}" data-tk="color" value="${t.color}" style="flex:0 0 26px;padding:0">
      <select data-trace="${t.id}" data-tk="axis" style="flex:0 0 46px">${opts(['left', 'right'], t.axis)}</select>
    </div>`;
  });
  h += row('normalize', 'normalize', 'sel', opts(['none', 'max'], n.normalise));
  h += row('line mm', 'traceMm', NUM, 'step="0.05"');
  h += `</details>`;

  h += `<details class="fold" open><summary>axes</summary>`;
  h += row('x label', 'xlabel', STR);
  h += row('y label', 'ylabel', STR);
  h += row('y2 label', 'y2label', STR);
  h += row('auto range', 'auto', BOOL);
  if (!n.auto) {
    h += `<div class="row tight"><label>x</label>${ctl('xmin', NUM, 'step="0.5"')}${ctl('xmax', NUM, 'step="0.5"')}</div>`;
    h += `<div class="row tight"><label>y</label>${ctl('ymin', NUM, 'step="1"')}${ctl('ymax', NUM, 'step="1"')}</div>`;
    if (n.traces.some(t => t.axis === 'right'))
      h += `<div class="row tight"><label>y2</label>${ctl('y2min', NUM, 'step="1"')}${ctl('y2max', NUM, 'step="1"')}</div>`;
  }
  h += `<div class="note">${n.auto
    ? 'The range is whatever the traces cover, padded a little. Untick it to set the window — a SEC profile cropped to the peaks, or two columns drawn to one scale.'
    : 'The window the traces are drawn in. Anything outside it is clipped, not rescaled.'}</div>`;
  h += row('font pt', 'fontPt', NUM, 'step="0.5"');
  h += row('spines', 'frame', 'sel', opts(['lb', 'lbr', 'lbrt', 'b', 'l'], n.frame));
  h += `</details>`;

  h += `<details class="fold" open><summary>column & fractions</summary>`;
  h += row('column', 'column.name', 'sel', opts(Object.keys(COLUMNS), n.column.name));
  const F = columnFacts(n.column);
  if (F.bed) {
    h += `<div class="kv">
      <span>bed</span><b>${F.bed}${F.cv ? ` · ${F.cv} mL` : ''}</b>
      ${F.range ? `<span>separates</span><b>${r2(F.range[0] / 1000)}–${r2(F.range[1] / 1000)} kDa</b>` : ''}
      ${F.exclusion ? `<span>excluded above</span><b>${r2(F.exclusion / 1000)} kDa</b>` : ''}
      ${F.flow ? `<span>flow</span><b>${F.flow}${F.flowMax ? ` (max ${F.flowMax})` : ''} mL/min</b>` : ''}
      ${F.plates ? `<span>plates</span><b>${F.plates.toLocaleString()} N/m</b>` : ''}
      ${F.sample ? `<span>sample</span><b>${F.sample[0]}–${F.sample[1]} µL</b>` : ''}
      ${F.code ? `<span>product</span><b>${F.code}</b>` : ''}
    </div>`;
    h += `<div class="note">${F.src === 'datasheet'
      ? `From ${esc(F.ref)}.`
      : F.src === 'catalogue'
        ? `Family characteristics, not from a data file in hand — worth a look at your column's own papers.`
        : ''}</div>`;
  }
  h += `<div class="row tight"><label>V₀ mL</label>${ctl('column.v0', NUM, 'step="0.1"')}
        <label>Vt</label>${ctl('column.vt', NUM, 'step="0.1"')}</div>`;
  if (F.v0From === 'estimate') {
    h += `<div class="note warn">V₀ is an estimate (⅓ of the bed), not a published
          figure — it depends on how your bed settled and drifts as the column ages.
          Kav is measured from it, so every mass on this panel moves with it. Run blue
          dextran and type what you get.</div>`;
  }
  h += `<div class="row tight"><label>flow</label>${ctl('column.flow', NUM, 'step="0.05"')}
        <label>mark</label>${ctl('marks.v0', BOOL)}${ctl('marks.vt', BOOL)}</div>`;
  if (n.inject && n.inject.offset) {
    h += `<div class="row tight"><label>inject mL</label>${ctl('inject.v', NUM, 'step="0.01"')}
          <label>mark</label>${ctl('marks.inject', BOOL)}
          ${btn('rebase', n.inject.rebased ? 'x from method' : 'x from inject')}</div>`;
  }
  h += row('buffer', 'column.buffer', STR, 'placeholder="20 mM HEPES pH 7.5, 150 mM NaCl"');
  h += `<div class="row tight"><label>fraction bar</label>${ctl('fractions.on', BOOL)}
        ${ctl('fractions.side', 'sel', opts(['top', 'bottom'], n.fractions.side || 'top'))}</div>`;
  h += `<div class="row tight"><label>label every</label>${ctl('fractions.every', NUM, 'step="1" min="1"')}
        <label>pt</label>${ctl('fractions.pt', NUM, 'step="0.5" min="2"')}
        ${ctl('fractions.fill', COL)}</div>`;
  h += `<div class="row tight"><label>gel fractions</label>${ctl('fractions.shade', COL)}
        <span class="derived">${(() => { const g = chromShadedFractions(n);
          return g.length ? `${g.length} shaded` : 'none — brace one to a gel'; })()}</span></div>`;
  h += `<div class="note">Mark gel lanes as <b>SEC fraction</b> and number them, then run a
        brace from this panel to that gel: the fractions it holds are shaded here, each over
        its own volume, so a set with holes in it is drawn with the holes.</div>`;
  h += `<div class="row tight"><label>pooled</label>${ctl('fractions.pooled.0', NUM, 'step="0.1" placeholder="from mL"')}
        ${ctl('fractions.pooled.1', NUM, 'step="0.1" placeholder="to"')}</div>`;
  h += `<div class="btnrow">${btn('poolClear', 'no pool')}${btn('fracEven', 'even fractions…')}</div>`;
  h += `</details>`;

  const fitted = n.calib.fit || chromFit(n);
  h += `<details class="fold"${n.calib.on || n.peaks.length ? ' open' : ''}>
        <summary>calibration — molecular weight</summary>`;
  if (!n.calib.standards.length) {
    h += `<div class="note">A mass on this panel comes from standards you ran on this
          column. Pick the kit, press <b>load kit</b>, then type the elution volume
          beside each standard; peak labels can carry the mass from then on.</div>`;
  }
  h += row('show', 'calib.on', BOOL);
  h += row('kit', 'calib.kit', 'sel', opts(Object.keys(STANDARD_KITS), n.calib.kit));
  h += `<div class="btnrow">${btn('kitLoad', 'load kit')}</div>`;
  n.calib.standards.forEach((s, i) => {
    h += `<div class="lane"><span class="n">${s.kDa}</span>
      <input class="lbl" data-std="${i}" value="${esc(s.name)}">
      <input class="lbl" data-std="${i}" data-sk="ve" type="number" step="0.01" value="${s.ve ?? ''}" placeholder="Ve mL" style="flex:0 0 62px">
    </div>`;
  });
  const f = fitted;
  if (f) h += `<div class="status">log₁₀(MW) vs Kav: r² = ${f.r2.toFixed(3)}, ${f.n} standards</div>`;
  else if (n.calib.standards.length) {
    const typed = n.calib.standards.filter(s => nn(s.ve) !== null).length;
    h += `<div class="note">${typed} of ${n.calib.standards.length} elution volumes typed in —
          two is the fewest that will fit a line.</div>`;
  }
  h += `<div class="note">An elution volume is not a mass. The calibration makes the
        panel say what the column was actually asked, and a globular-standard curve
        is only a guide for anything that is not globular.</div>`;

  const constructs = doc.nodes.filter(x => x.type === 'construct' && constructWhole(x).n);
  if (constructs.length) {
    h += row('expected from', 'expect', 'sel',
      `<option value="">nothing marked</option>` +
      constructs.map((c, i) => `<option value="${c.id}"${n.expect === c.id ? ' selected' : ''}>` +
        `${esc(c.title || c.map && c.map.name || `construct ${i + 1}`)}</option>`).join(''));
    const ex = chromExpected(n);
    if (ex.length) {
      h += `<div class="kv">` + ex.map(sp =>
        `<span>${esc(sp.label)}${sp.cleaved ? ' (cut)' : ''}</span>` +
        `<b>${kDa(sp)} at ${r2(sp.ve)} mL</b>`).join('') + `</div>`;
    } else if (n.expect) {
      h += `<div class="note warn">${fitted
        ? 'Every species of that construct is outside the masses the standards cover, so the fit has nothing to say about where it elutes.'
        : 'Nothing to mark yet: an expected volume comes from the standards, and there is no calibration on this column. The rough scale is deliberately not used for this — a mark saying “the monomer is here” is a peak label.'}</div>`;
    }
    h += `<div class="note">The construct's mass, put through this column's own
          calibration: where the chain and each piece it cleaves into <b>should</b> come
          off. A peak that is not on the mark is the result — an oligomer, an aggregate,
          a tag that did not come off — rather than something to work out afterwards.</div>`;
  }

  if (roughFit(n)) {
    h += row('rough scale', 'rough', BOOL);
    h += `<div class="note">With no standards to hand, a dim scale drawn from the
          column's published fractionation range alone — the top of the range at Kav 0,
          the bottom at Kav 1. Against real standards on a Superdex 200 Increase it
          lands within <b>1.7×</b>, and it inherits whatever V₀ is in use, so ±2× is
          the honest claim. It stays off peak labels: reading a mass off a coarse
          scale shows you how coarse it is, printing one beside a peak does not.</div>`;
    if (n.rough && f) {
      h += `<div class="note warn">You have a real calibration from ${f.n} standards.
            The rough scale can only be worse than it — turn it off before this
            figure goes anywhere.</div>`;
    }
  }
  h += `</details>`;

  h += `<details class="fold"${n.peaks.length ? ' open' : ''}><summary>peak labels</summary>`;
  h += `<div class="btnrow">${btn('addPeak', 'add at…')}</div>`;
  if (!n.peaks.length) {
    h += `<div class="note">A peak label is where a mass appears on the figure:
          <b>add at…</b> a volume, then tick <b>kDa</b>.</div>`;
  }
  n.peaks.forEach((p, i) => {
    const mw = chromMwLabel(n, p.v), caveat = chromMwCaveat(n, p.v);
    h += `<div class="lane"><span class="n">${r2(p.v)}</span>
      <input class="lbl" data-peak="${i}" value="${esc(p.label)}" placeholder="label">
      <span class="derived">${mw || ''}</span>
      <button data-act="delPeak" data-peak="${i}">✕</button></div>
      <div class="row tight" style="margin-left:20px">
        <label class="chk"><input type="checkbox" data-peak="${i}" data-pk="showV" ${p.showV ? 'checked' : ''}> mL</label>
        <label class="chk"><input type="checkbox" data-peak="${i}" data-pk="showMW" ${p.showMW ? 'checked' : ''}> kDa</label>
        <label class="chk"><input type="checkbox" data-peak="${i}" data-pk="showRatio" ${p.showRatio ? 'checked' : ''}> 260/280</label>
      </div>`;
    if (p.showMW && !mw) {
      const rough = roughMwAt(n, p.v);
      h += `<div class="note warn">Nothing to print for kDa here: ${fitted
        ? 'this peak is outside the volumes the standards cover, so the fit has nothing to say about it'
        : 'no calibration yet — load a kit above and type the standards\u2019 elution volumes'}.` +
        (rough !== null ? ` The column's range alone puts it near
          <b>${rough >= 10 ? Math.round(rough) : r2(rough)} kDa</b>, give or take a
          factor of two — enough to tell a monomer from an aggregate, not enough
          to print.` : '') + `</div>`;
    }
    if (caveat) h += `<div class="note warn">${esc(caveat)}.</div>`;
  });
  h += `</details>`;
  return h;
}

/* ---- table & box ---- */

function nanodropInspector(n) {
  const k = proteinConstants(n.protein);
  const pp = k.pp;
  let h = '';
  h += row('title', 'title', STR);

  h += `<details class="fold" open><summary>protein</summary>`;
  h += row('name', 'protein.name', STR, 'placeholder="ExampleR"');
  h += `<div class="btnrow">${btn('pasteSeq', pp ? 'change sequence…' : 'paste sequence…', 'primary')}
        ${btn('clearSeq', 'clear')}</div>`;
  if (pp) {
    if (pp.nucleotide) {
      h += `<div class="note warn">This reads as a nucleotide sequence, not a protein —
            A, C, G and T are all amino acids, so it will happily give you a mass for
            a protein that does not exist. Translate it first.</div>`;
    }
    const odd = Object.keys(pp.odd);
    if (odd.length) {
      h += `<div class="note warn">Ignored ${odd.map(c => `${pp.odd[c]}×${c}`).join(', ')} —
            not one of the twenty, so it counts for nothing in the mass or the ε.</div>`;
    }
    h += `<div class="kv">
      <span>residues</span><b>${pp.n}</b>
      <span>mass</span><b>${r2(pp.mw)} Da &nbsp;(${r2(pp.mw / 1000)} kDa)</b>
      <span>pI</span><b>${r2(pp.pI)}</b>
      <span>ε₂₈₀ reduced</span><b>${pp.epsRed} M⁻¹cm⁻¹</b>
      <span>ε₂₈₀ cystines</span><b>${pp.epsCys} M⁻¹cm⁻¹</b>
      <span>A 0.1% reduced</span><b>${r3(pp.a01Red)}</b>
      <span>A 0.1% cystines</span><b>${r3(pp.a01Cys)}</b>
      <span>W · Y · C</span><b>${pp.trp} · ${pp.tyr} · ${pp.cysteines} (${pp.cystines} cystine${pp.cystines === 1 ? '' : 's'})</b>
      <span>− / + residues</span><b>${pp.neg} / ${pp.pos}</b>
      <span>aliphatic index</span><b>${r2(pp.aliphatic)}</b>
      <span>GRAVY</span><b>${r3(pp.gravy)}</b>
      <span>instability</span><b>${r2(pp.instability)} — ${pp.instability < 40 ? 'stable' : 'unstable'}</b>
    </div>`;
    h += row('cysteines', 'protein.cys', 'sel', opts(['reduced', 'cystine'], n.protein.cys));
    if (pp.epsRed === 0) {
      h += `<div class="note warn">No tryptophan or tyrosine: this protein has
            essentially no absorbance at 280 nm, and A₂₈₀ will not measure it.</div>`;
    }
  }
  h += `<div class="note">Or type the constants, if the sequence is not to hand or you
        measured ε yourself. A typed value wins over the sequence.</div>`;
  h += `<div class="row tight"><label>MW Da</label>${ctl('protein.mw', NUM, 'step="1" placeholder="from sequence"')}
        <label>ε</label>${ctl('protein.eps', NUM, 'step="1" placeholder="from sequence"')}</div>`;
  h += row('A 0.1%', 'protein.a01', NUM, 'step="0.01" placeholder="from ε / MW"');
  h += `</details>`;

  h += `<details class="fold" open><summary>readings</summary>`;
  h += `<div class="btnrow">${btn('ndImport', 'import export…', 'primary')}${btn('ndPaste', 'paste…')}
        ${btn('ndAdd', '+ reading')}</div>`;
  if (!n.readings.length) {
    h += `<div class="note">Import a NanoDrop, Lunatic or DeNovix table, paste one, or add
          readings by hand. Only A₂₈₀ and the dilution are entered; mg/mL and µM follow
          from the constants above and are never stored.</div>`;
  }
  n.readings.forEach((r, i) => {
    const v = readingValues(r, k);
    h += `<div class="lane"><span class="n">${i + 1}</span>
      <input class="lbl" data-nd="${r.id}" data-nk="sample" value="${esc(r.sample || '')}" placeholder="sample">
      <input class="lbl num" data-nd="${r.id}" data-nk="a280" value="${r.a280 ?? ''}" placeholder="A280" title="A280">
      <input class="lbl num" data-nd="${r.id}" data-nk="dil" value="${r.dil ?? ''}" placeholder="dil" title="dilution factor">
      <input class="lbl num" data-nd="${r.id}" data-nk="vol" value="${r.vol ?? ''}" placeholder="mL" title="volume">
      <span class="derived" title="${v.uM != null ? r2(v.uM) + ' µM' : ''}">${v.mgml != null ? r2(v.mgml) + ' mg/mL' : '—'}</span>
      <button data-act="ndDel" data-nd="${r.id}" title="remove this reading">✕</button></div>`;
    if (r.instrument != null && v.mgml != null) {
      const said = r.instrument;
      const ratio = said > 0 ? v.mgml / said : null;
      if (ratio !== null && (ratio < 0.95 || ratio > 1.05)) {
        h += `<div class="note warn">Row ${i + 1}: the instrument recorded
              ${r2(said)}${r.instrumentUnit ? ' ' + r.instrumentUnit : ''}, which is
              ${r2(ratio)}× what this A 0.1% gives. It was set to a different
              extinction coefficient — check which one is right before either
              number reaches a figure.</div>`;
      }
    }
  });
  h += `</details>`;

  h += `<details class="fold"><summary>columns</summary>`;
  ['dil', 'uM', 'vol', 'mg', 'ratio'].forEach(key => {
    h += row(({ dil: 'dilution', uM: 'µM', vol: 'volume mL', mg: 'total mg', ratio: 'A₂₆₀/A₂₈₀' })[key],
             `show.${key}`, BOOL);
  });
  h += row('constants line', 'header', BOOL);
  h += `<div class="row tight"><label>decimals</label>${ctl('dp.a280', NUM, 'step="1" min="0" max="4" title="A280"')}
        ${ctl('dp.mgml', NUM, 'step="1" min="0" max="4" title="mg/mL"')}
        ${ctl('dp.uM', NUM, 'step="1" min="0" max="4" title="µM"')}</div>`;
  h += row('font pt', 'fontPt', NUM, 'step="0.5"');
  h += row('row mm', 'rowMm', NUM, 'step="0.1"');
  h += row('rules', 'rules', 'sel', opts(['booktabs', 'all', 'none'], n.rules));
  h += `</details>`;

  h += `<div class="note">A NanoDrop left on "1 Abs = 1 mg/mL" is wrong for most
        proteins by the factor between that and the real A 0.1%. The constant is
        printed on the panel so the arithmetic can be checked rather than trusted.</div>`;
  return h;
}

function tableInspector(n) {
  let h = '';
  h += row('title', 'title', STR);
  h += `<div class="btnrow">${btn('addRow', '+ row')}${btn('delRow', '− row')}${btn('addCol', '+ column')}</div>`;
  h += row('from the figure', 'derive', BOOL);
  h += `<div class="note">Click a cell in the list to edit it. A greyed cell is taken
        from the figure rather than typed — hover it for where from. What you typed is
        kept underneath and comes back if you turn this off.</div>`;
  const der = tableRows(n);
  n.rows.forEach((r, i) => {
    const from = (der[i] && der[i]._from) || {};
    h += `<div class="lane"><span class="n">${i + 1}</span>` +
      n.cols.map(c => from[c.key]
        ? `<input class="lbl" value="${esc(der[i][c.key] ?? '')}" disabled
            title="${esc(String(c.label).replace('\n', ' '))} — from ${esc(from[c.key])}">`
        : `<input class="lbl" data-cell="${i}" data-col="${c.key}" value="${esc(r[c.key] ?? '')}"
            title="${esc(String(c.label).replace('\n', ' '))}" placeholder="${esc(String(c.label).split('\n')[0])}">`).join('') +
      `</div>`;
  });
  h += row('font pt', 'fontPt', NUM, 'step="0.5"');
  h += row('row mm', 'rowMm', NUM, 'step="0.1"');
  h += row('rules', 'rules', 'sel', opts(['booktabs', 'all', 'none'], n.rules));
  h += `<div class="note">Yield and purity are what a reviewer checks first; a table
        beats the same numbers scattered through the legend. Name a step the way the
        sample is named in the A₂₈₀ panel and its volume and milligrams come from
        there; target is then total × purity and yield is against the first step, so
        the two columns a reviewer recomputes are the two nobody has to retype.
        Purity stays typed — nothing on this page measures it.</div>`;
  return h;
}

function constructInspector(n) {
  let h = '';
  h += `<div class="btnrow">${btn('pickMap', n.map ? 'read another map…' : 'read a plasmid map…',
                                  n.map ? '' : 'primary')}</div>`;
  if (n.map) {
    h += `<div class="status">${esc(n.map.name)} · ${n.map.len} bp` +
         `${n.map.circular ? ' circular' : ''} · ${esc(n.map.chain || 'one chain')}` +
         ` from the ${esc(n.map.via)}</div>`;
    const proms = (n.map.promoters || []).filter(p => p.aa);
    if (proms.length > 1) {
      h += `<div class="row"><label>read from</label><select id="cnProm">` +
           proms.map(p => `<option value="${esc(p.label)}"${p.label === n.map.promoter ? ' selected' : ''}>` +
                          `${esc(p.label)} — ${p.aa} aa</option>`).join('') + `</select></div>`;
    }
    h += `<div class="note">The reading frame comes from the sequence, not from a CDS
          feature — a feature with a hand-typed end translates to a protein nobody made.
          ${n.map.found
            ? `That file annotates nothing this can read, so the names come from the
               sequence too: the tags, sites and 2A peptides whose sequence is settled.
               The long unnamed stretch is the protein — name it yourself.`
            : `The map's own annotation names the pieces.`}
          ${n.map.guessed
            ? `No promoter in that file, so the frame is one PuriFig picked out of the
               sequence — the open frame carrying the most tags, then the longest.
               Check it against the map before the figure goes anywhere.`
            : ''}
          Every mass here is counted.</div>`;
  }
  h += row('title', 'title', STR);
  h += `<div class="row"><label>add</label><select id="cnTag">` +
       `<option value="">a segment…</option><option value="__plain">blank — name and length</option>` +
       opts(Object.keys(TAG_PRESETS)) + `</select></div>`;
  n.segs.forEach(s => {
    const q = segSeqOf(s);
    h += `<div class="lane seg">
      <input class="lbl" data-seg="${s.id}" data-ck="name" value="${esc(s.name)}" placeholder="name">
      <input class="lbl num" data-seg="${s.id}" data-ck="n" value="${q ? q.length : (s.n ?? '')}"
             ${q ? 'readonly' : ''} title="${q ? 'residues, counted from the sequence' : 'residues'}" placeholder="res">
      <input class="lbl num" data-seg="${s.id}" data-ck="start" value="${s.start ?? ''}" placeholder="from"
             title="the number its first residue has in the protein — blank for a tag, which nobody numbers">
      <input type="color" data-seg="${s.id}" data-ck="fill" value="${s.fill || '#eeeeee'}">
      <button data-act="segCut" data-seg="${s.id}" class="${s.cut ? 'on' : ''}"
              title="a protease cuts at the end of this segment">✂</button>
      <button data-act="segSeq" data-seg="${s.id}"
              title="${q ? `${q.length} residues counted from the sequence — click to replace it` : 'paste this segment’s sequence and its mass is counted rather than estimated'}">${q ? 'seq✓' : 'seq'}</button>
      ${q ? `<button data-act="segBlast" data-seg="${s.id}" class="${s.blast ? 'on' : ''}"
              title="${s.blast ? `waiting on NCBI as ${s.blast.rid} — click to check`
                               : 'ask NCBI what this is — sends the sequence over the internet'}">?</button>` : ''}
      <button data-act="segDel" data-seg="${s.id}" title="remove this segment">✕</button></div>`;
  });
  const whole = constructWhole(n);
  if (whole.n) {
    const pieces = constructPieces(n);
    h += `<div class="kv"><span>residues</span><b>${whole.n}</b>` +
         `<span>mass</span><b>${kDa(whole)}</b>` +
         (pieces.length > 1 ? `<span>${constructBreak(n)}</span><b>${pieces.map(kDa).join(' + ')}</b>` : '') +
         `</div>`;
    // Only where a protease site exists, since that is the only thing it decides.
    // A 2A is not offered: it is not a cut, and it cannot be left undone.
    if (n.segs.some(s => s.cut && !/2A$/i.test(s.name || '')))
      h += row('cut with the protease', 'cleaved', BOOL);
    if (!whole.exact)
      h += `<div class="note">A “~” is a mass estimated at ${RES_AVG} Da per residue, because
            that segment has a length and no sequence. Paste one and it is counted instead.</div>`;
  }
  h += row('to scale', 'scale', BOOL);
  h += row('labels', 'labels', 'sel', opts(['auto', 'above'], n.labels));
  h += row('residue numbers', 'numbers', BOOL);
  h += row('mass line', 'masses', BOOL);
  h += row('bar mm', 'barMm', NUM, 'step="0.5"');
  h += row('font pt', 'fontPt', NUM, 'step="0.5"');
  h += `<div class="note">Drawn to scale in residues. A tag is a sliver beside a domain,
        which is the proportion a hand-drawn cartoon never has and a reader half-remembers.</div>`;
  return h;
}

function boxInspector(n) {
  let h = '';
  h += row('text', 'text', 'area');
  h += row('font pt', 'fontPt', NUM, 'step="0.5"');
  h += row('bold', 'bold', BOOL);
  h += row('align', 'align', 'sel', opts(['start', 'center', 'end'], n.align));
  h += row('fill', 'fill', COL);
  h += row('stroke', 'stroke', COL);
  h += row('stroke mm', 'strokeMm', NUM, 'step="0.05"');
  h += row('corner mm', 'radius', NUM, 'step="0.5"');
  return h;
}

/* ---- inspector wiring ---- */

function getPath(o, p) { return p.split('.').reduce((a, k) => (a == null ? a : a[k]), o); }
function setPath(o, p, v) {
  const ks = p.split('.');
  let t = o;
  for (let i = 0; i < ks.length - 1; i++) {
    if (t[ks[i]] == null) t[ks[i]] = isNaN(+ks[i + 1]) ? {} : [];
    t = t[ks[i]];
  }
  t[ks[ks.length - 1]] = v;
}

function fillInspector() {
  const ns = selNodes(), es = selEdges();
  const targets = ns.length === 1 ? [ns[0]] : es.length ? [es[0]] : [];
  document.querySelectorAll('#inspector [data-k]').forEach(el => {
    const key = el.dataset.k;
    const obj = /^(meta|page)\./.test(key) ? doc : targets[0];
    if (!obj) return;
    const v = getPath(obj, key);
    if (el.type === 'checkbox') el.checked = !!v;
    else if (v !== undefined && v !== null) el.value = v;
  });
  drawHistogram();
}

function bindInspector() {
  const box = $('#inspector');
  box.oninput = ev => {
    const el = ev.target;
    const ns = selNodes(), es = selEdges();
    const n = ns[0], e = es[0];

    // Which edge to measure is a preference about the tool, not a change to the
    // figure — so it neither redraws anything nor lands in the undo history.
    if (el.id === 'alignRef') { alignRef = el.value; rememberUi(); return; }

    // One undo step per field, not per keystroke.  Controls that stream while
    // you hold them — text, numbers, a color picker — coalesce; a checkbox or
    // a menu is a discrete act and gets its own step.
    const streams = el.tagName === 'TEXTAREA' ||
                    ['text', 'number', 'color', 'range'].includes(el.type);
    // A menu or a checkbox reports twice, as `input` and again as `change`.
    // Answering both banked two steps for one act, the second of which undid
    // nothing anyone could see; they are answered once, on the change.
    if (!streams && ev.type === 'input') return;
    // A control that edits nothing — the lane count waiting for its "set"
    // button — is not an edit, and should not leave a step behind.
    if (!Object.keys(el.dataset).length &&
        !['qnControl', 'qnRel', 'qnAddGel', 'cnTag', 'cnProm'].includes(el.id)) return;
    // A size typed into a strip's edge is read when it is finished, not letter
    // by letter: "5" on the way to "50" is a size too, and a strip cut there for
    // a moment is not something the undo history should remember.
    const whole = !!(el.dataset.strip && el.dataset.sk !== 'label');
    if (whole && ev.type !== 'change') return;
    // Any other field has already said everything, keystroke by keystroke; its
    // change is only the moment it was finished.  Taking a step then banks a
    // copy of the state the keystrokes already reached — an undo that does
    // nothing — so it does only what waits for a finished value.
    if (streams && ev.type === 'change' && !whole) { committed(el, n); return; }
    const d = el.dataset;
    const field = d.k || d.lk || d.mk || d.tk || d.sk || d.pk || d.col || d.qk || el.id || 'edit';
    const slot = d.lane || d.mark || d.band || d.trace || d.std || d.peak || d.cell ||
                 d.strip || d.qrow || '';
    mark(streams ? `f:${(n && n.id) || (e && e.id) || 'doc'}:${field}:${slot}` : null);

    // The quantification panel's two compound menus: which loading control, and
    // relative to what.  Each sets two fields at once.
    if (el.id === 'qnControl') {
      if (el.value === '__none') n.useControl = false;
      else { n.useControl = true; n.control = el.value; }
      render(); inspector(); return;
    }
    if (el.id === 'qnRel') {
      n.norm = el.value;
      render(); inspector(); return;
    }
    if (el.classList.contains('qnRef')) {
      const was = quantData(n).refs || [];
      const now = el.checked ? [...was, el.dataset.cond] : was.filter(c => c !== el.dataset.cond);
      // Unticking the last one would leave nothing to be relative to, and
      // `quantRefs` would quietly hand back the first condition anyway.
      if (now.length) n.ref = now;
      render(); inspector(); return;
    }
    if (el.id === 'cnTag') {
      if (!el.value) { unmark(); return; }
      const preset = el.value === '__plain' ? { n: 100 } : TAG_PRESETS[el.value];
      n.segs.push(seg({ name: el.value === '__plain' ? '' : el.value.replace(/ site$/, ''),
                        ...preset, fill: SEG_FILLS[n.segs.length % SEG_FILLS.length] }));
      render(); inspector(); return;
    }
    if (el.id === 'cnProm') {
      const want = el.value;
      unmark();
      api('/api/seq/construct', { path: n.map.path, promoter: want }).then(r => {
        mark();
        constructFromChain(n, { ...r, path: n.map.path }, 0);
        render(); inspector();
        hint(r.chains.length > 1
          ? `Read from the ${r.promoter}. That promoter makes ${r.chains.length} proteins — ` +
            `"read another map…" lays them all out.`
          : `Read from the ${r.promoter}: ${r.chains[0].aa} residues.`);
      }).catch(err => hint(err.message, true));
      return;
    }
    if (el.dataset.act === 'qnCtrlGel') {
      if (!n.controls) n.controls = [];
      n.controls[+el.dataset.i] = el.value || '';
      render(); inspector(); return;
    }
    if (el.id === 'qnAddGel') {
      if (el.value && !n.gels.includes(el.value)) n.gels.push(el.value);
      else unmark();
      render(); inspector(); return;
    }
    if (el.dataset.strip) {
      const s = n.strips.find(x => x.id === el.dataset.strip);
      if (!s) return;
      if (el.dataset.sk === 'label') { s.label = el.value; render(); return; }
      const y = stripEdgeY(n, el.value);
      if (y === null) {
        unmark();
        hint(`“${el.value}” is not a size the ladder reaches — type one between its rungs, ` +
             `or “top” or “bottom”.`, true);
        inspector(); return;
      }
      if (el.dataset.sk === 'from') s.y0 = r2(clamp(y, 0, s.y1 - 4));
      else s.y1 = r2(clamp(y, s.y0 + 4, n.imgH));
      render(); inspector(); return;
    }
    if (el.dataset.qrow) {
      const r = n.quant.rows.find(x => x.id === el.dataset.qrow);
      if (!r) return;
      const k = el.dataset.qk;
      if (k === 'name') { r.name = el.value; render(); return; }
      if (k === 'role') { r.role = el.value; render(); inspector(); return; }
      if (k === 'h') {
        const v = numOr(el.value);
        r.h = v && v >= 2 ? Math.round(v) : null;
        return;                          // applied to the boxes once finished
      }
    }

    if (el.dataset.k) {
      const key = el.dataset.k;
      const obj = /^(meta|page)\./.test(key) ? doc : (n || e);
      const v = el.dataset.t === 'num' ? (el.value === '' ? null : +el.value)
              : el.dataset.t === 'bool' ? el.checked : el.value;
      // A gel has no height of its own: `h` is its magnification, and with
      // strips the drawn height is their share of it plus the gaps between
      // them.  The box holds the drawn height, so it goes back in the way the
      // drag handle puts it back.
      if (n && n.type === 'gel' && key === 'drawnH') {
        if (v) { gelSetDrawnH(n, v); render(); }
        return;
      }
      setPath(obj, key, v);
      // Typing a lean is claiming it; it then survives a change of lane count.
      if (n && key.startsWith('lean')) n.leanManual = true;
      // and the lanes are drawn and measured at it, once the number is finished.
      if (n && key.startsWith('lean') && ev.type === 'change') refreshLaneDensitometry(n);
      // Only the operating numbers follow the column; the rest of what is known
      // about it is looked up by name so the figure does not carry a stale copy.
      if (n && n.type === 'chrom' && key === 'column.name' && COLUMNS[v])
        Object.assign(n.column, columnDefaults(v));
      if (n && n.type === 'gel' && key.startsWith('levels.')) { /* applied on demand */ }
      // How the bands are measured is part of every number: change it and they
      // are all measured again, once the value is finished.
      if (n && n.type === 'gel' && key.startsWith('quant.') && ev.type === 'change') quantRemeasure(n);
      // A bar runs up from zero, and a size axis does not start there, so the
      // bar would be drawn from wherever the axis happens to begin.  Points and
      // a rule at the mean are what a size wants.
      if (n && n.type === 'quant' && key === 'readout' && v === 'size') { n.bars = false; n.points = true; }
      // Resizing every blot to its lanes leaves the loading controls where they
      // were, at the scale of the blots they used to be under.
      if (key === 'page.laneMm') gelSyncControls();
      if (n && n.type === 'gel' && key === 'view') {
        refreshMerge(n).then(() => { render(); inspector(); })
          .catch(err => hint('Could not make the composite: ' + err.message, true));
      }
      render();
      // A menu is the kind of control that reconfigures the ones around it —
      // picking a column rewrites V₀, Vt and everything shown about the bed — so
      // the panel is redrawn to match.  Safe here and nowhere else: a menu has
      // already closed by the time it reports, while redrawing under a field
      // somebody is typing in would take the field away from them.  A tickbox
      // is a discrete act in the same way, and several of them are gates on the
      // controls under them: a chromatogram's axis limits appear when its range
      // stops being automatic, and until this rebuilt for them too, unticking
      // it did nothing anyone could see.
      if (el.tagName === 'SELECT' || el.type === 'checkbox') inspector();
      return;
    }
    if (el.dataset.lane) {
      const l = n.lanes.find(x => x.id === el.dataset.lane);
      if (l) l[el.dataset.lk] = el.value;
      render();
      // What the role is decides what the field beside it is for — a fraction
      // number as the collector wrote it, rather than a name — so the row is
      // drawn again to say so.
      if (l && el.dataset.lk === 'role') inspector();
      // Marking a lane as the ladder is as much as anyone should have to say:
      // where its rungs are is in the image, and reading them off is this
      // program's job rather than a dozen clicks.
      if (l && el.dataset.lk === 'role' && el.value === 'ladder' && !n.ladder.marks.length) {
        findLadder(n, l);
      }
      return;
    }
    if (el.dataset.mark !== undefined && el.dataset.mk) {
      n.ladder.marks[+el.dataset.mark][el.dataset.mk] = +el.value || 0;
      n.fit = gelFit(n); render(); return;
    }
    if (el.dataset.band) {
      const b = n.bands.find(x => x.id === el.dataset.band);
      if (b) b.label = el.value;
      render(); return;
    }
    if (el.dataset.trace) {
      const t = n.traces.find(x => x.id === el.dataset.trace);
      if (t) t[el.dataset.tk] = el.type === 'checkbox' ? el.checked : el.value;
      render(); return;
    }
    if (el.dataset.std !== undefined) {
      const s = n.calib.standards[+el.dataset.std];
      if (el.dataset.sk === 've') s.ve = el.value === '' ? null : +el.value;
      else s.name = el.value;
      n.calib.fit = chromFit(n);
      render(); return;
    }
    if (el.dataset.peak !== undefined) {
      const p = n.peaks[+el.dataset.peak];
      if (el.dataset.pk) p[el.dataset.pk] = el.checked;
      else p.label = el.value;
      render(); return;
    }
    if (el.dataset.cell !== undefined) {
      n.rows[+el.dataset.cell][el.dataset.col] = el.value;
      render(); return;
    }
    if (el.dataset.seg) {
      const s = n.segs.find(x => x.id === el.dataset.seg);
      if (!s) return;
      const k = el.dataset.ck;
      if (k === 'cut') s.cut = el.checked;
      else if (k === 'n' || k === 'start') s[k] = numOr(el.value);
      else s[k] = el.value;
      render();
      // A cut changes the masses the panel reports, which are in the inspector too.
      if (k === 'cut') inspector();
      return;
    }
    if (el.dataset.nd) {
      const r = n.readings.find(x => x.id === el.dataset.nd);
      if (r) r[el.dataset.nk] = el.dataset.nk === 'sample' ? el.value : numOr(el.value);
      render();
      // The concentration beside the field follows the typing in place.
      // Rebuilding the inspector here took the field away after one character,
      // and the next keystroke landed on the canvas as a shortcut — the 0 of
      // "10" zoomed to fit.  The rest of the panel catches up when the field is
      // left.
      const v = r && readingValues(r, proteinConstants(n.protein));
      const said = el.parentElement && el.parentElement.querySelector('.derived');
      if (said && v) said.textContent = v.mgml != null ? r2(v.mgml) + ' mg/mL' : '—';
      return;
    }
  };
  box.onchange = box.oninput;
  box.onclick = ev => {
    const b = ev.target.closest('button');
    if (b && b.dataset.act) { ev.preventDefault(); inspectorAction(b.dataset.act, b); }
  };
}

/** What waits for a field to be finished rather than following each keystroke.
 *  Measuring again: a box height is one height for the whole row, and how the
 *  background is taken is part of every number, so either change measures every
 *  box again — once, with the value as it was left.  And redrawing the panel
 *  around an A₂₈₀ reading, whose warnings depend on the whole of it. */
function committed(el, n) {
  if (n && n.type === 'nanodrop' && el.dataset.nd) { inspector(); return; }
  if (!n || n.type !== 'gel') return;
  if (el.dataset.qrow && el.dataset.qk === 'h') {
    const r = n.quant.rows.find(x => x.id === el.dataset.qrow);
    if (!r || !r.h) return;
    n.quant.bands.filter(b => b.row === r.id).forEach(b => { b.h = r.h; });
    quantRemeasure(n);
  }
  if (el.dataset.k && el.dataset.k.startsWith('quant.')) quantRemeasure(n);
  // A new angle is a new picture and a new margin a new grid, and both are done
  // once the number is finished rather than at every keystroke: one resamples
  // the whole scan and the other goes looking for the lanes again.
  if (el.dataset.k === 'tilt' || el.dataset.k === 'margin') {
    (el.dataset.k === 'tilt' ? refreshGelImage(n) : autoLanes(n, n.lanes.length || 10))
      .then(() => { render(); inspector(); })
      .catch(err => hint('Could not redraw it: ' + err.message, true));
  }
}

//: Actions that open a dialog first and may be canceled.  They take their own
//: snapshot once a file has actually been chosen, so backing out of the dialog
//: does not leave an empty step in the history.
const DEFERRED_MARK = new Set(['pickChrom', 'pickImage', 'ndImport', 'relink',
                               'pickMarker', 'relinkMarker', 'qnLoadRep', 'pickMap',
                               'rebuildSupp']);

async function inspectorAction(act, el) {
  const ns = selNodes(), n = ns[0], es = selEdges();
  if (!DEFERRED_MARK.has(act)) mark();
  try {
    switch (act) {
      case 'front': ns.forEach(x => { doc.nodes.splice(doc.nodes.indexOf(x), 1); doc.nodes.push(x); }); break;
      case 'back': ns.forEach(x => { doc.nodes.splice(doc.nodes.indexOf(x), 1); doc.nodes.unshift(x); }); break;
      case 'dup': duplicate(); return;
      case 'del':
        doc.nodes = doc.nodes.filter(x => !sel.has(x.id));
        doc.edges = doc.edges.filter(e => node(e.from) && node(e.to));
        sel.clear(); break;
      case 'delEdge': doc.edges = doc.edges.filter(e => !sel.has(e.id)); sel.clear(); break;
      case 'braceMid': selEdges().forEach(x => { x.drop = 0.5; }); break;
      case 'align': alignSelection(el.dataset.edge); return;

      case 'pickImage': await pickImage(n); return;
      case 'relink': await relinkSource(n); return;
      case 'pickMarker': await pickMarker(n); return;
      case 'relinkMarker': await relinkSource(n, 'marker'); return;
      case 'markerAuto': {
        const s = n.marker && source(n.marker.src);
        if (!s) return unmark();
        Object.assign(n.marker.levels, s.suggest, { invert: n.marker.levels.invert });
        await refreshMarker(n); await refreshMerge(n);
        break;
      }
      case 'markerApply': await refreshMarker(n); await refreshMerge(n); break;

      case 'sliceKDa': {
        const ms = gelSizedMarks(n);
        if (ms.length < 2) {
          hint('The strips are cut at sizes read off the ladder — give it at least two sized rungs first.', true);
          return unmark();
        }
        const v = prompt(`Sizes to show, in kDa, top to bottom — one range per strip.\n` +
                         `The ladder here runs ${ms[0].kDa} to ${ms[ms.length - 1].kDa} kDa; ` +
                         `“top” and “bottom” reach the ends of the gel.`,
                         n.strips.length ? n.strips.map(s => stripRange(n, s).replace('–', '-')).join(', ')
                                         : '100-50, 45-30');
        if (!v) return unmark();
        const r = parseStrips(n, v);
        if (r.bad.length) hint(`Could not place ${r.bad.map(b => `“${b}”`).join(', ')} on this ladder.`, true);
        if (!r.strips.length) return unmark();
        n.strips = r.strips;
        break;
      }
      case 'stripAdd': n.strips.push({ id: uid(), y0: 0, y1: n.imgH || 1, label: '' }); break;
      case 'stripDel': n.strips = n.strips.filter(s => s.id !== el.dataset.strip); break;
      case 'stripsClear': n.strips = []; break;

      case 'qRowAdd':
      case 'qCtrlAdd': {
        const role = act === 'qCtrlAdd' ? 'loading control' : 'target';
        n.quant.rows.push({ id: uid(), role, h: null,
                            name: role === 'target' ? (n.quant.rows.some(r => r.role === 'target') ? '' : 'target')
                                                    : 'loading control' });
        break;
      }
      case 'qRowDel':
        n.quant.rows = n.quant.rows.filter(r => r.id !== el.dataset.row);
        n.quant.bands = n.quant.bands.filter(b => b.row !== el.dataset.row);
        if (mode === 'pick' && pending && pending.extra === el.dataset.row) { setMode('select'); hint(''); }
        break;
      case 'qClear': n.quant.bands = n.quant.bands.filter(b => b.row !== el.dataset.row); break;
      case 'qPick': {
        unmark();
        if (mode === 'pick' && pending && pending.pick === 'quant' && pending.extra === el.dataset.row) {
          setMode('select'); hint('');
        } else {
          sel = new Set([n.id]);
          armPick(n.id, 'quant', el.dataset.row);
        }
        break;
      }
      case 'qEvery': {
        const r = n.quant.rows.find(x => x.id === el.dataset.row);
        if (!r || !n.quant.bands.some(b => b.row === r.id)) {
          hint('Click the band in one lane first; the other lanes follow from it.', true);
          return unmark();
        }
        await quantEvery(n, r);
        break;
      }
      case 'qWhole':
        if (!n.quant.bands.some(b => b.row === WHOLE_LANE)) { await quantWholeLanes(n); break; }
        n.quant.bands = n.quant.bands.filter(b => b.row !== WHOLE_LANE);
        hint('The whole-lane boxes are gone, and with them the purity they measured.');
        break;
      case 'qRemeasure': unmark(); await quantRemeasure(n); return;
      case 'qNewPanel': {
        const q = addNode('quant', [0, 0], { mark: false });
        q.gels = [n.id];
        if (!placeClear(q, n)) hint('No clear space on the page, so the graph was put where it fits ' +
                                    'and overlaps something — drag it, or make the page taller.', true);
        break;
      }
      case 'qOpenPanel': {
        unmark();
        const q = doc.nodes.find(x => x.type === 'quant' && x.gels.includes(n.id));
        if (q) sel = new Set([q.id]);
        break;
      }

      case 'rebuildSupp': {
        // Built from the figure, so the figure has to be the one showing.
        showSheet('figure');
        await buildSupplementary();
        return;
      }

      case 'qnLoadRep': await loadReplicates(n); return;
      case 'qnSelGel': {
        unmark();
        const g = node(el.dataset.gel);
        if (!g) return;
        sel = new Set([g.id]);
        showNode(g);
        break;
      }
      case 'qnDelGel': {
        const at = n.gels.indexOf(el.dataset.gel);
        n.gels = n.gels.filter(id => id !== el.dataset.gel);
        // `controls` runs beside `gels`, so dropping a blot has to drop its
        // control with it or every later replicate reads the wrong panel.
        if (at >= 0 && n.controls) n.controls.splice(at, 1);
        break;
      }
      case 'qnNumbers': {
        unmark();
        const t = quantCsv(n);
        showModal('Quantification — every number', `<pre>${esc(t)}</pre>`, t,
                  `${(n.title || 'quantification').replace(/[^\w.-]+/g, '_')}.csv`);
        return;
      }
      case 'relayLanes': await autoLanes(n, +$('#nLanes').value || 10); break;
      case 'evenLanes': await evenLanes(n); break;
      case 'cut': {
        const l = n.lanes.find(x => x.id === el.dataset.lane);
        l.excised = !l.excised;
        break;
      }
      case 'splitAt': {
        const i = n.lanes.findIndex(x => x.id === el.dataset.lane);
        // The lane clicked on is the seam.  A marker or a blank one is there to
        // separate the two halves and belongs to neither; anything else holds a
        // sample, which would be lost, so it starts the second part instead.
        const seam = SEAM_ROLES.includes(n.lanes[i].role);
        const start = seam ? i + 1 : i;
        if (i < 1 || start > n.lanes.length - 1) {
          unmark();
          return hint('A cut needs a lane on each side of it.', true);
        }
        const b = copyNode(n);
        // Two panels captioned the same thing say they are the same panel, which
        // is the one claim the cut makes false.  The second part is named by the
        // person who cut it.
        b.title = '';
        n.lanes.forEach((l, j) => { if (j >= i) l.excised = true; });
        b.lanes.forEach((l, j) => { if (j < start) l.excised = true; });
        // Beside the part it was cut off, at the width that part now draws to.
        b.x = r2(n.x + gelLayout(n).totalW + 4);
        b.y = n.y;
        doc.nodes.push(b);
        sel = new Set([b.id]);
        // Nothing is juxtaposed, so nothing is spliced: each part is its own
        // panel, and the lanes each of them drops are all at one end of it.
        hint(`Cut in two${seam ? ` — the ${n.lanes[i].role} lane is in neither part` : ''}. ` +
             `Each part is its own panel, with no splice to mark. ⌘Z puts the gel back together.`);
        break;
      }
      case 'lanesAZ': n.lanes.filter(l => !l.excised).forEach((l, i) => l.label = String.fromCharCode(65 + i)); break;
      case 'lanesNum': n.lanes.filter(l => !l.excised).forEach((l, i) => l.label = String(i + 1)); break;
      case 'lanesFrac': {
        const first = prompt('First fraction number or volume for the leftmost kept lane:', 'A5');
        if (first === null) return unmark();
        const m = String(first).match(/^([A-Za-z]*)(\d+(?:\.\d+)?)$/);
        if (!m) { hint('Could not read that as a fraction label.', true); return; }
        n.lanes.filter(l => !l.excised).forEach((l, i) => {
          l.label = m[1] + (Number(m[2]) + i);
          if (l.role === 'sample') l.role = 'SEC fraction';
        });
        break;
      }
      case 'findLadder': {
        // With a white light there is no need to be told which lane: the ladder
        // is the only thing in that picture, so it can be looked for.
        const l = n.lanes.find(x => x.role === 'ladder') ||
                  (n.marker && source(n.marker.src) ? null : undefined);
        if (l === undefined) { hint('Mark a lane as the ladder first.', true); return unmark(); }
        unmark();
        n.ladder.marks = [];
        await findLadder(n, l);
        return;
      }
      case 'pickLadder': unmark(); armPick(n.id, 'ladder'); return;
      case 'pickBand': unmark(); armPick(n.id, 'band'); return;
      case 'ladderPreset': {
        const v = prompt('Sizes in kDa, top to bottom, comma separated:',
                         '250, 150, 100, 75, 50, 37, 25, 20, 15, 10');
        if (!v) return unmark();
        const sizes = v.split(/[,\s]+/).map(Number).filter(x => x > 0);
        if (!n.ladder.marks.length) {
          hint('Click the bands on the gel first, then the sizes fill in from the top.');
          return;
        }
        n.ladder.marks.sort((a, b) => a.y - b.y).forEach((m, i) => { if (sizes[i]) m.kDa = sizes[i]; });
        n.fit = gelFit(n);
        break;
      }
      case 'delMark': n.ladder.marks.splice(+el.dataset.mark, 1); n.fit = gelFit(n); break;
      case 'delBand': n.bands = n.bands.filter(b => b.id !== el.dataset.band); break;

      case 'cropDrag': {
        const src = source(n.src);
        if (!src || !src.preview) { hint('Load an image first.', true); return unmark(); }
        if (mode === 'crop') { endCrop(); return unmark(); }
        // The snapshot is taken on entering, so one undo puts back the crop you
        // started with however many times you nudged an edge.
        sel = new Set([n.id]);
        const v0 = gelCropView(n, src);     // where the scan is now; it stays there
        mode = 'crop'; pending = { node: n.id, hold: { s: v0.s, x0: v0.x0, y0: v0.y0 } };
        $('#canvas').classList.add('cropping');
        hint('Drag the outline to crop. Enter or click "done" to keep it, Escape to undo.');
        render(); inspector();
        return;
      }
      case 'leanZero': n.leanL = 0; n.leanR = 0; n.leanManual = true;
                       await refreshLaneDensitometry(n); break;
      case 'leanAuto': {
        n.leanManual = false;
        await autoLanes(n, n.lanes.length || 10);
        hint(`Re-measured: ${r2(n.leanL)} px at the left, ${r2(n.leanR)} at the right.`);
        break;
      }
      case 'cropDone': endCrop(); return unmark();
      case 'autoCrop': {
        const src = source(n.src);
        if (!src) { hint('Load an image first.', true); return unmark(); }
        if (!backend.ok) { hint('Finding the gel needs the server running.', true); return unmark(); }
        const r = await api('/api/image/autocrop', { path: src.path });
        n.crop = r.crop;
        // Say which sides were left where they were, and why.  A side reported
        // as flush is a decision, not a failure, and the difference matters if
        // you were expecting it to move.
        const left = Object.entries(r.sides).filter(([, why]) => why);
        hint(`${r.crop.w}×${r.crop.h} px, ${Math.round(r.kept * 100)}% of the scan.` +
             (left.length ? ` Left alone: ${left.map(([s, why]) => `${s} (${why})`).join(', ')}.` : ''));
        if (mode === 'crop') { render(); inspector(); return; }
        await refreshGelImage(n);
        break;
      }
      case 'cropReset': { const s = source(n.src); n.crop = null; await refreshGelImage(n); break; }
      case 'rot90': n.rotate = ((n.rotate || 0) + 90) % 360; await refreshGelImage(n); break;
      case 'tiltZero': n.tilt = 0; await refreshGelImage(n); break;
      case 'straighten': {
        // Two ladders beat anything read off the picture: the same standards in
        // the same run, so the line through a size marked in both is level
        // exactly when the gel is.  Failing that, the rows of bands.
        let by = gelLevelTilt(n), how = 'the two ladders';
        if (by === null) {
          const src = source(n.src);
          if (!src || !src.server || !backend.ok) {
            hint('Straightening reads the scan, which needs the server — or mark the same ' +
                 'sizes on two ladders and it levels those instead.', true);
            return unmark();
          }
          const r = await api('/api/image/lanes', {
            path: src.path, crop: n.crop || { x: 0, y: 0, w: src.w, h: src.h },
            rotate: n.rotate, tilt: n.tilt, flipH: n.flipH, flipV: n.flipV, levels: n.levels,
            darkBands: !n.levels.invert ? src.darkBands : !src.darkBands,
            // Its own lanes and its own lean: nothing here is looking for
            // those, and re-finding them would only be paid for.
            lanes: n.lanes.map(l => [l.x0, l.x1]), leanL: n.leanL || 0, leanR: n.leanR || 0,
            straighten: true,
          });
          by = r.tiltSure ? r.tiltDeg : null;
          how = 'the rows of bands';
        }
        if (by === null || Math.abs(by) < 0.05) {
          hint(by === null ? 'Nothing in the picture lies straight enough to level it by — ' +
                             'mark the same sizes on two ladders, or type the angle.'
                           : 'Already level, to a twentieth of a degree.', by === null);
          return unmark();
        }
        n.tilt = r2((n.tilt || 0) - by);
        await refreshGelImage(n);
        hint(`Turned ${r2(-by)}° by ${how}; the angle is now ${r2(n.tilt)}° and the record says so.`);
        break;
      }
      case 'flipH': n.flipH = !n.flipH; await refreshGelImage(n); break;
      case 'autoLevels': {
        const s = source(n.src);
        Object.assign(n.levels, s.suggest);
        await refreshGelImage(n); break;
      }
      case 'fullLevels': {
        const s = source(n.src);
        n.levels.black = s.rangeLo; n.levels.white = s.rangeHi; n.levels.gamma = 1;
        await refreshGelImage(n); break;
      }
      case 'applyLevels': await refreshGelImage(n); break;

      case 'pickChrom': {
        // With no server there is no server-side dialog, and the browser reads
        // every one of these formats anyway — so hand the job to the OS picker
        // rather than opening a file browser that can only say "offline".
        if (!backend.ok) { pickTraceFile(n); return; }
        const p = await LK.browse({ mode: 'file',
                                    exts: ['.res', '.asc', '.txt', '.csv', '.tsv', '.xls'],
                                    title: 'Chromatogram — a UNICORN .RES, an export, or a CSV' });
        if (!p) return;
        mark();
        await openChromByPath(n.id, Array.isArray(p) ? p[0] : p);
        return;
      }
      case 'pasteCsv': {
        const t = prompt('Paste the table — first column volume, the rest curves:');
        if (!t) return unmark();
        parseTraceText(t, n);
        break;
      }
      case 'kitLoad':
        n.calib.standards = STANDARD_KITS[n.calib.kit].map(s => ({ ...s, ve: null }));
        n.calib.on = true;
        break;
      case 'rebase':
        rebaseChrom(n, !n.inject.rebased);
        hint(n.inject.rebased
             ? `x is now volume since the injection — ${r2(n.inject.raw)} mL earlier than the method's own axis.`
             : `x is back on the method's own axis; the injection was at ${r2(n.inject.raw)} mL.`);
        break;
      case 'pasteSeq': {
        const t = prompt('Paste the protein sequence — FASTA, plain, numbered, any case:',
                         n.protein.seq || '');
        if (t === null) return unmark();
        n.protein.seq = t.trim();
        const pp = protParam(n.protein.seq);
        hint(pp ? `${pp.n} residues, ${r2(pp.mw / 1000)} kDa, A 0.1% ${r3(pp.a01Red)}`
                : 'No residues found in that.', !pp);
        break;
      }
      case 'clearSeq': n.protein.seq = ''; break;
      case 'ndAdd':
        n.readings.push({ id: uid(), sample: '', a280: null, a260: null,
                          dil: null, vol: null, instrument: null, note: '' });
        break;
      case 'ndDel': n.readings = n.readings.filter(r => r.id !== el.dataset.nd); break;
      case 'ndPaste': {
        const t = prompt('Paste the table, header row included:');
        if (!t) return unmark();
        const r = parseNanodropText(t);
        n.readings.push(...r.rows);
        hint(`${r.rows.length} readings, from ${r.mapped.join(', ')}.`);
        break;
      }
      case 'ndImport': {
        if (!backend.ok) { pickNanodropFile(n); return; }
        const p = await LK.browse({ mode: 'file', exts: ['.csv', '.tsv', '.txt', '.xls'],
                                    title: 'Spectrophotometer export' });
        if (!p) return;
        mark();
        const path = Array.isArray(p) ? p[0] : p;
        const r = await api('/api/nanodrop/open', { path });
        n.readings.push(...r.rows.map(x => ({ ...x, id: uid() })));
        if (!n.title) n.title = path.split('/').pop().replace(/\.[^.]+$/, '');
        hint(`${r.rows.length} readings from ${path.split('/').pop()}.`);
        render(); inspector();
        return;
      }
      case 'pickMap': {
        if (!backend.ok) { hint('Reading a plasmid map needs the server.', true); return unmark(); }
        const p = await LK.browse({ mode: 'file', exts: SEQ_EXTS, title: 'Plasmid map' });
        if (!p) return;
        const path = Array.isArray(p) ? p[0] : p;
        mark();
        try {
          const r = await api('/api/seq/construct', { path });
          readMap(n, { ...r, path });
        } catch (err) { unmark(); hint(err.message, true); }
        return;
      }
      case 'poolClear': n.fractions.pooled = null; break;
      case 'fracEven': {
        const v = prompt('Fraction size in mL, and the volume the collector started at — "0.5, 8":', '0.5, 8');
        if (!v) return unmark();
        const [size, start] = v.split(/[,\s]+/).map(Number);
        const S = chromScales(n);
        n.fractions.marks = [];
        for (let x = start, i = 1; x <= S.xmax && i < 400; x += size, i++)
          n.fractions.marks.push({ v: r3(x), label: String(i) });
        n.fractions.on = true;
        break;
      }
      case 'addPeak': {
        const v = prompt('Elution volume of the peak (mL):');
        if (!v) return unmark();
        n.peaks.push({ v: Number(v), label: '', showV: true, showMW: !!n.calib.on, showRatio: false });
        break;
      }
      case 'delPeak': n.peaks.splice(+el.dataset.peak, 1); break;

      case 'segCut': {
        const s = n.segs.find(x => x.id === el.dataset.seg);
        if (!s) return unmark();
        s.cut = !s.cut;
        break;
      }
      case 'segDel': n.segs = n.segs.filter(s => s.id !== el.dataset.seg); break;
      case 'segSeq': {
        const s = n.segs.find(x => x.id === el.dataset.seg);
        if (!s) return unmark();
        const t = prompt(`Sequence of “${s.name || 'this segment'}” — FASTA, plain, numbered, any case:`,
                         s.seq || '');
        if (t === null) return unmark();
        s.seq = t.trim();
        const pp = protParam(s.seq);
        hint(pp ? `${pp.n} residues, ${r2(pp.mw / 1000)} kDa — counted, not estimated.`
                : 'No residues in that. The segment keeps the length it was given.', !pp);
        break;
      }

      // The one thing in purifig that leaves this machine, so it asks first and
      // never fills the name in by itself: a 96% hit is a relative, and writing
      // its name on the bar is how a figure says something nobody did.
      case 'segBlast': {
        const s = n.segs.find(x => x.id === el.dataset.seg);
        const q = s && segSeqOf(s);
        if (!q) { hint('That segment has no sequence to ask about.', true); return unmark(); }
        if (!backend.ok) { hint('A BLAST needs the server.', true); return unmark(); }
        // NCBI hands out a ticket and works its queue in its own time -- twenty
        // minutes is an ordinary afternoon there.  So the ticket is kept on the
        // segment and the button picks it up again, rather than a tab being held
        // open for the whole wait.
        let r = s.blast;
        if (!r) {
          const db = prompt(`Send these ${q.length} residues to NCBI? The sequence leaves this ` +
                            `machine — nothing else in PuriFig does.\n\n` +
                            `swissprot answers sooner and names things plainly; nr knows the ` +
                            `engineered proteins swissprot has never heard of. Blank to cancel:`,
                            'swissprot');
          if (!db || !db.trim()) return unmark();
          hint('BLAST at NCBI — waiting for a ticket…');
          r = await api('/api/seq/blast', { seq: q, db: db.trim() });
        }
        for (let i = 0; !r.hits && i < 6; i++) {
          hint(`BLAST at NCBI — queued, ${i * 15}s…`);
          await new Promise(k => setTimeout(k, 15000));
          r = await api('/api/seq/blast', { rid: r.rid });
        }
        if (!r.hits) {
          s.blast = { rid: r.rid };
          hint(`Still in NCBI's queue as ${r.rid}. Press ? again whenever — the ticket is kept, ` +
               `and saving the session keeps it too.`);
          break;
        }
        delete s.blast;
        if (!r.hits.length) { hint('NCBI found nothing like it.', true); break; }
        const list = r.hits.map((x, i) =>
          `${i + 1}. ${x.name} — ${x.ident}% identical over ${x.cover}% of it`).join('\n');
        const pick = prompt(`${list}\n\nNumber to take that name, or type your own. ` +
                            `Blank leaves the segment as it is:`, '');
        if (!pick) break;
        const hit = r.hits[+pick - 1];
        s.name = hit ? hit.name : pick.trim();
        if (hit && hit.ident < 100)
          hint(`${hit.ident}% identical — that is a relative, not the same protein. ` +
               `The name on the bar is yours to correct.`, true);
        break;
      }

      case 'addRow': n.rows.push(Object.fromEntries(n.cols.map(c => [c.key, '']))); break;
      case 'delRow': n.rows.pop(); break;
      case 'addCol': {
        const label = prompt('Column heading (use \\n for a second line):', 'Fold\\npurification');
        if (!label) return unmark();
        n.cols.push({ key: 'c' + uid(), label: label.replace(/\\n/g, '\n'), align: 'end', w: 14 });
        break;
      }
    }
  } catch (err) {
    hint(err.message, true);
  }
  render(); inspector();
}

async function pickImage(n) {
  if (!backend.ok) { $('#fileImage').onchange = null; $('#fileImage').click(); return; }
  const p = await LK.browse({ mode: 'file', exts: backend.imageExts || ['.tif', '.tiff', '.png', '.jpg'],
                              title: 'Gel or blot scan' });
  if (!p) return;
  mark();
  const path = Array.isArray(p) ? p[0] : p;
  const existing = doc.sources.find(s => s.path === path);
  const src = existing || await openSourceByPath(path);
  n.src = src.id;
  n.crop = null;
  Object.assign(n.levels, src.suggest);
  await refreshGelImage(n);
  render(); inspector();
}

/** Point a source at the file it has moved to, and change nothing else.
 *
 *  Distinct from "change image…", which is for showing a different scan and
 *  therefore throws the crop away.  A relink is the same scan at a new address:
 *  the crop rectangle, the levels and the lane boundaries are all in source
 *  pixels and stay exactly where they were — which is only true if the file is
 *  the same size, so a different one is refused rather than silently applied to
 *  a crop that would now be pointing at the wrong part of the gel. */
async function relinkSource(n, which) {
  const src = source(which === 'marker' ? n.marker && n.marker.src : n.src);
  if (!src) return;
  if (!backend.ok) { hint('Relinking needs the server.', true); return; }
  const p = await LK.browse({ mode: 'file', exts: backend.imageExts || ['.tif', '.tiff', '.png', '.jpg'],
                              title: `Where is ${src.name} now?` });
  if (!p) return;
  const path = Array.isArray(p) ? p[0] : p;
  try {
    const info = await api('/api/image/open', { path });
    if (info.w !== src.w || info.h !== src.h) {
      hint(`That file is ${info.w}×${info.h} px and this session recorded ` +
           `${src.w}×${src.h} — the crop would land somewhere else. Use “change image…” ` +
           `if you mean to replace the scan.`, true);
      return;
    }
    mark();
    Object.assign(src, {
      path, name: info.name, bits: info.bits, note: info.note, preview: info.preview,
      hist: info.hist, dataLo: info.min, dataHi: info.max, p01: info.p01, p999: info.p999,
      saturatedFraction: info.saturatedFraction, darkBands: info.darkBands, server: true,
    });
    delete src.missing;
    // Everything drawn from this scan is redrawn from the file rather than left
    // on the copy the session was carrying, so a relink is visibly a relink.
    for (const g of doc.nodes.filter(x => x.type === 'gel' &&
                                          (x.src === src.id || (x.marker && x.marker.src === src.id))))
      await refreshGelImage(g);
    render(); inspector();
    hint(`Relinked to ${info.name}.`);
  } catch (err) {
    hint('Could not open that file: ' + err.message, true);
  }
}

/* ---- the white-light image ---- */

/** How much bigger the white-light picture is than the signal, given that the
 *  two are pictures of one frame.  An imager takes both from the same place,
 *  so they differ at most by binning — the same field at a different pixel
 *  count — and a pair that are not the same shape at any scale are not a pair:
 *  the size standards would be read off one membrane and printed on another. */
function frameScale(sig, m) {
  const kx = m.w / sig.w, ky = m.h / sig.h;
  if (Math.abs(kx - ky) > 0.01 * Math.max(kx, ky)) {
    throw new Error(`the white-light image is ${m.w}×${m.h} and the signal ${sig.w}×${sig.h} — ` +
                    `not the same frame at any scale. They have to be two pictures from one ` +
                    `acquisition, or the sizes would land in the wrong place.`);
  }
  const k = (kx + ky) / 2;
  return Math.abs(k - Math.round(k)) < 0.01 ? Math.round(k) : r3(k);
}

/** Put a white-light picture beside a panel's signal. */
async function attachMarker(n, msrc) {
  const sig = source(n.src);
  if (!sig) throw new Error('load the signal first — the white light is matched to it');
  const k = frameScale(sig, msrc);
  // Which way round a white-light picture is is not a question for the
  // histogram.  A prestained band absorbs the light, so it is darker than the
  // membrane it is on — always.  The histogram's guess, the commonest value is
  // the background, is wrong here in the usual case: the commonest value is the
  // dark imager tray around the membrane, and read that way every rung comes
  // out as the two light edges either side of it.  An export that was inverted
  // on the way out is the exception, and the invert box is there for it.
  msrc.darkBands = true;
  // Asked before the marker is attached: isBlot counts a marker as proof on its
  // own, so afterwards every panel looks like a blot already and the kind stayed
  // whatever it was -- SDS-PAGE, in the caption and in the record, on a western.
  const was = isBlot(n);
  n.marker = { src: msrc.id, levels: { ...msrc.suggest, invert: false }, k, href: null };
  if (!was) n.kind = 'western blot';
  await refreshMarker(n);
  await refreshMerge(n);
  // The ladder lane is already known and nothing has been read off it: the
  // white light is where its rungs are, so read them.
  const ladder = n.lanes.find(l => l.role === 'ladder');
  if (ladder && !n.ladder.marks.length) await findLadder(n, ladder);
  return k;
}

async function pickMarker(n) {
  if (!source(n.src)) { hint('Load the signal first — the white light is matched to it.', true); return; }
  if (!backend.ok) {
    const input = $('#fileMarker');
    input.value = '';
    input.onchange = async () => {
      const f = input.files[0];
      if (!f) return;
      mark();
      try {
        const k = await attachMarker(n, await openSourceFromFile(f));
        hint(`White light: ${f.name}${k === 1 ? ', same frame as the signal' : `, ${k}× the signal’s size`}.`);
      } catch (err) { hint(err.message, true); }
      render(); inspector();
    };
    input.click();
    return;
  }
  const p = await LK.browse({ mode: 'file', exts: backend.imageExts || ['.tif', '.tiff', '.png', '.jpg'],
                              title: 'The white-light image of this membrane' });
  if (!p) return;
  const path = Array.isArray(p) ? p[0] : p;
  mark();
  try {
    const msrc = doc.sources.find(s => s.path === path) || await openSourceByPath(path, 'marker');
    const k = await attachMarker(n, msrc);
    hint(`White light: ${msrc.name}${k === 1 ? ', same frame as the signal' : `, ${k}× the signal’s size, matched by scale`}.` +
         (n.lanes.some(l => l.role === 'ladder') ? '' : ' Mark the ladder lane and its rungs are read from it.'));
  } catch (err) {
    unmark();
    hint('Could not use that as the white light: ' + err.message, true);
  }
  render(); inspector();
}

/* ---- strips ---- */

/** One edge of a strip, as typed: a size, or the top or bottom of the gel. */
function stripEdgeY(n, text) {
  const t = String(text || '').trim().toLowerCase();
  if (t === 'top') return 0;
  if (t === 'bottom') return n.imgH || null;
  const row = /^row\s*(\d+(?:\.\d+)?)$/.exec(t);
  if (row) return clamp(Number(row[1]), 0, n.imgH || 0);
  const v = numOr(t.replace(/\s*kda$/, ''));
  return v === null ? null : gelYForKDa(n, v);
}

/** "100-50, 45-30" into strips.  Each range is a strip; either end can be a
 *  size or "top"/"bottom"; written either way round. */
function parseStrips(n, text) {
  const strips = [], bad = [];
  String(text).split(/[,;\n]+/).map(s => s.trim()).filter(Boolean).forEach(part => {
    const m = /^(.+?)\s*(?:-|–|—|to)\s*(.+)$/i.exec(part);
    const a = m ? stripEdgeY(n, m[1]) : null, b = m ? stripEdgeY(n, m[2]) : null;
    if (a === null || b === null || Math.abs(b - a) < 4) { bad.push(part); return; }
    // Not rounded to whole pixels: the edge is drawn in millimeters, and a
    // strip asked to stop at 30 kDa should say 30, not 30.1.
    const y0 = r2(Math.min(a, b)), y1 = r2(Math.max(a, b));
    // Name a strip after what was measured in it, when that is known.
    const inside = n.quant.rows.filter(r => n.quant.bands.some(x => x.row === r.id && x.y >= y0 && x.y <= y1));
    strips.push({ id: uid(), y0, y1, label: inside.map(r => r.name).filter(Boolean).join(' / ') });
  });
  return { strips, bad };
}

/* ---- replicates ---- */

/** Which of an imager's two pictures a file name says it is.  Matched as whole
 *  words, so a lab called Whitehead is not a white-light image. */
const MARKER_NAME = /(?<![a-z])(white[\s_-]?light|white|colou?rimetric|marker|epi[\s_-]?white|trans[\s_-]?white|bright[\s_-]?field|visible|membranes?|mem)(?![a-z])/gi;
const SIGNAL_NAME = /(?<![a-z])(chemi(luminescen(ce|t))?|chemilum\w*|lumi(nescence)?|ecl|signal|fluor(escence)?)(?![a-z])/gi;

function channelOf(name) {
  const s = String(name || '');
  if (new RegExp(MARKER_NAME.source, 'i').test(s)) return 'marker';
  if (new RegExp(SIGNAL_NAME.source, 'i').test(s)) return 'signal';
  return null;
}

/** Pair files that are the two pictures of one membrane: the same name once the
 *  word saying which picture it is has been taken out. */
function pairChannels(files) {
  // Two pictures and one of each kind is the whole of what a western needs, and
  // an imager names the two halves of one acquisition nothing alike -- a serial
  // number for the exposure and "mem" for the white light.  Nothing to match on
  // there, and nothing that needs matching either.
  if (files.length === 2) {
    const [a, b] = files, ca = channelOf(a.name), cb = channelOf(b.name);
    if (ca === 'marker' && cb !== 'marker') return [{ stem: '', signal: b, marker: a }];
    if (cb === 'marker' && ca !== 'marker') return [{ stem: '', signal: a, marker: b }];
  }
  const stem = f => String(f.name).replace(/\.[^.]+$/, '').replace(MARKER_NAME, '')
                          .replace(SIGNAL_NAME, '').replace(/[\s_\-.()]+/g, ' ').trim().toLowerCase();
  const groups = [];
  files.forEach(f => {
    const ch = channelOf(f.name) || 'signal', st = stem(f);
    let g = groups.find(x => x.stem === st && !x[ch]);
    if (!g) groups.push(g = { stem: st });
    g[ch] = f;
  });
  // A white-light picture with no signal to go with it is just a picture.
  return groups.map(g => (g.signal ? g : { stem: g.stem, signal: g.marker, marker: null }));
}

/** One panel per membrane in the picture, cropped to it.
 *
 *  A field of view on an imager holds several membranes, and some of them are
 *  strips cut off one sheet and probed for different proteins -- which is a
 *  thing the caption has to say, so the strips of one sheet are given a shared
 *  membrane id and each panel records which of its sides were cuts rather than
 *  the membrane's own edge.  The pieces are found in the white light, where a
 *  membrane is a rectangle on a dark tray; the signal picture is mostly empty
 *  and says nothing about where a membrane stops. */
async function splitMembranes(n) {
  const m = n.marker && source(n.marker.src);
  if (!m || !m.server || !backend.ok) return { panels: 0, laddered: 0 };
  const r = await api('/api/image/membranes', { path: m.path });
  const k = n.marker.k || 1;
  const sheets = [...new Set(r.pieces.map(p => p.sheet))];
  // One field of view, one scale.  Drawn to a common height instead, a short
  // strip and a tall one come out the same size, which says the membranes were
  // the same and the lanes on them were too -- and they were not.
  const mm = 80 / Math.max(...r.pieces.map(p => p.w / k));
  const made = [];
  let rungs = 0;
  for (const [i, p] of r.pieces.entries()) {
    const kin = r.pieces.filter(q => q.sheet === p.sheet);
    const g = i === 0 ? n : addNode('blot', [n.x, n.y], { mark: false });
    if (g !== n) {
      g.src = n.src;
      g.levels = { ...n.levels };
      g.marker = { ...n.marker, href: null };
      g.kind = n.kind;
    }
    g.crop = { x: r2(p.x / k), y: r2(p.y / k), w: r2(p.w / k), h: r2(p.h / k) };
    g.h = r2(mm * p.h / k);
    if (sheets.length > 1 || kin.length > 1) g.membraneId = 'M' + p.sheet;
    const cuts = ['top', 'bottom', 'left', 'right'].filter(side => p.cut[side]);
    if (cuts.length) {
      g.stripNote = `strip ${kin.indexOf(p) + 1} of ${kin.length}, cut along the ${cuts.join(' and ')}`;
    }
    // The lanes of the whole field are not this membrane's lanes.  The first
    // panel is the node the files were dropped on, and it already had ten of
    // them spread across all four sheets; kept and fitted to one sheet's crop,
    // seven of them folded onto its edges two pixels wide.
    g.lanes = [];
    await refreshGelImage(g);
    await refreshMarker(g);
    await refreshMerge(g);
    // The size standards are in the white light and nowhere else — a prestained
    // ladder is colored, not luminescent — so they are read off it now, while
    // the white light is the picture in hand.  Which lane they are in is read
    // off it too: nothing in the signal says where a lane of a blot is.
    if (await findLadder(g, null, true)) rungs++;
    made.push(g);
  }
  // Laid out the way they lie in the picture, so what is on screen is what was
  // on the tray and nobody has to work out which strip is which.
  let y = n.y;
  for (const g of made) { g.x = n.x; g.y = r2(y); y += g.h + 4; }
  sel = new Set(made.map(g => g.id));
  return { panels: made.length, laddered: rungs };
}

/** Somewhere on the pasteboard, to the right of the page and below whatever is
 *  already there. */
function pasteboardSpot() {
  const x = doc.page.w + 16;
  const there = doc.nodes.filter(m => offPage(m) && m.x >= doc.page.w);
  const y = there.length ? Math.max(...there.map(m => { const b = inkBox(m); return b.y + b.h; })) + 16 : 14;
  return [x, y];
}

/** A new replicate panel shaped like the first blot of a quantification: the
 *  same lanes, labels and roles, the same rows to measure, the same account of
 *  what the blot is — everything except the measurements, which are its own. */
function replicatePanel(q, at) {
  const t = quantGels(q)[0];
  const n = newNode('blot', at[0], at[1]);
  if (t) {
    ['kind', 'h', 'acrylamide', 'reducing', 'stain', 'antibody', 'secondary', 'detection',
     'labelPt', 'labelAngle', 'labelGap'].forEach(k => { n[k] = t[k]; });
    n.lanes = t.lanes.map(l => ({ ...l, id: uid() }));
    n.ladder = { ...n.ladder, side: t.ladder.side, pt: t.ladder.pt, lw: t.ladder.lw };
    n.quant.method = t.quant.method; n.quant.border = t.quant.border; n.quant.inset = t.quant.inset;
    n.quant.rows = t.quant.rows.map(r => ({ id: uid(), name: r.name, role: r.role, h: null }));
  }
  doc.nodes.push(n);
  return n;
}

/** Load replicate blots straight into a quantification: each file, or each pair
 *  of signal and white light, becomes a panel on the pasteboard. */
async function loadReplicates(q) {
  if (!backend.ok) {
    hint('Loading replicates needs the server. Drop the files beside the page instead, then add them here.', true);
    return;
  }
  const p = await LK.browse({ mode: 'files', exts: backend.imageExts || ['.tif', '.tiff', '.png', '.jpg'],
                              title: 'Replicate blots',
                              hint: 'Pick the signal of each blot, and its white-light image too if there is ' +
                                    'one — the two are paired by name.' });
  const paths = p ? (Array.isArray(p) ? p : [p]) : [];
  if (!paths.length) return;
  mark();
  const made = [], failed = [];
  for (const g of pairChannels(paths.map(path => ({ name: path.split('/').pop(), path })))) {
    const n = replicatePanel(q, pasteboardSpot());
    try {
      const src = doc.sources.find(s => s.path === g.signal.path) || await openSourceByPath(g.signal.path);
      n.src = src.id; n.crop = null;
      Object.assign(n.levels, src.suggest);
      await refreshGelImage(n);
      if (n.lanes.length) await autoLanes(n, n.lanes.length);
      if (g.marker) {
        const ms = doc.sources.find(s => s.path === g.marker.path) || await openSourceByPath(g.marker.path, 'marker');
        await attachMarker(n, ms);
      }
      q.gels.push(n.id);
      made.push(n);
    } catch (err) {
      doc.nodes = doc.nodes.filter(x => x !== n);
      failed.push(`${g.signal.name}: ${err.message}`);
    }
  }
  render(); inspector();
  if (made.length) showNode(made[0]);
  hint(`${made.length} replicate${made.length === 1 ? '' : 's'} on the pasteboard, right of the page` +
       (made.some(n => n.marker) ? `, ${made.filter(n => n.marker).length} with white light` : '') +
       `. Set each one's outer lane boundaries, then click its bands.` +
       (failed.length ? ` Not loaded — ${failed.join('; ')}` : ''), !!failed.length);
}

/** Bring a panel into view, if it is not in view already. */
function showNode(n) {
  const b = inkBox(n);
  if (b.x >= view.x && b.y >= view.y && b.x + b.w <= view.x + view.w && b.y + b.h <= view.y + view.h) return;
  const k = Math.max((b.w + 30) / view.w, (b.h + 30) / view.h, 1);
  view.w *= k; view.h *= k;
  view.x = b.x + b.w / 2 - view.w / 2;
  view.y = b.y + b.h / 2 - view.h / 2;
  render();
}

/** Every number behind a quantification, as CSV: each band on each blot, then
 *  each condition's summary.  The raw measurements are what a reader asks for
 *  and what a journal's source-data policy means. */
function quantCsv(q) {
  const D = quantData(q);
  const cell = v => (v === null || v === undefined || (typeof v === 'number' && !isFinite(v)) ? ''
                     : typeof v === 'number' ? String(+v.toPrecision(6)) : `"${String(v).replace(/"/g, '""')}"`);
  const out = [];
  const withC = !!D.control;
  out.push(['blot', 'file', 'lane', 'label', 'condition', `${D.target || 'target'} net`,
            `${D.target || 'target'} saturated px`,
            ...(withC ? [`${D.control} net`, `${D.control} saturated px`, 'ratio'] : []),
            'relative', 'note'].map(cell).join(','));
  D.reps.forEach((rep, i) => {
    const s = source(rep.gel.src);
    rep.rows.forEach(r => {
      const v = r.value ?? r.held;
      out.push([i + 1, s ? s.name : '', rep.gel.lanes.indexOf(r.lane) + 1, r.lane.label || '', r.key,
                r.t.net, r.t.sat || 0,
                ...(withC ? [r.c ? r.c.net : null, r.c ? r.c.sat || 0 : null, v] : []),
                v != null ? v / rep.by : null,
                (r.dropped ? 'left out of the mean — ' : '') + r.why.join('; ')].map(cell).join(','));
    });
  });
  out.push('');
  out.push(['condition', 'n', 'mean', 'SD', 'SEM'].map(cell).join(','));
  D.conditions.forEach(c => {
    const s = D.summary[c];
    out.push([c, s.n, s.mean, s.sd, s.sem].map(cell).join(','));
  });
  out.push('');
  out.push(cell(D.readout === 'size'
    ? `# apparent size of ${D.target || 'the band'} in kDa, read off each blot's own ladder` +
      ` between the two rungs either side; not normalized`
    : D.readout === 'share'
    ? `# ${D.target || 'the band'} as a percentage of every band measured for the protein` +
      ` in the same lane; no loading control and not normalized`
    : `# ${D.target || 'target'}${D.control ? ` / ${D.control} in the same lane` : ''}` +
      (q.norm === 'ref' && D.ref ? `, relative to ${D.ref} on the same blot` :
       q.norm === 'mean' ? ', relative to the mean of each blot' : '') +
      `; background: ${[...new Set(D.gels.map(g => g.quant.method))].join(', ')}` +
      (q.keepSaturated ? '; saturated bands kept'
                       : `; bands over ${nn(q.satTol) ?? 2}% clipped left out`)));
  return out.join('\n');
}

/** Read the rungs of a ladder lane off the scan.
 *
 *  Positions only.  The sizes are the one thing the image cannot tell you —
 *  they come off the tube — so they are left at zero for you to type or fill
 *  from a preset, and a fit is refused until they are there. */
//: The plasmid maps that can be read.  A .clc is offered so that opening one
//: says what to do about it rather than leaving it invisible.
const SEQ_EXTS = ['.gb', '.gbk', '.genbank', '.ape', '.dna', '.fa', '.fasta', '.seq', '.clc'];

/** Lay a map out: this panel takes the first chain, and any cistron after an
 *  IRES gets a panel of its own.
 *
 *  Its own, because it is its own protein — it has its own mass, it runs as its
 *  own band, and drawing it as a second bar on one panel would say the two come
 *  off the ribosome joined, which is the one thing an IRES means they do not. */
function readMap(n, r) {
  constructFromChain(n, r, 0);
  let y = n.y;
  for (let i = 1; i < r.chains.length; i++) {
    y = r2(y + 20);
    const m = constructFromChain(addNode('construct', [n.x, y], { mark: false }), r, i);
    // One map, one scale.  Two cistrons drawn to the same width would say the two
    // proteins are the same size, which is the thing this panel exists not to do.
    m.w = Math.max(8, r2(n.w * r.chains[i].aa / (r.chains[0].aa || 1)));
  }
  sel = new Set([n.id]);
  render(); inspector();
  hint(`${r.name}, read from the ${r.promoter}: ` +
       r.chains.map(c => `${c.name || 'one chain'}, ${c.aa} residues`).join('; ') + '.');
}

async function findLadder(n, lane, quiet) {
  // On a western the ladder is in the white-light picture and nowhere else: a
  // prestained marker is colored, not luminescent, so in the signal its lane
  // is blank.  The white light was taken in the same frame, `k` times the
  // signal's size, so the lane is the same lane scaled, and the rungs come
  // back in its pixels and are scaled down to the signal's.
  const m = n.marker, msrc = m && source(m.src);
  const white = !!(msrc && msrc.server);
  const src = white ? msrc : source(n.src);
  if (!src || !src.server || !backend.ok) {
    hint('Finding the rungs needs the server; click them on the gel instead.', true);
    return;
  }
  const k = white ? (m.k || 1) : 1;
  const lv = white ? m.levels : n.levels;
  const lean = serverLean(n);
  try {
    const r = await api('/api/image/ladder', {
      path: src.path, crop: white ? markerCrop(n) : (n.crop || { x: 0, y: 0, w: src.w, h: src.h }),
      rotate: n.rotate, tilt: n.tilt, flipH: n.flipH, flipV: n.flipV, levels: lv,
      // No lane given: which one the ladder is in is itself read off the
      // picture.  On a western that is the only way to know — the lanes are
      // invisible in the white light, which is the one picture the prestained
      // ladder is in, so an even split across the membrane lands the window
      // half on the ladder and half on whatever was written beside it.
      ...(lane ? { x0: lane.x0 * k, x1: lane.x1 * k }
               : { wide: Math.round(k * n.imgW / Math.max(1, n.lanes.length || 10)) }),
      leanL: lean.leanL * k, leanR: lean.leanR * k,
      darkBands: !lv.invert ? src.darkBands : !src.darkBands,
      // A blot is a membrane: no wells to blank at the top, and an edge that
      // is a step rather than a rim.
      membrane: white || isBlot(n),
    });
    if (!r.bands.length) {
      if (!quiet) hint(`No bands found in that lane${white ? ' of the white-light image' : ''}.`, true);
      return 0;
    }
    if (!quiet) mark();
    const at = r2((r.x0 + r.x1) / 2 / k);
    const found = r.bands.map(b => ({ kDa: 0, y: r2(b.y / k), label: '', x: at }));
    // Rungs read in another lane are another ladder and stay where they are: a
    // gel run with standards at both ends has two, and reading the second is
    // not a reason to lose the first.  Reading the same lane again replaces it.
    n.ladder.marks = n.ladder.marks
      .filter(m => m.x != null && Math.abs(m.x - at) > (r.x1 - r.x0) / k / 2)
      .concat(found).sort((a, b) => a.y - b.y);
    n.ladder.on = true;
    n.ladder.from = white ? 'white light' : 'signal';
    if (!lane) {
      // The lane it turned out to be, so the list says which one carries the
      // standards and the record says where the sizes were read.
      const mid = (r.x0 + r.x1) / 2 / k;
      const l = n.lanes.find(x => x.x0 <= mid && mid < x.x1) || n.lanes[0];
      if (l) l.role = 'ladder';
    }
    n.fit = gelFit(n);
    if (quiet) return r.bands.length;
    render(); inspector();
    hint(`${r.bands.length} rungs found${white ? ' in the white-light image' : ''}` +
         `${r.wells != null ? ', the comb skipped' : ''}. Type the sizes, ` +
         `or use "sizes…" to fill them from the top down.`);
    return r.bands.length;
  } catch (err) {
    if (!quiet) hint('Finding the rungs failed: ' + err.message, true);
    return 0;
  }
}

/* ---- the levels histogram ---- */

function drawHistogram() {
  const host = $('#hist');
  if (!host) return;
  const n = selNodes()[0];
  const src = n && source(n.src);
  if (!src || !src.hist) return;
  host.innerHTML = '<canvas></canvas>';
  const cv = host.querySelector('canvas');
  const W = host.clientWidth || 240, H = host.clientHeight || 46;
  cv.width = W * 2; cv.height = H * 2;
  const ctx = cv.getContext('2d');

  // The axis spans the data, not the detector: a Coomassie scan sits in the top
  // fifth of a 16-bit well, and drawing 0–65535 makes it one spike at the edge
  // with nothing to aim at.  The numbers in the boxes stay absolute.
  const lo = Math.max(src.rangeLo, (src.dataLo ?? src.rangeLo) - (src.dataHi - src.dataLo) * 0.05);
  const hi = Math.min(src.rangeHi, (src.dataHi ?? src.rangeHi) + (src.dataHi - src.dataLo) * 0.05);
  const span = (hi - lo) || 1;
  const binLo = src.rangeLo, binSpan = (src.rangeHi - src.rangeLo) || 1;
  const hist = src.hist, max = Math.max(...hist.slice(1, -1)) || 1;
  ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--dim') || '#949ba5';
  hist.forEach((v, i) => {
    const vlo = binLo + i / hist.length * binSpan;
    const x = (vlo - lo) / span * cv.width;
    const bw = binSpan / hist.length / span * cv.width;
    if (x + bw < 0 || x > cv.width) return;
    const h = Math.pow(v / max, 0.42) * cv.height;
    ctx.fillRect(x, cv.height - h, Math.max(1, bw), h);
  });
  const pos = v => clamp((v - lo) / span, 0, 1) * 100;
  host.insertAdjacentHTML('beforeend',
    `<div class="clip" style="left:0;width:${pos(n.levels.black)}%"></div>` +
    `<div class="clip" style="left:${pos(n.levels.white)}%;right:0"></div>` +
    `<div class="knob" style="left:${pos(n.levels.black)}%"></div>` +
    `<div class="knob" style="left:${pos(n.levels.white)}%"></div>`);
  host.onmousedown = ev => {
    const r = host.getBoundingClientRect();
    const val = x => lo + clamp((x - r.left) / r.width, 0, 1) * span;
    const near = Math.abs(val(ev.clientX) - n.levels.black) < Math.abs(val(ev.clientX) - n.levels.white)
      ? 'black' : 'white';
    const move = e => { n.levels[near] = Math.round(val(e.clientX)); drawHistogram(); };
    const up = () => {
      window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up);
      refreshGelImage(n).then(() => { render(); inspector(); });
    };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    move(ev);
  };
}

/* ================= integrity, caption, source data ================= */

function integrityReport() {
  const L = [];
  const push = (s = '') => L.push(s);
  push(`# Image processing record — ${doc.meta.title || 'untitled figure'}`);
  push(`Generated by PuriFig. Every entry below is read from the figure itself.`);
  push('');

  const gels = doc.nodes.filter(n => n.type === 'gel' && n.src);
  const bySource = {}, byMembrane = {};
  gels.forEach(n => {
    (bySource[n.src] = bySource[n.src] || []).push(n);
    if (n.membraneId) (byMembrane[n.membraneId] = byMembrane[n.membraneId] || []).push(n);
  });

  const warn = [];
  gels.forEach((n, i) => {
    const s = source(n.src) || {};
    const tag = n.title || `Panel ${i + 1}`;
    const rep = doc.nodes.find(q => q.type === 'quant' && q.gels.includes(n.id));
    push(`## ${tag} — ${n.kind}` + (offPage(n)
      ? (rep ? '  (on the pasteboard: a replicate the quantification counts, not in the figure)'
             : '  (on the pasteboard: not in the figure)') : ''));
    // A dropped scan's path is a working copy in a temp directory — plumbing,
    // not provenance.  Printing it would put a meaningless location in the
    // record where a reader expects to find where the file actually lives.
    push(`source file        ${s.name || '?'}` +
         (s.dropped ? `  (dropped onto the canvas)` : s.path ? `  (${s.path})` : ''));
    push(`source dimensions  ${s.w}×${s.h} px, ${s.bits}-bit${s.note ? `, ${s.note}` : ''}`);
    const c = n.crop;
    push(`crop               ${c ? `x ${Math.round(c.x)}, y ${Math.round(c.y)}, ${Math.round(c.w)}×${Math.round(c.h)} px` : 'none — full frame'}`);
    if (n.rotate || n.flipH || n.flipV)
      push(`orientation        ${n.rotate ? n.rotate + '° cw' : ''}${n.flipH ? ' flipped horizontally' : ''}${n.flipV ? ' flipped vertically' : ''}`);
    const lv = n.levels, linear = Math.abs((lv.gamma || 1) - 1) < 1e-6;
    push(`display range      black ${Math.round(lv.black)}, white ${Math.round(lv.white)} of ${Math.round(s.rangeLo)}–${Math.round(s.rangeHi)}`);
    push(`gamma              ${lv.gamma ?? 1}${linear ? '  (linear)' : '  ← NON-LINEAR, must be declared'}`);
    push(`inverted           ${lv.invert ? 'yes' : 'no'}`);
    push(`applied to         the whole panel, in one operation, on the original data`);
    if (n.clip) push(`clipped            ${(n.clip.low * 100).toFixed(2)}% to black, ${(n.clip.high * 100).toFixed(2)}% to white`);
    if (!linear) warn.push(`${tag}: gamma ${lv.gamma} — non-linear adjustment`);
    if (n.clip && n.clip.high > 0.005) warn.push(`${tag}: ${(n.clip.high * 100).toFixed(1)}% of pixels clipped to white — bands may be saturated in the figure`);
    if (s.saturatedFraction > 0.001) warn.push(`${tag}: the source scan itself is saturated over ${(s.saturatedFraction * 100).toFixed(2)}% of its area`);

    const cut = n.lanes.map((l, j) => ({ l, j })).filter(x => x.l.excised);
    push(`lanes              ${n.lanes.length} in the source, ${n.lanes.length - cut.length} shown`);
    if (n.leanL || n.leanR) {
      push(`lanes lean         ${r2(n.leanL)} px at the left edge, ${r2(n.leanR)} at the right, ` +
           `across the height`);
      if (Math.abs(n.leanR - n.leanL) > 4) {
        push(`  the lanes fan    the block is ${r2(Math.abs(n.leanR - n.leanL))} px ` +
             `${n.leanR > n.leanL ? 'wider' : 'narrower'} at the bottom than at the top`);
      }
      push(`  the scan itself  ${n.tilt ? 'is turned by the angle below and nothing else'
                                              : 'is drawn as it arrived'}; ` +
           `only the boundaries follow the lean`);
    }
    if (n.tilt) {
      push(`turned             ${r2(n.tilt)}° clockwise, on top of ${n.rotate || 0}° of quarter turns`);
      push(`  which means      the picture was RESAMPLED — bilinear, once, off the original ` +
           `${s.bits}-bit data, in the crop's own frame, so the corners of the crop are lost ` +
           `and nothing is rescaled`);
      warn.push(`${tag}: the picture is turned ${r2(n.tilt)}° to straighten it, which resamples it — ` +
                `intensities are interpolated, so quote densitometry from the numbers and not the pixels`);
    }
    if (cut.length) {
      push(`lanes removed      ${cut.map(x => `#${x.j + 1}${x.l.label ? ` (${x.l.label})` : ''}${x.l.role !== 'sample' ? ` [${x.l.role}]` : ''}`).join(', ')}`);
      const segs = gelLayout(n).segs.filter(x => x.spliceBefore).length;
      // None means the lanes removed are all at the ends of the panel, so no two
      // lanes that were not neighbors on the gel are shown side by side: there
      // is nothing to mark, and nothing to warn about either.
      push(`splices            ${segs
        ? `${segs}, ${n.splice.rule ? `marked with a ${n.splice.ruleMm} mm rule and a ${n.splice.gap} mm gap`
                                    : 'NOT MARKED'}`
        : 'none — every lane removed is at an edge of the panel, so no two lanes are juxtaposed'}`);
      if (segs && !n.splice.rule) warn.push(`${tag}: lanes were removed but the splice is not marked with a dividing line`);
    }
    const parts = gelPartsOf(n, doc.nodes);
    if (parts.length) {
      push(`one part of a gel  cut in two on the canvas; ${parts.length === 1 ? 'the other part is' : `the other ${parts.length} parts are`} ` +
           `in this figure, from the same crop of the same scan at the same levels`);
    }
    push(`lane order         ${n.lanes.filter(l => !l.excised).map(l => l.label || '·').join(' | ') || '—'}`);
    push(`lanes are          in their original order and orientation; no lane was moved or duplicated`);
    if (n.marker) {
      const m = source(n.marker.src) || {};
      push(`white light        ${m.name || '?'}${m.dropped ? '  (dropped onto the canvas)' : m.path ? `  (${m.path})` : ''}`);
      push(`  of the same frame ${m.w}×${m.h} px, ${m.bits}-bit, ` +
           (Math.abs(n.marker.k - 1) < 1e-6 ? 'the same size as the signal'
             : `${r3(n.marker.k)}× the signal's size — matched by scale, as for a binned signal`));
      const ml = n.marker.levels;
      push(`  shown at          black ${Math.round(ml.black)}, white ${Math.round(ml.white)}` +
           `${Math.abs((ml.gamma || 1) - 1) > 1e-6 ? `, γ ${ml.gamma}` : ''}${ml.invert ? ', inverted' : ''}`);
    }
    const ladderLanes = n.lanes.filter(l => !l.excised && l.role === 'ladder');
    push(`panel shows        ${n.view === 'marker' && n.marker ? 'the white-light image, not the signal'
                             : n.view === 'merge' && n.marker ? 'a COMPOSITE: the white light multiplied onto the signal'
                             : n.view === 'ladder' && n.marker
                               ? `a COMPOSITE: the signal, with lane${ladderLanes.length === 1 ? '' : 's'} ` +
                                 `${ladderLanes.map(l => `#${n.lanes.indexOf(l) + 1}`).join(', ') || '(none marked)'} ` +
                                 `taken from the white light`
                             : n.marker ? 'the signal' : 'the image'}`);
    if (n.view === 'merge' && n.marker) {
      warn.push(`${tag}: the panel is a composite of two images of the membrane (white light × signal) — say so in the legend`);
    }
    if (n.view === 'ladder' && n.marker) {
      push(`  the rest of it   is the signal alone, unmultiplied, at the levels above`);
      warn.push(`${tag}: the ladder lane is drawn from the white-light image and the other lanes from ` +
                `the signal — a composite of two images, to be said in the legend`);
    }
    if (n.ladder.marks.length) {
      push(`size standards     ${n.ladder.marks.map(m => m.kDa).filter(Boolean).join(', ')} kDa` +
           (n.fit ? `  (log₁₀ MW vs Rf, r² = ${n.fit.r2.toFixed(3)})` : ''));
      if (n.ladder.from === 'white light') push(`  read off         the white-light image, in register with the signal`);
      if (n.fit && n.fit.r2 < 0.98) warn.push(`${tag}: the mobility fit is poor (r² = ${n.fit.r2.toFixed(3)}) — quote sizes from the ladder, not the fit`);
    } else {
      warn.push(`${tag}: no size standards marked`);
    }
    if (n.strips.length) {
      push(`strips shown       ${n.strips.map(x => `${stripRange(n, x)} kDa${x.label ? ` (${x.label})` : ''}`).join(', ')}`);
      push(`  from             one image; rows ${n.strips.map(x => `${Math.round(x.y0)}–${Math.round(x.y1)}`).join(', ')} ` +
           `of the crop, each at the gel's own scale, ${n.stripGap} mm apart`);
      push(`  the rest         of the membrane is not in the figure — it is in the source data`);
      const ms = gelSizedMarks(n);
      n.strips.forEach(x => {
        if (ms.length >= 2 && !ms.some(m => m.y >= x.y0 - 1e-6 && m.y <= x.y1 + 1e-6)) {
          warn.push(`${tag}: the strip ${x.label ? `“${x.label}” ` : ''}(${stripRange(n, x)} kDa) has no ` +
                    `ladder rung inside it, so nothing on the figure says what size it shows`);
        }
      });
    }
    if (n.quant.bands.length) {
      const q = n.quant;
      push(`quantified         ${q.rows.map(r => `${r.name || '(unnamed)'} (${r.role}, box ${r.h ?? '?'} px tall)`).join(', ')}`);
      push(`  measured on      the original ${s.bits}-bit data, ${q.signal || (s.darkBands ? 'inverted against full scale' : 'as recorded')};` +
           ` the display window and γ do not enter it`);
      push(`  boxes            the lane less ${Math.round((q.inset ?? 0.05) * 100)}% at each side, along the lean; one height per row, shared by every lane`);
      push(`  background       ${q.method === 'profile' ? 'rolling minimum down each lane, per row under the box'
                                  : `median of a ${q.border ?? 3}-px strip above and below each box, in its own lane`}`);
      if (q.satLevel !== undefined && q.satLevel !== null) push(`  saturated at     ${q.satLevel} (${q.satWhy})`);
      gelQuantLanes(n).forEach(x => {
        if (!q.rows.some(r => x.by[r.id])) return;
        // Two spaces of their own after the label: padEnd never truncates, so a
        // lane called "Superose 6 Increase" would otherwise run into its number.
        push(`  lane ${String(x.index + 1).padEnd(3)}${(x.lane.label || '').padEnd(10)}  ` +
             q.rows.map(r => {
               const b = x.by[r.id];
               return b ? `${r.name || r.role} ${fmtVol(b.net)}${b.sat ? ` [${b.sat} px SATURATED]` : ''}${b.weak ? ' [no band found]' : ''}` : '';
             }).filter(Boolean).join('   ') +
             Object.entries(x.ratios).map(([id, v]) => `   ratio ${r3(v)}`).join('') +
             (x.purity === null ? '' : `   purity ${x.purity >= 10 ? Math.round(x.purity) : r2(x.purity)}%`));
      });
      if (q.bands.some(b => b.row === WHOLE_LANE)) {
        push(`  whole lanes      measured floor to ceiling, same background rule and same inset, ` +
             `so purity is the target band over everything in its lane`);
        push(`  purity is        a fraction of the stain, not of the protein: dye per milligram ` +
             `differs between proteins, what does not stain is not counted, and what ran off the ` +
             `bottom is not either`);
      }
      const sat = q.bands.filter(b => b.sat);
      if (sat.length) warn.push(`${tag}: ${sat.length} measured box${sat.length === 1 ? ' contains' : 'es contain'} saturated pixels — those bands held more signal than was recorded`);
      if (s.bits === 8) warn.push(`${tag}: bands were measured on 8-bit data — use the imager's own 16-bit file if there is one`);
      if (/\.jpe?g$/i.test(s.name || '')) warn.push(`${tag}: bands were measured on a JPEG, whose values were changed by its compression`);
      if (q.bands.some(b => b.edge)) warn.push(`${tag}: a measured box runs off the edge of the picture`);
    }
    if (n.acrylamide) push(`gel                ${n.acrylamide}${n.reducing ? ', reducing' : ', non-reducing'}`);
    if (n.stain) push(`stain              ${n.stain}`);
    if (n.antibody) push(`primary antibody   ${n.antibody}`);
    if (n.secondary) push(`secondary          ${n.secondary}`);
    if (n.detection) push(`detection          ${n.detection}${n.exposure ? `, ${n.exposure}` : ''}`);
    if (n.membraneId) push(`membrane           ${n.membraneId}${n.stripNote ? ` — ${n.stripNote}` : ''}`);
    push('');
  });

  // A gel cut in two on the canvas puts two panels on one crop, which is the one
  // thing both of these lists would otherwise deny.  `gelPartsOf` finds them by
  // what they show -- one crop, no lane in common -- so they are named here.
  const partNote = (n, list) => gelPartsOf(n, list).length ? '  [one part of a gel cut in two]' : '';
  Object.entries(bySource).forEach(([sid, list]) => {
    if (list.length < 2) return;
    const s = source(sid);
    push(`## Panels from one image: ${s.name}`);
    push(list.map(n => `  ${n.title || n.kind} — crop ${n.crop ? `${Math.round(n.crop.x)},${Math.round(n.crop.y)} ${Math.round(n.crop.w)}×${Math.round(n.crop.h)}` : 'full frame'}${partNote(n, list)}`).join('\n'));
    push(list.some(n => partNote(n, list))
      ? `Different regions of the same scan, each windowed independently — except the parts`
      : `These are different regions of the same scan, each windowed independently.`);
    if (list.some(n => partNote(n, list)))
      push(`marked above, which are one gel shown in pieces: one crop, no lane in common.`);
    push('');
  });
  Object.entries(byMembrane).forEach(([m, list]) => {
    if (list.length < 2) return;
    push(`## Membrane ${m}, cut into strips before probing`);
    list.forEach(n => push(`  ${n.title || n.kind}: ${n.stripNote || 'strip'}${n.antibody ? ` — ${n.antibody}` : ''}${partNote(n, list)}`));
    push(`Strips of one membrane, probed separately. They are not one blot reprobed,`);
    push(list.some(n => partNote(n, list))
      ? `and no strip is a crop of another; the parts marked above are one strip in two panels.`
      : `and no strip is a crop of another.`);
    push('');
  });

  const chroms = doc.nodes.filter(n => n.type === 'chrom');
  chroms.forEach((n, i) => {
    push(`## Chromatogram ${i + 1}`);
    push(`source file        ${n.source ? n.source.split('/').pop() : 'entered by hand'}`);
    if (n.run && n.run.id) push(`run                ${n.run.id}${n.run.started ? `, started ${n.run.started}` : ''}`);
    if (n.run && n.run.xaxis) push(`x axis in the file ${n.run.xaxis}`);
    if (n.inject) {
      push(`injection          at ${r2(n.inject.raw)} mL of the method` +
           (!n.inject.offset ? ' — the axis already starts there'
            : n.inject.rebased ? ' — x re-based so 0 is the injection'
            : ' — x is the method\u2019s own accumulated volume'));
    }
    const F = columnFacts(n.column);
    push(`column             ${n.column.name}${n.column.flow ? `, ${n.column.flow} mL/min` : ''}`);
    if (F.bed) push(`  bed              ${F.bed}, ${F.cv} mL` +
                    `${F.plates ? `, ${F.plates.toLocaleString()} N/m` : ''}` +
                    `${F.code ? `, product ${F.code}` : ''}`);
    if (F.range) push(`  separates        ${r2(F.range[0] / 1000)}–${r2(F.range[1] / 1000)} kDa (globular)` +
                      `${F.exclusion ? `, excluded above ${r2(F.exclusion / 1000)} kDa` : ''}`);
    push(`  characteristics  ${F.src === 'datasheet' ? `from ${F.ref}`
                              : F.src === 'catalog' ? 'family values, no data file cited'
                              : 'entered by hand'}`);
    if (n.column.buffer) push(`buffer             ${n.column.buffer}`);
    push(`V₀ / Vt            ${n.column.v0} / ${n.column.vt} mL`);
    push(`curves shown       ${n.traces.filter(t => t.on !== false).map(t => t.name).join(', ') || '—'}`);
    push(`normalization      ${n.normalise === 'max' ? 'each curve to its own maximum' : 'none — raw signal'}`);
    if (n.fractions.pooled) push(`pooled             ${n.fractions.pooled[0]}–${n.fractions.pooled[1]} mL`);
    const shaded = chromShadedFractions(n);
    if (shaded.length) {
      const labels = shaded.map(x => x.label);
      push(`fractions shaded   ${labels.join(', ')} — read off the gel this panel is braced to`);
      // A run of fractions with holes in it is a fact about the experiment, and
      // the figure should say which are missing rather than let the gaps pass
      // as a drawing quirk.
      const nums = labels.map(Number).filter(v => isFinite(v));
      if (nums.length > 1) {
        const missing = [];
        for (let v = Math.min(...nums); v <= Math.max(...nums); v++) if (!nums.includes(v)) missing.push(v);
        if (missing.length) push(`  not on the gel   ${missing.join(', ')} — those volumes are left unshaded`);
      }
    }
    push(`V₀ measured?       ${F.v0From === 'measured' ? 'yes — entered'
                              : F.v0From === 'entered' ? 'entered'
                              : 'no — ⅓ of the bed volume, assumed'}`);
    const f = n.calib.fit || chromFit(n);
    if (f) push(`calibration        ${f.n} standards, log₁₀(MW) vs Kav, r² = ${f.r2.toFixed(3)}`);
    if (n.rough) {
      push(`rough scale        shown — from the column's published range alone, not a calibration`);
      warn.push(`chromatogram ${i + 1}: the dim mass scale is drawn from the column's ` +
                `published fractionation range, not from standards. It is good to about ` +
                `a factor of two${F.v0From === 'estimate' ? ', on top of an assumed V₀' : ''}. ` +
                `Say so in the legend, or run standards.`);
    }
    if (n.rough && f) {
      warn.push(`chromatogram ${i + 1}: a real calibration and the rough scale are both ` +
                `shown; a reader cannot tell which a mass came from.`);
    }
    chromExpected(n).forEach(sp => {
      push(`expected           ${sp.label}${sp.cleaved ? ` (${sp.after})` : ''}, ` +
           `${kDa(sp)}, marked at ${r2(sp.ve)} mL by this calibration`);
    });
    n.peaks.forEach(p => {
      const l = chromMwLabel(n, p.v);
      const caveat = chromMwCaveat(n, p.v);
      push(`peak               ${p.label || '(unlabelled)'} at ${r2(p.v)} mL` +
           (l ? `, ${l} by calibration${chromMwAt(n, p.v) === null ? ' — outside the range the standards cover' : ''}` : '') +
           (caveat ? ` — ${caveat}` : ''));
      if (caveat) warn.push(`chromatogram ${i + 1}: the peak at ${r2(p.v)} mL calibrates to ${l}, ${caveat}.`);
    });
    if (F.v0From === 'estimate' && (n.calib.on || n.peaks.length)) {
      warn.push(`chromatogram ${i + 1}: V₀ is assumed (⅓ of the bed), not measured. ` +
                `Kav is measured from V₀, so every mass quoted here moves with it — ` +
                `run blue dextran and enter the volume you get.`);
    }
    if (F.cv && n.column.vt && Math.abs(n.column.vt - F.cv) > F.cv * 0.25) {
      warn.push(`chromatogram ${i + 1}: Vt is ${n.column.vt} mL for a ${F.cv} mL column — ` +
                `one of the two is wrong, and Kav depends on both.`);
    }
    if (n.column.v0 >= n.column.vt) {
      warn.push(`chromatogram ${i + 1}: V₀ (${n.column.v0}) is not below Vt (${n.column.vt}), so Kav ` +
                `cannot be computed and no mass here means anything.`);
    }
    if (F.flowMax && n.column.flow > F.flowMax) {
      warn.push(`chromatogram ${i + 1}: ${n.column.flow} mL/min is above this column's ` +
                `maximum of ${F.flowMax} mL/min.`);
    }
    // V0, Vt and every standards kit are column volumes counted from the
    // injection.  A UNICORN axis counts from the start of the method, so
    // reading one against the other puts every Kav — and so every mass — out
    // by the injection volume, silently and in the direction of "bigger".
    if (n.inject && n.inject.offset && !n.inject.rebased && (n.calib.on || n.marks.v0)) {
      warn.push(`chromatogram ${i + 1}: x runs from the start of the method, but V₀, Vt and the ` +
                `standards are volumes from the injection — everything read off this axis is ` +
                `${r2(n.inject.raw)} mL late. Use "x from inject" to put them in the same frame.`);
    }
    push('');
  });

  doc.nodes.filter(n => n.type === 'construct').forEach((n, i) => {
    const whole = constructWhole(n), pieces = constructPieces(n);
    push(`## Construct ${i + 1}`);
    if (n.title) push(`title              ${n.title}`);
    if (n.map) {
      push(`read from          ${n.map.name} (${n.map.len} bp${n.map.circular ? ', circular' : ''})`);
      push(`  frame            translated from the sequence, read from the ${n.map.via}` +
           (n.map.chain ? `, annotated ${n.map.chain}` : ''));
      if (n.map.found)
        push(`  names            found in the sequence — that file annotates none this reads`);
      if (n.map.guessed)
        push(`  frame chosen by   PuriFig — no promoter in that file, so the open frame`);
      push(`  file             ${n.map.path}`);
    }
    n.segs.forEach(s => {
      const q = segSeqOf(s);
      const st = nn(s.start);
      push(`  ${(s.name || '(unnamed)').padEnd(17)}${String(segLen(s)).padStart(5)} res` +
           `  ${q ? 'sequence' : 'length only, mass estimated'}` +
           (st === null ? '' : `  residues ${st}–${st + segLen(s) - 1}`) +
           (!s.cut ? '' : /2A$/i.test(s.name || '') ? '  — the ribosome skips here'
            : n.cleaved === false ? '  — protease site, left uncut'
            : '  — protease cuts after this'));
    });
    push(`expressed          ${whole.n} residues, ${kDa(whole)}`);
    if (pieces.length > 1)
      push(`${constructBreak(n).padEnd(19)}${pieces.map(kDa).join(' + ')}`);
    if (whole.n && !whole.exact)
      push(`estimated          at ${RES_AVG} Da per residue, for the segments with no sequence`);
    push('');
  });

  doc.nodes.filter(n => n.type === 'nanodrop').forEach((n, i) => {
    const k = proteinConstants(n.protein);
    push(`## Concentration table ${i + 1}`);
    if (n.title) push(`title              ${n.title}`);
    push(`protein            ${n.protein.name || '(unnamed)'}`);
    if (k.pp) {
      push(`sequence           ${k.pp.n} residues, ${r2(k.pp.mw)} Da, pI ${r2(k.pp.pI)}`);
      push(`ε₂₈₀               ${k.pp.epsRed} M⁻¹cm⁻¹ reduced, ${k.pp.epsCys} with cystines` +
           ` — using ${n.protein.cys === 'cystine' ? 'cystines' : 'reduced'}`);
    }
    push(`A 0.1%             ${k.a01 === null ? 'not set' : r3(k.a01)}` +
         ` (${k.from === 'sequence' ? 'from the sequence' : k.from === 'entered' ? 'entered by hand' : 'missing'})`);
    push(`readings           ${n.readings.length}`);
    n.readings.forEach(r => {
      const v = readingValues(r, k);
      push(`  ${(r.sample || '(unnamed)').padEnd(24)} A₂₈₀ ${r.a280}` +
           `${nn(r.dil) ? ` × ${r.dil}` : ''}` +
           `${v.mgml != null ? ` → ${r2(v.mgml)} mg/mL` : ''}` +
           `${v.uM != null ? `, ${r2(v.uM)} µM` : ''}` +
           `${r.instrument != null ? `  [instrument said ${r.instrument}${r.instrumentUnit ? ' ' + r.instrumentUnit : ''}]` : ''}`);
    });
    if (k.a01 === null && n.readings.length) {
      warn.push(`concentration table ${i + 1}: no extinction coefficient — the A₂₈₀ readings ` +
                `are absorbances, and nothing here turns them into a concentration.`);
    }
    if (k.pp && k.pp.nucleotide) {
      warn.push(`concentration table ${i + 1}: the sequence reads as nucleotide, not protein — ` +
                `every mass and coefficient derived from it is meaningless.`);
    }
    if (k.pp && k.pp.epsRed === 0) {
      warn.push(`concentration table ${i + 1}: no Trp or Tyr, so this protein barely absorbs at ` +
                `280 nm — A₂₈₀ is the wrong way to measure it.`);
    }
    // The instrument's own number and this one should agree; when they do not,
    // one of the two extinction coefficients is wrong and it matters which.
    const off = n.readings.filter(r => {
      const v = readingValues(r, k);
      return r.instrument != null && r.instrument > 0 && v.mgml != null &&
             Math.abs(v.mgml / r.instrument - 1) > 0.05;
    });
    if (off.length) {
      const f = readingValues(off[0], k).mgml / off[0].instrument;
      warn.push(`concentration table ${i + 1}: ${off.length} of ${n.readings.length} readings ` +
                `disagree with the concentration the instrument recorded, by about ${r2(f)}× — ` +
                `it was set to a different extinction coefficient.`);
    }
    push('');
  });

  // A table is the one panel whose numbers can be typed, so the record says
  // which of them were and which the figure worked out for itself.
  doc.nodes.filter(n => n.type === 'table').forEach((n, i) => {
    push(`## Purification table ${i + 1}`);
    if (n.title) push(`title              ${n.title}`);
    if (!n.derive) {
      push(`numbers            all typed into the table by hand`);
      push('');
      return;
    }
    const der = tableRows(n);
    const got = der.filter(r => Object.keys(r._from || {}).length);
    push(`numbers            typed, except where a step's name matches a sample in the A₂₈₀ panel`);
    push(`derived            ${got.length} of ${der.length} row${der.length === 1 ? '' : 's'}` +
         (got.length ? '' : ' — no step name matches a reading, so every number here is typed'));
    der.forEach((r, j) => {
      const from = r._from || {};
      const bits = n.cols.filter(c => from[c.key])
        .map(c => `${String(c.label).replace('\n', ' ')} ${r[c.key]} ← ${from[c.key]}`);
      if (bits.length) push(`  ${(r.step || `row ${j + 1}`).padEnd(24)}${bits.join('; ')}`);
    });
    push('');
  });

  doc.nodes.filter(n => n.type === 'quant').forEach((q, i) => {
    const D = quantData(q);
    const tag = q.title || `Quantification ${i + 1}`;
    push(`## ${tag}`);
    if (D.readout === 'size') {
      push(`measures           the apparent size of ${D.target || '(no target row)'}, in kDa`);
      push(`read from          each blot's own ladder, straight in log(size) between the two ` +
           `rungs either side of the band; not normalized`);
    } else if (D.readout === 'share') {
      push(`measures           ${D.target || '(no target row)'} as a percentage of the protein`);
      push(`read from          every target row on the blot, summed in the same lane; no loading ` +
           `control and nothing set to 1, because the loading cancels inside the lane`);
    } else {
      push(`measures           ${D.target || '(no target row)'}` +
           (D.control ? `, divided by ${D.control} in the same lane` +
                        (D.reps.some(r => r.control) ? ' of the same gel' : '')
                      : ', not divided by a loading control'));
      push(`relative to        ${q.norm === 'ref' ? `${D.ref || '?'}, on each blot separately`
                                : q.norm === 'mean' ? 'the mean of all lanes on each blot' : 'nothing — raw values'}`);
    }
    push(`blots              ${D.gels.length}: ` + D.gels.map((g, j) =>
      `${repName(g, j)}${offPage(g) ? ' (pasteboard)' : ' (in the figure)'}`).join(', '));
    if (q.points) push(`points drawn as    ` + D.gels.map((g, j) =>
      `${repName(g, j)} ${markShapeName(j)}s`).join(', '));
    // Where each loading control was measured.  A western's is a second
    // exposure of the membrane, so it is a second picture and a second panel,
    // and a reader has to be able to see which picture each ratio came off.
    D.reps.forEach((rep, j) => {
      if (rep.control) push(`control for ${String(j + 1).padEnd(6)} measured on ${repName(rep.control, -1)}, ` +
                            `a separate exposure; lanes matched by ${q.match === 'position' ? 'position' : 'label'}`);
    });
    push(`lanes matched      by ${q.match === 'position' ? 'position among the sample lanes' : 'label'}` +
         (D.repeated.length
           ? `; ${D.separate ? 'two lanes of one condition on one blot each count towards n'
                             : 'two lanes of one condition on one blot are averaged into one point'}` +
             ` (${D.repeated.join('; ')})`
           : ''));
    D.conditions.forEach(c => {
      const s = D.summary[c];
      push(`  ${c.padEnd(16)} n = ${s.n}` + (s.n ? `, mean ${r3(s.mean)}` : '') +
           (s.n > 1 ? `, SD ${r3(s.sd)}, SEM ${r3(s.sem)}` : ''));
    });
    push(`drawn              ${q.bars ? 'bars at the mean' : 'a rule at the mean'}` +
         `${q.points ? (D.separate && D.repeated.length ? ', one point per lane' : ', one point per blot') : ''}` +
         `, error bars ${q.error === 'sem' ? 'SEM' : 'SD'}`);
    D.excluded.forEach(s => push(`left out           ${s}`));
    D.issues.forEach(s => warn.push(`${tag}: ${s}`));
    if (q.keepSaturated && D.reps.some(r => r.rows.some(x => x.t.sat || (x.c && x.c.sat)))) {
      warn.push(`${tag}: saturated bands are kept in the mean — their true signal was higher than recorded`);
    }
    if (D.gels.length && D.gels.length < 3) {
      const most = Math.max(0, ...D.conditions.map(c => D.summary[c].n));
      warn.push(`${tag}: ${D.gels.length === 1 ? 'one blot' : 'two blots'} — fewer than the three ` +
                `independent replicates usually asked for` +
                (most > D.gels.length ? `, and n = ${most} counts lanes of one blot, which are not independent of one another` : ''));
    }
    if (D.readout === 'intensity' && q.norm === 'none' && D.gels.length > 1) {
      warn.push(`${tag}: nothing is set to 1, so blots exposed differently are averaged on different scales`);
    }
    if (D.readout === 'size' && D.reps.some(r => !r.gel.fit)) {
      warn.push(`${tag}: a blot has no sizes typed on its ladder, so nothing on it can be sized`);
    }
    const methods = new Set(D.gels.map(g => `${g.quant.method}|${g.quant.border}|${g.quant.inset}`));
    if (methods.size > 1) warn.push(`${tag}: the blots were not all measured the same way (background, border or inset differ)`);
    push('');
  });

  push(`## Checks`);
  if (!warn.length) push(`Nothing flagged.`);
  warn.forEach(w => push(`⚠ ${w}`));
  push('');
  push(`## What is not recorded here`);
  push(`Anything done to the file before PuriFig opened it. If the scan was already`);
  push(`cropped, leveled or assembled in the imager's software, that history lives`);
  push(`there and belongs in the methods section too.`);
  return L.join('\n');
}

/** The panels in the order they are lettered: down the page, then across.  What
 *  is on the page is the figure; the pasteboard is not lettered.  One list, so
 *  the legend and the supplementary sheet cannot disagree about which is B. */
function figurePanels() {
  return readingOrder(doc.nodes.filter(
    n => ['gel', 'chrom', 'table', 'nanodrop', 'quant', 'construct'].includes(n.type) && !offPage(n)));
}
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** A panel's letter, past Z as well: A…Z, then AA, AB.  A figure with
 *  twenty-seven panels is a real figure — the fibroblast western has that
 *  many — and the twenty-seventh of them is not called "?". */
const panelLetter = i => (i < 26 ? '' : LETTERS[Math.floor(i / 26) - 1]) + LETTERS[i % 26];

/** The methods paragraph, written from the figure itself.
 *
 *  The legend says what a reader is looking at; this says what was done to get
 *  it -- which image the numbers came off, how the background was taken, what
 *  was divided by what, and what counts as an n.  Every one of those is already
 *  recorded on the nodes, and every one of them is a thing a methods section is
 *  asked for and a figure cannot show. */
function methodsDraft() {
  const L = [], push = (s = '') => L.push(s);
  const qs = doc.nodes.filter(n => n.type === 'quant' && quantData(n).gels.length);
  const name = (q, i) => q.title || `quantification ${i + 1}`;
  // One sentence where they agree, the odd ones out named where they do not: a
  // methods section that repeats itself five times is not read, and one that
  // says "every blot" while one of them differs is wrong.  The majority carries
  // the sentence and the rest become its exception clause -- listing the
  // eighteen blots that agree to point at the one that does not is no better
  // than saying nothing.
  const shared = (items, label, pick) => {
    const m = new Map();
    items.forEach((it, i) => { const k = pick(it, i); if (k) m.set(k, (m.get(k) || []).concat(label(it, i))); });
    const g = [...m].sort((a, b) => b[1].length - a[1].length);
    if (!g.length) return '';
    return g[0][0] + (g.length > 1
      ? `, except ${g.slice(1).map(([k, who]) => `${k} (${who.join(', ')})`).join('; ')}` : '');
  };
  const agree = pick => shared(qs, (q, i) => name(q, i), q => pick(q, quantData(q)));
  // The blots a quantification reads, rather than the panels it draws.
  const gels = [...new Set(qs.flatMap(q => {
    const D = quantData(q);
    return D.gels.concat(D.reps.map(r => r.control).filter(Boolean));
  }))];
  const perGel = pick => shared(gels, g => g.title || 'a blot', pick);

  push(`# Methods — band quantification${doc.meta.title ? ` — ${doc.meta.title}` : ''}`);
  push(`Drafted by PuriFig from this figure. Everything below is read from the figure's own`);
  push(`settings; the instrument, the antibodies and the statistics are yours to fill in.`);
  push('');
  if (!qs.length) {
    push(`Nothing in this figure is quantified, so there is nothing to describe.`);
    return L.join('\n');
  }

  push(`## What was measured`);
  const bits = [...new Set(gels.map(g => (source(g.src) || {}).bits).filter(Boolean))].sort();
  push(`Band intensities were measured from the original ${bits.join('- and ') || '16'}-bit image` +
       ` files. The brightness and contrast of the panels in the figure are display settings` +
       ` only: they are applied for the figure and do not enter any number reported here.` +
       (gels.some(g => Math.abs((g.levels.gamma || 1) - 1) > 1e-6)
         ? ` One or more panels are displayed with a non-linear gamma, which must be declared` +
           ` in the legend; the measurements themselves are linear.` : ''));
  push('');
  push(`In each lane a rectangular box was placed over the band and the pixel values inside it` +
       ` were summed, less a local background taken in the same lane: ` +
       perGel(g => g.quant.method === 'profile'
         ? `a rolling-minimum baseline computed down the lane's own intensity profile and` +
           ` subtracted row by row`
         : `the median of a ${g.quant.border}-pixel strip immediately above and below the box`) +
       `. Background was never taken from beside a lane, where the gap to the next lane is a` +
       ` different background from the one under the band, and no value was clipped at zero, so` +
       ` an empty box measures as approximately nothing rather than as zero.`);
  if (gels.some(g => g.leanL || g.leanR)) {
    push('');
    push(`Where the lanes of a blot do not run square to the image, the boxes follow the lanes:` +
         ` the image was sheared along them before measuring, so each box is a rectangle in the` +
         ` lane's own frame.`);
  }
  if (gels.some(g => g.tilt)) {
    push('');
    push(`${gels.filter(g => g.tilt).map(g => g.title || 'one blot').join(', ')} ` +
         `${gels.filter(g => g.tilt).length === 1 ? 'was' : 'were'} rotated to level the lanes,` +
         ` which resamples the image; the numbers were taken from the rotated image and should be` +
         ` quoted as measured rather than re-read off the printed panel.`);
  }
  const sat = agree((q) => q.keepSaturated
    ? `bands at the camera's limit were kept and are reported as measured, which understates them`
    : `a lane was left out when more than ${q.satTol ?? 2}% of a box sat at the camera's limit`);
  if (sat) { push(''); push(`Saturation: ${sat}.`); }
  push('');

  push(`## What each number is`);
  qs.forEach((q, i) => {
    const D = quantData(q);
    let s = `**${name(q, i)}.** `;
    if (D.readout === 'size') {
      s += `The apparent size of ${D.target || 'the band'}, read off each blot's own marker by` +
           ` straight-line interpolation in log(size) between the two rungs either side of the band.`;
    } else if (D.readout === 'share') {
      const tr = [...new Set(D.gels.flatMap(g =>
        (g.quant.rows || []).filter(r => r.role === 'target').map(r => r.name)))];
      s += `${D.target || 'The band'} as a percentage of ${tr.length > 1 ? tr.join(' + ') : 'every form the protein runs as'}` +
           ` in the same lane. A percentage of the lane's own total needs no loading control and` +
           ` nothing is set to 1: how much was loaded cancels inside the lane.`;
    } else {
      s += `${D.target || 'The target'}${D.control
        ? `, divided by ${D.control} in the same lane` +
          (D.reps.some(r => r.control) ? `, measured on a separate exposure of the same membrane` : '')
        : `, with no loading control`}`;
      s += q.norm === 'ref' && D.ref
        ? `, then expressed relative to ${D.ref} on that same blot.`
        : q.norm === 'mean' ? `, then expressed relative to the mean of that blot.`
        : `. Nothing is set to 1, so each blot keeps its own exposure.`;
    }
    const ns = [...new Set(D.conditions.map(c => D.summary[c].n))].filter(Boolean).sort((a, b) => a - b);
    s += ` n = ${ns.length > 1 ? `${ns[0]}–${ns[ns.length - 1]}` : ns[0] || 0}` +
         ` from ${D.gels.length} blot${D.gels.length === 1 ? '' : 's'}` +
         (D.repeated.length
           ? D.separate ? `, each lane counted separately` : `, lanes of one condition averaged`
           : '') + `.`;
    if (D.excluded.length) s += ` Left out: ${D.excluded.join('; ')}.`;
    push(s);
    push('');
  });

  push(`## What the plots show`);
  const upper = t => t.charAt(0).toUpperCase() + t.slice(1);
  push(upper(agree(q => q.box
    ? `the box spans the quartiles with the median across it and the whiskers reach the` +
      ` smallest and largest value, outliers included`
    : `${q.bars ? 'the bar is' : 'the rule is'} the mean with ${q.error === 'sem' ? 'SEM' : 'SD'}`)) +
    (qs.some(q => q.points)
      ? `. Every measurement is drawn as a point, shaped by the blot it came from.` : `.`));
  push('');
  push(`No statistical test is applied in PuriFig. Whatever test is reported belongs here, with`);
  push(`what the n is for it: blots are independent of one another, lanes of one blot are not.`);
  push('');
  push(`— draft. Check every claim against your notebook before it goes in.`);
  return L.join('\n');
}

function captionDraft() {
  const panels = figurePanels();
  const m = doc.meta;
  const out = [];
  out.push(`**${m.title || 'Figure 1'}. Purification of ${m.protein || '[protein]'}${m.construct ? ` (${m.construct})` : ''}.**`);
  panels.forEach((n, i) => {
    const L = panelLetter(i);
    if (n.type === 'chrom') {
      const bits = [`(${L}) ${/superose|superdex|sec|s200|s6/i.test(n.column.name) ? 'Size-exclusion chromatography' : 'Chromatography'} on ${n.column.name}`];
      if (n.column.buffer) bits.push(`in ${n.column.buffer}`);
      if (n.column.flow) bits.push(`at ${n.column.flow} mL/min`);
      let s = bits.join(' ') + '.';
      const shown = n.traces.filter(t => t.on !== false).map(t => t.name);
      if (shown.length > 1) s += ` ${shown.join(' and ')} are shown.`;
      if (n.marks.v0) s += ` V₀ is marked.`;
      const f = n.calib.fit || chromFit(n);
      if (f) {
        const F = columnFacts(n.column);
        s += ` Ticks above the trace mark the elution volumes of globular standards (${n.calib.standards.map(x => x.kDa).join(', ')} kDa; log₁₀MW vs Kav, r² = ${f.r2.toFixed(2)}`;
        s += F.range ? `; the resin separates ${r2(F.range[0] / 1000)}–${r2(F.range[1] / 1000)} kDa).` : ').';
      }
      if (n.rough) s += ` The faint mass scale is drawn from the column's published fractionation range rather than from standards, and is accurate to about a factor of two.`;
      const ex = chromExpected(n);
      if (ex.length) {
        s += ` Dashed lines mark where the construct should elute on this calibration: ` +
             ex.map(sp => `${sp.label} ${kDa(sp)} at ${r2(sp.ve)} mL`).join(', ') + `.`;
      }
      const shaded = chromShadedFractions(n);
      if (shaded.length) {
        s += ` Shading marks the fractions run on the gel below (${shaded.map(x => x.label).join(', ')}).`;
      }
      if (n.fractions.pooled) s += ` The shaded region was pooled${doc.nodes.some(x => x.type === 'gel') ? ' and analysed in the panel below' : ''}.`;
      n.peaks.filter(p => p.label).forEach(p => {
        const mw = chromMwLabel(n, p.v);
        s += ` The peak at ${r2(p.v)} mL${mw ? ` (${mw})` : ''} is labeled ${p.label}.`;
      });
      out.push(s);
    } else if (n.type === 'construct') {
      const named = n.segs.filter(s => s.name && segLen(s)).map(s => s.name);
      const whole = constructWhole(n), pieces = constructPieces(n);
      let s = `(${L}) The construct`;
      if (n.map) s += ` read from ${n.map.name}`;
      if (named.length) s += `: ${named.join('–')}`;
      if (whole.n) s += `, ${whole.n} residues, ${kDa(whole)}`;
      s += '.';
      if (pieces.length > 1) {
        const m = pieces.map(kDa);
        s += ` ${/2A/.test(constructBreak(n)) ? 'Skipping' : 'Cleavage'} leaves ` +
             `${m.slice(0, -1).join(', ')} and ${m[m.length - 1]}.`;
      }
      if (n.scale) s += ` Segments are drawn to scale in residues.`;
      if (whole.n && !whole.exact)
        s += ` Masses marked ~ are estimated at ${RES_AVG} Da per residue, the rest counted from sequence.`;
      out.push(s);
    } else if (n.type === 'nanodrop') {
      const k = proteinConstants(n.protein);
      let s = `(${L}) Concentrations from A₂₈₀`;
      if (n.protein.name) s += ` for ${n.protein.name}`;
      if (k.a01 !== null) {
        s += `, using A 0.1% = ${r3(k.a01)}`;
        if (k.from === 'sequence') s += ` (ε₂₈₀ ${Math.round(k.eps)} M⁻¹cm⁻¹ and ${r2(k.mw)} Da from the sequence,` +
          ` ${n.protein.cys === 'cystine' ? 'cystines formed' : 'cysteines reduced'})`;
        else s += ` as entered`;
      }
      s += '.';
      out.push(s);
    } else if (n.type === 'gel') {
      const s0 = source(n.src) || {};
      let s = `(${L}) ${n.kind}${n.acrylamide ? `, ${n.acrylamide}` : ''}${n.reducing === false ? ', non-reducing' : ''}`;
      s += n.stain ? `, ${n.stain}.` : '.';
      if (n.antibody) s += ` Probed with ${n.antibody}${n.secondary ? ` and ${n.secondary}` : ''}${n.detection ? `; ${n.detection}` : ''}.`;
      const kept = n.lanes.filter(l => !l.excised);
      if (kept.some(l => l.label)) {
        s += ` Lanes: ${kept.map((l, j) => `${j + 1}, ${l.label || (l.role !== 'sample' ? l.role : '—')}`).join('; ')}.`;
      }
      if (n.ladder.marks.length) {
        s += n.ladder.side === 'both' ? ` Sizes in kDa are at both sides.`
                                      : ` Sizes in kDa are at the ${n.ladder.side}.`;
      }
      const cut = n.lanes.filter(l => l.excised);
      if (cut.length) {
        // The splices are the ones actually drawn, not one per lane removed:
        // lanes taken off an end of the panel juxtapose nothing, and claiming a
        // marked splice that is not there is as wrong as leaving one unmarked.
        const sp = gelRuns(n).length - 1;
        s += ` ${cut.length === 1 ? 'One lane' : `${cut.length} lanes`} (${cut.map(l => l.label || l.role).join(', ')}) ${cut.length === 1 ? 'was' : 'were'} removed from the panel`;
        s += sp ? `; the resulting splice${sp === 1 ? ' is' : 's are'} marked with a vertical line.`
                : `, all of them at its edges, so no two lanes are shown side by side that were not neighbors on the gel.`;
        s += ` The uncropped scan is in the source data.`;
      }
      const parts = gelPartsOf(n, doc.nodes);
      if (parts.length) s += ` This panel is one part of a gel cut in two after imaging; the other part${parts.length === 1 ? '' : 's'} appear${parts.length === 1 ? 's' : ''} in this figure, from the same image at the same levels.`;
      if (n.membraneId) {
        // The other part of a gel cut on the canvas is the same strip, not a
        // second one probed separately: that claim is the sentence above.
        const sibs = doc.nodes.filter(x => x.type === 'gel' && x.membraneId === n.membraneId &&
                                           x !== n && !parts.includes(x));
        if (sibs.length) s += ` This panel is a strip of membrane ${n.membraneId}${n.stripNote ? ` (${n.stripNote})` : ''}, cut before probing; the other strip${sibs.length === 1 ? '' : 's'} appear${sibs.length === 1 ? 's' : ''} in this figure.`;
      }
      if (n.marker && n.ladder.from === 'white light' && n.ladder.marks.length) {
        s += ` Sizes were read from a white-light image of the same membrane, taken with the chemiluminescence.`;
      }
      if (n.view === 'merge' && n.marker) {
        s += ` The white-light image is overlaid on the signal to show the prestained marker.`;
      }
      if (n.view === 'ladder' && n.marker) {
        s += ` The marker lane is from the white-light image of the same membrane, taken in the` +
             ` same frame; the sample lanes are the chemiluminescence alone.`;
      }
      if (n.tilt) {
        s += ` The image was rotated ${r2(Math.abs(n.tilt))}° to level it.`;
      }
      if (n.strips.length) {
        s += ` ${n.strips.length === 1 ? 'The region' : 'Regions'} shown ` +
             `(${n.strips.map(x => `${stripRange(n, x)} kDa${x.label ? `, ${x.label}` : ''}`).join('; ')}) ` +
             `${n.strips.length === 1 ? 'is' : 'are'} from one image of one membrane; the whole blot is in the source data.`;
      }
      out.push(s);
    } else if (n.type === 'quant') {
      const D = quantData(n);
      let s = `(${L}) Quantification of ${D.target || 'the target'}`;
      if (D.control) s += `, normalized to ${D.control} in the same lane`;
      if (n.norm === 'ref' && D.ref) s += ` and expressed relative to ${D.ref} on each blot`;
      else if (n.norm === 'mean') s += ` and expressed relative to the mean of each blot`;
      const ns = [...new Set(D.conditions.map(c => D.summary[c].n))];
      const nTxt = ns.length === 1 ? `n = ${ns[0]}` : `n = ${Math.min(...ns)}–${Math.max(...ns)}`;
      // What the panel actually draws.  A box panel draws no error bar at all,
      // and a legend promising mean ± SD under a quartile box is a legend
      // describing a different figure.
      s += `. ${n.box ? 'Boxes show the median and quartiles with whiskers to the extremes'
                      : `${n.bars ? 'Bars show the mean' : 'Lines mark the mean'} ± ${n.error === 'sem' ? 'SEM' : 'SD'}`} of ` +
           `${nTxt} independent blot${ns.length === 1 && ns[0] === 1 ? '' : 's'}` +
           `${n.points ? ', and points the individual blots' : ''}.`;
      if (D.excluded.length) s += ` ${D.excluded.length === 1 ? 'One lane was' : `${D.excluded.length} lanes were`} left out because a band was saturated (${D.excluded.join('; ')}).`;
      s += ` Bands were measured on the unprocessed ${[...new Set(D.gels.map(g => (source(g.src) || {}).bits))].join('/')}-bit images with local background subtracted.`;
      out.push(s);
    } else {
      out.push(`(${L}) ${n.title || 'Purification balance sheet'}. Yields are from ${n.rows.length} steps.`);
    }
  });
  if (m.host) out.push(`${m.protein || 'The protein'} was expressed in ${m.host}${m.tag ? ` with an ${m.tag} tag` : ''}.`);
  out.push('');
  out.push('— draft. Check every number against your notebook before it goes in.');
  return out.join('\n\n');
}

function sourceDataSheet() {
  const gels = doc.nodes.filter(n => n.type === 'gel' && n.src);
  let h = `<div class="sheet"><h2 style="font:600 15px sans-serif;color:#111">Source data — uncropped scans</h2>`;
  h += `<p style="font:12px sans-serif;color:#444">Every gel and blot panel in this figure, and every
        replicate blot its quantification used, shown as the whole original scan with the region
        used outlined in red. Lanes removed from the published panel are shaded; strips shown in the
        figure are outlined in blue; boxes are the bands that were measured.</p>`;
  const seen = new Set();
  gels.forEach(n => {
    const s = source(n.src);
    if (!s) return;
    const key = s.id + '|' + JSON.stringify(n.crop);
    if (seen.has(key)) return;
    seen.add(key);
    const c = n.crop || { x: 0, y: 0, w: s.w, h: s.h };
    const W = 620, k = W / s.w, H = s.h * k;
    const g = n.geom && n.geom.src === s.id ? n.geom : gelGeom(n, s);
    // Anything placed on the panel's picture, carried back onto the scan — the
    // way the picture was cut and turned undone, so a box is drawn where the
    // band is on the original whatever was done to make the figure.
    const poly = pts => pts.map(([x, y]) => toScan(g, x, y)).map(([x, y]) => `${r2(x * k)},${r2(y * k)}`).join(' ');
    const Hp = picH(g), Wp = picW(g);
    let ov = `<rect x="${c.x * k}" y="${c.y * k}" width="${c.w * k}" height="${c.h * k}"
              fill="none" stroke="#c62f34" stroke-width="2"/>`;
    const lean = (x, y) => x + gelLeanAt(n, x) * (y - Hp / 2) / (Hp || 1);
    n.lanes.forEach(l => {
      if (!l.excised) return;
      ov += `<polygon points="${poly([[lean(l.x0, 0), 0], [lean(l.x1, 0), 0], [lean(l.x1, Hp), Hp], [lean(l.x0, Hp), Hp]])}"
             fill="#c62f34" opacity=".25"/>`;
    });
    n.strips.forEach(st => {
      ov += `<polygon points="${poly([[0, st.y0], [Wp, st.y0], [Wp, st.y1], [0, st.y1]])}"
             fill="none" stroke="#2b6cb0" stroke-width="1.4" stroke-dasharray="4 3"/>`;
    });
    n.quant.bands.forEach(b => {
      const l = n.lanes.find(x => x.id === b.lane), row = n.quant.rows.find(r => r.id === b.row);
      if (!l || !row) return;
      const [x0, x1] = quantBoxX(n, l), a = b.y - b.h / 2, z = b.y + b.h / 2;
      ov += `<polygon points="${poly([[lean(x0, a), a], [lean(x1, a), a], [lean(x1, z), z], [lean(x0, z), z]])}"
             fill="none" stroke="${quantColour(n, row)}" stroke-width="1.2"/>`;
    });
    const rep = offPage(n) && doc.nodes.some(q => q.type === 'quant' && q.gels.includes(n.id));
    h += `<div style="margin:14px 0;font:12px sans-serif;color:#111">
      <b>${esc(n.title || n.kind)}</b>${rep ? ' <i>(replicate — quantified, not shown in the figure)</i>' : ''}
      — ${esc(s.name)}, ${s.w}×${s.h} px, ${s.bits}-bit<br>
      <span style="color:#555">in the figure at black ${Math.round(n.levels.black)} / white ${Math.round(n.levels.white)},
      γ ${n.levels.gamma ?? 1}${n.levels.invert ? ', inverted' : ''}; shown here as scanned — the outline is the region used</span>
      <div style="position:relative;width:${W}px;margin-top:6px">
        <img src="${s.preview}" style="width:${W}px;display:block;border:1px solid #ccc">
        <svg viewBox="0 0 ${W} ${H}" style="position:absolute;inset:0;width:${W}px;height:${H}px">${ov}</svg>
      </div>`;
    const m = n.marker && source(n.marker.src);
    if (m && m.preview) {
      const km = W / m.w, cm = markerCrop(n);
      h += `<div style="margin-top:8px;color:#555">white light of the same membrane — ${esc(m.name)},
            ${m.w}×${m.h} px, ${m.bits}-bit${n.ladder.from === 'white light' ? '; the size standards were read from it' : ''}</div>
            <div style="position:relative;width:${W}px;margin-top:4px">
              <img src="${m.preview}" style="width:${W}px;display:block;border:1px solid #ccc">
              <svg viewBox="0 0 ${W} ${m.h * km}" style="position:absolute;inset:0;width:${W}px;height:${m.h * km}px">
                <rect x="${cm.x * km}" y="${cm.y * km}" width="${cm.w * km}" height="${cm.h * km}"
                      fill="none" stroke="#c62f34" stroke-width="2"/></svg>
            </div>`;
    }
    h += `</div>`;
  });
  if (!gels.length) h += `<p style="font:12px sans-serif">No gel or blot panels in this figure.</p>`;

  // The numbers behind every quantification: what a source-data policy means
  // by the data underlying a graph.
  doc.nodes.filter(n => n.type === 'quant').forEach((q, i) => {
    const D = quantData(q);
    if (!D.conditions.length) return;
    const td = 'style="padding:2px 8px;border-bottom:1px solid #ddd;text-align:right"';
    h += `<h3 style="font:600 13px sans-serif;color:#111;margin-top:18px">${esc(q.title || `Quantification ${i + 1}`)} —
          ${D.readout === 'size' ? `apparent size of ${esc(D.target)}, kDa`
            : D.readout === 'share' ? `${esc(D.target)}, % of the protein`
            : `${esc(D.target)}${D.control ? ` / ${esc(D.control)}` : ''}${q.norm === 'ref' && D.ref ? `, relative to ${esc(D.ref)}` : ''}`}</h3>
          <table style="border-collapse:collapse;font:12px sans-serif;color:#111">
          <tr><th ${td}>condition</th>${D.reps.map((r, j) => `<th ${td}>${j + 1}. ${esc(r.name)}</th>`).join('')}
              <th ${td}>n</th><th ${td}>mean</th><th ${td}>SD</th><th ${td}>SEM</th></tr>` +
         D.conditions.map(c => {
           const s = D.summary[c];
           return `<tr><td ${td} style="text-align:left">${esc(c)}</td>` +
             D.reps.map(r => { const v = r.vals[c]; return `<td ${td}>${v && isFinite(v.norm) ? r3(v.norm) : '—'}</td>`; }).join('') +
             `<td ${td}>${s.n}</td><td ${td}>${isFinite(s.mean) ? r3(s.mean) : ''}</td>` +
             `<td ${td}>${isFinite(s.sd) ? r3(s.sd) : ''}</td><td ${td}>${isFinite(s.sem) ? r3(s.sem) : ''}</td></tr>`;
         }).join('') + `</table>` +
         (D.excluded.length ? `<p style="font:12px sans-serif;color:#555">Left out: ${esc(D.excluded.join('; '))}.</p>` : '') +
         `<pre style="font:11px monospace;color:#333;white-space:pre-wrap">${esc(quantCsv(q))}</pre>`;
  });
  return h + `</div>`;
}

/* ---- modal ---- */

let modalPayload = { text: '', name: 'report.txt' };

function showModal(title, bodyHtml, text, name) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = bodyHtml;
  modalPayload = { text, name };
  $('#modal').hidden = false;
}
$('#modalClose').onclick = () => { $('#modal').hidden = true; };
$('#modal').onclick = ev => { if (ev.target.id === 'modal') $('#modal').hidden = true; };
$('#modalCopy').onclick = () => {
  navigator.clipboard.writeText(modalPayload.text).then(() => hint('Copied.'));
};
$('#modalSave').onclick = () => {
  const type = modalPayload.name.endsWith('.html') ? 'text/html' : 'text/plain';
  download(new Blob([modalPayload.text], { type }), modalPayload.name);
};

/* ================= the purification protocol ================= */

/** The purification this figure is of, as the bench wrote it down.
 *
 *  A protocol in this lab is a Word file: headings with a date on them, steps
 *  under them, and -- in a color that is not the body's -- what actually
 *  happened on the day.  That color is the whole of the import.  It is the line
 *  between the recipe, which is the same every time, and the one experiment the
 *  figure is about, and it is the experiment that belongs beside a figure.
 *
 *  It comes in as text and stays text: a title, headings, steps, lines
 *  belonging to the step above them, comments, and `*spans*` where a value was
 *  written over the recipe's own.  All six survive the trip back out to Word,
 *  so editing here is editing a protocol rather than filling in a form -- and
 *  editing is also the repair for every heading the reader guessed wrong.
 */
function protocolDoc() {
  if (!doc.protocol) doc.protocol = { text: '', color: 'FF0000', src: '' };
  return doc.protocol;
}

/** What each panel is, in one phrase, for the overview the document opens
 *  with.  The caption says all of this properly; this is the contents page. */
function panelWhat(n) {
  if (n.type === 'gel') {
    return [n.title, n.kind, n.antibody && `anti-${n.antibody}`].filter(Boolean).join(', ');
  }
  if (n.type === 'chrom') return `chromatogram on ${n.column.name || 'the column'}`;
  if (n.type === 'quant') return `quantification of ${n.target || 'the bands'}`;
  if (n.type === 'table') return n.title || 'purification table';
  if (n.type === 'nanodrop') return 'concentrations from A₂₈₀';
  if (n.type === 'construct') return 'the construct';
  return n.type;
}

function protocolModal() {
  const P = protocolDoc();
  showModal('Purification protocol', `
    <div class="prot-bar">
      <button id="protImport" class="ghost small">Import from Word…</button>
      <span class="dim" id="protSrc"></span>
      <span class="spacer"></span>
      <button id="protDocx" class="small">Export .docx with the figure</button>
      <button id="protPdf" class="small">Export .pdf</button>
    </div>
    <textarea id="protText" class="prot-text" spellcheck="false"
      placeholder="Import the Word protocol, or write it here."></textarea>
    <p class="note"><b>#</b> the title · <b>##</b> a heading, usually a date ·
      <b>-</b> a step · two spaces for a line belonging to the step above it ·
      <b>&gt;</b> a comment from this experiment · <b>*marked*</b> for a value
      written over the recipe's own. Comments and marked values go back out to
      Word in ${esc(P.color)}.</p>`, P.text, 'protocol.md');
  const ta = $('#protText');
  // A protocol is text, not markup: it goes in through .value, never innerHTML.
  ta.value = P.text;
  ta.oninput = () => { P.text = ta.value; modalPayload.text = ta.value; touch(); };
  $('#protSrc').textContent = P.src ? P.src.replace(/^.*\//, '') : '';
  $('#protImport').onclick = protocolImport;
  $('#protDocx').onclick = () => protocolExport('docx');
  $('#protPdf').onclick = () => protocolExport('pdf');
}

async function protocolImport() {
  const p = await LK.browse({ mode: 'file', exts: ['.docx'], title: 'The Word protocol' });
  if (!p) return;
  try {
    const r = await api('/api/protocol/open', { path: p });
    const P = protocolDoc();
    P.text = r.text; P.color = r.color; P.src = r.path;
    touch();
    protocolModal();
    hint(`Read ${r.name} — the comments in it are ${r.color}. ` +
         `Look over the headings: which lines are headings is a guess.`);
  } catch (err) {
    hint('Could not read that protocol: ' + err.message, true);
  }
}

/** The protocol, the figure and the overview as one document.
 *
 *  It goes beside the session, because that is where the figure's own files
 *  already are, and it never writes over a document already there -- the same
 *  name twice gets a -2.  Exporting is cheap; a protocol is not. */
async function protocolExport(fmt) {
  const P = protocolDoc();
  if (!P.text.trim()) { hint('Nothing to export yet — import a protocol first.', true); return; }
  if (!backend.ok) { hint('Writing a .docx or a .pdf needs the backend.', true); return; }
  let dir = session.path ? session.path.replace(/\/[^/]*$/, '') : '';
  if (!dir) dir = await LK.browse({ mode: 'dir', title: 'Where to put the document' });
  if (!dir) return;
  hint('Rendering the figure…');
  const png = await figurePng(300);
  try {
    const r = await api('/api/protocol/export', {
      path: `${dir.replace(/\/+$/, '')}/${defaultName()}_purification.${fmt}`,
      text: P.text, color: P.color, png, pngMm: [doc.page.w, doc.page.h],
      title: doc.meta.title || '',
      figure: figurePanels().map((n, i) => `(${panelLetter(i)}) ${panelWhat(n)}`),
      // The legend the figure already writes for itself, without the markdown.
      caption: captionDraft().replace(/\*\*/g, ''),
    });
    hint(`Wrote ${r.name} · ${(r.bytes / 1024).toFixed(0)} kB, beside the session.`);
    sayPasteboard();
  } catch (err) {
    hint('Could not write it: ' + err.message, true);
  }
}

/* ================= file I/O ================= */

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/* ================= the session ================= */

/** A figure is what comes out; a session is what you come back to.
 *
 *  The two are not the same file and should not pretend to be.  An SVG is
 *  finished — it has lost the crop rectangle, the levels, which lane was
 *  excised and why, the fraction the brace ties to which lane.  The session
 *  keeps all of that, plus where you were looking and what you had selected,
 *  so that reopening it puts you back at the desk rather than at the start.
 *
 *  It is a file on disk with a name you chose, not a download that lands in
 *  ~/Downloads as figure(4).json: ⌘S writes over the one you opened, and the
 *  toolbar says which that is and whether it is behind.  With the server down
 *  it falls back to download-and-drop, which still works, and says so.
 *
 *  What it does *not* embed is the original scans.  A 16-bit TIFF is thirty
 *  megabytes and already on disk; the session points at it, and every panel
 *  carries its own rendered image, so the figure draws whether or not the
 *  original is reachable.  Only re-cropping and re-leveling need the file, so
 *  a session that cannot find one says so plainly instead of failing later. */

const SESSION_FORMAT = 'purifig-session';
const SESSION_VERSION = 1;
const AUTOSAVE_MS = 20000;
const RECENT_KEY = 'purifig.recent', UI_KEY = 'purifig.ui', LOCAL_AUTOSAVE = 'purifig.autosave';

let session = { path: null, name: null, dirty: false, savedAt: null, autosave: 'off' };

//: Bumped by every edit.  The autosave writes only when this has moved, so a
//: figure left open all afternoon is not re-serialized every twenty seconds
//: for no reason — on a four-gel figure that is megabytes of stringify.
let revision = 0, autosavedAt = -1;

const store = {
  get(k, dflt) { try { return JSON.parse(localStorage.getItem(k)) ?? dflt; } catch (e) { return dflt; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
  drop(k) { try { localStorage.removeItem(k); } catch (e) { /* private mode */ } },
};

/* ---- what is in a session besides the document ---- */

function uiState() {
  return { snap: $('#snap').checked, grid: $('#grid').checked,
           dpi: $('#dpi').value, alignRef };
}

function applyUi(u) {
  if (!u) return;
  if (u.snap !== undefined) $('#snap').checked = !!u.snap;
  if (u.grid !== undefined) $('#grid').checked = !!u.grid;
  if (u.dpi) $('#dpi').value = u.dpi;
  if (u.alignRef) alignRef = u.alignRef;
}

//: Preferences about the tool outlive the document they were set in.
function rememberUi() { store.set(UI_KEY, uiState()); }
function restoreUi() { applyUi(store.get(UI_KEY, null)); }

function sessionPayload() {
  return {
    format: SESSION_FORMAT, version: SESSION_VERSION,
    app: 'purifig', savedAt: new Date().toISOString(),
    doc, view: { ...view }, sel: [...sel], ui: uiState(),
  };
}

/** Accept a session, or a bare document from before sessions existed. */
function readSession(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('not a PuriFig file');
  if (raw.format === SESSION_FORMAT) return raw;
  if (raw.nodes && raw.page) return { doc: raw, view: null, sel: [], ui: null };
  throw new Error('not a PuriFig session or figure');
}

/** Put a whole session on screen.  `view` is restored after `reset`, which
 *  fits the page — reopening where you were beats reopening zoomed out. */
function applySession(s, where) {
  const S = readSession(s);
  reset(S.doc);
  applyUi(S.ui);
  if (S.view && S.view.w > 0) { view = { ...S.view }; matchAspect(); }
  if (S.sel) sel = new Set(S.sel.filter(id => node(id) || edge(id)));
  session = { path: (where && where.path) || null, name: (where && where.name) || null,
              dirty: false, savedAt: S.savedAt || null, autosave: session.autosave };
  syncPage();
  render(); inspector(); showSession();
}

/** Put the page controls back in step with the document.
 *
 *  Without this the boxes still read 183 × 240 over a 120 mm page, and the next
 *  keystroke in either of them resizes the page to the number that was left
 *  lying in the box. */
function syncPage() {
  $('#pageW').value = doc.page.w;
  $('#pageH').value = doc.page.h;
  const p = PRESETS.find(x => x[1] === doc.page.w && x[2] === doc.page.h);
  $('#preset').value = p ? p[0] : '';
}

/* ---- has anything changed since the last save ---- */

function touch() {
  revision++;
  if (session.dirty) return;
  session.dirty = true;
  showSession();
}

function showSession() {
  const el = $('#sessionName');
  if (!el) return;
  el.textContent = (session.name || 'untitled') + (session.dirty ? ' •' : '');
  el.classList.toggle('dirty', session.dirty);
  el.title = (session.path || 'not saved to a file yet') +
             (session.dirty
               ? '\n\nunsaved changes' +
                 (session.autosave === 'off' ? ' — autosave is off'
                                             : `, autosaved to ${session.autosave}`)
               : '\n\nsaved');
}

/** Ask before throwing work away.  Only for things that replace the document
 *  in place — the browser puts up its own dialog when the tab is closed. */
function confirmDiscard(what) {
  if (!session.dirty) return true;
  return confirm(`${session.name || 'This session'} has unsaved changes.\n\n${what} anyway?`);
}

/* ---- recently used ---- */

function recentSessions() { return store.get(RECENT_KEY, []).filter(r => r && r.path); }

function rememberRecent(path, name) {
  if (!path) return;
  const list = [{ path, name, at: Date.now() }]
    .concat(recentSessions().filter(r => r.path !== path)).slice(0, 10);
  store.set(RECENT_KEY, list);
  fillRecent();
}

function fillRecent() {
  const el = $('#recent');
  if (!el) return;
  const list = recentSessions();
  el.innerHTML = `<option value="">recent…</option>` +
    list.map(r => `<option value="${esc(r.path)}">${esc(r.name || r.path)}</option>`).join('') +
    (list.length ? `<option value="__clear">— forget this list —</option>` : '');
  el.disabled = !list.length;
}

/* ---- saving ---- */

function defaultName() {
  return (doc.meta.title || 'figure').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') ||
         'figure';
}

/** Save the session.  `as` forces the file dialog even when there is a path. */
async function saveSession(as) {
  if (!backend.ok) return saveDownload();
  let path = session.path;
  if (as || !path) {
    const dir = await LK.browse({
      mode: 'dir', exts: ['.json'],     // so the folder shows the sessions in it
      title: as && session.path ? 'Save the session as…' : 'Where to keep this session',
      hint: 'The session file goes here. Scans you dropped on the canvas are copied ' +
            'into a folder beside it, so they cannot be lost to a temp cleanup.',
    });
    if (!dir) return;
    const name = prompt('File name:', (session.name || defaultName() + '.purifig.json'));
    if (!name) return;
    path = dir.replace(/\/+$/, '') + '/' + name.trim();
  }
  await writeSession(path, path === session.path);
}

async function writeSession(path, overwrite) {
  const payload = sessionPayload();
  try {
    const r = await api('/api/session/save', { path, session: payload, overwrite: !!overwrite });
    if (r.needsOverwrite) {
      if (!confirm(`${r.name} already exists.\n\nReplace it?`)) return;
      return writeSession(path, true);
    }
    // A dropped scan that was living in a temp folder now lives beside the
    // session; the document has to learn its new address or the next crop will
    // go looking in the old one.
    (r.sources || []).forEach(u => { const s = source(u.id); if (s && u.path) s.path = u.path; });
    session = { path: r.path, name: r.name, dirty: false,
                savedAt: payload.savedAt, autosave: session.autosave };
    rememberRecent(r.path, r.name);
    clearAutosave();
    showSession();
    hint(`Saved ${r.name} · ${(r.bytes / 1048576).toFixed(1)} MB` +
         (r.copied && r.copied.length
           ? ` · ${r.copied.length} dropped scan${r.copied.length === 1 ? '' : 's'} copied beside it`
           : ''));
  } catch (err) {
    hint('Could not save: ' + err.message, true);
  }
}

/** With no server there is nowhere on disk to write, so the session goes out
 *  as a download and comes back by being dropped on the canvas. */
function saveDownload() {
  const name = session.name || defaultName() + '.purifig.json';
  download(new Blob([JSON.stringify(sessionPayload())], { type: 'application/json' }), name);
  session.name = name;
  session.dirty = false;
  showSession();
  hint('Backend down — saved as a download. Drop it back on the canvas to reopen it.', true);
}

/* ---- opening ---- */

async function openSession(path) {
  if (!confirmDiscard('Open another session')) return;
  if (!backend.ok) { $('#fileJson').click(); return; }
  if (!path) {
    path = await LK.browse({ mode: 'file', exts: ['.json'], title: 'Open a session' });
    if (!path) return;
  }
  try {
    const r = await api('/api/session/open', { path });
    applySession(r.session, { path: r.path, name: r.name });
    rememberRecent(r.path, r.name);
    reportMissing(r.missing);
  } catch (err) {
    hint('Could not open that session: ' + err.message, true);
    store.set(RECENT_KEY, recentSessions().filter(r => r.path !== path));
    fillRecent();
  }
}

/** A session opened on another machine, or after a folder was moved, points at
 *  scans that are not there.  Everything still draws — the panels carry their
 *  own rendered images — but nothing that needs the original can run, so the
 *  panels that are affected say so and offer to be pointed at the file. */
function reportMissing(missing) {
  doc.sources.forEach(s => { delete s.missing; });
  if (!missing || !missing.length) return;
  missing.forEach(m => { const s = source(m.id); if (s) s.missing = true; });
  hint(`${missing.length} source scan${missing.length === 1 ? ' is' : 's are'} not where this ` +
       `session left ${missing.length === 1 ? 'it' : 'them'} — the figure still draws, but ` +
       `re-cropping needs the file. Use “relink…” on the panel.`, true);
  inspector();
}

function openJsonFile(file) {
  const fr = new FileReader();
  fr.onload = () => {
    try {
      applySession(JSON.parse(fr.result), { path: null, name: file.name });
      hint(`Opened ${file.name}. It is not linked to a file on disk — “save as…” to make it one.`);
    } catch (err) { hint('Could not read that file: ' + err.message, true); }
  };
  fr.readAsText(file);
}

/* ---- autosave ---- */

/** Written every twenty seconds while there is anything to lose, and deleted
 *  the moment the session is saved properly.  So an autosave existing at start
 *  means exactly one thing: last time, work was lost.  That is what makes the
 *  offer to restore it trustworthy rather than a thing to click past. */
let autosaving = false;

async function autosave() {
  if (!session.dirty || autosaving || revision === autosavedAt) return;
  autosaving = true;
  const at = revision;
  const payload = { ...sessionPayload(), from: session.path || null, name: session.name || null };
  try {
    if (backend.ok) {
      const r = await api('/api/session/autosave', { session: payload });
      session.autosave = r.path;
    } else if (store.set(LOCAL_AUTOSAVE, payload)) {
      session.autosave = 'this browser';
    } else {
      // localStorage is a few megabytes and a figure with two gels in it is
      // more than that.  Saying so beats a silent no-op.
      session.autosave = 'off';
      hint('Too large to autosave in the browser — save the session to disk.', true);
    }
  } catch (err) {
    session.autosave = 'off';
  }
  if (session.autosave !== 'off') autosavedAt = at;
  autosaving = false;
  showSession();
}

function clearAutosave() {
  autosavedAt = -1;
  store.drop(LOCAL_AUTOSAVE);
  if (backend.ok) api('/api/session/autosave', { clear: true }).catch(() => {});
}

/** Offer back whatever was in flight when the app last stopped. */
async function offerRestore() {
  let found = null;
  try {
    if (backend.ok) {
      const r = await api('/api/session/autosave');
      if (!r.empty) found = { session: r.session, at: r.savedAt * 1000, where: 'on disk' };
    }
  } catch (err) { /* no autosave to offer */ }
  if (!found) {
    const local = store.get(LOCAL_AUTOSAVE, null);
    if (local) found = { session: local, at: Date.parse(local.savedAt) || 0, where: 'in this browser' };
  }
  if (!found) return;
  const who = found.session.name || 'an unsaved figure';
  const when = found.at ? new Date(found.at).toLocaleString() : 'earlier';
  hint(`PuriFig closed with unsaved changes to ${who} (${when}).`, true, {
    label: 'restore',
    fn: () => {
      applySession(found.session, { path: found.session.from || null,
                                    name: found.session.name || null });
      session.dirty = true; showSession();
      hint('Restored from the autosave. Save it to keep it.');
    },
  });
}

function exportSvgString() {
  // An export is a copy of the canvas, so the canvas has to be the figure
  // again: the white light is shown to be looked at, not to be exported.
  if (unpeek()) render();
  const svg = $('#canvas').cloneNode(true);
  ['#lg', '#lu', '#lb'].forEach(id => { const el = svg.querySelector(id); if (el) el.remove(); });
  // On screen the pictures are blob URLs, which mean nothing outside this tab.
  // The file carries the bytes.
  svg.querySelectorAll('image').forEach(el => {
    const uri = imgSrcs.get(el.getAttribute('href'));
    if (uri) el.setAttribute('href', uri);
  });
  // The pasteboard is not the figure.  A replicate blot kept beside the page
  // would otherwise ride along outside the viewBox — invisible in a browser,
  // there in Illustrator, and a whole embedded scan heavier.
  doc.nodes.filter(offPage).forEach(n => {
    const g = svg.querySelector(`g[data-node="${n.id}"]`);
    if (g) g.remove();
    svg.querySelectorAll(`clipPath[id^="gc${n.id}_"], clipPath[id="cc${n.id}"]`).forEach(c => c.remove());
  });
  [...svg.querySelectorAll('*')].forEach(el => {
    if (el.getAttribute('fill') === 'transparent') el.remove();
  });
  svg.setAttribute('viewBox', `0 0 ${doc.page.w} ${doc.page.h}`);
  svg.setAttribute('width', doc.page.w + 'mm');
  svg.setAttribute('height', doc.page.h + 'mm');
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  svg.removeAttribute('id');
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(svg);
}

/** What the file is called: the name of the session it came out of, so the
 *  figure, the session and the protocol document are one set on disk rather
 *  than figure(3).pdf among them.  The two canvases export the same way, and
 *  two files both called figure.pdf is how a supplementary sheet gets
 *  submitted as the figure. */
const sheetName = () =>
  ((session.name || '').replace(/\.purifig\.json$|\.json$/i, '') || defaultName()) +
  (doc.sheet === 'supp' ? '_supplementary' : '');

function exportSvg() {
  download(new Blob([exportSvgString()], { type: 'image/svg+xml' }), `${sheetName()}.svg`);
  sayPasteboard();
}

/** The figure as a vector PDF — what a journal asks for, and what Illustrator
 *  and Word both open without being told the page size.
 *
 *  Nothing on a lab machine turns an SVG into a PDF: the Python side has no
 *  converter installed and macOS's own `sips` rasterizes it to a JPEG in a PDF
 *  wrapper.  A browser does, so the server prints this very SVG with a
 *  headless one — the same engine that drew the figure, so there is no second
 *  renderer to drift from it.  The labels stay text and the scans go in whole
 *  and lossless; see `svg_to_pdf` for why the page box is rewritten after. */
async function exportPdf() {
  if (!backend.ok) {
    hint('The PDF is drawn by the backend, which is not reachable — SVG still works.', true);
    return;
  }
  const body = JSON.stringify({ svg: exportSvgString(), w: doc.page.w, h: doc.page.h });
  hint('Drawing the PDF…');
  try {
    const r = await fetch('/api/figure/pdf', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    const blob = await r.blob();
    download(blob, `${sheetName()}.pdf`);
    hint(`${sheetName()}.pdf · ${(blob.size / 1048576).toFixed(1)} MB, ` +
         `${r2(doc.page.w)} × ${r2(doc.page.h)} mm, text still text.`);
    sayPasteboard();
  } catch (err) {
    hint('Could not make the PDF: ' + err.message, true);
  }
}

/** Say what an export left out, so a panel that slid off the page is noticed
 *  rather than discovered missing from the submitted figure. */
function sayPasteboard() {
  const off = doc.nodes.filter(offPage);
  if (!off.length) return;
  const reps = off.filter(n => doc.nodes.some(q => q.type === 'quant' && q.gels.includes(n.id))).length;
  hint(`${off.length} panel${off.length === 1 ? ' is' : 's are'} on the pasteboard and ` +
       `${off.length === 1 ? 'was' : 'were'} left out of the figure` +
       (reps ? ` — ${reps === off.length ? (reps === 1 ? 'a replicate' : 'all replicates') : `${reps} of them replicates`} ` +
               `that the quantification still counts` : '') + '.');
}

async function exportPng(dpi) {
  const c = await figureCanvas(dpi);
  if (!c) return;
  c.toBlob(b => download(b, `${sheetName()}_${dpi}dpi.png`), 'image/png');
  sayPasteboard();
}

/** The figure, rasterized.  The PNG export saves it; a protocol document
 *  embeds it. */
async function figureCanvas(dpi) {
  const px = Math.round(doc.page.w / 25.4 * dpi), py = Math.round(doc.page.h / 25.4 * dpi);
  if (px * py > 60e6) { alert(`${px}×${py} px is too large for the browser canvas — export SVG and rasterize it.`); return null; }
  // A blob URL rather than a data URI: a figure with two 16-bit gels in it is
  // already a megabyte of embedded PNG, and percent-encoding that into a URL is
  // a size cliff waiting to be found by someone with four panels.
  const url = URL.createObjectURL(new Blob([exportSvgString()], { type: 'image/svg+xml' }));
  const img = new Image();
  try {
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('render failed')); img.src = url; });
  } finally { setTimeout(() => URL.revokeObjectURL(url), 2000); }
  const c = document.createElement('canvas');
  c.width = px; c.height = py;
  // Nothing is painted behind the figure: the page is white on screen because
  // the canvas draws a page, and a PNG dropped on a slide or a poster should
  // take the background it lands on rather than bring a white card with it.
  // The gels keep their own backgrounds — those are in the scans.
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, px, py);
  return c;
}

const figurePng = async dpi => {
  const c = await figureCanvas(dpi);
  return c ? c.toDataURL('image/png') : null;
};

/* ================= dropping files in ================= */

/** Read one dropped or picked file into the document.
 *
 *  Everything here happens in the browser, so it works with the server down —
 *  which is the whole point of the route: a UNICORN .RES, an export and a plain
 *  CSV all parse client-side, and so does a PNG or JPEG gel.  Only a 16-bit
 *  TIFF has to go the other way, because a File carries no path the server
 *  could open and a browser decoder throws half the depth away. */
async function loadDroppedFile(f, at, into) {
  const name = f.name.toLowerCase();
  // A session dropped on the canvas replaces the whole document, so it asks
  // first — the same question the Open button asks, for the same reason.
  if (name.endsWith('.json') || name.endsWith('.purifig')) {
    if (confirmDiscard(`Open ${f.name}`)) openJsonFile(f);
    return;
  }

  if (/\.(res|csv|tsv|asc|txt|xls)$/.test(name)) {
    const buf = await f.arrayBuffer();
    const u8 = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
    // A .RES is recognized by its magic number, not its extension: UNICORN's
    // ASCII export is often saved under the same one.
    const isRes = u8[0] === 0x11 && u8[1] === 0x47 && u8[2] === 0x11 && u8[3] === 0x47;

    // A CSV off a spectrophotometer and a CSV off a chromatograph are the same
    // file type and a different measurement, so the header decides which panel
    // this is — a column called A280 next to one called Sample is not a trace.
    if (!isRes) {
      const text = decodeTrace(buf);
      const lines = text.split(/\r?\n/).filter(l => l.trim());
      const sep = (lines[0] || '').includes('\t') ? '\t' : (lines[0] || '').includes(';') ? ';' : ',';
      if (looksLikeNanodrop(lines.slice(0, 240).map(l => splitRow(l, sep)))) {
        const n = into && into.type === 'nanodrop' ? into : addNode('nanodrop', at, { mark: false });
        const r = parseNanodropText(text);
        n.readings.push(...r.rows);
        if (!n.title) n.title = f.name.replace(/\.[^.]+$/, '');
        hint(`${r.rows.length} readings, from ${r.mapped.join(', ')}.`);
        return;
      }
    }

    // A panel only takes a file of its own kind.  Dropped on the wrong one, the
    // file makes its own panel rather than being forced into a shape it is not:
    // a chromatogram read as absorbance readings is 1800 rows of nonsense that
    // looks exactly like data.
    const n = into && into.type === 'chrom' ? into : addNode('chrom', at, { mark: false });
    n.source = f.name;
    const r = isRes ? parseResBuffer(buf, n) : parseTraceText(decodeTrace(buf), n);
    n.fractions.every = fracLabelStep(n);
    titleFromSource(n);
    hint(`${r.curves} curves${r.fractions ? `, ${r.fractions} fraction marks` : ''}` +
         (r.res ? ' \u2014 UNICORN .RES' : r.paired ? ' \u2014 paired-column export' : '') +
         (n.inject && n.inject.offset ? `, injected at ${r2(n.inject.raw)} mL.` : '.'));
    return;
  }

  // A TIFF the browser cannot decode at full depth, so the bytes go to the
  // server and come back as an ordinary source.  Only the *path* was ever the
  // obstacle; a dropped file has none, so we hand over the file itself.
  const src = /\.(tif|tiff|gel|scn)$/.test(name)
    ? await uploadSource(f)
    : await openSourceFromFile(f);
  const channel = channelOf(f.name);
  // The white light of a blot that already has its signal is the second
  // picture of that membrane, not a replacement for the first.
  if (into && into.type === 'gel' && into.src && channel === 'marker') {
    const k = await attachMarker(into, src);
    hint(`White light: ${f.name}${k === 1 ? ', same frame as the signal' : `, ${k}× the signal’s size`}.`);
    return into;
  }
  const n = into && into.type === 'gel' ? into
          : addNode(channel === 'signal' ? 'blot' : 'gel', at, { mark: false });
  n.src = src.id;
  n.crop = null;
  Object.assign(n.levels, src.suggest);
  await refreshGelImage(n);
  return n;
}

const IMAGE_FILE = /\.(tif|tiff|gel|scn|png|jpe?g|bmp)$/i;

/** Hand a dropped scan to the backend, which reads it at full depth and keeps a
 *  working copy for the crop and levels calls that follow. */
async function uploadSource(file) {
  if (!backend.ok) {
    throw new Error(`${file.name} needs the server running — a browser cannot read a ` +
                    `TIFF at full depth. A PNG or JPEG export of the scan works without it.`);
  }
  const r = await fetch(`/api/image/upload?name=${encodeURIComponent(file.name)}`,
                        { method: 'POST', body: file });
  const info = await r.json().catch(() => ({ error: r.statusText }));
  if (!r.ok || info.error) throw new Error(info.error || r.statusText);
  const src = {
    id: uid(), name: info.name, path: info.path, kind: 'gel',
    w: info.w, h: info.h, bits: info.bits, note: info.note,
    preview: info.preview, hist: info.hist,
    rangeLo: info.rangeLo, rangeHi: info.rangeHi,
    dataLo: info.min, dataHi: info.max,
    p01: info.p01, p999: info.p999, saturatedFraction: info.saturatedFraction,
    darkBands: info.darkBands, suggest: info.suggest,
    membraneId: '', server: true, dropped: true,
  };
  doc.sources.push(src);
  hint(`${info.name} — ${info.w}×${info.h}, ${info.bits}-bit${info.note ? ', ' + info.note : ''}.`);
  return src;
}

async function loadFiles(files, at, into) {
  if (!files || !files.length) return;
  // One step for the whole drop: the panels it creates and the data loaded into
  // them are one act, and undoing should not leave empty panels behind.
  mark();
  files = [...files];
  // Two pictures of one membrane dropped together — the chemiluminescence and
  // its white light, named alike — make one blot panel rather than two panels
  // of which one is only a ladder.
  const imgs = files.filter(f => IMAGE_FILE.test(f.name));
  const pairs = imgs.length > 1 ? pairChannels(imgs).filter(g => g.signal && g.marker) : [];
  for (const g of pairs) {
    const before = doc.nodes.length;
    files = files.filter(f => f !== g.signal && f !== g.marker);
    try {
      const n = await loadDroppedFile(g.signal, at, into && into.type === 'gel' ? into : null);
      const msrc = /\.(tif|tiff|gel|scn)$/i.test(g.marker.name) ? await uploadSource(g.marker)
                                                               : await openSourceFromFile(g.marker);
      await attachMarker(n, msrc);
      const split = await splitMembranes(n);
      hint(`${g.signal.name} with its white light, ${g.marker.name}` +
           `${n.marker.k === 1 ? '' : ` (${n.marker.k}× its size, matched by scale)`}` +
           `${split.panels > 1 ? ` — ${split.panels} membranes in that field, one panel each, ` +
                                 `cut edges marked` : ''}` +
           `${split.laddered ? `; the size standards found in the white light on ` +
                               `${split.laddered} of them — type the sizes` : ''}.`);
    } catch (err) {
      if (doc.nodes.length > before) {
        doc.nodes.slice(before).forEach(x => sel.delete(x.id));
        doc.nodes.length = before;
      }
      hint(err.message, true);
    }
    into = null;
    at = [at[0] + 8, at[1] + 8];
  }
  for (const f of files) {
    const before = doc.nodes.length;
    try { await loadDroppedFile(f, at, into); }
    catch (err) {
      // A file that would not parse should not leave an empty panel behind for
      // the reader to wonder about.
      if (doc.nodes.length > before) {
        doc.nodes.slice(before).forEach(x => sel.delete(x.id));
        doc.nodes.length = before;
      }
      hint(err.message, true);
    }
    into = null;                        // only the first file lands in a given panel
  }
  render(); inspector();
}

/* Drops are taken anywhere in the window, not just over the canvas.  A drop the
   page does not handle is one the browser handles instead — by navigating away
   to the file, which loses the figure and looks for all the world like nothing
   happened.  The counter is because dragenter/dragleave also fire for every
   child element the pointer crosses, which makes a veil bound to them flicker. */
const veil = $('#dropveil');
let dragDepth = 0;

window.addEventListener('dragenter', ev => {
  ev.preventDefault();
  if (++dragDepth === 1 && [...(ev.dataTransfer?.types || [])].includes('Files')) veil.classList.add('show');
});
window.addEventListener('dragover', ev => { ev.preventDefault(); });
window.addEventListener('dragleave', ev => {
  ev.preventDefault();
  if (--dragDepth <= 0) { dragDepth = 0; veil.classList.remove('show'); }
});
window.addEventListener('drop', async ev => {
  ev.preventDefault();
  dragDepth = 0; veil.classList.remove('show');
  const files = ev.dataTransfer && ev.dataTransfer.files;
  if (!files || !files.length) return;
  // Dropped on a panel, the file loads into it; dropped anywhere else it makes
  // its own — including over the toolbar or the inspector, where the pointer
  // ends up often enough that refusing there reads as a broken app.
  const over = $('#stage').contains(ev.target);
  const at = over ? toDoc(ev) : [view.x + view.w * 0.22, view.y + view.h * 0.22];
  const hit = over ? hitNode(at) : null;
  const takes = hit && ['chrom', 'gel', 'nanodrop'].includes(hit.type);
  await loadFiles(files, at, takes ? hit : null);
});

/** The OS file picker, for a spectrophotometer table with no server to browse. */
function pickNanodropFile(n) {
  const input = $('#fileTrace');
  input.value = '';
  input.onchange = async () => {
    const f = input.files[0];
    if (!f) return;
    mark();
    try {
      const r = parseNanodropText(decodeTrace(await f.arrayBuffer()));
      n.readings.push(...r.rows);
      hint(`${r.rows.length} readings, from ${r.mapped.join(', ')}.`);
    } catch (err) { hint(err.message, true); }
    render(); inspector();
  };
  input.click();
}

/** The OS file picker, for when there is no server to browse with. */
function pickTraceFile(n) {
  const input = $('#fileTrace');
  input.value = '';
  input.onchange = async () => {
    const f = input.files[0];
    if (f) await loadFiles([f], [view.x + view.w * 0.22, view.y + view.h * 0.22], n);
  };
  input.click();
}

$('#fileImage').addEventListener('change', async ev => {
  const f = ev.target.files[0];
  if (f) mark();
  if (!f) return;
  const n = selNodes()[0];
  try {
    const src = await openSourceFromFile(f);
    if (n && n.type === 'gel') {
      n.src = src.id; n.crop = null;
      Object.assign(n.levels, src.suggest);
      await refreshGelImage(n);
    }
  } catch (err) { hint(err.message, true); }
  ev.target.value = '';
  render(); inspector();
});
$('#fileJson').addEventListener('change', ev => {
  if (ev.target.files[0]) openJsonFile(ev.target.files[0]);
  ev.target.value = '';
});

/* ================= toolbar ================= */

document.querySelectorAll('[data-add]').forEach(b =>
  b.onclick = () => addNode(b.dataset.add));
document.querySelectorAll('[data-connect]').forEach(b =>
  b.onclick = () => { setMode('connect', b.dataset.connect); hint('Click the source panel, then the target.'); });

$('#preset').innerHTML = PRESETS.map(p => `<option>${p[0]}</option>`).join('');
$('#preset').onchange = () => {
  const p = PRESETS.find(x => x[0] === $('#preset').value);
  touch();
  doc.page.w = p[1]; doc.page.h = p[2];
  $('#pageW').value = p[1]; $('#pageH').value = p[2];
  fitView(); render();
};
$('#pageW').oninput = () => { doc.page.w = +$('#pageW').value || 183; touch(); render(); };
$('#pageH').oninput = () => { doc.page.h = +$('#pageH').value || 240; touch(); render(); };
$('#snap').onchange = $('#grid').onchange = () => { rememberUi(); render(); };
$('#dpi').onchange = rememberUi;
$('#fit').onclick = () => { fitView(); render(); };
$('#sheet').onclick = async () => {
  if (doc.sheet === 'supp') return showSheet('figure');
  await endCrop();
  // Empty means never built: switching to a blank sheet and being told to find
  // a button is a step nobody wants, so the first switch builds it.
  if (!doc.other || !doc.other.nodes.length) return buildSupplementary();
  showSheet('supp');
};
$('#peekWhite').onchange = () => render();
$('#save').onclick = () => saveSession(false);
$('#saveAs').onclick = () => saveSession(true);
$('#open').onclick = () => openSession();
$('#new').onclick = () => {
  if (!confirmDiscard('Start a new figure')) return;
  applySession({ format: SESSION_FORMAT, doc: blankDoc(doc.page.w, doc.page.h) }, {});
  clearAutosave();
};
$('#recent').onchange = ev => {
  const v = ev.target.value;
  ev.target.selectedIndex = 0;
  if (!v) return;
  if (v === '__clear') { store.drop(RECENT_KEY); fillRecent(); return; }
  openSession(v);
};
// A crop still being dragged is interface, not figure: the panel is showing the
// whole scan under a dimming veil while the outline is moved, and that veil is
// what would land in the file.  Every export finishes the crop first.
$('#expPdf').onclick = async () => { await endCrop(); await exportPdf(); };
$('#expSvg').onclick = async () => { await endCrop(); exportSvg(); };
$('#expPng').onclick = async () => { await endCrop(); exportPng(+$('#dpi').value); };
$('#expSource').onclick = async () => {
  await endCrop();
  const html = sourceDataSheet();
  showModal('Source data — uncropped scans', html,
    `<!doctype html><meta charset="utf-8"><title>Source data</title>` +
    `<body style="background:#fff;margin:20px">${html}</body>`, 'source_data.html');
};
$('#integrity').onclick = () => {
  const t = integrityReport();
  showModal('Image processing record', `<pre>${esc(t)}</pre>`, t, 'image_processing_record.txt');
};
$('#caption').onclick = () => {
  const t = captionDraft();
  showModal('Draft figure legend', `<pre>${esc(t)}</pre>`, t, 'figure_legend.md');
};
$('#protocol').onclick = protocolModal;
$('#methods').onclick = () => {
  const t = methodsDraft();
  showModal('Draft methods — band quantification', `<pre>${esc(t)}</pre>`, t, 'methods.md');
};
$('#example').onclick = () => {
  if (!confirmDiscard('Load the example')) return;
  applySession({ format: SESSION_FORMAT, doc: exampleDoc() }, {});
};

window.addEventListener('resize', () => { canvasRect = null; matchAspect(); render(); });

/* ================= example ================= */

function synthChrom() {
  const pts = [];
  const g = (x, c, a, w) => a * Math.exp(-((x - c) ** 2) / (2 * w * w));
  for (let v = 6; v <= 24; v += 0.02) {
    const y = g(v, 8.2, 22, 0.35) + g(v, 12.6, 140, 0.55) + g(v, 15.4, 46, 0.5)
            + g(v, 19.5, 12, 0.9) + 2 + Math.sin(v * 7) * 0.5;
    pts.push([r3(v), r2(y)]);
  }
  return pts;
}

function exampleDoc() {
  const d = blankDoc(183, 150);
  d.meta = { title: 'Figure S1', protein: 'ExampleR', construct: 'residues 1–412',
             tag: 'N-terminal Twin-Strep–3C', host: 'Expi293F', notes: '' };

  const c = chromNode(18, 14);
  c.w = 74; c.h = 42;
  const uv = synthChrom();
  c.traces = [
    { id: uid(), name: 'UV 280', unit: 'mAU', on: true, axis: 'left', color: '#000000',
      dash: '', width: 0, pts: uv, _max: 140 },
    { id: uid(), name: 'UV 260', unit: 'mAU', on: true, axis: 'left', color: '#c62f34',
      dash: '1.6 1.2', width: 0, pts: uv.map(p => [p[0], r2(p[1] * 0.55)]), _max: 77 },
  ];
  c.column = { name: 'Superose 6 Increase 10/300 GL', cv: 24, v0: 8.0, vt: 24, flow: 0.5,
               buffer: '20 mM HEPES pH 7.5, 150 mM NaCl, 0.5 mM TCEP' };
  c.calib = { on: true, kit: 'Cytiva HMW kit',
              standards: [{ name: 'Thyroglobulin', kDa: 669, ve: 10.1 },
                          { name: 'Ferritin', kDa: 440, ve: 11.6 },
                          { name: 'Aldolase', kDa: 158, ve: 13.7 },
                          { name: 'Conalbumin', kDa: 75, ve: 15.2 },
                          { name: 'Ovalbumin', kDa: 44, ve: 16.3 }], fit: null };
  c.calib.fit = chromFit(c);
  c.fractions.marks = [];
  for (let v = 9, i = 1; v <= 20; v += 0.5, i++) c.fractions.marks.push({ v: r2(v), label: String(i) });
  c.fractions.pooled = [12.0, 13.5];
  c.fractions.every = 4;
  c.peaks = [{ v: 12.6, label: 'ExampleR', showV: true, showMW: true, showRatio: false },
             { v: 8.2, label: 'void', showV: false, showMW: false, showRatio: false }];
  d.nodes.push(c);

  const a = newNode('panel', 10, 13); a.text = 'A'; d.nodes.push(a);
  const b = newNode('panel', 100, 14); b.text = 'B'; d.nodes.push(b);
  const e = newNode('panel', 10, 82); e.text = 'C'; d.nodes.push(e);

  const t = tableNode(108, 16);
  t.w = 62; t.fontPt = 5.5; t.rowMm = 3.1;
  t.cols = [{ key: 'step', label: 'Step', align: 'start', w: 24 },
            { key: 'total', label: 'Protein\n(mg)', align: 'end', w: 12 },
            { key: 'purity', label: 'Purity\n(%)', align: 'end', w: 10 },
            { key: 'yield', label: 'Yield\n(%)', align: 'end', w: 10 }];
  d.nodes.push(t);

  const g = gelNode(18, 84);
  g.h = 30; g.title = 'Peak fractions';
  g.kind = 'SDS-PAGE'; g.acrylamide = '4–20% gradient'; g.stain = 'InstantBlue';
  g.lanes = [];
  d.nodes.push(g);

  const note = newNode('text', 18, 120);
  note.w = 150; note.h = 14; note.fontPt = 6; note.align = 'start';
  note.text = 'Load a gel into panel C — drop a PNG on it, or use "load image…" for a 16-bit TIFF.\n' +
              'Then set the lane count, click the ladder bands, and cut the lanes you are not showing.';
  d.nodes.push(note);

  d.edges.push({ ...newEdge('brace', c.id, g.id), strokeMm: 0.2 });
  return d;
}

/* ================= boot ================= */

PF.render = render;
PF.inspector = inspector;
PF.api = api;
PF.hint = hint;
PF.select = id => { sel = new Set([id]); render(); inspector(); };
PF.source = source;
PF.croppingNode = () => (mode === 'crop' && pending ? pending.node : null);
PF.cropHold = n => (mode === 'crop' && pending && pending.node === n.id ? pending.hold : null);
PF.pick = armPick;
PF.viewOverride = viewOverride;
PF.imgUrl = imgUrl;

reset(blankDoc(183, 150));
syncPage();
restoreUi();
fillRecent();
showSession();
LK.mountThemeToggle('#exportGroup');

// Leaving with work in it should take a deliberate click, whatever the browser
// chooses to say in its own dialog.
window.addEventListener('beforeunload', ev => {
  if (!session.dirty) return;
  ev.preventDefault();
  ev.returnValue = '';
});
setInterval(autosave, AUTOSAVE_MS);

pingBackend().then(async () => {
  applySession({ format: SESSION_FORMAT, doc: exampleDoc() }, {});
  await offerRestore();
});
render();
inspector();
