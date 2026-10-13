/* A crop you can still get hold of.
 *
 *     node test_crop.js
 *
 * The panel being cropped shows the whole scan, because the crop is dragged on
 * what is being cut away as much as on what is kept.  It used to be drawn at the
 * panel's own height — and a panel's height is the height of its crop, not of
 * the scan — so a strip cut down to one band showed the scan as a speck with a
 * rectangle on it thinner than the handles that resize it.  A crop once cut too
 * tight could then never be dragged back out.
 */
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

for (const f of ['protein.js', 'panels.js'])
  vm.runInThisContext(fs.readFileSync(__dirname + '/' + f, 'utf8'), { filename: f });

// A scan of seven membrane strips, and a panel cut to one band of one of them:
// 60 rows of 1024, drawn 4.7 mm tall.
const src = { id: 's', w: 1280, h: 1024, preview: 'data:,' };
const n = { id: 'g', type: 'gel', x: 40, y: 119, w: 21.3, h: 4.7,
            imgW: 448, imgH: 60, crop: { x: 534, y: 85, w: 448, h: 60 } };
const page = { w: 183, h: 240 };
PF.doc = { page, nodes: [n] };

// A panel with lanes, so the crop view knows where its corner is drawn.
n.lanes = [{ id: 'l0', x0: 40, x1: 120, role: 'ladder' }, { id: 'l1', x0: 120, x1: 200 }];
n.splice = {};
const v = gelCropView(n, src);

// The blot inside the crop rectangle is drawn the size it is in the figure, so
// opening a crop does not resize what is being judged.
assert.ok(Math.abs(v.s - n.h / n.imgH) < 1e-12, `${v.s} mm/px against the panel's ${n.h / n.imgH}`);
assert.ok(Math.abs(v.c.h * v.s - n.h) < 1e-9, `the crop drew ${v.c.h * v.s} mm where the panel is ${n.h}`);

// And it does not move either: the picture pixel `renderGel` draws at the
// panel's corner is drawn at that same corner here.  Crop pixel (40, 0) of the
// first lane is scan pixel (534 + 40, 85).
assert.ok(Math.abs(v.X(534 + 40) - n.x) < 1e-9, `the blot jumped to ${v.X(574)}, panel at ${n.x}`);
assert.ok(Math.abs(v.Y(85) - n.y) < 1e-9, `the blot jumped to ${v.Y(85)}, panel at ${n.y}`);

// The whole scan is drawn around it: 1024 rows at 4.7 mm per 60 is a
// membrane-sized 80 mm, not the 5.9 mm the scan's own height used to give.
assert.ok(v.H > 70 && v.H < 90, `the scan came out ${v.H} mm tall`);

// The crop rectangle is larger than the handles that resize it.  Seven screen
// pixels is about a millimeter of a page this wide; this was 0.28 mm.
assert.ok(v.c.h * v.s > 2, `crop drawn ${(v.c.h * v.s).toFixed(2)} mm tall`);
assert.ok(v.c.w * v.s > 2, `crop drawn ${(v.c.w * v.s).toFixed(2)} mm wide`);

// With strips the panel's corner is the first strip's first row, not the
// crop's top, or opening a crop on a striped panel slides it up the page.
const stv = gelCropView({ ...n, strips: [{ y0: 12, y1: 50 }] }, src);
assert.ok(Math.abs(stv.Y(85 + 12) - n.y) < 1e-9, `striped panel jumped to ${stv.Y(97)}`);

// Uncropped to the whole scan at that same magnification, the scale is the
// same scale: it follows the panel, and the panel follows its crop.
const whole = gelCropView({ ...n, crop: null, h: 80.18, imgH: 1024 }, src);
assert.ok(Math.abs(whole.s - v.s) < 1e-4, [whole.s, v.s]);
assert.ok(Math.abs(v.X(src.w) - (v.x0 + v.W)) < 1e-9);
assert.ok(Math.abs(v.Y(85) - (v.y0 + 85 * v.s)) < 1e-9);

