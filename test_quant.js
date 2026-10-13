/* What the quantification panel compares, which now has two answers.
 *
 *     node test_quant.js
 *
 * Intensity is a ratio and needs a loading control and a lane set to 1.  An
 * apparent size is neither: it is read off each blot's own ladder, in its own
 * kilodaltons, and dividing it by anything would destroy it.  So what is
 * checked is that the size comes back in kDa, that it is each band's own row
 * and not the row the box was aimed at, and that nothing normalizes it.
 */
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

for (const f of ['protein.js', 'panels.js'])
  vm.runInThisContext(fs.readFileSync(__dirname + '/' + f, 'utf8'), { filename: f });

// A blot 400 rows tall with a ladder at 100, 50 and 25 kDa, and two lanes whose
// bands sit at different rows: the shift is the thing being measured.
function blot(id, title, ys) {
  const lanes = [{ id: id + 'L0', x0: 0, x1: 50, role: 'ladder' },
                 { id: id + 'La', x0: 50, x1: 100, label: 'wild type' },
                 { id: id + 'Lb', x0: 100, x1: 150, label: 'mutant' }];
  const row = { id: id + 'R', name: 'Lamp2', role: 'target' };
  return {
    id, type: 'gel', title, imgH: 400, imgW: 150, lanes,
    ladder: { on: true, marks: [{ kDa: 100, y: 100 }, { kDa: 50, y: 200 }, { kDa: 25, y: 300 }] },
    quant: {
      method: 'border', border: 3, inset: 0.1, rows: [row],
      bands: [{ id: id + 'Ba', row: row.id, lane: lanes[1].id, y: ys[0], h: 20, net: 1000 },
              { id: id + 'Bb', row: row.id, lane: lanes[2].id, y: ys[1], h: 20, net: 4000, sat: 9 }],
    },
  };
}

// Two blots, the mutant running half a decade lower on both.
const g1 = blot('g1', 'blot 1', [200, 250]);       // 50 kDa and 35.4 kDa
const g2 = blot('g2', 'blot 2', [190, 260]);       // 54.6 kDa and 31.5 kDa
const q = { id: 'q', type: 'quant', gels: ['g1', 'g2'], readout: 'size',
            match: 'label', norm: 'ref', error: 'sd', keepSaturated: false };
PF.doc = { nodes: [g1, g2, q] };

const D = quantData(q);
assert.deepStrictEqual(D.conditions, ['wild type', 'mutant']);
assert.strictEqual(D.control, '', 'a size is not divided by a loading control');

// Straight in log(size) between the two rungs either side: row 200 is the
// 50 kDa rung itself, row 250 is half way from 50 to 25.
const wt = D.summary['wild type'], mut = D.summary['mutant'];
assert.ok(Math.abs(wt.vals[0] - 50) < 0.01, wt.vals);
assert.ok(Math.abs(mut.vals[0] - 50 / Math.SQRT2) < 0.01, mut.vals);
assert.strictEqual(wt.n, 2);
assert.ok(wt.mean > mut.mean * 1.3, [wt.mean, mut.mean]);

// Nothing is set to 1: `relative to` is still 'ref' and is ignored, or the
// reference lane would read 1 kDa on every blot.
assert.ok(wt.mean > 40 && wt.mean < 60, wt.mean);

// A saturated band is the wrong height but not in the wrong place, so it is
// still sized — under intensity the same band is thrown out.
assert.strictEqual(mut.n, 2, 'a saturated band still has a position');
const I = quantData({ ...q, readout: 'intensity' });
assert.strictEqual(I.summary['mutant'].n, 0, 'a saturated band has no usable intensity');

// How much clipping is too much.  The band above records no area and is dropped
// on any clipping at all; given one, 9 px of 1000 is kept and 9 px of 100 is
// not.  All or nothing threw away a lane missing a single pixel exactly as hard
// as one missing a third of its band, which on blots exposed to the limit is
// most of them.
const sat = (tol) => quantData({ ...q, readout: 'intensity', satTol: tol }).summary['mutant'].n;
[g1, g2].forEach(g => { g.quant.bands[1].area = 1000; });
assert.strictEqual(sat(undefined), 2, 'a band 0.9% clipped was thrown away');
assert.strictEqual(sat(0), 0, 'nothing allowed, and a clipped band was still kept');
[g1, g2].forEach(g => { g.quant.bands[1].area = 100; });
assert.strictEqual(sat(undefined), 0, 'a band 9% clipped was kept');
[g1, g2].forEach(g => { delete g.quant.bands[1].area; });

