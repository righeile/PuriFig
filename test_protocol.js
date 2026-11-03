/* The protocol as a form: what scales, what does not, and what a cleanup keeps.
 *
 *     node test_protocol.js
 *
 * Three things are being pinned. The text is the document, so parsing it and
 * writing it back must be exactly the same text. The form's reading of the five
 * kinds of line must be protocol.py's reading of them, because that file holds
 * the writers — the fixture below is its own self-check's fixture, and the kinds
 * asserted here are the kinds asserted there. And a scale factor must reach
 * every amount and nothing else: the one mistake worth a test is a doubled prep
 * that comes out with twice the salt or twice the centrifuge speed.
 */
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

vm.runInThisContext(fs.readFileSync(__dirname + '/protein.js', 'utf8'), { filename: 'protein.js' });
vm.runInThisContext(fs.readFileSync(__dirname + '/panels.js', 'utf8'), { filename: 'panels.js' });
const app = fs.readFileSync(__dirname + '/app.js', 'utf8');
vm.runInThisContext(app.slice(app.indexOf('const PROT_PREFIX'),
                              app.indexOf('/* ================= file I/O')),
                    { filename: 'app.js (protocol)' });

// ---- the same protocol protocol.py checks itself with ----------------------
const src = '# Testpurification of LRRC8A/D 06.02.2026\n\n'
          + '## Material\n- Cell pellet, 13x350 ml\n  25 mM Tris pH 8.5\n\n'
          + '## Day 1 - 06.02.2026\n- Thaw cell pellet\n> Comment: pellet was soft\n'
          + '- Centrifuge at 85kg\n\n## Day 2 - 07.02.2026\n- Run the SEC\n';

const items = protParse(src);
const kinds = items.map(i => i.kind).filter(k => k !== 'blank');
assert.deepStrictEqual(kinds,
  ['title', 'heading', 'step', 'line', 'heading', 'step', 'comment', 'step', 'heading', 'step'],
  'the form reads the lines differently from protocol.py: ' + kinds.join(' '));

// The text is the document: through the items and back is the same protocol.
assert.strictEqual(protSerialize(protParse(src)), src, 'a round trip changed the text');

// ---- which comment belongs to which step ----------------------------------
const shape = protShape(items);
const stepI = items.findIndex(i => i.text === 'Thaw cell pellet');
assert.ok(shape.note.has(stepI), 'the comment under a step is that step’s field');
assert.strictEqual(items[shape.note.get(stepI)].text, 'Comment: pellet was soft');
assert.ok(!shape.note.has(items.findIndex(i => i.text === 'Run the SEC')),
          'a step with nothing under it has no comment');

// ---- ready for reuse ------------------------------------------------------
const dirty = '# Prep\n## Day 1\n- Resuspend in *25* mL buffer\n> went to 30 mL, pellet was large\n- Load\n';
const clean = protClean(dirty);
assert.strictEqual(clean.notes, 1, 'the comment line was not counted');
assert.strictEqual(clean.marks, 1, 'the overwritten value was not counted');
assert.ok(!/[>*]/.test(clean.text), 'a mark or a comment survived the cleanup:\n' + clean.text);
// The number that was actually used stays, as the recipe's own.
assert.ok(clean.text.includes('Resuspend in 25 mL buffer'), clean.text);
assert.ok(!clean.text.includes('\n\n\n'), 'the removed line left a hole');
// Nothing to clean is not an error, and nothing changes.
const twice = protClean(clean.text);
assert.strictEqual(twice.notes + twice.marks, 0);
assert.strictEqual(twice.text, clean.text, 'cleaning a clean protocol changed it');

// ---- what a scale factor reaches -----------------------------------------
const recipe = '# Prep 06.02.2026\n'
  + '## Day 1 - 06.02.2026\n'
  + '- Resuspend 12 g of pellet in 250 mL of 25 mM Tris pH 8.5, 150 mM NaCl, 10% glycerol\n'
  + '  Add 2.5 µL benzonase and 1 mmol MgCl2\n'
  + '- Centrifuge at 85kg for 45 min at 4 °C\n'
  + '- Load onto a Superose 6 10/300 at 0.5 mL/min, 1.5 mL fractions\n'
  + '- Elute with 3 column volumes\n'
  + '> ran 500 mL through the column\n';
const x2 = protScale(recipe, 2);

