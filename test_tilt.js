/* Gel panel geometry: leveling by two ladders, where the title sits, and which
 * membrane a crop came off.
 *
 *     node test_tilt.js
 *
 * Two sets of standards at the two ends of a gel are the best straight edge
 * there is on it: the same proteins, the same run, so a size marked in both is
 * at one height exactly when the gel is level.  What is checked here is the
 * angle and, mostly, its sign — a sign the wrong way round turns the picture
 * the wrong way and doubles the tilt instead of taking it off.
 */
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

for (const f of ['protein.js', 'panels.js'])
  vm.runInThisContext(fs.readFileSync(__dirname + '/' + f, 'utf8'), { filename: f });

/** A blot 700 px wide with standards in the first and last lane.  `drop` is how
 *  much lower the right-hand ladder sits: lower on the right is a picture
 *  turned clockwise, which is what a positive angle means. */
function twoLadders(drop, marks) {
  return {
    id: 'g', type: 'gel', x: 0, y: 0, w: 60, h: 40, imgW: 700, imgH: 500,
    href: 'x', leanL: 0, leanR: 0, strips: [], stripGap: 1,
    splice: { gap: 1, rule: true, ruleMm: 0.3 },
    lanes: [{ id: 'L0', x0: 0, x1: 50, role: 'ladder' },
            { id: 'L1', x0: 50, x1: 600, role: 'sample' },
            { id: 'L2', x0: 600, x1: 700, role: 'ladder' }],
    ladder: { on: true, side: 'left', pt: 5.5, marks: marks || [
      { kDa: 100, y: 100, x: 25 }, { kDa: 50, y: 200, x: 25 }, { kDa: 25, y: 300, x: 25 },
      { kDa: 100, y: 100 + drop, x: 650 }, { kDa: 50, y: 200 + drop, x: 650 },
      { kDa: 25, y: 300 + drop, x: 650 },
    ] },
  };
}

// 21.8 px down over 625 across is 2°, and the picture is turned -2° to level it.
const g = twoLadders(21.8);
assert.ok(Math.abs(gelLevelTilt(g) - 2.0) < 0.05, gelLevelTilt(g));
assert.ok(gelLevelTilt(twoLadders(-21.8)) < 0, 'the other way round is the other sign');

// One rung clicked on the wrong band does not decide it: the middle pair does.
const bad = twoLadders(21.8).ladder.marks.slice();
bad[5] = { ...bad[5], y: 300 + 90 };
assert.ok(Math.abs(gelLevelTilt(twoLadders(0, bad)) - 2.0) < 0.05,
          'one bad rung moved the angle: ' + gelLevelTilt(twoLadders(0, bad)));

// One ladder is not two, however many rungs are on it, and neither is the same
// lane marked twice: there is no angle in a single column of points.
assert.strictEqual(gelLevelTilt(twoLadders(0, [
  { kDa: 100, y: 100, x: 25 }, { kDa: 50, y: 200, x: 25 }])), null);
assert.strictEqual(gelLevelTilt(twoLadders(0, [
  { kDa: 50, y: 200, x: 25 }, { kDa: 50, y: 214, x: 30 }])), null);

// A rung with no size typed, or none marked at all, is nothing to level by.
assert.strictEqual(gelLevelTilt(twoLadders(0, [
  { kDa: 0, y: 200, x: 25 }, { kDa: 0, y: 220, x: 650 }])), null);
assert.strictEqual(gelLevelTilt(twoLadders(0, [])), null);

// And the angle is the one that levels them: turning the marks with the picture,
// by the angle the button turns it, puts every pair at one height.  This is the
// sign the whole thing turns on -- the wrong way round doubles the tilt.
const turn = (m, deg, cx, cy) => {
  const a = deg * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a);
  const dx = m.x - cx, dy = m.y - cy;
  return { ...m, x: cx + dx * c - dy * sn, y: cy + dx * sn + dy * c };
};
const crooked = twoLadders(21.8), by = gelLevelTilt(crooked);
const levelled = twoLadders(0, crooked.ladder.marks.map(m => turn(m, -by, 350, 250)));
assert.ok(Math.abs(gelLevelTilt(levelled)) < 0.01,
          'turning by the measured angle did not level the rungs: ' + gelLevelTilt(levelled));