// Past the ends of the ladder there is no size, and none is invented.
g1.quant.bands[0].y = 20;
const P = quantData(q);
assert.strictEqual(P.summary['wild type'].n, 1, 'a band above the top rung was given a size');

// Two lanes of one condition on one blot.  By default they are two replicates
// and count towards n; told otherwise, they are one measurement of one thing.
function twoOfOne(id) {
  const g = blot(id, id, [200, 250]);
  delete g.quant.bands[1].sat;              // saturation is a different test
  g.lanes.push({ id: id + 'Lc', x0: 150, x1: 200, label: 'mutant' });
  g.quant.bands.push({ id: id + 'Bc', row: id + 'R', lane: id + 'Lc', y: 230, h: 20, net: 2000 });
  return g;
}
const h1 = twoOfOne('h1'), h2 = twoOfOne('h2');
const hq = { ...q, gels: ['h1', 'h2'], readout: 'intensity', norm: 'none' };
PF.doc = { nodes: [h1, h2, hq] };

const S = quantData(hq);
assert.deepStrictEqual(S.repeated, ['h1: mutant is in 2 lanes', 'h2: mutant is in 2 lanes'],
                       JSON.stringify(S.repeated));
assert.strictEqual(S.summary['mutant'].n, 4, 'two lanes on each of two blots is four points');
assert.strictEqual(S.summary['wild type'].n, 2);
// Each lane's own value, not the blot's mean, twice over.
assert.deepStrictEqual(S.summary['mutant'].vals.slice().sort((a, b) => a - b), [2000, 2000, 4000, 4000]);

const A = quantData({ ...hq, repeats: 'averaged' });
assert.strictEqual(A.summary['mutant'].n, 2, 'averaged, a blot is one point however it was loaded');
assert.deepStrictEqual(A.summary['mutant'].vals, [3000, 3000]);

// The blot is divided by one number either way: the mean of the reference lanes,
// so how often the reference was loaded does not move the other bars.
const R = quantData({ ...hq, norm: 'ref', ref: 'mutant' });
assert.ok(Math.abs(R.reps[0].by - 3000) < 1e-9, 'normalized by something other than the lane mean: ' + R.reps[0].by);

PF.doc = { nodes: [g1, g2, q] };

/* ---- a loading control is drawn at its blot's scale ---- */

// A control is a second exposure of a second strip cut from the same gel, and
// usually photographed separately -- so its pixels are its own and say nothing
// about the blot's.  What the two share is the membrane, and the comb that ran
// through both strips is the ruler: match the lane spacing and a millimeter of
// figure means the same on each.
function strip(id, imgH, pitch, x) {
  const lanes = [0, 1, 2].map(i => ({ id: id + 'L' + i, x0: 10 + i * pitch, x1: 10 + i * pitch + pitch * 0.8,
                                      label: ['wild type', 'mutant', 'rescue'][i] }));
  return { id, type: 'gel', title: id, x, y: 0, w: 30, h: imgH * 0.1, imgH, imgW: 400,
           href: 'data:,', lanes, splice: {}, strips: [],
           ladder: { on: false, marks: [] }, bands: [],
           quant: { method: 'border', rows: [], bands: [] } };
}
const tgt = strip('b', 100, 50, 20);            // 0.1 mm/row, lanes 5 mm apart
const ctrl = strip('c', 40, 52, 23);            // shot 4% closer, and mis-sized
ctrl.h = 3;
const cq = { id: 'cq', type: 'quant', gels: ['b'], controls: ['c'], readout: 'intensity' };
PF.doc = { nodes: [tgt, ctrl, cq] };

assert.strictEqual(gelBlotOf(ctrl), tgt);
assert.strictEqual(gelBlotOf(tgt), null, 'a blot is not its own control');

const pitch = n => { const k = gelLayout(n).kept; return (k[2]._xmm - k[0]._xmm) / 2; };
assert.deepStrictEqual(gelSyncControls().map(n => n.id), ['c']);
assert.ok(Math.abs(pitch(ctrl) - pitch(tgt)) < 1e-3, `${pitch(ctrl)} mm per lane against ${pitch(tgt)}`);