const scaled = [['24 g', 'a mass'], ['500 mL', 'a volume'], ['5 µL', 'a microvolume'],
                ['2 mmol', 'a mole amount'], ['3 mL fractions', 'a fraction size']];
scaled.forEach(([want, what]) => assert.ok(x2.text.includes(want), `${what} did not scale: ${want}`));

const kept = [['25 mM', 'a concentration'], ['150 mM', 'a concentration'], ['10%', 'a percentage'],
              ['pH 8.5', 'a pH'], ['45 min', 'a time'], ['4 °C', 'a temperature'],
              ['85kg', 'a centrifuge speed'], ['Superose 6 10/300', 'a column name'],
              ['0.5 mL/min', 'a flow rate'], ['3 column volumes', 'a column volume'],
              ['ran 500 mL through', 'a comment — what happened, not a recipe']];
kept.forEach(([want, what]) => assert.ok(x2.text.includes(want), `${what} was scaled: ${want} is gone`));

assert.strictEqual(x2.n, 5, `${x2.n} quantities scaled, expected 5`);
assert.strictEqual(protScale(recipe, 1).text, recipe, '×1 is not the protocol itself');

// A marked value is a measurement, so it stays whatever the factor is.
assert.ok(protScale('- Resuspend in *25* mL buffer\n', 2).text.includes('*25*'),
          'a marked value was scaled');
// And the recipe's own number beside it still does.
assert.ok(protScale('- Resuspend in *25* mL of 300 mL stock\n', 2).text.includes('600 mL stock'));

// Halving, and the decimals that come with it.
assert.ok(protScale('- Add 1 mL and 0.5 mL and 3 g\n', 0.5).text.includes('0.5 mL and 0.25 mL and 1.5 g'));
// A title and a heading carry dates, which no factor applies to.
assert.ok(protScale('# Prep 06.02.2026\n## Day 1 - 06.02.2026\n', 4).text
            .includes('# Prep 06.02.2026\n## Day 1 - 06.02.2026'), 'a date was scaled');

// ---- the document says it was scaled -------------------------------------
const out = protOut({ text: recipe, scale: 2 });
assert.ok(out.split('\n')[1].startsWith('> Quantities scaled ×2'),
          'the export does not say it is not the recipe:\n' + out.slice(0, 120));
assert.ok(out.startsWith('# Prep'), 'the note went above the title');
assert.strictEqual(protOut({ text: recipe, scale: 1 }), recipe,
                   '×1 added a note to a protocol that was not scaled');

// ---- the form shows every line ------------------------------------------
const html = protForm(protParse(src), true);
['Thaw cell pellet', 'Comment: pellet was soft', 'Day 2 - 07.02.2026', '25 mM Tris pH 8.5',
 'Testpurification of LRRC8A/D'].forEach(t =>
  assert.ok(html.includes(esc(t)), `the form does not show "${t}" anywhere`));

// An empty comment is the line a comment field types into: it has to survive
// serialize -> parse, or the field never finds it and inserts another.
{
  const empty = protSerialize([{ kind: 'step', text: 'Spin' }, { kind: 'comment', text: '' }]);
  const back = protParse(empty);
  assert.strictEqual(back.map(i => i.kind).join(','), 'step,comment',
    'an empty comment must stay a comment, or its field inserts a new line on every focus');
  assert.strictEqual(protParse(protSerialize([{ kind: 'step', text: '' }]))[0].kind, 'step',
    'an empty step must stay a step');
}

// ---- which rotor the spin needs ------------------------------------------
// Capacity, not g: a prep that doubles still has to fit in a rotor.
{
  const spinSrc = '## Day 1 - 06.02.2026\n'
                + '- Resuspend 12 g in 250 mL lysis buffer\n'
                + '  Add 2.5 \u00b5L benzonase\n'
                + '- Centrifuge at 85kg for 45 min at 4 \u00b0C\n';
  const spinOf = (text, k) => {
    const items = protScale(text, k).items;
    const i = items.findIndex(it => /Centrifuge/.test(it.text));
    return protSpin(items, i);
  };
  assert.strictEqual(spinOf(spinSrc, 1), '250 mL — one spin in a Ti70 (8 × 39 mL)',
    'at the written scale the lysate fits the smaller rotor');
  assert.strictEqual(spinOf(spinSrc, 2), '500 mL — 2 spins in a Ti45 (420 mL a run)',
    'doubled, it fits neither rotor in one go');
  // The volume is the one above the step, not the benzonase on the line under it.
  assert.ok(!/0\.0025|2\.5 /.test(spinOf(spinSrc, 1)), 'a microliter addition is not the spin volume');
  // A rotor already written in, and big enough, says nothing.
  assert.strictEqual(
    protSpin(protParse('- Resuspend in 250 mL\n- Centrifuge in a Ti45 at 85kg'), 1), '',
    'a rotor that holds it is left alone');
  assert.ok(/more than a Ti70 holds/.test(
    protSpin(protParse('- Resuspend in 400 mL\n- Centrifuge in a Ti70 at 85kg'), 1)),
    'a rotor that no longer holds it is contradicted');
  // A rate is not an amount.
  assert.strictEqual(protVolume('0.5 mL/min, 1.5 mL fractions'), 1.5, 'mL/min is a rate');
}


