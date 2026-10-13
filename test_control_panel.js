/* A loading control that was probed as its own exposure, and so lives on its
 * own panel.
 *
 *     node test_control_panel.js
 *
 * On a gel the target and the loading control are two rows of one picture.  On
 * a western they usually are not: the membrane is reprobed, or a strip of it is
 * probed on its own, and either way the control is a second exposure and a
 * second panel.  What is checked here is that pointing a replicate at that
 * panel gives the same numbers as having both rows on one blot would, that the
 * lanes are paired by label and not by hope, that a condition loaded twice
 * pairs first-with-first rather than pooling, and that the points of one blot
 * are drawn as one shape and of another blot as another.
 */
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

for (const f of ['protein.js', 'panels.js'])
  vm.runInThisContext(fs.readFileSync(__dirname + '/' + f, 'utf8'), { filename: f });

const uidc = (() => { let i = 0; return () => 'x' + (++i); })();

/** A blot with one row, measured in every lane.  `labels` names the lanes and
 *  `nets` gives each lane's measured signal, so a control panel is built the
 *  same way as a target panel and only the role differs. */
function blot(id, title, labels, nets, role, name) {
  const lanes = labels.map((lab, i) =>
    ({ id: `${id}L${i}`, x0: i * 50, x1: (i + 1) * 50, label: lab, role: 'sample' }));
  const row = { id: id + 'R', name, role };
  return {
    id, type: 'gel', title, imgW: labels.length * 50, imgH: 400, lanes,
    ladder: { on: false, marks: [] },
    quant: {
      method: 'border', border: 3, inset: 0.1, rows: [row],
      bands: lanes.map((l, i) => ({ id: `${id}B${i}`, row: row.id, lane: l.id,
                                    y: 200, h: 20, net: nets[i] })),
    },
  };
}

const LAB = ['WT', 'WT', 'mut', 'mut'];           // each condition loaded twice

// Replicate 1: target on one panel, its GAPDH on another.
const t1 = blot('t1', 'blot 1', LAB, [100, 120, 200, 260], 'target', 'Lamp2');
const c1 = blot('c1', 'blot 1 GAPDH', LAB, [100, 100, 100, 100], 'loading control', 'GAPDH');
// Replicate 2: the control lanes are not all equal, so dividing has to bite.
const t2 = blot('t2', 'blot 2', LAB, [50, 50, 90, 150], 'target', 'Lamp2');
const c2 = blot('c2', 'blot 2 GAPDH', LAB, [50, 25, 50, 50], 'loading control', 'GAPDH');

const q = {
  id: 'q', type: 'quant', x: 0, y: 0, w: 44, h: 32,
  gels: ['t1', 't2'], controls: ['c1', 'c2'],
  target: 'Lamp2', control: 'GAPDH', readout: 'intensity',
  useControl: true, norm: 'ref', ref: 'WT', match: 'label',
  repeats: 'separate', keepSaturated: false, error: 'sd',
  bars: true, points: true, fontPt: 6.5, axisMm: 0.25, tickMm: 1.1,
};
PF.doc = { nodes: [t1, c1, t2, c2, q], sources: [] };
PF.source = () => null;

/* ---- the ratio is the target over the control in the matching lane ---- */
let D = quantData(q);
assert.deepStrictEqual(D.conditions, ['WT', 'mut'], 'two conditions, each from two lanes');

// Blot 1: WT lanes 100/100 and 120/100 -> mean 1.1, which is what it divides by.
// mut lanes 200/100 = 2 and 260/100 = 2.6, so relative to WT: 1.818... and 2.363...
const r1 = D.reps[0];
assert.strictEqual(r1.control.id, 'c1', 'replicate 1 reads its own control panel');
assert.deepStrictEqual(r1.vals.WT.each.map(v => +v.toFixed(4)), [1, 1.2]);
assert.deepStrictEqual(r1.vals.mut.each.map(v => +v.toFixed(4)), [2, 2.6]);
assert.strictEqual(+r1.by.toFixed(4), 1.1, 'a blot divides by the mean of its reference lanes');

// Blot 2: the second WT lane has half the control, so its ratio is twice the
// first's -- the thing that cannot happen if the control panel is ignored.
const r2 = D.reps[1];
assert.deepStrictEqual(r2.vals.WT.each.map(v => +v.toFixed(4)), [1, 2]);
assert.deepStrictEqual(r2.vals.mut.each.map(v => +v.toFixed(4)), [1.8, 3]);

/* ---- it agrees with the same numbers measured on one panel ---- */
const merged = JSON.parse(JSON.stringify(t1));
merged.quant.rows.push(JSON.parse(JSON.stringify(c1.quant.rows[0])));
merged.quant.bands.push(...c1.quant.bands.map((b, i) =>
  ({ ...b, lane: merged.lanes[i].id })));           // same lanes, one picture
const q2 = { ...q, gels: ['m'], controls: [''] };
PF.doc = { nodes: [{ ...merged, id: 'm' }, q2], sources: [] };
const Dm = quantData(q2);
assert.deepStrictEqual(Dm.reps[0].vals.mut.each, D.reps[0].vals.mut.each,
                       'a control on its own panel measures what a control on the blot does');