// Two ladders marked, and the scale beside the panel still shows each size
// once: two readings of one standard are not two standards.
const level = twoLadders(0);
const L = gelLayout(level), rows = gelRows(level, L);
assert.strictEqual(gelShownMarks(level, rows, L).length, 3,
                   'the size scale printed the same rungs twice');

// The panel title goes above the lane labels, not through them.  One straight
// line of labels leaves it exactly where it has always been; a slanted row, or a
// second line, reaches higher and takes the title with it.
const titled = twoLadders(0);
Object.assign(titled, { title: 'blot 1', titlePt: 7, labelPt: 6, labelGap: 1.2, labelAngle: 0 });
titled.lanes[1].label = 'wild type';
const plain = gelTitleY(titled);
assert.ok(Math.abs(plain - (titled.y - titled.labelGap - titled.labelPt * PT * 1.9)) < 1e-9,
          'one line of labels moved the title from where it has always been');
titled.labelAngle = 60;
assert.ok(gelTitleY(titled) < plain - 3, 'a slanted label row did not push the title clear');
titled.labelAngle = 0;
titled.lanes[1].label = 'wild\ntype';
assert.ok(gelTitleY(titled) < plain, 'a second line of labels did not push the title clear');

// Which membrane a figure's crop came off.  One imager picture holds the whole
// tray, so the supplementary sheet shows the piece the crop is on and not the
// seven blots lying beside it.
const tray = [
  { sheet: 1, x: 534, y: 8, w: 448, h: 293 },
  { sheet: 2, x: 64, y: 43, w: 438, h: 295 },
  // One membrane cut across and probed in three strips.
  { sheet: 6, x: 76, y: 702, w: 365, h: 59 },
  { sheet: 6, x: 76, y: 761, w: 365, h: 86 },
  { sheet: 6, x: 76, y: 847, w: 365, h: 158 },
];
const bx4 = p => ({ x: p.x, y: p.y, w: p.w, h: p.h });
assert.deepStrictEqual(membraneFor(tray, { x: 600, y: 40, w: 200, h: 100 }), bx4(tray[0]));
// A crop that is already the whole membrane comes back as it is, not grown.
assert.deepStrictEqual(membraneFor(tray, { x: 64, y: 43, w: 438, h: 295 }), bx4(tray[1]));
// A crop reaching over a cut takes in the strip it reaches, and no further.
assert.deepStrictEqual(membraneFor(tray, { x: 100, y: 740, w: 100, h: 60 }),
                       { x: 76, y: 702, w: 365, h: 145 });
// A crop on no membrane at all -- and no white light to look at -- says so
// rather than picking the nearest piece.
assert.strictEqual(membraneFor(tray, { x: 1000, y: 900, w: 50, h: 50 }), null);
// A crop that stops a hair past its own membrane stays on its own membrane: a
// whole blot of somebody else's protein is not evidence for this panel.
assert.deepStrictEqual(membraneFor(tray, { x: 80, y: 775, w: 355, h: 80 }), bx4(tray[3]),
                       'eight pixels of the next strip dragged it in whole');
assert.strictEqual(membraneFor(null, { x: 100, y: 100, w: 10, h: 10 }), null);

// Cutting a gel in two on its marker lane.  Each part is one unbroken run of
// lanes, so neither draws a splice -- nothing has been juxtaposed, the two
// halves are simply two panels -- and each recognizes the other as the rest of
// the same gel.
const five = () => ({
  ...twoLadders(0), crop: { x: 0, y: 0, w: 700, h: 500 },
  lanes: [0, 1, 2, 3, 4].map(i => ({ id: 'L' + i, x0: i * 140, x1: i * 140 + 130,
                                     role: i === 2 ? 'ladder' : 'sample', label: 'abcde'[i] })),
});
const left = five(), right = five();
left.lanes.forEach((l, j) => { if (j >= 2) l.excised = true; });
right.lanes.forEach((l, j) => { if (j < 3) l.excised = true; });
assert.strictEqual(gelRuns(left).length, 1, 'the left part is not one unbroken run');
assert.strictEqual(gelRuns(right).length, 1, 'the right part is not one unbroken run');
assert.strictEqual(gelLayout(left).segs.filter(g => g.spliceBefore).length, 0,
                   'a part of a cut gel drew a splice');
assert.deepStrictEqual(gelPartsOf(left, [left, right]), [right]);
assert.deepStrictEqual(gelPartsOf(right, [left, right]), [left]);