// ---- a comment is as many lines as it has --------------------------------
// What happened at a step is rarely one line, and `>` lines in a row are one
// comment of several lines: the field is a textarea and Enter is a line in it.
{
  const src2 = '## Day 1\n- Spin\n> went long\n> and the pellet was loose\n- Load\n';
  const its = protParse(src2);
  const sh = protShape(its);
  const step = its.findIndex(i => i.text === 'Spin');
  assert.strictEqual(sh.note.get(step), 2, 'the comment under the step starts at its first line');
  assert.strictEqual(sh.runs.get(2), 2, 'two > lines in a row are one comment of two lines');
  assert.strictEqual(sh.owner.get(3), 2, 'the second line belongs to the comment above it');
  const html2 = protForm(its, true, {});
  assert.ok(html2.includes('went long\nand the pellet was loose</textarea>'),
            'both lines are not in one field:\n' + html2);
  assert.strictEqual((html2.match(/class="prot-note"/g) || []).length, 2,
    'one field for the comment and one for the step with none — not one per line');
  assert.strictEqual(protSerialize(its), src2, 'a round trip changed the text');
  // A blank line inside a comment is a line of it, and survives the round trip.
  const gap = protSerialize([{ kind: 'comment', text: 'a' }, { kind: 'comment', text: '' },
                             { kind: 'comment', text: 'b' }]);
  assert.strictEqual(protParse(gap).map(i => i.text).join('\n'), 'a\n\nb');
}

// ---- the pellet is the scale --------------------------------------------
{
  assert.strictEqual(protBaseMass(recipe), 12, 'the mass the protocol is written for');
  assert.strictEqual(protBaseMass('- Centrifuge at 85kg\n- Spin at 500 g for 10 min\n'), 0,
    'a g-force is not a pellet');
  const P = { text: recipe, base: 12, pellet: 'a',
              pellets: [{ id: 'a', c: 'LRRC8A', g: 24 }, { id: 'b', c: 'LRRC8D', g: 12 }] };
  assert.strictEqual(protK(P), 2, 'twice the pellet is twice the recipe');
  P.pellet = 'b';
  assert.strictEqual(protK(P), 1, 'the other pellet is the mass it was written for');
  // A session saved while the scale was a bare number opens at that scale.
  assert.strictEqual(protK({ text: recipe, scale: 3 }), 3);
  // Nothing to compare a mass with scales nothing.
  assert.strictEqual(protK({ text: recipe, base: 0, pellet: 'a', pellets: [{ id: 'a', g: 24 }] }), 1);
  // The document says whose pellet it was and what it was written for.
  const outP = protOut({ text: recipe, base: 12, pellet: 'a',
                         pellets: [{ id: 'a', c: 'LRRC8A', g: 24 }] });
  assert.strictEqual(outP.split('\n')[1],
    '> LRRC8A, 24 g pellet — quantities scaled ×2 from the protocol as written (12 g).',
    outP.split('\n')[1]);
  assert.ok(outP.includes('24 g of pellet in 500 mL'), 'the steps did not scale with the pellet');
  // At the mass it was written for it is the recipe, and still says whose.
  const outOne = protOut({ text: recipe, base: 12, pellet: 'a',
                           pellets: [{ id: 'a', c: 'LRRC8D', g: 12 }] });
  assert.strictEqual(outOne.split('\n')[1], '> LRRC8D, 12 g pellet — the protocol as written.');
  assert.ok(outOne.includes('12 g of pellet in 250 mL'), 'a protocol at its own mass was rewritten');
}

