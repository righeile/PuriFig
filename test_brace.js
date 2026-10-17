/* The fractions→lanes brace, when the gel has no lanes to span.
 *
 *     node test_brace.js
 *
 * A brace is a claim that these fractions are those lanes, and it is drawn
 * across the lanes it points at.  A panel with no lanes -- or with lanes but no
 * scan behind them yet, which is the same thing measured in millimeters -- has
 * none to span, and the per-lane arithmetic then collapses both legs onto its
 * left edge or, with nothing laid out at all, writes a NaN into the markup.
 * What is checked is that such a gel is bracketed by its own edges instead, and
 * that a gel that does have lanes is still bracketed by the lanes and not by
 * the panel, which is the whole point of the thing.
 */
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

vm.runInThisContext(fs.readFileSync(__dirname + '/panels.js', 'utf8'), { filename: 'panels.js' });

// The geometry block of app.js: `bbox` through `braceGeom`, which is the only
// part of it this needs and the only part that runs without a DOM.
const app = fs.readFileSync(__dirname + '/app.js', 'utf8');
vm.runInThisContext(app.slice(app.indexOf('function bbox(n) {'),
                              app.indexOf('/* ================= view ================= */')),
                    { filename: 'app.js (geometry)' });

const chrom = chromNode(18, 14);
chrom.w = 74; chrom.h = 42;
chrom.traces = [{ id: uid(), name: 'UV 280', unit: 'mAU', on: true, axis: 'left',
                  pts: [[6, 0], [12, 100], [24, 0]] }];
chrom.fractions.marks = [{ v: 12, label: '7' }, { v: 12.5, label: '8' },
                         { v: 13, label: '9' }, { v: 13.5, label: '10' }];
chrom.fractions.pooled = [12, 13.5];

const gel = gelNode(18, 84);
gel.h = 30;

const edge = { id: uid(), kind: 'brace', from: chrom.id, to: gel.id, drop: 0.5 };
globalThis.doc = { page: { w: 183, h: 150 }, nodes: [chrom, gel], edges: [edge] };
globalThis.PF = { doc };
globalThis.node = id => doc.nodes.find(n => n.id === id);

const legs = g => {
  assert.ok(!/NaN/.test(g.d), `NaN in the brace path: ${g.d}`);
  // The two down-strokes of the bracket, as the path lists them: each leg ends
  // at the panel, so the last point of each `M` run is where it lands.
  return g.d.split('M').slice(1, 3)
            .map(s => Number(s.trim().split(/\s+/).pop().replace('L', '').split(',')[0]));
};

// No lanes at all: the panel's own edges.
let [a, b] = legs(braceGeom(edge));
assert.deepStrictEqual([a, b], [gel.x, gel.x + gel.w],
                       `a gel with no lanes was not bracketed by its own edges: ${a}–${b}`);

// Four fraction lanes, but no scan behind them: every lane is zero wide, so
// there is still nothing to span and the panel's edges still stand.
gel.lanes = [7, 8, 9, 10].map((f, i) => ({ id: uid(), x0: i * 20, x1: i * 20 + 18,
                                           role: 'SEC fraction', label: String(f), excised: false }));
[a, b] = legs(braceGeom(edge));
assert.deepStrictEqual([a, b], [gel.x, gel.x + gel.w],
                       `a gel with no scan behind its lanes collapsed the brace: ${a}–${b}`);

// With a scan, the lanes are what the brace spans: a ladder on the left is
// outside the bracket, so it starts past the panel's own left edge.
gel.imgW = 400; gel.imgH = 200; gel.href = 'data:,';
gel.lanes.unshift({ id: uid(), x0: 0, x1: 60, role: 'ladder', label: 'M', excised: false });
gel.lanes.forEach((l, i) => { if (i) { l.x0 = 60 + (i - 1) * 80; l.x1 = l.x0 + 70; } });
[a, b] = legs(braceGeom(edge));
assert.ok(a > gel.x + 5, `the ladder was bracketed with the fractions: leg at ${a}`);
assert.ok(b > a, `the brace has no width: ${a}–${b}`);

console.log('ok — brace spans the lanes, or the panel when there are none');