// A panel keeping a lane this one also keeps is not the rest of it, and neither
// is one showing a different piece of the scan.
const overlap = five();
overlap.lanes.forEach((l, j) => { if (j < 1) l.excised = true; });
assert.deepStrictEqual(gelPartsOf(left, [left, overlap]), []);
assert.deepStrictEqual(gelPartsOf(left, [left, { ...right, crop: { x: 10, y: 0, w: 700, h: 500 } }]), []);

// Excising a lane out of the middle is the other thing entirely, and still
// splices: two lanes that never touched are drawn side by side.
const spliced = five();
spliced.lanes[2].excised = true;
assert.strictEqual(gelLayout(spliced).segs.filter(g => g.spliceBefore).length, 1,
                   'a lane cut out of the middle drew no splice');

// A thicker size bar takes the numbers out with it rather than under it: the
// scale's reach grows by exactly what the bar grew by, and the default pair is
// the 2.5 mm every figure drawn so far was laid out against.
{
  const thin = five(), thick = five();
  thick.ladder = { ...thick.ladder, lw: 0.6 };
  const reach = n => { const L = gelLayout(n); return gelScaleReach(n, 'left', gelRows(n, L), L); };
  const txtw = Math.max(...['100', '50', '25', 'kDa'].map(t => textWmm(t, 5.5)));
  assert.ok(Math.abs(reach(thin) - (2.5 + txtw)) < 1e-9, reach(thin));
  assert.strictEqual(r2(reach(thick) - reach(thin)),
                     r2(gelLadderBar(thick).len - gelLadderBar(thin).len),
                     'a thicker bar moved the numbers by something other than its own growth');
  // Thin bars keep the length they have always had rather than shrinking to 6:1.
  assert.strictEqual(gelLadderBar({ ladder: { lw: 0.1 } }).len, 1.4);
}

/* ---- a caption fits the box it was given ---- */
{
  const n = { type: 'text', x: 14, y: 8, w: 155, h: 6, fontPt: 7, align: 'start',
              fill: 'none', stroke: 'none',
              text: 'Supplementary to ClC-7 patient fibroblasts. Whole membranes, processed ' +
                    'as in the figure, with the size marker lanes in white light; the region ' +
                    'the figure uses is outlined.' };
  const lines = textNodeLines(n);
  assert.ok(lines.length > 1, 'a sentence 184 mm wide did not break for a 155 mm box');
  lines.forEach(l => assert.ok(textWmm(l, n.fontPt) <= n.w - 1.6, l));
  assert.strictEqual(lines.join(' '), n.text, 'wrapping changed the words');
  // Typed breaks are kept, and a short label is left alone.
  assert.deepStrictEqual(textNodeLines({ ...n, text: 'one\ntwo' }), ['one', 'two']);
  assert.deepStrictEqual(textNodeLines({ ...n, w: 8, text: 'A' }), ['A']);
  // One word too wide for the box overhangs rather than being cut in half.
  assert.deepStrictEqual(textNodeLines({ ...n, w: 8, text: 'beta-galactosidase' }),
                         ['beta-galactosidase']);
  // The ink box grows with the lines, or the panel below it would overlap.
  const tall = inkBox(n), one = inkBox({ ...n, text: 'short' });
  assert.ok(tall.h > one.h, 'a wrapped caption still measures one line high');
}

/* ---- nought point prints nothing ---- */
{
  assert.strictEqual(txt(0, 0, 'WT1', { pt: 0 }), '', 'a label set to no size was still drawn');
  assert.strictEqual(txtLines(0, 0, ['a', 'b'], { pt: 0 }), '');
  assert.ok(txt(0, 0, 'WT1', {}).includes('WT1'), 'no size given still means the default');
  // What it is for: a loading control whose lanes keep their labels for pairing
  // draws none of them.  The room above is `n.labelPt` times a constant, so it
  // is nought by construction and needs no test of its own.
  const n = five();
  n.labelPt = 0;
  n.bands = [];
  PF.imgUrl = u => u;
  const plain = five(); plain.bands = [];
  assert.ok(renderGel(plain).includes('>a<'), 'the fixture draws lane labels at all');
  assert.ok(!renderGel(n).includes('>a<'), 'a lane label slipped through at nought point');
}

console.log('ok');