// ---- the samples a prep takes of itself ---------------------------------
{
  globalThis.doc = { nodes: [] };
  globalThis.figurePanels = () => doc.nodes;
  globalThis.panelLetter = i => 'AB'[i];
  const sampSrc = '## Day 1\n'
    + '- Resuspend the pellet in 250 mL lysis buffer\n'
    + '- Take a 20 µL sample of the lysate\n'
    + '- Load onto the resin and keep 20 µL of the flow-through\n'
    + '- Wash with 50 mL buffer, keep 20 µL of the wash\n'
    + '- Wash again with 50 mL and sample the wash\n'
    + '- Elute and take a sample of the eluate\n';
  const found = [...protSamples(protParse(sampSrc)).values()];
  assert.deepStrictEqual(found.map(v => v.name),
    ['lysate', 'flow-through', 'wash', 'wash 2', 'eluate'],
    'the samples, in the order they are taken, the second wash numbered');
  found.forEach(v => assert.ok(LANE_ROLES.includes(v.role),
    `${v.name} points at a lane role the gel does not have: ${v.role}`));
  // What is not taking a sample: a step that moves the whole prep around.
  ['Resuspend the pellet in 250 mL lysis buffer',
   'Load onto a Superose 6 10/300 at 0.5 mL/min',
   'Keep the supernatant, 250 mL, on ice',
   'Add 2.5 µL benzonase and keep on ice',
   'Centrifuge at 85kg for 45 min at 4 °C'].forEach(t =>
    assert.strictEqual(protSample(t), '', `"${t}" is not taking a sample`));
  // The step that takes one reads in blue, and is offered a lane.
  const its = protParse(sampSrc);
  const html = protForm(its, true, { samples: {} });
  assert.strictEqual((html.match(/prot-sample/g) || []).length, 5, 'five steps take a sample');
  assert.ok(html.includes('lysate — no gel lanes yet'), 'with no gel there is nothing to link to');
}

// ---- a sample linked to its lane ----------------------------------------
// The figure says what the sample looked like; only the link says it is that
// sample.  The lane list and the exported document both need the figure, so
// this is the one block that stands a page up around the protocol.
{
  let n = 0;
  globalThis.uid = () => 'L' + (++n);
  const lanes = [{ id: 'l1', label: '', role: 'sample' }, { id: 'l2', label: 'FT', role: 'flow-through' },
                 { id: 'l3', label: '', role: 'ladder' }];
  globalThis.doc = { nodes: [{ id: 'g1', type: 'gel', lanes }] };
  globalThis.figurePanels = () => doc.nodes;
  globalThis.panelLetter = i => 'AB'[i];
  const choices = protLaneChoices();
  assert.deepStrictEqual(choices.map(c => c.label), ['(A) lane 1', '(A) lane 2 — FT'],
    'the ladder lane holds no sample and is not offered');
  const P = { text: '- Take a 20 µL sample of the lysate\n- Keep 20 µL of the flow-through\n',
              samples: { lysate: 'l1', 'flow-through': 'l2' } };
  const html = protForm(protParse(P.text), true, P);
  assert.ok(html.includes('<option value="l1" selected>(A) lane 1</option>'),
            'the linked lane is not the one selected:\n' + html);
  const out = protOut(P);
  assert.ok(out.includes('> lysate → (A) lane 1\n'), 'the document does not say where the sample went:\n' + out);
  assert.ok(out.includes('> flow-through → (A) lane 2 — FT\n'), out);
  // The link is a comment under the step that took the sample, not over it.
  const lines = out.split('\n');
  assert.ok(/sample of the lysate/.test(lines[0]) && lines[1] === '> lysate → (A) lane 1', lines.slice(0, 3));
}


// ---- the sample you take for a gel is not the prep ------------------------
// Twice the pellet is twice the lysate and still the same 20 µL in the well.
{
  const src3 = '- Take a 20 µL sample of the lysate\n'
             + '- Elute with 15 mL elution buffer and take a 20 µL sample of the eluate\n'
             + '  Add 2.5 µL benzonase\n';
  const got = protScale(src3, 2).text;
  assert.ok(got.includes('Take a 20 µL sample of the lysate'), 'a gel sample doubled: ' + got);
  assert.ok(got.includes('Elute with 30 mL'), 'the elution buffer did not scale: ' + got);
  assert.ok(got.includes('take a 20 µL sample of the eluate'), 'the sample in it doubled: ' + got);
  assert.ok(got.includes('Add 5 µL benzonase'), 'a small addition is not a sample: ' + got);
}