// Which is *not* the same pixel scale, and must not be: forcing that on these
// would have drawn Na/K ATPase n2 a third too large.
assert.ok(Math.abs(ctrl.h / ctrl.imgH - tgt.h / tgt.imgH) > 1e-3,
          'the control was given the blot\'s pixel scale instead of its lane spacing');

// With the spacing right the lanes land on the blot's exactly -- there is
// nothing left for the slide to absorb.
const off = gelLayout(ctrl).kept.map((l, i) =>
  Math.abs((ctrl.x + l._xmm) - (tgt.x + gelLayout(tgt).kept[i]._xmm)));
assert.ok(Math.max(...off) < 1e-3, off);   // bar the 0.1 um h is stored to

// Run again and nothing moves: the sync is the resting state, not a nudge.
assert.deepStrictEqual(gelSyncControls(), []);

// Resize the blot and the control comes with it.
tgt.h = 20;
assert.deepStrictEqual(gelSyncControls().map(n => n.id), ['c']);
assert.ok(Math.abs(pitch(ctrl) - 10) < 1e-3, pitch(ctrl));

// A control whose lanes were placed wrong is not quietly resized to fit: its
// nine lanes spread over half again the blot's span, which is a lane set to
// repair, not a magnification.  The fit is least squares, so it lands between.
const wide = strip('w', 40, 70, 23);
PF.doc = { nodes: [tgt, wide, { ...cq, controls: ['w'] }] };
gelSyncControls();
assert.ok(Math.abs(pitch(wide) - 10) < 1e-3, 'a wrong lane set still reads as the blot\'s spacing');

PF.doc = { nodes: [g1, g2, q] };

// And the axis says what it is.
assert.ok(/apparent size/.test(quantYLabel(q, D)), quantYLabel(q, D));

/* ---- a measured box is a grip ---- */

// A click searches for the darkest row near it, so on a smear or a doublet the
// box can land on a row that is not the one meant.  Every box the overlay draws
// names its band, which is what the canvas takes hold of to drag it.
Object.assign(g1, { x: 10, y: 10, w: 30, h: 40, href: 'data:,', splice: {} });
const grips = renderGelOverlay(g1, true);
g1.quant.bands.forEach(b => {
  assert.ok(grips.includes(`data-band="${b.id}"`), `${b.id} has no grip`);
});
assert.ok(/class="bandhit"[^>]*cursor:ns-resize/.test(grips) ||
          /class="bandhit"/.test(grips) && /cursor:ns-resize/.test(grips),
          'the box does not say it can be dragged');

// Unselected, nothing on a panel is a grip -- the overlay is the selection.
assert.ok(!renderGelOverlay(g1, false).includes('data-band='), 'grips on an unselected panel');

/* ---- a bar is the same width whatever the condition count ---- */

// The failure this replaces: `w` was set by hand and the bar was a fraction of
// one category, so the same bar came out 10 mm wide beside two conditions and
// 5.3 mm beside seven.  Two panels of one figure then carried two scales, and
// nothing on screen said so.
function sheet(id, labels) {
  const lanes = [{ id: id + 'L0', x0: 0, x1: 50, role: 'ladder' }].concat(
    labels.map((t, i) => ({ id: id + 'L' + i, x0: 50 + i * 50, x1: 100 + i * 50, label: t })));
  const row = { id: id + 'R', name: 'Lamp2', role: 'target' };
  return {
    id, type: 'gel', title: id, imgH: 400, imgW: 100 + labels.length * 50, lanes,
    ladder: { on: true, marks: [{ kDa: 100, y: 100 }, { kDa: 50, y: 200 }, { kDa: 25, y: 300 }] },
    quant: { method: 'border', border: 3, inset: 0.1, rows: [row],
             bands: labels.map((t, i) => ({ id: id + 'B' + i, row: row.id, lane: id + 'L' + i,
                                            y: 200 + i * 5, h: 20, net: 1000 + i * 100 })) },
  };
}
const panel = over => Object.assign({
  id: 'qq', type: 'quant', x: 0, y: 0, w: 44, h: 32, controls: [],
  readout: 'intensity', useControl: false, norm: 'none', match: 'label',
  repeats: 'separate', error: 'sd', bars: true, points: true,
  fontPt: 6.5, axisMm: 0.25, tickMm: 1.1, titlePt: 6.5, title: '', ylabel: '',
  barFill: '#c8c8c8',
}, over);

const two = sheet('t', ['wt', 'ko']), seven = sheet('s', ['a', 'b', 'c', 'd', 'e', 'f', 'g']);

