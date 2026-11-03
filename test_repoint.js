/* A panel re-pointed at another exposure keeps its lanes.
 *
 *     node test_repoint.js
 *
 * Swapping a blot's scan for a shorter exposure of the same frame is a new
 * source id, so `refreshGelImage` cannot recognise it through `geom.src` the
 * way it recognises a crop or a turn.  It used to fall through to
 * `rescaleLanes`, which stretches the block of lanes across the whole picture
 * — and a blot's crop has blank membrane either side of its lanes, so the
 * lane boxes came off the bands and the panel drew that blank membrane as
 * though it were a lane.  It happened to the ClC-7 fibroblast figure: four
 * Cathepsin D panels, a lane's worth of empty membrane printed in each, every
 * construct label standing next to somebody else's band, and the measured
 * numbers — taken before the swap — still right, so nothing flagged it.
 *
 * The picture comes back the same size, which says the pixels are the same
 * pixels.  That is the test.
 */
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

for (const f of ['protein.js', 'panels.js'])
  vm.runInThisContext(fs.readFileSync(__dirname + '/' + f, 'utf8'), { filename: f });

const app = fs.readFileSync(__dirname + '/app.js', 'utf8');
let rendered = null;
Object.assign(globalThis, {
  backend: { ok: false },                       // so the render goes through the stub below
  clientRender: (src, n, crop) => {
    rendered = crop;
    return Promise.resolve({ png: 'data:,', w: Math.round(crop.w), h: Math.round(crop.h), clip: {} });
  },
  source: id => SRC[id],
  autoLanes: () => { throw new Error('the lanes were thrown away and found again'); },
  refreshMarker: async () => {}, refreshMerge: async () => {}, quantRemeasure: async () => {},
  hint() {},
});
vm.runInThisContext(app.slice(app.indexOf('function gelGeom(n, src) {'),
                              app.indexOf('function clientRender(src, n, crop, levels) {')),
                    { filename: 'app.js (gel geometry)' });

// Two exposures of one membrane: the same camera, the same frame, 30 s and 6 s.
const SRC = {
  long: { id: 'long', path: '/IM000298_7Sum.tif', w: 1280, h: 1024, server: false },
  short: { id: 'short', path: '/IM000298_6.TIF', w: 1280, h: 1024, server: false },
};

const panel = () => ({
  id: 'g', type: 'gel', src: 'long', rotate: 0, tilt: 0, flipH: false, flipV: false,
  crop: { x: 81, y: 114, w: 429, h: 192 }, imgW: 429, imgH: 192, href: 'data:,',
  levels: { black: 0, white: 65535, gamma: 1, invert: true },
  // Four lanes of a blot: 259 px of them in a 429 px crop, the rest membrane.
  lanes: [[152, 217], [217, 281], [281, 346], [346, 411]].map(([x0, x1], i) =>
    ({ id: 'l' + i, x0, x1, label: ['WT1', 'WT2', 'Y715C', 'P716L'][i], role: 'sample' })),
  ladder: { marks: [] }, bands: [], strips: [], quant: { bands: [], rows: [] },
  leanL: 0, leanR: 0, geom: null,
});
const spans = n => n.lanes.map(l => [l.x0, l.x1]);

// Rendered once, the panel records the geometry it was drawn at.
const n = panel();
return (async () => {
  await refreshGelImage(n);
  assert.strictEqual(n.geom.src, 'long', 'the render did not record which scan it drew');
  const before = spans(n);

  // The swap: another exposure of the same frame, same crop, same size out.
  n.src = 'short';
  await refreshGelImage(n);
  assert.deepStrictEqual(spans(n), before,
    `the lanes moved to ${JSON.stringify(spans(n))} on a re-point to the same frame`);
  assert.strictEqual(n.geom.src, 'short', 'the new scan was not recorded');

  // Nor does a contrast change on the same scan move them, which is the case
  // that was already right and must stay right.
  n.levels.white = 13149;
  await refreshGelImage(n);
  assert.deepStrictEqual(spans(n), before, 'a contrast change moved the lanes');

  // A genuinely different scan — a different size — is still fitted to the
  // width, because its pixels are not this one's pixels.
  const m = panel();
  await refreshGelImage(m);
  m.src = 'short';
  m.crop = { x: 81, y: 114, w: 858, h: 384 };
  await refreshGelImage(m);
  assert.deepStrictEqual(spans(m), [[0, 215], [215, 427], [427, 643], [643, 858]],
    `a different scan was not fitted to the width: ${JSON.stringify(spans(m))}`);

  console.log('ok — a panel re-pointed at another exposure keeps its lanes');
})();