// ---- the words are a guess, the switch on the row is the answer ----------
{
  const items = protParse('- Spin down and save the top\n- Take a 20 µL sample of the lysate\n');
  assert.deepStrictEqual([...protSamples(items).values()].map(v => v.name), ['lysate'],
    'only the step whose words say so');
  const taken = { [protTakenKey('Spin down and save the top')]: 'on',
                  [protTakenKey('Take a 20 µL sample of the lysate')]: 'off' };
  assert.deepStrictEqual([...protSamples(items, taken).values()].map(v => v.name), ['sample'],
    'the switch turns one on and the other off');
  // The key is the words, not the line: writing a comment above it moves the
  // line and must not lose the answer.
  const moved = protParse('> a comment first\n- Spin down and save the top\n');
  assert.strictEqual([...protSamples(moved, taken).values()][0].name, 'sample');
  // A step switched on holds its sample volume, like one that says so.
  const key = { [protTakenKey('Keep 2 mL of the top')]: 'on' };
  assert.ok(protScale('- Keep 2 mL of the top\n', 2, false, key).text.includes('2 mL'),
    'the sample of a step told it takes one was scaled');
  assert.ok(protScale('- Keep 2 mL of the top\n', 2).text.includes('4 mL'),
    'without the switch it is an amount like any other');
}


// ---- what the plate reader answered --------------------------------------
{
  assert.ok(protMeasure('Read the plate on the TECAN'), 'the machine by name');
  assert.ok(protMeasure('Measure Venus fluorescence of each well'), 'measuring what it measures');
  assert.ok(!protMeasure('Measure the A280 of the eluate'), 'the A280 is a NanoDrop, not a plate');
  assert.ok(!protMeasure('Read the pressure trace and stop the pump'), 'reading is not measuring');

  const got = { file: 'Venus.xlsx', device: 'Spark', date: '2026-02-24 16:34',
                reads: [{ says: 'Venus, 510/528 nm, gain 100, 29.3 °C', n: 4, lo: 12, hi: 786,
                          wells: { A21: 786, A22: 711, B10: 12, B1: 295 } }] };
  assert.deepStrictEqual(protReadLines(got), [
    'Venus, 510/528 nm, gain 100, 29.3 °C — 4 wells, 12–786 (Spark, 2026-02-24 16:34)',
    'A21 786 · A22 711 · B1 295 · B10 12']);  // across the plate, not down the alphabet

  const step = 'Read the plate on the TECAN';
  const P = { text: `- Resuspend the pellet\n- ${step}\n`, reads: { [protTakenKey(step)]: got } };
  const html = protForm(protParse(P.text), true, P);
  assert.ok(html.includes('data-pread="read the plate on the tecan"'), 'no way to attach a sheet:\n' + html);
  assert.strictEqual(html.match(/data-pread/g).length, 1, 'every step offered one:\n' + html);
  const out = protOut(P).split('\n');
  assert.ok(/TECAN/.test(out[1]) && /^> Venus, 510\/528 nm/.test(out[2]) && /^> A21 786/.test(out[3]),
    'the reading is not under the step that took it:\n' + out.slice(0, 5).join('\n'));
}

