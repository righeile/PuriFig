/* What a session saved by an older build is missing.
 *
 *     node test_defaults.js
 *
 * A file is opened as it was written, so every field added since it was saved
 * is simply absent from it.  The ones the renderer multiplies by are the
 * dangerous ones: a gel with no `labelGap` makes `gelTop()` NaN, a chromatogram
 * with no `tickMm` makes `chromBottom()` NaN, and an edge with no `labelDy`
 * hangs its label at NaN — none of which shows on the page, and all of which
 * goes out in the exported SVG.  What is checked is that opening fills those
 * in from a fresh panel of the same type, that the geometry comes back finite,
 * and that nothing the file did say is touched: a blank title, an empty lane
 * list and a null crop are answers, not gaps.
 */
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

vm.runInThisContext(fs.readFileSync(__dirname + '/panels.js', 'utf8'), { filename: 'panels.js' });

// The node and edge constructors from app.js: `reset()` fills against these,
// and they are the only part of it this needs.
const app = fs.readFileSync(__dirname + '/app.js', 'utf8');
vm.runInThisContext(app.slice(app.indexOf('function newNode(type, x, y) {'),
                              app.indexOf('/* ================= geometry ================= */')),
                    { filename: 'app.js (constructors)' });

// As `reset()` does it, for one node.
const open = n => fillDefaults(n, newNode(n.type, 0, 0));

// A gel from before the blot and quantification fields existed, before the
// label sizes were settable, and with one lane cut by hand.
const gel = open({
  id: 'g1', type: 'gel', x: 18, y: 84, w: 60, h: 30, title: 'Peak fractions',
  src: null, crop: null, href: null, imgW: 0, imgH: 0,
  lanes: [{ id: 'a', x0: 0, x1: 10, role: 'SEC fraction', label: '7', excised: false }],
  ladder: { on: true, side: 'left', pt: 5.5, lw: 0.22, marks: [] },
  splice: { gap: 1.0, rule: true, ruleMm: 0.3 }, labelAngle: 0,
});
assert.deepStrictEqual([gel.labelPt, gel.labelGap, gel.titlePt], [7, 1, 8],
                       'the label sizes a gel is measured by were not filled in');
assert.deepStrictEqual(gel.quant, { method: 'border', border: 3, inset: 0.05, rows: [], bands: [] },
                       'the quantification block came back incomplete');
assert.strictEqual(gel.view, 'signal', 'the blot fields were not filled in');
assert.ok(Number.isFinite(gelTop(gel)), `gelTop is ${gelTop(gel)}`);

// Nothing the file did say is touched, including the things that look empty.
assert.strictEqual(gel.title, 'Peak fractions', 'the title was overwritten');
assert.strictEqual(gel.crop, null, 'a null crop was filled in as though it were missing');
assert.strictEqual(gel.lanes.length, 1, 'the lanes were replaced');
assert.strictEqual(open({ ...gel, labelPt: 4.5 }).labelPt, 4.5, 'a set label size was overwritten');
// A half-written nested block keeps its own numbers and gains the rest.
const half = open({ ...gel, quant: { method: 'line', rows: [{ id: 'r' }] } });
assert.strictEqual(half.quant.method, 'line', 'the stored method was overwritten');
assert.strictEqual(half.quant.border, 3, 'the rest of the block was not filled in');
assert.strictEqual(half.quant.rows.length, 1, 'the stored rows were replaced');

// A chromatogram from before the tick length and the fraction bar's type sizes.
const chrom = open({
  id: 'c1', type: 'chrom', x: 18, y: 14, w: 74, h: 42, traces: [], peaks: [],
  fractions: { on: true, side: 'bottom', marks: [{ v: 12, label: '7' }], pooled: [12, 13.5] },
});
assert.ok(Number.isFinite(chromBottom(chrom)), `chromBottom is ${chromBottom(chrom)}`);
assert.deepStrictEqual([chrom.fractions.side, chrom.fractions.marks.length], ['bottom', 1],
                       'the fraction bar the file described was not kept');

// The C7 figure type sizes: a new panel has them, and an old quant gains the
// two sizes it lacked while keeping the font size it stored.
assert.strictEqual(newNode('gel', 0, 0).ladder.pt, 6, 'kDa marks are not 6 pt');
const fresh = newNode('quant', 0, 0);
assert.deepStrictEqual([fresh.fontPt, fresh.axisPt, fresh.pPt, fresh.titlePt], [7, 8, 6, 8], 'quant type sizes');
const oldQ = { ...fresh, fontPt: 6 };
delete oldQ.axisPt; delete oldQ.pPt;
open(oldQ);
assert.deepStrictEqual([oldQ.fontPt, oldQ.axisPt, oldQ.pPt], [6, 8, 6], 'an old quant was not filled in');

// The brace between them, saved before its label could be nudged.
const e = { id: 'e1', kind: 'brace', from: 'c1', to: 'g1', label: 'pooled' };
fillDefaults(e, newEdge(e.kind, e.from, e.to));
assert.strictEqual(e.labelDy, -1.2, 'the label offset was not filled in');
assert.strictEqual(e.arrowhead, false, 'a brace came back with an arrowhead');
assert.strictEqual(e.label, 'pooled', 'the label was overwritten');

// The tick that `reset()` used to fill in by hand: a construct saved before it
// existed was drawn cleaved, and still opens ticked.
assert.strictEqual(open({ id: 'k1', type: 'construct', x: 0, y: 0, segs: [] }).cleaved, true,
                   'a construct saved before the tick existed did not open ticked');

console.log('ok — an older session opens with its gaps filled and its answers kept');