const q2 = panel({ gels: ['t'] }), q7 = panel({ gels: ['s'] });
PF.doc = { nodes: [two, seven, q2, q7] };

const L2 = quantLayout(q2), L7 = quantLayout(q7);
assert.strictEqual(L2.D.conditions.length, 2, L2.D.conditions);
assert.strictEqual(L7.D.conditions.length, 7, L7.D.conditions);
assert.ok(Math.abs(L2.bw - 3.94) < 1e-9, `two conditions gave a ${L2.bw} mm bar`);
assert.ok(Math.abs(L7.bw - 3.94) < 1e-9, `seven conditions gave a ${L7.bw} mm bar`);

// Tight: the panel is only as wide as the bars need, so seven of them is
// exactly three and a half times two of them.
assert.ok(Math.abs(q7.w / q2.w - 3.5) < 0.01, `${q2.w} mm for two, ${q7.w} mm for seven`);
assert.ok(Math.abs(q2.w - 2 * 3.94 / 0.62) < 0.05, q2.w);
assert.ok(Math.abs(L2.w - q2.w) < 1e-9, 'the drawn width and the panel width disagree');

// Unpinned is the old behavior, kept as the way back: the bar now follows the
// panel and the two counts no longer agree.
const q2o = panel({ gels: ['t'], barMm: 0, w: 44 }), q7o = panel({ gels: ['s'], barMm: 0, w: 44 });
PF.doc = { nodes: [two, seven, q2o, q7o] };
assert.ok(Math.abs(quantLayout(q2o).bw - quantLayout(q7o).bw) > 1,
          'barMm 0 should hand the width back to w');
assert.strictEqual(q2o.w, 44, 'barMm 0 must not touch the panel width');

/* ---- the value axis is 1.5 in, and it is the plotting area ---- */

// 30.48 mm = 1.2 in, the same value axis labkit prints and every other app
// draws.  A new panel gets it whatever its bars turn out to be: the height
// does not follow the group count the way a stretched panel's does.
assert.ok(Math.abs(quantNode(0, 0).h - 30.48) < 1e-9,
          `a new quant panel is ${quantNode(0, 0).h} mm tall`);

// And `h` is the plot, not the panel: ymin lands on the bottom of it and ymax
// on the top, so the axis spans exactly h with the labels outside.  Measured
// on both counts -- a height read off the canvas would differ between them.
[[q2, 'two'], [q7, 'seven']].forEach(([q, name]) => {
  const t = Object.assign({}, q, { h: 30.48 });
  PF.doc = { nodes: [two, seven, t] };
  const L = quantLayout(t);
  const span = L.Y(L.ymin) - L.Y(L.ymax);
  assert.ok(Math.abs(span - 30.48) < 1e-9,
            `${name} conditions: the value axis spans ${span} mm, not 30.48`);
});
PF.doc = { nodes: [two, seven, q2, q7] };

/* ---- bars across ---- */

// The same panel turned on its side: the conditions pin the *height* and the
// value axis becomes the width, so a long condition name gets the whole left
// margin and never has to be tilted to fit.
const q7h = panel({ gels: ['s'], horizontal: true, w: 30.48, h: 44 });
PF.doc = { nodes: [two, seven, q7h] };
const LH = quantLayout(q7h);
assert.ok(Math.abs(LH.bw - 3.94) < 1e-9, `across, seven conditions gave a ${LH.bw} mm bar`);
assert.ok(Math.abs(q7h.h - 7 * 3.94 / 0.62) < 0.05, `across, the height is not the bars': ${q7h.h}`);
assert.strictEqual(q7h.w, 30.48, 'across, the value axis must not be rewritten by the bars');
// The value axis spans w, and runs left to right from zero.
assert.ok(Math.abs((LH.Y(LH.ymax) - LH.Y(LH.ymin)) - 30.48) < 1e-9,
          `across, the value axis spans ${LH.Y(LH.ymax) - LH.Y(LH.ymin)} mm`);
assert.ok(LH.Y(LH.ymin) < LH.Y(LH.ymax), 'across, the value axis runs backwards');
// Bars are as thick as bw and as long as the value; conditions run down the
// panel in plot order, one slot apart.
LH.groups.forEach(g => assert.ok(Math.abs(g.bar.h - LH.bw) < 1e-9, 'a bar across is the wrong thickness'));
assert.ok(Math.abs(LH.groups[0].bar.w - Math.abs(LH.groups[0].mean - LH.Y(0))) < 1e-9);
assert.ok(LH.groups[1].cx - LH.groups[0].cx > 0, 'the conditions do not run down the panel');
assert.ok(Math.abs((LH.groups[1].cx - LH.groups[0].cx) - LH.slot) < 1e-9);