// ---- the column volumes are the resin's, not the pellet's ----------------
// The lab's binder protocol is written in CV: 40 CV of wash, 5 CV of eluate,
// and the millilitres beside them are only what that comes to for the 2 mL of
// resin it assumes.  Pack 3 mL, as the protocol itself says to when expression
// is good, and every one of those numbers is wrong.
{
  const cvSrc = '## Material\n'
    + '- Ni-NTA resin: 2 mL bed volume per construct (1 CV = 2 mL).\n'
    + '- Wash buffer:\n'
    + '  TBS, 50 mM imidazole, 5% glycerol; 40 CV (80 mL for 2 mL resin)\n'
    + '## Procedure\n'
    + '- Resuspend the cell pellet in 20 mL cold TBS\n'
    + '- Wash the resin with 40 CV wash buffer (80 mL for 2 mL resin), then elute as below.\n'
    + '  E2: 5 mL elution buffer (2.5 CV)\n';
  assert.strictEqual(protBed(cvSrc), 2, 'one column volume is 2 mL, and the protocol says so three ways');
  // Each shape on its own: what it says a CV is, and both orders of the pair.
  assert.strictEqual(protBed('- Wash with 40 CV (80 mL for 2 mL resin)\n'), 2, 'the CV-first pair');
  assert.strictEqual(protBed('- E2: 5 mL elution buffer (2.5 CV)\n'), 2, 'the millilitre-first pair');
  assert.strictEqual(protBed('- Resuspend in 20 mL TBS\n'), 0, 'a protocol that never counts in CV');

  const cv = { base: 2, mL: 3 };
  const at3 = protScale(cvSrc, 1, false, {}, cv).text;
  assert.ok(at3.includes('40 CV (120 mL for 3 mL resin)'), 'the wash did not follow the resin:\n' + at3);
  assert.ok(at3.includes('1 CV = 3 mL'), 'the bed volume still says what it was written for:\n' + at3);
  assert.ok(at3.includes('E2: 7.5 mL elution buffer (2.5 CV)'), 'the fraction did not follow:\n' + at3);
  assert.ok(at3.includes('20 mL cold TBS'), 'a volume that is not the column\u2019s moved:\n' + at3);
  // The pellet does not reach a CV volume: 40 CV is 40 CV whatever it weighed,
  // and doubling it washes a column with twice what it holds.
  const x2cv = protScale(cvSrc, 2, false, {}, cv).text;
  assert.ok(x2cv.includes('40 CV (120 mL for 3 mL resin)'), 'the pellet factor reached the wash:\n' + x2cv);
  assert.ok(x2cv.includes('40 mL cold TBS'), 'the resuspension did not scale with the pellet:\n' + x2cv);
  // And with no column of its own, the protocol is left as written.
  assert.strictEqual(protScale(cvSrc, 1, false, {}, { base: 2, mL: 2 }).text, cvSrc,
    'the same column as the protocol rewrote it anyway');

  const P = { text: cvSrc, bed: 2, base: 0,
              pellets: [{ id: 'a', c: 'GSb10', g: 24, r: 3 }, { id: 'b', c: 'GSb14', g: 21, r: 3 }],
              pellet: 'a' };
  assert.strictEqual(protConditions(P), 2, 'two constructs side by side are two conditions');
  assert.ok(protCVmoved(P), 'the column this run packed is not the protocol\u2019s');
  const said = protOut(P).split('\n')[0];
  assert.ok(/GSb10, 24 g pellet, 3 mL of resin/.test(said), 'the document does not say what it ran on:\n' + said);
  assert.ok(/2 conditions run side by side \(GSb10, GSb14\)/.test(said), said);
  assert.ok(/at 3 mL of resin, not the 2 mL/.test(said), said);
  // What has to be made up before a day of two columns starts.
  assert.ok(protOut(P).includes('> \u00d72 conditions: 120 \u2192 240 mL'),
    'the buffer for the second column is nowhere in the document:\n' + protOut(P));
  // One condition says nothing, because one column is what the protocol is.
  assert.strictEqual(protPer('Wash with 40 CV (120 mL for 3 mL resin)', 1), '');
  // The top of a range is a choice, not an amount.
  assert.strictEqual(
    protPer('Equilibrate 3 mL resin per construct, or scale up to 3\u20134 mL of resin', 2),
    '\u00d72 conditions: 3 \u2192 6 mL');
}


// ---- a sample line written in the comment color is a step ----------------
// The binder template marks every `SDS-PAGE sample:` line in its second color,
// the same one a day’s comments are in.  Read as comments they are dropped the
// moment the recipe is taken fresh — and they are the lines that say which lane
// of the blot is which sample.
{
  const blue = protSampleSteps('- Drain the column\n'
    + '> SDS-PAGE sample: 15 \u00b5L lysate + 15 \u00b5L SDS sample buffer.\n'
    + '> the resin had settled overnight\n');
  assert.strictEqual(blue.n, 1, 'the sample line was not read as a step');
  assert.ok(blue.text.includes('- SDS-PAGE sample: 15 \u00b5L lysate'), blue.text);
  assert.ok(blue.text.includes('> the resin had settled overnight'),
    'a note about the day was taken for an instruction:\n' + blue.text);
  assert.strictEqual(protSampleSteps('- Load the column\n').n, 0, 'nothing to promote is not a change');
  // Past tense is a record of a sample, not an instruction to take one.
  assert.strictEqual(protSampleSteps('> kept 20 \u00b5L of the lysate for the gel\n').n, 0);

  // Each of the five the template writes names its own lane role.
  const five = ['15 \u00b5L lysate', '15 \u00b5L flow-through', '20 \u00b5L wash',
                '20 \u00b5L of each elution fraction', '20 \u00b5L of each relevant SEC fraction']
    .map(t => `- SDS-PAGE sample: ${t} + 5 \u00b5L SDS sample buffer.`).join('\n') + '\n';
  assert.deepStrictEqual([...protSamples(protParse(five)).values()].map(v => v.role),
    ['lysate', 'flow-through', 'wash', 'eluate', 'SEC fraction'],
    'the five samples of a binder prep are not the five lanes of its gel');
}


