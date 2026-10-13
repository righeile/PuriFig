/* The construct panel's arithmetic, which is the part with a decision in it.
 *
 *     node test_construct.js
 *
 * Masses reach a figure: a reader compares the number printed here against the
 * band on the gel beside it.  So what is checked is that a counted mass is the
 * real one, that an estimated mass says it is estimated, and that a cut splits
 * the construct where the site is and not one segment out.
 */
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

// Both files are plain scripts sharing one global scope in the browser; giving
// them one here is the whole of the setup.  `_measure` already falls back to an
// estimate when there is no canvas, so nothing has to be stubbed.
for (const f of ['protein.js', 'panels.js'])
  vm.runInThisContext(fs.readFileSync(__dirname + '/' + f, 'utf8'), { filename: f });

const N = o => ({ type: 'construct', x: 0, y: 0, w: 92, barMm: 5, fontPt: 6, headPt: 6,
                  scale: true, numbers: true, masses: true, labels: 'auto', title: '',
                  stroke: '#333', strokeMm: 0.2, ...o });

// A counted mass is ProtParam's, to the last decimal.
{
  const one = seg({ name: 'His10', seq: 'HHHHHHHHHH' });
  const n = N({ segs: [one] });
  assert.strictEqual(segLen(one), 10);
  assert.ok(Math.abs(constructWhole(n).da - protParam('HHHHHHHHHH').mw) < 1e-9,
            'a one-segment construct weighs exactly what its sequence weighs');
}

// Water closes the chain once, not once per segment.  Two halves of a sequence
// must weigh what the whole of it weighs.
{
  const whole = 'MGSSHHHHHHSSGLVPRGSHMASMTGGQQMGRGSEFNLYFQGAAAWTYRDDK';
  const a = whole.slice(0, 20), b = whole.slice(20);
  const split = constructWhole(N({ segs: [seg({ seq: a }), seg({ seq: b })] }));
  assert.ok(Math.abs(split.da - protParam(whole).mw) < 1e-9,
            `two segments came to ${split.da}, the one sequence to ${protParam(whole).mw}`);
  assert.strictEqual(split.n, whole.length);
  assert.ok(split.exact, 'every segment had a sequence, so nothing is estimated');
}

// A length with no sequence is an estimate, and says so all the way up.
{
  const n = N({ segs: [seg({ name: 'MBP', n: 370 }), seg({ name: 'x', seq: 'ACDEFGHIK' })] });
  const w = constructWhole(n);
  assert.ok(!w.exact, 'one segment without a sequence makes the total an estimate');
  assert.strictEqual(w.n, 379);
  assert.ok(kDa(w).startsWith('~'), `an estimated mass must be marked: got ${kDa(w)}`);
  assert.ok(!kDa(constructWhole(N({ segs: [seg({ seq: 'ACDEFGHIK' })] }))).startsWith('~'));
}

// The cut is at the END of the segment carrying it: the site stays upstream.
{
  const n = N({ segs: [seg({ name: 'His6', seq: 'HHHHHH' }),
                       seg({ name: '3C', seq: 'LEVLFQ', cut: true }),
                       seg({ name: 'target', seq: 'MAWTYRDDK' })] });
  const p = constructPieces(n);
  assert.strictEqual(p.length, 2, 'one cut makes two pieces');
  assert.deepStrictEqual(p.map(x => x.n), [12, 9]);
  assert.ok(Math.abs(p[0].da - protParam('HHHHHHLEVLFQ').mw) < 1e-9, 'the site stays with the tag');
  assert.ok(Math.abs(p[1].da - protParam('MAWTYRDDK').mw) < 1e-9);
  // Cutting adds the water of a second chain, so the pieces outweigh the whole.
  const gained = p[0].da + p[1].da - constructWhole(n).da;
  assert.ok(Math.abs(gained - 18.01524) < 1e-9, `hydrolysis should add one water, added ${gained}`);
}

