/* The extinction coefficient of a complex, which is the one number in a
 * concentration nobody can check by looking at the tube.
 *
 *     node test_complex.js
 *
 * A complex is several chains, often from several plasmids, in a stoichiometry
 * somebody decided.  ε and mass are sums over the copies; A 0.1% is their
 * ratio, which is why it is the one that does not behave the way people expect
 * — a hexamer of one subunit has its monomer's A 0.1% exactly, and a
 * hetero-complex has neither chain's.  What is checked here is that the sums
 * are sums, that a missing coefficient stays missing instead of becoming a
 * smaller protein's, and that the arithmetic a reader would do by hand comes
 * out the same.
 */
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

for (const f of ['protein.js', 'panels.js'])
  vm.runInThisContext(fs.readFileSync(__dirname + '/' + f, 'utf8'), { filename: f });

// Two chains of a co-expression: one with tryptophan, one without, so the
// shares are plainly different.
const A = 'MWKTYVLRDWQSGHAACNPTTWEEYMSGKLDWFR';
const B = 'MSTLYEQNGHKAADEFPQRSTVYWLKGGSDEYAK';
const a = protParam(A), b = protParam(B);

// ---- one chain, written as a complex, is the protein it always was.
{
  const one = proteinConstants({ chains: [{ seq: A, n: 1 }] });
  const plain = proteinConstants({ seq: A });
  assert.ok(Math.abs(one.mw - plain.mw) < 1e-9, `${one.mw} vs ${plain.mw}`);
  assert.strictEqual(one.eps, plain.eps);
  assert.ok(Math.abs(one.a01 - plain.a01) < 1e-12);
  assert.strictEqual(one.from, 'sequence');
}

// ---- ε and mass are sums over the copies, A 0.1% their ratio.
{
  const k = proteinConstants({ chains: [{ name: 'A', seq: A, n: 4 }, { name: 'B', seq: B, n: 2 }] });
  assert.strictEqual(k.eps, 4 * a.epsRed + 2 * b.epsRed);
  assert.ok(Math.abs(k.mw - (4 * a.mw + 2 * b.mw)) < 1e-9);
  assert.ok(Math.abs(k.a01 - k.eps / k.mw) < 1e-12);
  assert.strictEqual(k.copies, 6);
  assert.strictEqual(k.aa, 4 * a.n + 2 * b.n);
  assert.strictEqual(k.pp, null, 'a complex has no pI of its own and must not pretend to');

  // The one a reader checks by hand: A 0.1% of the complex lies between the
  // chains', at the mass-weighted place.
  const lo = Math.min(a.a01Red, b.a01Red), hi = Math.max(a.a01Red, b.a01Red);
  assert.ok(k.a01 > lo && k.a01 < hi, `${k.a01} is outside [${lo}, ${hi}]`);
}

// ---- a homo-oligomer has its monomer's A 0.1% exactly: only the µM moves.
{
  const mono = proteinConstants({ seq: A });
  const hexa = proteinConstants({ chains: [{ seq: A, n: 6 }] });
  assert.ok(Math.abs(hexa.a01 - mono.a01) < 1e-12,
            'six of the same chain absorb six times as much and weigh six times as much');
  const r = { a280: 0.6 };
  assert.ok(Math.abs(readingValues(r, hexa).mgml - readingValues(r, mono).mgml) < 1e-12);
  assert.ok(Math.abs(readingValues(r, hexa).uM * 6 - readingValues(r, mono).uM) < 1e-9,
            'the same milligrams are a sixth as many moles');
}

// ---- pasting both chains into one box is not the same thing, and the
// difference is the water that is not lost: two chains are not one chain.
{
  const joined = proteinConstants({ seq: A + B });
  const pair = proteinConstants({ chains: [{ seq: A, n: 1 }, { seq: B, n: 1 }] });
  assert.strictEqual(joined.eps, pair.eps, 'the chromophores are the same either way');
  assert.ok(Math.abs(pair.mw - joined.mw - WATER) < 1e-9,
            `joining them loses a water: ${joined.mw} vs ${pair.mw}`);
}

// ---- a chain whose ε nobody knows leaves the complex's unknown.
{
  const k = proteinConstants({ chains: [{ seq: A, n: 1 }, { name: 'partner', mw: 38000, n: 1 }] });
  assert.ok(Math.abs(k.mw - (a.mw + 38000)) < 1e-9, 'the masses still add up');
  assert.strictEqual(k.eps, null, 'two thirds of an ε is not an ε');
  assert.strictEqual(k.a01, null);
  assert.strictEqual(readingValues({ a280: 0.5 }, k).mgml, null);
}

// ---- a measured coefficient still beats the sequence, for the complex and
// for any one chain in it.
{
  const mine = proteinConstants({ chains: [{ seq: A, n: 2 }], eps: 12345 });
  assert.strictEqual(mine.eps, 12345);
  assert.strictEqual(mine.from, 'entered');
  assert.ok(Math.abs(mine.a01 - 12345 / mine.mw) < 1e-12);

  const perChain = proteinConstants({ chains: [{ seq: A, n: 2, eps: 1000 }, { seq: B, n: 1 }] });
  assert.strictEqual(perChain.eps, 2 * 1000 + b.epsRed);
}

// ---- cystines are the complex's setting unless a chain overrides it.
{
  const C = 'MCCWYCCGGCCYW';
  const red = proteinConstants({ chains: [{ seq: C, n: 2 }] });
  const ox = proteinConstants({ cys: 'cystine', chains: [{ seq: C, n: 2 }] });
  const pp = protParam(C);
  assert.strictEqual(red.eps, 2 * pp.epsRed);
  assert.strictEqual(ox.eps, 2 * pp.epsCys);
  assert.ok(pp.epsCys > pp.epsRed, 'the fixture has cystines to count');
}

// ---- the stoichiometry comes off the FASTA headers, as it is written down.
{
  const cs = parseChains(`>LRRC8A ×4\n${A}\n>LRRC8C x2\n${B}`);
  assert.deepStrictEqual(cs.map(c => [c.name, c.n, c.seq]),
                         [['LRRC8A', 4, A], ['LRRC8C', 2, B]]);
  assert.strictEqual(parseChains(`>partner (3)\n${A}`)[0].n, 3);
  assert.strictEqual(parseChains(`>two subunits here 2 copies\n${A}`)[0].n, 2);

  // A plain sequence is one chain of one, which is what every box held before.
  const plain = parseChains(A);
  assert.deepStrictEqual([plain.length, plain[0].n, plain[0].name], [1, 1, '']);
  assert.strictEqual(parseChains('>header with nothing under it').length, 0);

  // And a header that merely has numbers in it is not a stoichiometry.
  assert.strictEqual(parseChains(`>sp|P48723|HSP13_HUMAN heat shock 70 kDa\n${A}`)[0].n, 1);
}

console.log('ok — ε and mass are sums over the copies, A 0.1% their ratio');