/* ---- the outline follows the cursor, not the picture ---- */

// While a crop is open the picture is held where it was.  `ax` -- how far into
// the crop the panel's corner falls -- is read off lanes that regeom only moves
// onto the new crop when the drag ends, so working the anchor out again on each
// mouse move cancelled the drag exactly: the left handle stood where it was and
// the rectangle grew out of the far side instead.
PF.cropHold = g => (g.id === n.id ? { s: v.s, x0: v.x0, y0: v.y0 } : null);
const held0 = gelCropView(n, src);
n.crop = { x: 534 - 30, y: 85 - 10, w: 448 + 30, h: 60 + 10 };   // top-left dragged out
const held1 = gelCropView(n, src);
assert.ok(Math.abs(held1.x0 - held0.x0) < 1e-9 && Math.abs(held1.y0 - held0.y0) < 1e-9,
          `the scan slid ${held1.x0 - held0.x0}, ${held1.y0 - held0.y0} mm under the cursor`);
assert.ok(Math.abs(held1.X(held1.c.x) - (held0.X(held0.c.x) - 30 * v.s)) < 1e-9,
          `the left edge moved ${held1.X(held1.c.x) - held0.X(held0.c.x)} mm, asked for ${-30 * v.s}`);
assert.ok(Math.abs(held1.Y(held1.c.y) - (held0.Y(held0.c.y) - 10 * v.s)) < 1e-9,
          `the top edge moved ${held1.Y(held1.c.y) - held0.Y(held0.c.y)} mm, asked for ${-10 * v.s}`);
assert.ok(Math.abs(held1.X(held1.c.x + held1.c.w) - held0.X(held0.c.x + held0.c.w)) < 1e-9,
          'dragging the left edge moved the right one too');
PF.cropHold = null;
n.crop = { x: 534, y: 85, w: 448, h: 60 };

/* ---- a crop keeps the magnification ---- */

// The same panel again, and the scale it is drawn at: millimeters per row.
const mm = n.h / n.imgH;

// Trim 20 rows off the bottom.  The panel loses exactly those rows' worth of
// height and nothing moves: what was above the cut is drawn where it was.
const bot = { ...n, strips: [] };
gelKeepScale(bot, 60, 40, 0);
assert.ok(Math.abs(bot.h / 40 - mm) < 1e-5, `${bot.h / 40} mm/row, was ${mm}`);
assert.ok(Math.abs(bot.h - (n.h - 20 * mm)) < 0.01, bot.h);
assert.strictEqual(bot.y, n.y);

// Trim 20 off the top instead: the old top row now sits 20 rows above the new
// picture, so the panel starts 20 rows further down the page and the band that
// is left is drawn where it already was.
const top = { ...n, strips: [] };
gelKeepScale(top, 60, 40, -20);
assert.ok(Math.abs(top.h / 40 - mm) < 1e-5, top.h);
assert.ok(Math.abs(top.y - (n.y + 20 * mm)) < 0.01, `${top.y}, was ${n.y}`);

// Uncrop to the whole scan at that same magnification -- the point of being
// able to get hold of a crop again is seeing the strip it was cut from.
const out = { ...n, strips: [] };
gelKeepScale(out, 60, 1024, 85);
assert.ok(Math.abs(out.h / 1024 - mm) < 1e-5, out.h);
assert.ok(out.h > 75 && out.h < 85, `the whole scan came back ${out.h} mm tall`);

// With strips the panel's top is the first strip, which is put back on its own
// rows of the scan by the same pass; moving the panel too would move it twice.
const st = { ...n, strips: [{ y0: 10, y1: 50 }] };
gelKeepScale(st, 60, 40, -20);
assert.strictEqual(st.y, n.y, 'a striped panel was moved as well as its strips');
assert.ok(Math.abs(st.h / 40 - mm) < 1e-5, st.h);