// And nothing is tilted: that is the point of drawing it this way.
assert.strictEqual(LH.tilt, false, 'a condition was tilted on a horizontal panel');
LH.xlabels.forEach(l => assert.strictEqual(l.rotate, 0, 'a tilted label across'));
assert.strictEqual(LH.ylabel.rotate, 0, 'the value label is still on its side');
// Turning it back gives the vertical panel exactly.
const back = quantLayout(panel({ gels: ['s'], w: 44, h: 30.48 }));
assert.ok(Math.abs(back.bw - LH.bw) < 1e-9);
assert.strictEqual(back.ylabel.rotate, -90);

/* ---- the color scheme ---- */

PF.doc = { nodes: [two, seven, q2, q7] };
// No scheme: the one fill this panel has always used.
assert.strictEqual(quantFillFor(q2, 'wt', 0), '#c8c8c8');
assert.strictEqual(quantFillFor({ ...q2, barFill: '#112233' }, 'wt', 1), '#112233');
// A per-condition override beats both.
assert.strictEqual(quantFillFor({ ...q2, colours: { ko: '#abcdef' } }, 'ko', 1), '#abcdef');

/* ---- a share: one band as a percentage of the protein ---- */

// Three rows on one blot -- a precursor, an intermediate and a mature form, or
// a modified band against the unmodified one.  They are the whole of the
// protein, so each lane's three add up to 100 and how much was loaded cancels.
function three(id, nets) {
  const lanes = [{ id: id + 'La', x0: 0, x1: 50, label: 'wild type' },
                 { id: id + 'Lb', x0: 50, x1: 100, label: 'mutant' }];
  const rows = ['pro', 'intermediate', 'mature'].map((name, i) =>
    ({ id: `${id}R${i}`, name, role: 'target', h: 20 }));
  rows.push({ id: id + 'Rc', name: 'GAPDH', role: 'loading control', h: 20 });
  const bands = [];
  lanes.forEach((l, k) => rows.forEach((r, i) => bands.push(
    { id: `${id}B${k}${i}`, row: r.id, lane: l.id, y: 50 + i * 40, h: 20,
      net: i === 3 ? 5000 : nets[k][i], area: 1000, sat: 0 })));
  return { id, type: 'gel', title: id, imgH: 400, imgW: 100, lanes,
           quant: { method: 'border', border: 3, inset: 0.1, rows, bands } };
}

// Twice as much loaded in the mutant lane, and the same split: the share must
// not notice the loading at all.  Mutant holds back half of it as intermediate.
const s1 = three('s1', [[100, 100, 800], [400, 800, 400]]);
const qs = { id: 'qs', type: 'quant', gels: ['s1'], readout: 'share', target: 'intermediate',
             match: 'label', norm: 'ref', error: 'sd', keepSaturated: false, satTol: 2 };
PF.doc = { nodes: [s1, qs] };
const SH = quantData(qs);
assert.strictEqual(SH.control, '', 'a share is not divided by a loading control');
assert.ok(Math.abs(SH.summary['wild type'].vals[0] - 10) < 1e-9, SH.summary['wild type'].vals);
assert.ok(Math.abs(SH.summary['mutant'].vals[0] - 50) < 1e-9, SH.summary['mutant'].vals);

// Nothing is set to 1 although `norm` still says 'ref' -- a percentage is
// already absolute, so the reference lane keeps its own 10.
assert.strictEqual(SH.ref, 'wild type');
assert.ok(Math.abs(SH.summary['wild type'].mean - 10) < 1e-9, SH.summary['wild type'].mean);

// The loading control row is not one of the bands the protein runs as, so its
// 5000 is nowhere in the total.
assert.ok(Math.abs(SH.summary['mutant'].mean - 50) < 1e-9, SH.summary['mutant'].mean);

// A band below background is none of the protein, not a negative amount of it.
const s2 = three('s2', [[-50, 100, 900], [400, 800, 400]]);
PF.doc = { nodes: [s2, { ...qs, gels: ['s2'] }] };
const S2 = quantData({ ...qs, gels: ['s2'] });
assert.ok(Math.abs(S2.summary['wild type'].vals[0] - 10) < 1e-9, S2.summary['wild type'].vals);

