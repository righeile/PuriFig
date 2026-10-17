/* The peaks a chromatogram finds for itself.
 *
 *     node test_chrom.js
 *
 * A curve reaches the canvas thinned to each bucket's minimum and maximum, so
 * its noise arrives as a zigzag with a maximum at every second point.  What is
 * checked is that the real peaks come back and the six hundred teeth do not,
 * that a small peak beside a huge one still counts, that the conductivity is
 * not what gets read, that nothing before the injection is called a peak, and
 * that a saturated flat top is one peak marked in its middle.
 */
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

for (const f of ['protein.js', 'panels.js'])
  vm.runInThisContext(fs.readFileSync(__dirname + '/' + f, 'utf8'), { filename: f });

const G = (x, c, h, s) => h * Math.exp(-((x - c) ** 2) / (2 * s * s));

// A 24 mL run: a bump before the sample went on, the main peak, a small second
// peak, and one a hundredth of the main that is dust and not a peak.
const pts = [];
for (let i = 0; i < 1200; i++) {
  const x = r3(i * 0.02);
  const y = 2 + G(x, 1.2, 300, 0.2) + G(x, 12.4, 900, 0.45)
              + G(x, 16.8, 40, 0.3) + G(x, 20.5, 10, 0.3);
  pts.push([x, r3(y + (i % 2 ? 1.5 : -1.5))]);
}
const uv = { id: 't1', name: 'UV 280', unit: 'mAU', on: true, axis: 'left', pts };
const cond = { id: 't2', name: 'Cond', unit: 'mS/cm', on: true, axis: 'right',
               pts: pts.map(([x], i) => [x, 20 + G(x, 22, 60, 0.4) + (i % 2 ? 1 : -1)]) };
const n = { traces: [cond, uv], peaks: [], calib: { on: false, standards: [] }, inject: null };

let got = chromAutoPeaks(n);
assert.deepStrictEqual(got.map(p => Math.round(p.v * 10) / 10), [1.2, 12.4, 16.8],
                       `three peaks, not the zigzag: ${got.map(p => p.v)}`);
assert.ok(got.every(p => p.trace === 't1'), 'read off the absorbance, not the conductivity');
assert.ok(got.every(p => p.showV && p.label === ''),
          'the volume is the label; naming the peak is the user’s');

// The sample was not on the column before it was injected, so the 1.2 mL bump
// is the equilibration and not a peak of anything.
n.inject = { v: 2, raw: 2, rebased: false, offset: true };
got = chromAutoPeaks(n);
assert.deepStrictEqual(got.map(p => Math.round(p.v * 10) / 10), [12.4, 16.8],
                       `nothing before the injection: ${got.map(p => p.v)}`);

// A peak 4% of the main one is a peak; a hundredth of it is dust.  The dust
// stands well clear of the noise -- a noise-only threshold labels it, which is
// why there is a second floor.
assert.ok(tracePeaks(pts, { rel: 0 }).some(p => Math.abs(p.v - 20.5) < 0.1),
          'the 1% bump does clear the noise on its own');
assert.ok(!got.some(p => Math.abs(p.v - 20.5) < 0.1),
          'a hundredth of the main peak is not labeled on the figure');

// Nothing to read peaks off.
assert.deepStrictEqual(chromAutoPeaks({ traces: [], peaks: [], calib: { on: false } }), []);
assert.deepStrictEqual(tracePeaks([[0, 1], [1, 9], [2, 1]]), [], 'too few points to judge');

// A saturated detector repeats its maximum exactly: one peak, in the middle of
// the flat run rather than at whichever edge the walk tested.
const clip = [];
for (let i = 0; i < 400; i++) {
  const x = r3(i * 0.05);
  clip.push([x, Math.min(r3(2 + G(x, 10, 900, 0.5)), 500)]);
}
const cp = chromAutoPeaks({ traces: [{ id: 'c', name: 'UV 280', on: true, pts: clip }],
                            peaks: [], calib: { on: false, standards: [] }, inject: null });
assert.strictEqual(cp.length, 1, `a flat top is one peak: ${JSON.stringify(cp)}`);
assert.ok(Math.abs(cp[0].v - 10) < 0.1, `marked in its middle: ${cp[0].v}`);

// With a calibration on the panel, a found peak is ready to print its mass.
n.calib.on = true;
assert.ok(chromAutoPeaks(n).every(p => p.showMW), 'a calibrated column labels kDa too');

// The axis makes room for the labels rather than letting them print over the
// standards ticks: the peak anyone labels is the tallest one, and 6% of padding
// is nowhere near three lines of text.
const cn = chromNode(10, 20);
cn.h = 40;
cn.traces = [{ id: 'u', name: 'UV 280', on: true, axis: 'left', pts }];
cn.peaks = [{ v: 12.4, label: 'ExampleR', showV: true, showMW: false, showRatio: false }];
const lh = cn.fontPt * PT * 1.15;
const H = PEAK_GAP + lh + cn.fontPt * PT * ASC;      // a name and a volume
const apex = traceValueAt(cn.traces[0], 12.4);
assert.ok(chromScales(cn).Y(apex) - H >= cn.y - 1e-9,
          'two lines of label fit above the tallest peak, inside the plot');
const two = chromScales(cn).ymax;
cn.peaks[0].showV = false;                            // one line needs less
assert.ok(chromScales(cn).ymax < two - lh / cn.h * two * 0.5,
          'how far the axis gives way follows how many lines there are');

// An axis with nothing to accommodate is the plain padded one, and a label
// taller than half the plot is left hanging over rather than running the axis
// away to infinity.
const bare = { ...cn, peaks: [] };
assert.ok(chromScales(cn).ymax > chromScales(bare).ymax, 'the label is what raised it');
const tiny = { ...cn, h: 6 };
assert.strictEqual(chromScales(tiny).ymax, chromScales({ ...bare, h: 6 }).ymax,
                   'a label taller than the panel does not move the axis');

console.log('ok — peaks found on a noisy trace, before the injection ignored,');
console.log('     the conductivity left alone, a flat top read in its middle,');
console.log('     and the axis raised until the labels fit inside the plot');