// ---- the word `sample` is not a sample being taken -----------------------
{
  assert.strictEqual(protSample('With more than one sample, alternate between them'), '',
    'sonicating two samples in turn is not taking one');
  assert.strictEqual(protSample('Add glycerol equal to \u00bc of the sample volume'), '',
    'the sample you have is not a sample you take');
  assert.strictEqual(protSample('Aliquot, snap-freeze in liquid nitrogen and store at \u221280 \u00b0C'), '',
    'the final product going into the freezer is not a lane on a gel');
  assert.strictEqual(protSample('SDS-PAGE sample: 20 \u00b5L wash'), 'wash', 'a stage and a volume');
  assert.strictEqual(protSample('Take a 20 \u00b5L sample of the top fraction'), 'sample',
    'a volume with no stage named is still a sample');
}


// ---- the rotor advice is an ultracentrifuge’s --------------------------
// Ti70 and Ti45 are 100,000 x g rotors.  A lysate cleared at 20,000 x g goes in
// a benchtop rotor this does not know about, and the wrong rotor is worse
// advice than none.
{
  const clear = protParse('- Resuspend in 250 mL lysis buffer\n- Centrifuge the lysate at 20,000 \u00d7 g for 50 min\n');
  assert.strictEqual(protSpin(clear, 1), '', 'a benchtop spin was given an ultracentrifuge rotor');
  const ultra = protParse('- Resuspend in 250 mL lysis buffer\n- Centrifuge at 85kg for 45 min\n');
  assert.ok(/Ti70/.test(protSpin(ultra, 1)), 'the ultracentrifuge spin lost its rotor');
}

console.log('ok — protocol: 5 kinds of line, a cleanup, 5 of 16 numbers scaled by the pellet,\n     multi-line comments, 5 samples linked to their lanes, a plate read under\n     the step that asked for it, and the column volumes of 2 conditions\u2019 resin');

// ---- the table stays a table ----------------------------------------------
// A form with a row per construct is the one thing in a protocol that is
// neither a step nor a note, and shredded into lines it stops being fillable.
// Outer pipes always: a cell with nothing in it is still a cell, and the
// column count is what tells the sheet which column is which.
assert.deepStrictEqual(protRowCells('| a |  | c |'), ['a', '', 'c']);
assert.strictEqual(protRowText(['a', '', 'c']), '| a |  | c |');
assert.deepStrictEqual(protRowCells(protRowText(['', '', '', ''])), ['', '', '', ''],
  'an empty row lost its cells');
assert.strictEqual(protParse('| a | b |')[0].kind, 'row');
assert.strictEqual(protParse('|')[0].kind, 'step', 'a lone pipe is not a table');

const tsrc = '# T\n\n## Overview\n'
           + '| ID | ε 0.1% | MW (kDa) | E1 | Conc (mg/ml) | Vol (µl) | Gly (µl) | Final (mg/ml) |\n'
           + '|  |  |  |  |  |  |  |  |\n'
           + '|  |  |  |  |  |  |  |  |\n\n- Equilibrate the resin\n';
assert.strictEqual(protSerialize(protParse(tsrc)), tsrc, 'a table did not round trip');
// A run of rows is one table; the blank line after it ends it.
const titems = protParse(tsrc);
assert.deepStrictEqual(Object.keys(protTables(titems)), ['3']);
assert.strictEqual(protTables(titems)[3].length, 3, 'header and two rows');
// Taking the recipe fresh keeps the form -- an empty Overview is what you fill in.
assert.ok(protClean(tsrc).text.includes('| ID |'), 'a cleanup dropped the table');