// Saturation anywhere in the set spoils the share, because every band is the
// denominator as well: clipping the *mature* band drops the intermediate's bar.
const s3 = three('s3', [[100, 100, 800], [400, 800, 400]]);
s3.quant.bands.find(b => b.row === 's3R2' && b.lane === 's3La').sat = 500;
PF.doc = { nodes: [s3, { ...qs, gels: ['s3'] }] };
const S3 = quantData({ ...qs, gels: ['s3'] });
assert.strictEqual(S3.summary['wild type'].n, 0, 'a clipped band elsewhere in the set was kept');
assert.strictEqual(S3.summary['mutant'].n, 1);

/* ---- quartile boxes ---- */

// Known numbers, one condition: 1 2 3 4 5 gives a median of 3 and a box from
// 2 to 4 -- the interpolated quartile every other tool draws.
assert.ok(Math.abs(quantile([1, 2, 3, 4, 5], 0.25) - 2) < 1e-9);
assert.ok(Math.abs(quantile([1, 2, 3, 4, 5], 0.5) - 3) < 1e-9);
assert.ok(Math.abs(quantile([1, 2, 3, 4, 5], 0.75) - 4) < 1e-9);
// Two values: the box is the gap between them and the median is the midpoint.
assert.ok(Math.abs(quantile([10, 20], 0.5) - 15) < 1e-9);
assert.ok(Math.abs(quantile([10, 20], 0.25) - 12.5) < 1e-9);
// One value: a box of no width, not a crash.
assert.ok(Math.abs(quantile([7], 0.75) - 7) < 1e-9);

const qb = panel({ gels: ['s'], box: true, w: 30.48, h: 44 });
PF.doc = { nodes: [two, seven, qb] };
const LB = quantLayout(qb);
LB.groups.forEach(g => {
  assert.strictEqual(g.bar, null, 'a box panel still drew its bar');
  assert.strictEqual(g.err, null, 'a box panel still drew its error bar');
  assert.ok(g.box, 'a measured condition got no box');
  const v = [...g.s.vals].sort((a, b) => a - b);
  // The whiskers are the extremes and the box is inside them, median inside
  // the box: on the up axis a bigger value is a *smaller* y.
  assert.ok(Math.abs(g.box.hi - LB.Y(v[v.length - 1])) < 1e-9, 'the whisker is not the largest value');
  assert.ok(Math.abs(g.box.lo - LB.Y(v[0])) < 1e-9, 'the whisker is not the smallest value');
  assert.ok(g.box.y >= g.box.hi - 1e-9 && g.box.y + g.box.h <= g.box.lo + 1e-9,
            'the box runs past its own whiskers');
  assert.ok(g.box.med >= g.box.y - 1e-9 && g.box.med <= g.box.y + g.box.h + 1e-9,
            'the median is outside the box');
  assert.ok(Math.abs(g.box.w - LB.bw) < 1e-9, 'a box is not as thick as a bar');
  // The whiskers stop at the box: no stub may enter the quartiles.
  g.box.stubs.forEach(([u, w]) => assert.ok(w <= g.box.y + 1e-9 || u >= g.box.y + g.box.h - 1e-9,
    `a whisker ${u}..${w} runs into the box ${g.box.y}..${g.box.y + g.box.h}`));
});
// The axis makes no room for an error bar a box panel never draws.
const spread7 = panel({ gels: ['s'], w: 30.48, h: 44 });
PF.doc = { nodes: [two, seven, spread7] };
const LN = quantLayout(spread7), LBb = quantLayout({ ...spread7, box: true });
assert.ok(LBb.ymin >= LN.ymin - 1e-9, 'a box panel reserved room below for an error bar');
assert.ok(LBb.groups.every(g => g.s.vals.every(v => v >= LBb.ymin - 1e-9)),
          'a value fell off the bottom of a box panel');