// No cut is one piece; a cut on the last segment does not leave an empty one.
{
  assert.strictEqual(constructPieces(N({ segs: [seg({ seq: 'AAA' }), seg({ seq: 'CCC' })] })).length, 1);
  assert.strictEqual(constructPieces(N({ segs: [seg({ seq: 'AAA', cut: true })] })).length, 1);
  assert.strictEqual(constructPieces(N({ segs: [] })).length, 0);
}

// An empty panel draws, and takes up its bar's worth of room rather than none.
{
  const n = N({ segs: [] });
  assert.strictEqual(constructMassLine(n), '');
  assert.ok(renderConstruct(n).includes('<rect'), 'an empty construct still draws its bar');
  assert.ok(n.h >= 5);
}

// Segment widths are the residue proportions, and they fill the panel exactly.
{
  const n = N({ segs: [seg({ seq: 'HHHHHHHHHH' }), seg({ name: 'target', n: 390, start: 1 })] });
  const L = constructLayout(n);
  assert.ok(Math.abs(L.box[0].w - 92 * 10 / 400) < 1e-9, 'a 10-residue tag is a fortieth of 400');
  assert.ok(Math.abs(L.box[0].w + L.box[1].w - 92) < 1e-9, 'the segments fill the width');
  // Too narrow for its name, so the name goes above with a leader.
  assert.ok(L.above.length === 0 || L.above[0].s !== n.segs[1]);
  const equal = constructLayout(N({ ...n, scale: false }));
  assert.ok(Math.abs(equal.box[0].w - 46) < 1e-9, 'unscaled, every segment is the same width');
}

// A drawn panel is sound SVG-ish markup and carries the mass it reports.
{
  const n = N({ title: 'ClC-7', segs: [seg({ name: 'His10', seq: 'HHHHHHHHHH' }),
                                       seg({ name: '3C', seq: 'LEVLFQ', cut: true }),
                                       seg({ name: 'ClC-7', n: 805, start: 1 })] });
  const svg = renderConstruct(n);
  assert.strictEqual((svg.match(/</g) || []).length, (svg.match(/>/g) || []).length);
  assert.ok(svg.includes('ClC-7') && svg.includes('805'), 'the name and the last residue are drawn');
  assert.ok(svg.includes(constructMassLine(n).slice(0, 6)));
  assert.ok(constructMassLine(n).includes('→'), 'a cut construct reports what cleavage leaves');
  assert.ok(n.h > 8 && n.h < 30, `a three-segment panel should be a sane height, got ${n.h}`);
}

// Untick "cut with the protease" and the panel is the construct as expressed --
// but a 2A still leaves two proteins, because that break was never a cleavage.
{
  const site = () => seg({ name: 'HRV 3C site', seq: 'LEVLFQ', cut: true });
  const n = N({ segs: [seg({ name: 'His10', seq: 'HHHHHHHHHH' }), site(),
                       seg({ name: 'target', n: 300, start: 1 })] });
  assert.strictEqual(constructPieces(n).length, 2);
  n.cleaved = false;
  assert.strictEqual(constructPieces(n).length, 1, 'uncut, the chain is one piece');
  assert.ok(!constructMassLine(n).includes('→'), 'and the mass line reports one mass');
  assert.ok(!renderConstruct(n).includes('stroke-dasharray="0.5 0.45"'), 'no cut is drawn');
  assert.strictEqual(constructSpecies(n).length, 1, 'a column is only asked for the whole thing');

  const p2a = N({ cleaved: false, segs: [seg({ name: 'A', n: 100, start: 1 }),
                                         seg({ name: 'P2A', seq: 'ATNFSLLKQAGDVEENPG', cut: true }),
                                         site(),
                                         seg({ name: 'B', n: 200, start: 1 })] });
  assert.strictEqual(constructPieces(p2a).length, 2, 'the 2A splits whether or not it was cut');
  assert.strictEqual(constructBreak(p2a), 'after the 2A');
}

console.log('ok');