/* ---- a label with no mate on the control panel is reported, not guessed ---- */
const odd = blot('c3', 'short control', ['WT', 'WT', 'mut'], [10, 10, 10],
                 'loading control', 'GAPDH');
const q3 = { ...q, gels: ['t1'], controls: ['c3'] };
PF.doc = { nodes: [t1, odd, q3], sources: [] };
const D3 = quantData(q3);
const lost = D3.reps[0].rows.filter(r => r.value === null);
assert.strictEqual(lost.length, 1, 'the one unmatched lane drops out and no other');
assert.match(lost[0].why.join(' '), /no lane of this sample/,
             'and it says the control panel has no such lane');
assert.strictEqual(D3.summary.mut.n, 1, 'the matched mut lane still counts');

/* ---- repeats pair in order: first WT with first WT, not pooled ---- */
// Give the control's two WT lanes very different signals.  If the n-th lane of
// a label did not pair with the n-th, both target lanes would divide by one of
// them and come out equal -- which is exactly the bug this guards.
const c4 = blot('c4', 'skewed control', LAB, [100, 400, 100, 100],
                'loading control', 'GAPDH');
const q4 = { ...q, gels: ['t1'], controls: ['c4'] };
PF.doc = { nodes: [t1, c4, q4], sources: [] };
const D4 = quantData(q4);
assert.deepStrictEqual(D4.reps[0].vals.WT.each.map(v => +v.toFixed(4)), [1, 0.3],
                       'the second WT lane divides by the second control lane');

/* ---- no control panel named: unchanged, the blot carries its own ---- */
const q5 = { ...q, gels: ['m'], controls: [] };
PF.doc = { nodes: [{ ...merged, id: 'm' }, q5], sources: [] };
assert.deepStrictEqual(quantData(q5).reps[0].vals.mut.each, Dm.reps[0].vals.mut.each,
                       'an empty controls list is the old behavior exactly');

/* ---- one blot, one shape ---- */
const shapes = [0, 1, 2, 3, 4].map(r => markGlyph(r, 10, 10));
assert.strictEqual(new Set(shapes).size, 5, 'five blots, five different glyphs');
assert.match(shapes[0], /<circle/, 'blot 1 is circles');
assert.match(shapes[1], /<polygon/, 'blot 2 is triangles');
assert.match(shapes[2], /<rect/, 'blot 3 is squares');
assert.strictEqual(markGlyph(5, 10, 10), shapes[0], 'a sixth blot starts the shapes again');
// Equal ink per blot, or the blot drawn third looks like more evidence.
const area = s => {
  const c = s.match(/r="([\d.]+)"/);
  if (c) return Math.PI * (+c[1]) ** 2;
  const w = s.match(/width="([\d.]+)"/);
  if (w) return (+w[1]) ** 2;
  const pts = [...s.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map(m => [+m[1], +m[2]]);
  let a = 0;                                        // the shoelace formula
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length];
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a) / 2;
};
shapes.forEach((s, i) => assert.ok(Math.abs(area(s) - area(shapes[0])) < 0.02,
                                   `shape ${i} carries the same ink as a circle`));

/* ---- and the graph places them: same blot, same offset under every bar ---- */
const L = quantLayout(q4 === undefined ? q : q);
PF.doc = { nodes: [t1, c1, t2, c2, q], sources: [] };
const L2 = quantLayout(q);
const off = L2.groups.map(g => g.pts.filter(p => p.r === 0).map(p => +(p.x - g.cx).toFixed(4)));
assert.deepStrictEqual(off[0], off[1], 'blot 1 sits in the same place under both conditions');

/* ---- a row is a row even when a panel in it was nudged ---- */

// The LAMP2 row of this figure: four panels side by side, one of them left
// 0.15 mm high.  Read down the page and then across, they are left to right;
// sorted on y alone the high one came first and the caption lettered the row
// (O) (P) (Q) (R) for panels at x 79, 12, 40 and 129.
const row = [{ id: 'n2', x: 79.5, y: 119 }, { id: 'l', x: 12, y: 119.15 },
             { id: 'r', x: 40.3, y: 119.15 }, { id: 'n3', x: 129.1, y: 119.15 }];
assert.deepStrictEqual(readingOrder(row).map(n => n.id), ['l', 'r', 'n2', 'n3']);

// And rows still come in order, with the panels of each across it.
const sheet = [{ id: 'b2', x: 60, y: 48 }, { id: 'a1', x: 12, y: 17 },
               { id: 'b1', x: 12, y: 48.4 }, { id: 'a2', x: 49.5, y: 17 },
               { id: 'c', x: 20, y: 152.7 }];
assert.deepStrictEqual(readingOrder(sheet).map(n => n.id), ['a1', 'a2', 'b1', 'b2', 'c']);

// A real second row is not swallowed: the tolerance is a hand's nudge, not a
// panel's height.
assert.deepStrictEqual(
  readingOrder([{ id: 'low', x: 80, y: 20 }, { id: 'high', x: 10, y: 17 }]).map(n => n.id),
  ['high', 'low']);

console.log('ok');