// ---- which column is which, off the header's own words ---------------------
const hdr = protRowCells(titems[3].text);
assert.deepStrictEqual(protRowCols(hdr),
  ['id', 'eps', 'mw', '', 'conc', 'vol', 'gly', 'final']);
assert.deepStrictEqual(protRowCols(['Fraction', 'A280', 'Notes']), ['', '', ''],
  'A280 is a reading off the machine, not an extinction coefficient');
assert.deepStrictEqual(protRowCols(['Binder', 'A 0.1%', 'Mass (kDa)']), ['id', 'eps', 'mw']);

// ---- glycerol is a quarter of the sample, and dilutes it to x0.8 -----------
const cols = protRowCols(hdr);
const der = (...cs) => protRowDerive(cs, cols);
assert.deepStrictEqual(der('', '', '', '', '2', '200', '', ''),
  ['', '', '', '', '2', '200', '50', '1.6'], 'glycerol or the final concentration is wrong');
// 70.6 on a 1:2 dilution, 110 ul: the lab book's own `70.6/2->28.3`, x0.8.
assert.strictEqual(der('', '', '', '', '35.3', '110', '', '')[7], '28.24');
// Nothing to work from leaves the cell empty rather than a zero or a NaN.
assert.deepStrictEqual(der('', '', '', '', '', '', '', ''), ['', '', '', '', '', '', '', '']);
assert.strictEqual(der('', '', '', '', '2', '', '', '')[6], '', 'no volume, no glycerol');
// A completed prep read back out of Word writes `70.6/2->28.3` in the
// concentration cell: not a number, and not a mistake -- blanking the glycerol
// and the final concentration beside it would throw away the record.
assert.deepStrictEqual(der('M9', '', '', '', '70.6/2->28.3', '110+25', '25', '28.3'),
  ['M9', '', '', '', '70.6/2->28.3', '110+25', '25', '28.3'],
  'a derived cell was blanked over a value its own row still holds');

// ---- a construct dropped on a row answers for its mass and absorbance -----
// The protein in the tube is what came off the column after the protease, so a
// cleaved construct reports its largest piece and not the chain expressed.
const TGT = 'MWYACDEFGHIKLMNPQRSTVWYKKLDWWF';
globalThis.doc = { nodes: [{
  id: 'c1', type: 'construct', title: 'M51', cleaved: true,
  segs: [{ name: 'His10', seq: 'HHHHHHHHHH' },
         { name: '3C', seq: 'LEVLFQGP', cut: true },
         { name: 'target', seq: TGT }],
}] };
const pp = protParam(TGT);
const got = protConstructOf('m51');
assert.ok(got, 'the construct was not found by its title');
assert.strictEqual(r2(got.mw), r2(pp.mw), 'the mass is not the cleaved piece');
assert.strictEqual(r3(got.a01), r3(pp.epsRed / pp.mw), 'A 0.1% is not eps/MW');
assert.strictEqual(protConstructOf('nothing'), null);
// Which fills the row's own columns in -- but only while they are empty.
// `proteinConstants` is purifig's rule everywhere else: a typed value wins.
assert.deepStrictEqual(der('M51', '', '', '', '', '', '', '').slice(0, 3),
  ['M51', String(r3(pp.epsRed / pp.mw)), String(r2(pp.mw / 1000))]);
assert.deepStrictEqual(der('M51', '2.9', '14.1', '', '', '', '', '').slice(0, 3),
  ['M51', '2.9', '14.1'], 'the sequence overwrote a mass that was measured');
// A segment given as a length has no tryptophans to count: a mass, no epsilon.
doc.nodes[0].segs[2] = { name: 'target', n: 240 };
assert.strictEqual(protConstructOf('M51').a01, null, 'an estimated chain cannot have an epsilon');
assert.ok(protConstructOf('M51').mw > 0);
// Only the two computed columns are read-only, whatever is on the row: a cell
// edit must never change the shape of the row, or the form is rebuilt under the
// hand filling it in and the cursor goes with it.
assert.deepStrictEqual(protRowCalc(cols),
  [false, false, false, false, false, false, true, true]);

console.log("ok — the Overview stays a table: 8 columns read off their own\n" +
            "     header, glycerol a quarter of the sample, the final\n" +
            "     concentration ×0.8, and a cleaved construct's own mass and\n" +
            "     A 0.1% off its sequence");