// Across, the box turns with everything else: thickness down, quartiles along w.
const LBH = quantLayout(panel({ gels: ['s'], box: true, horizontal: true, w: 30.48, h: 44 }));
LBH.groups.forEach(g => {
  assert.ok(Math.abs(g.box.h - LBH.bw) < 1e-9, 'a box across is not as thick as a bar');
  assert.ok(g.box.x >= g.box.lo - 1e-9 && g.box.x + g.box.w <= g.box.hi + 1e-9,
            'the box across runs past its own whiskers');
  g.box.stubs.forEach(([u, w]) => assert.ok(w <= g.box.x + 1e-9 || u >= g.box.x + g.box.w - 1e-9,
    `a whisker across ${u}..${w} runs into the box ${g.box.x}..${g.box.x + g.box.w}`));
});
// Both are drawn without throwing, which is what the renderer has to do.
assert.ok(renderQuant(qb).includes('<rect'), 'a box panel rendered no box');

/* ---- several controls, averaged ---- */

// Two blots, three conditions, a loading control that is flat: c1 is 100 and
// 200 on the two blots, c2 is 300 and 600, c3 is 800 and 1600.  Relative to c1
// alone the mutant is 8x; relative to the mean of c1 and c2 it is 4x, and both
// blots have to land on the same number or nothing was normalized.
function flat(id, scale) {
  const lanes = ['c1', 'c2', 'c3'].map((c, k) => ({ id: `${id}L${k}`, label: c, x0: k * 30, x1: k * 30 + 25 }));
  const rows = [{ id: id + 'Rt', name: 'target', role: 'target', h: 20 },
                { id: id + 'Rc', name: 'GAPDH', role: 'loading control', h: 20 }];
  const nets = [100, 300, 800].map(v => v * scale);
  const bands = [];
  lanes.forEach((l, k) => rows.forEach((r, i) => bands.push(
    { id: `${id}B${k}${i}`, row: r.id, lane: l.id, y: 50 + i * 40, h: 20,
      net: i ? 1000 * scale : nets[k], area: 1000, sat: 0 })));
  return { id, type: 'gel', title: id, imgH: 400, imgW: 100, lanes,
           quant: { method: 'border', border: 3, inset: 0.1, rows, bands } };
}
const r1 = flat('r1', 1), r2 = flat('r2', 2);
const qr = { id: 'qr', type: 'quant', gels: ['r1', 'r2'], readout: 'intensity', target: 'target',
             match: 'label', norm: 'ref', error: 'sd', keepSaturated: true, satTol: 2 };
PF.doc = { nodes: [r1, r2, qr] };

const R1 = quantData({ ...qr, ref: 'c1' });
assert.deepStrictEqual(R1.refs, ['c1'], 'one name must still give one reference');
assert.strictEqual(R1.ref, 'c1', 'the printed name of a single reference changed');
assert.ok(Math.abs(R1.summary.c3.mean - 8) < 1e-9, R1.summary.c3.mean);

const R2 = quantData({ ...qr, ref: ['c1', 'c2'] });
assert.deepStrictEqual(R2.refs, ['c1', 'c2']);
assert.strictEqual(R2.ref, 'the mean of c1 + c2', 'the axis label must say both controls are averaged');
// 800 / mean(100, 300) = 4, on both blots: n of 2 and no spread at all.
assert.strictEqual(R2.summary.c3.n, 2);
assert.ok(Math.abs(R2.summary.c3.mean - 4) < 1e-9, R2.summary.c3.mean);
assert.ok(R2.summary.c3.sd < 1e-9, `the two blots did not land together: ${R2.summary.c3.sd}`);
// Neither control is 1 any more -- their mean is.
assert.ok(Math.abs(R2.summary.c1.mean - 0.5) < 1e-9, R2.summary.c1.mean);
assert.ok(Math.abs((R2.summary.c1.mean + R2.summary.c2.mean) / 2 - 1) < 1e-9);

// A blot missing one of the two controls is left out, and says so: half a
// reference is a different scale, not a smaller one.
const r3 = flat('r3', 3);
r3.quant.bands = r3.quant.bands.filter(b => b.lane !== 'r3L1');
r3.lanes = r3.lanes.filter(l => l.id !== 'r3L1');
PF.doc = { nodes: [r1, r2, r3, { ...qr, gels: ['r1', 'r2', 'r3'] }] };
const R3 = quantData({ ...qr, gels: ['r1', 'r2', 'r3'], ref: ['c1', 'c2'] });
assert.strictEqual(R3.summary.c3.n, 2, 'a blot without both controls was kept');
assert.ok(R3.issues.some(t => /r3/.test(t) && /c2/.test(t)), R3.issues);
// Named junk falls back to the first condition rather than dividing by nothing.
assert.deepStrictEqual(quantData({ ...qr, ref: ['nope'] }).refs, ['c1']);

console.log('ok');