// And it holds all the way down: a floor here would quietly magnify the small
// panels, which are the ones cropped hardest.  Sixteen rows is the tightest the
// crop tool will cut, and sixteen rows are drawn as sixteen rows.
const tiny = { ...n, strips: [] };
gelKeepScale(tiny, 60, 16, 0);
assert.ok(Math.abs(tiny.h / 16 - mm) < 1e-3, `${tiny.h} mm for 16 rows`);

// A crop dragged by hand goes through this on every mouse move, each one
// reading back what the last one wrote, so the rounding compounds.  Three
// hundred moves out and back, the scale is still the scale.
const drag = { ...n, strips: [] };
let H = 60;
for (let i = 0; i < 300; i++) {
  const next = 60 - (i % 40);
  gelKeepScale(drag, H, next, 0);
  H = next;
}
gelKeepScale(drag, H, 60, 0);
assert.ok(Math.abs(drag.h / 60 - mm) < 1e-4, `${drag.h / 60} mm/row after 300 moves, was ${mm}`);

/* ---- what a striped panel shows, which is what the supplement outlines ---- */

// A strip cuts the panel down to its band rows without touching its crop, so
// the crop is only where the numbers are measured from and the rows are what is
// printed.  `buildSupplementary` draws its outline from the first row's top to
// the last row's bottom; an outline round the whole crop would claim a strip of
// membrane the figure never shows.
const shown = { ...n, strips: [{ y0: 7, y1: 38 }, { y0: 44, y1: 52 }] };
const sr = gelRows(shown);
assert.strictEqual(sr.length, 2, 'a row per strip');
assert.strictEqual(sr[0].y0, 7);
assert.strictEqual(sr[sr.length - 1].y1, 52);
// And with none, the whole picture -- so the outline is the crop, as before.
assert.deepStrictEqual([gelRows({ ...n, strips: [] })[0].y0,
                        gelRows({ ...n, strips: [] })[0].y1], [0, n.imgH]);

console.log('ok');

/* ---- a lane pinned to a width in mm sizes the whole panel ---- */
PF.doc.page.laneMm = 3.5;
const pinned = { ...n, lanes: [{ id: 'a', x0: 10, x1: 50 }, { id: 'b', x0: 52, x1: 94 }] };
const PL = gelLayout(pinned);
const widths = PL.kept.map(l => l._wmm);
// 1e-3, not exact: the height is stored to four decimals, so the scale is
// quantized by a ten-thousandth of a millimeter -- far under anything printed.
assert.ok(Math.abs((widths[0] + widths[1]) / 2 - 3.5) < 1e-3, 'the average lane is 3.5 mm');
assert.ok(widths[0] < widths[1], 'the narrower lane stays narrower — nothing is stretched');
// Uniform: the height follows from the same scale, so mobilities do not move.
assert.ok(Math.abs(pinned.h / pinned.imgH - PL.s) < 1e-9, 'one scale for both axes');
// Idempotent: laying out twice is laying out once.
const again = gelLayout(pinned);
assert.ok(again.s === PL.s && again.totalW === PL.totalW, 'idempotent');
// A gel photographed twice as large prints at the same lane width.
const big = { ...pinned, imgW: n.imgW * 2, imgH: n.imgH * 2,
              lanes: pinned.lanes.map(l => ({ ...l, x0: l.x0 * 2, x1: l.x1 * 2 })) };
const BL = gelLayout(big);
assert.ok(Math.abs(BL.totalW - PL.totalW) < 1e-3, 'twice the pixels, the same millimeters');
// The panel opts out, and the page no longer reaches it.
const free = { ...pinned, laneMm: 0, h: 40 };
gelLayout(free);
assert.strictEqual(free.h, 40, 'laneMm 0 leaves the height alone');
PF.doc.page.laneMm = 0;
const hand = { ...pinned, h: 40 };
gelLayout(hand);
assert.strictEqual(hand.h, 40, 'unpinned, the page leaves the height alone');
