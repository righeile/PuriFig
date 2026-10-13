/* What a purification table works out for itself.
 *
 *     node test_table.js
 *
 * The two columns a reviewer recomputes by hand are target and yield, and both
 * are arithmetic over numbers that are already on the page.  What is checked
 * here is that they follow the figure rather than the typing: a step named like
 * a sample in the A280 panel takes that panel's volume and milligrams, target
 * is what the purity says of the total, yield is against the first step — and
 * that a table with `derive` off still prints exactly what was typed into it.
 */
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

for (const f of ['protein.js', 'panels.js'])
  vm.runInThisContext(fs.readFileSync(__dirname + '/' + f, 'utf8'), { filename: f });

// A 1 mg/mL protein by A 0.1% = 1, so the milligrams are the millilitres.
const nd = {
  id: 'd', type: 'nanodrop', title: 'A₂₈₀',
  protein: { name: 'M38', seq: '', mw: 25000, eps: null, a01: 1, cys: 'reduced' },
  readings: [{ sample: 'StrepTrap HP', a280: 2, vol: 9 },
             { sample: 'Superose 6 Increase', a280: 1.85, vol: 2 },
             { sample: 'StrepTrap HP', a280: 9, vol: 9 }],   // the same step measured twice
  dp: { a280: 3, mgml: 2, uM: 1, mg: 2 },
};
const t = {
  ...tableNode(0, 0),
  rows: [{ step: 'StrepTrap HP', vol: '1', total: '1', purity: '45', yield: '1' },
         { step: 'Superose 6 Increase', vol: '1', total: '1', purity: '95', yield: '1' },
         { step: 'Not measured', vol: '7', total: '3', purity: '50', yield: '1' }],
};
PF.doc = { nodes: [nd, t] };

const r = tableRows(t);
assert.strictEqual(r[0].vol, '9', 'the volume did not come from the A280 panel');
assert.strictEqual(r[0].total, '18', '2 A280 at A 0.1% 1 over 9 mL is 18 mg');
assert.strictEqual(r[1].total, '3.7');
// The second reading of one name is a disagreement, not a correction: the first
// stands, so 9 A280 must not reach the table.
assert.ok(!/81/.test(r[0].total), 'the duplicate reading was used');

// target = total × purity, and the yields are against the first row's target.
assert.strictEqual(r[0].target, '8.1');
assert.strictEqual(r[1].target, '3.52');
assert.strictEqual(r[0].yield, '100');
assert.strictEqual(r[1].yield, '43');

// A step nothing measured keeps what was typed, and still gets its arithmetic.
assert.strictEqual(r[2].vol, '7', 'an unmatched step lost its typed volume');
assert.strictEqual(r[2].target, '1.5');
assert.deepStrictEqual(Object.keys(r[2]._from), ['target', 'yield']);

// Nothing is written back, and turning it off brings the typed numbers back.
assert.strictEqual(t.rows[0].total, '1', 'the derived value was written into the document');
t.derive = false;
assert.strictEqual(tableRows(t)[0].total, '1');
assert.strictEqual(tableRows(t)[0].yield, '1');

// Purity comes off a gel whose whole lanes have been measured: the step's name
// is the lane's label there, and the target band is a fraction of everything in
// that lane.  The typed purity gives way to it, and target and yield follow.
{
  const gel = {
    id: 'g', type: 'gel', title: 'SDS-PAGE', imgW: 300, imgH: 400,
    lanes: [{ id: 'L0', x0: 0, x1: 50, role: 'ladder' },
            { id: 'L1', x0: 50, x1: 150, label: 'StrepTrap HP' },
            { id: 'L2', x0: 150, x1: 250, label: 'Superose 6 Increase' }],
    quant: {
      method: 'border', border: 3, inset: 0.1,
      rows: [{ id: 'R', name: 'M38', role: 'target', h: 20 }],
      bands: [{ id: 'b1', row: 'R', lane: 'L1', y: 100, h: 20, net: 500 },
              { id: 'b2', row: 'R', lane: 'L2', y: 100, h: 20, net: 900 },
              { id: 'w1', row: WHOLE_LANE, lane: 'L1', y: 200, h: 400, net: 1000 },
              { id: 'w2', row: WHOLE_LANE, lane: 'L2', y: 200, h: 400, net: 1000 }],
    },
  };
  assert.deepStrictEqual(gelQuantLanes(gel).map(x => x.purity), [null, 50, 90]);

  t.derive = true;
  PF.doc = { nodes: [nd, gel, t] };
  const g = tableRows(t);
  assert.strictEqual(g[0].purity, '50', 'the typed purity was not replaced by the measured one');
  assert.strictEqual(g[0].target, '9');          // 18 mg × 50%
  assert.strictEqual(g[1].target, '3.33');       // 3.7 mg × 90%
  assert.strictEqual(g[1].yield, '37');
  assert.strictEqual(g[2].purity, '50', 'a step no lane is named after lost its typed purity');

  // A whole lane with nothing measured in it is not a purity of zero.
  gel.quant.bands = gel.quant.bands.filter(b => b.id !== 'b1');
  assert.strictEqual(gelQuantLanes(gel)[1].purity, null);
  assert.strictEqual(tableRows(t)[0].purity, '45', 'the typed purity did not come back');
}

// The table a new panel starts from must be the table the derivation would
// produce, or the example on screen contradicts its own arithmetic the moment
// anyone looks at it twice.
{
  const fresh = tableNode(0, 0);
  PF.doc = { nodes: [fresh] };
  const keys = ['vol', 'total', 'target', 'purity', 'yield'];
  tableRows(fresh).forEach((d, i) => keys.forEach(k =>
    assert.strictEqual(String(d[k]), String(fresh.rows[i][k]),
                       `the preset's ${k} on row ${i + 1} is not what it derives to`)));
}

console.log('ok');
