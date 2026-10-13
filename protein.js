/* purifig — what a sequence tells you, and what a spectrophotometer tells you.
 *
 * The numbers here are ProtParam's, computed rather than fetched.  Fetching
 * would mean scraping a web form for arithmetic that is published, which makes
 * the figure depend on a service being up and on nobody changing their HTML —
 * and the point of this app is that every number in a figure can be checked.
 * The methods are named against each constant so they can be.
 *
 *   mass          average residue masses + one water
 *   ε₂₈₀          Pace et al. 1995: 5500·nTrp + 1490·nTyr + 125·nCystine
 *   A 0.1%        ε / M, the absorbance of 1 mg/mL through 1 cm
 *   pI            Bjellqvist pKa set, bisected for zero net charge
 *   instability   Guruprasad et al. 1990, dipeptide weights
 *   aliphatic     Ikai 1980
 *   GRAVY         Kyte & Doolittle 1982
 *
 * Checked residue for residue against Biopython's ProteinAnalysis, which is the
 * same calculation ExPASy runs.
 */

const AA = 'ACDEFGHIKLMNPQRSTVWY';

//: Average (not monoisotopic) residue masses, the ones ProtParam reports.
const AA_MASS = {
  A: 71.0788, C: 103.1388, D: 115.0886, E: 129.1155, F: 147.1766,
  G: 57.0519, H: 137.1411, I: 113.1594, K: 128.1741, L: 113.1594,
  M: 131.1926, N: 114.1038, P: 97.1167, Q: 128.1307, R: 156.1875,
  S: 87.0782, T: 101.1051, V: 99.1326, W: 186.2132, Y: 163.1760,
};
const WATER = 18.01524;

//: Kyte & Doolittle hydropathy.
const KD = {
  A: 1.8, C: 2.5, D: -3.5, E: -3.5, F: 2.8, G: -0.4, H: -3.2, I: 4.5,
  K: -3.9, L: 3.8, M: 1.9, N: -3.5, P: -1.6, Q: -3.5, R: -4.5, S: -0.8,
  T: -0.7, V: 4.2, W: -0.9, Y: -1.3,
};

//: Bjellqvist pKa values.  The termini depend on which residue they are, which
//: is why a tag on either end moves the pI a little.
const PK_POS = { K: 10.0, R: 12.0, H: 5.98 };
const PK_NEG = { D: 4.05, E: 4.45, C: 9.0, Y: 10.0 };
const PK_NTERM = { A: 7.59, M: 7.00, S: 6.93, P: 8.36, T: 6.82, V: 7.44, E: 7.70 };
const PK_CTERM = { D: 4.55, E: 4.75 };

//: Guruprasad's dipeptide instability weights, row = first residue, column
//: as the AA order above.  400 numbers, flattened; the instability index is
//: their mean over the chain's dipeptides, scaled by 10.
const DIWV = [
  /* A */ 1,44.94,-7.49,1,1,1,-7.49,1,1,1,1,1,20.26,1,1,1,1,1,1,1,
  /* C */ 1,1,20.26,1,1,1,33.6,1,1,20.26,33.6,1,20.26,-6.54,1,1,33.6,-6.54,24.68,1,
  /* D */ 1,1,1,1,-6.54,1,1,1,-7.49,1,1,1,1,1,-6.54,20.26,-14.03,1,1,1,
  /* E */ 1,44.94,20.26,33.6,1,1,-6.54,20.26,1,1,1,1,20.26,20.26,1,20.26,1,1,-14.03,1,
  /* F */ 1,1,13.34,1,1,1,1,1,-14.03,1,1,1,20.26,1,1,1,1,1,1,33.601,
  /* G */ -7.49,1,1,-6.54,1,13.34,1,-7.49,-7.49,1,1,-7.49,1,1,1,1,-7.49,1,13.34,-7.49,
  /* H */ 1,1,1,1,-9.37,-9.37,1,44.94,24.68,1,1,24.68,-1.88,1,1,1,-6.54,1,-1.88,44.94,
  /* I */ 1,1,1,44.94,1,1,13.34,1,-7.49,20.26,1,1,-1.88,1,1,1,1,-7.49,1,1,
  /* K */ 1,1,1,1,1,-7.49,1,-7.49,1,-7.49,33.6,1,-6.54,24.64,33.6,1,1,-7.49,1,1,
  /* L */ 1,1,1,1,1,1,1,1,-7.49,1,1,1,20.26,33.6,20.26,1,1,1,24.68,1,
  /* M */ 13.34,1,1,1,1,1,58.28,1,1,1,-1.88,1,44.94,-6.54,-6.54,44.94,-1.88,1,1,24.68,
  /* N */ 1,-1.88,1,1,-14.03,-14.03,1,44.94,24.68,1,1,1,-1.88,-6.54,1,1,-7.49,1,-9.37,1,
  /* P */ 20.26,-6.54,-6.54,18.38,20.26,1,1,1,1,1,-6.54,1,20.26,20.26,-6.54,20.26,1,20.26,-1.88,1,
  /* Q */ 1,-6.54,20.26,20.26,-6.54,1,1,1,1,1,1,1,20.26,20.26,1,44.94,1,-6.54,1,-6.54,
  /* R */ 1,1,1,1,1,-7.49,20.26,1,1,1,1,13.34,20.26,20.26,58.28,44.94,1,1,58.28,-6.54,
  /* S */ 1,33.6,1,20.26,1,1,1,1,1,1,1,1,44.94,20.26,20.26,20.26,1,1,1,1,
  /* T */ 1,1,1,20.26,13.34,-7.49,1,1,1,1,1,-14.03,1,-6.54,1,1,1,1,-14.03,1,
  /* V */ 1,1,-14.03,1,1,-7.49,1,1,-1.88,1,1,1,20.26,1,1,1,-7.49,1,1,-6.54,
  /* W */ -14.03,1,1,1,1,-9.37,24.68,1,1,13.34,24.68,13.34,1,1,1,1,-14.03,-7.49,1,1,
  /* Y */ 24.68,1,24.68,-6.54,1,-7.49,13.34,1,1,1,44.94,1,13.34,1,-15.91,1,-7.49,1,-9.37,13.34,
].join(',').split(',').map(Number);

/** Strip a sequence down to residues.  FASTA headers, numbering, whitespace and
 *  the lower case some databases use for signal peptides all come off; anything
 *  left that is not one of the twenty is reported rather than quietly dropped,
 *  because a stray X or a nucleotide sequence pasted by mistake changes every
 *  number below and should not do so silently. */
function cleanSeq(raw) {
  const noHeaders = String(raw || '').replace(/^[>;].*$/gm, '');
  const letters = noHeaders.toUpperCase().replace(/[^A-Z]/g, '');
  const seq = [], odd = {};
  for (const c of letters) {
    if (AA.includes(c)) seq.push(c);
    else odd[c] = (odd[c] || 0) + 1;
  }
  return { seq: seq.join(''), odd };
}

/** Net charge at a given pH, from the Bjellqvist model. */
function netCharge(counts, pH, nTerm, cTerm) {
  let q = 1 / (1 + Math.pow(10, pH - (PK_NTERM[nTerm] ?? 7.5)));
  for (const a in PK_POS) q += (counts[a] || 0) / (1 + Math.pow(10, pH - PK_POS[a]));
  q -= 1 / (1 + Math.pow(10, (PK_CTERM[cTerm] ?? 3.55) - pH));
  for (const a in PK_NEG) q -= (counts[a] || 0) / (1 + Math.pow(10, PK_NEG[a] - pH));
  return q;
}

/** Everything a sequence determines.  Returns null for an empty one rather than
 *  a page of zeros pretending to be a measurement. */
function protParam(raw) {
  const { seq, odd } = cleanSeq(raw);
  const n = seq.length;
  if (!n) return null;

  const counts = {};
  for (const c of seq) counts[c] = (counts[c] || 0) + 1;
  const at = a => counts[a] || 0;

  const mw = [...seq].reduce((s, c) => s + AA_MASS[c], 0) + WATER;

  // Cystines are counted as pairs; an odd cysteine cannot pair with itself.
  const cystines = Math.floor(at('C') / 2);
  const epsRed = at('W') * 5500 + at('Y') * 1490;
  const epsCys = epsRed + cystines * 125;

  // pI by bisection.  Charge falls monotonically with pH, so 60 halvings of
  // [0, 14] land well inside the second decimal ProtParam prints.
  let lo = 0, hi = 14;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (netCharge(counts, mid, seq[0], seq[n - 1]) > 0) lo = mid; else hi = mid;
  }
  const pI = (lo + hi) / 2;

  let diwv = 0;
  for (let i = 0; i < n - 1; i++) diwv += DIWV[AA.indexOf(seq[i]) * 20 + AA.indexOf(seq[i + 1])];

  // A, C, G and T are all amino acids, so a nucleotide sequence pasted by
  // mistake does not fail — it quietly yields a plausible-looking mass for a
  // protein that does not exist.  Nothing else here can catch that, so it is
  // caught by composition: no real 20-mer is nine-tenths ACGT.
  const acgt = [...seq].filter(c => 'ACGTU'.includes(c)).length;
  const nucleotide = n >= 20 && acgt / n >= 0.9;

  const pct = a => (at(a) / n) * 100;
  return {
    seq, n, odd, nucleotide,
    mw,
    epsRed, epsCys,
    a01Red: epsRed / mw, a01Cys: epsCys / mw,
    cysteines: at('C'), cystines,
    trp: at('W'), tyr: at('Y'),
    pI,
    neg: at('D') + at('E'), pos: at('R') + at('K'),
    counts,
    gravy: [...seq].reduce((s, c) => s + KD[c], 0) / n,
    aromaticity: (at('F') + at('W') + at('Y')) / n,
    aliphatic: pct('A') + 2.9 * pct('V') + 3.9 * (pct('I') + pct('L')),
    instability: (10 / n) * diwv,
  };
}

/** The constants a concentration actually needs, from a sequence when there is
 *  one and from what was typed in when there is not.  A typed value always wins:
 *  someone who measured their own extinction coefficient knows something the
 *  sequence does not. */
function proteinConstants(p) {
  const pp = p && p.seq ? protParam(p.seq) : null;
  const cys = (p && p.cys) === 'cystine';
  const mw = nn(p && p.mw) ?? (pp ? pp.mw : null);
  const eps = nn(p && p.eps) ?? (pp ? (cys ? pp.epsCys : pp.epsRed) : null);
  let a01 = nn(p && p.a01);
  if (a01 === null && eps !== null && mw) a01 = eps / mw;
  return {
    pp, mw, eps, a01, pI: pp ? pp.pI : null,
    from: (p && (nn(p.a01) !== null || nn(p.eps) !== null || nn(p.mw) !== null))
      ? 'entered' : pp ? 'sequence' : 'none',
  };
}

/** mg/mL and µM for one reading.  A280 is what was measured; everything else is
 *  arithmetic on it, so it is derived here and never stored. */
function readingValues(r, k) {
  const a = nn(r.a280);
  if (a === null) return {};
  const dil = nn(r.dil) || 1;
  const corrected = a * dil;
  const mgml = k.a01 ? corrected / k.a01 : null;
  const uM = mgml !== null && k.mw ? (mgml / k.mw) * 1e6 : null;
  const vol = nn(r.vol);
  return {
    corrected,
    mgml,
    uM,
    mg: mgml !== null && vol !== null ? mgml * vol : null,
    ratio: nn(r.a260) !== null && a ? nn(r.a260) / a : null,
  };
}

/* ---- reading what a spectrophotometer wrote ---------------------------------
   NanoDrop software has written several different tables over the years, and a
   Lunatic or a DeNovix writes others again.  Rather than know them all, the
   columns are matched by name: whatever the header calls it, an A280 column is
   the one whose heading says 280.  Ratios are matched first, because "A260/A280"
   contains "A280" and would otherwise be read as the absorbance itself. */

const ND_COLUMNS = [
  ['ratio280', /260\s*[\/:]\s*280|a260\s*\/\s*a280/i],
  ['ratio230', /260\s*[\/:]\s*230|a260\s*\/\s*a230/i],
  ['a280', /(^|[^0-9])a\.?\s*-?\s*280|280\s*nm|abs.*280|\b280\b/i],
  ['a260', /(^|[^0-9])a\.?\s*-?\s*260|260\s*nm|abs.*260|\b260\b/i],
  ['sample', /sample\s*(id|name)?|^name$|^id$|description/i],
  ['conc', /conc|ng\s*\/\s*[uµ]l|mg\s*\/\s*ml|\bcorr/i],
  ['unit', /^units?$/i],
  ['dil', /dilut|\bfactor\b/i],
  ['date', /date|time/i],
];

/** Is this a spectrophotometer table rather than a chromatogram?
 *
 *  Not a question wording can answer: "UV 280" heads a column in both, and a
 *  NanoDrop export saying "Concentration (mg/mL)" trips any rule that treats
 *  millilitres as the mark of a trace.  The difference is structural.  A trace
 *  is thousands of rows against a number that only goes up; a spectrophotometer
 *  table is one row per sample, and its first column holds the sample's name
 *  rather than a coordinate. */
function looksLikeNanodrop(rows) {
  const firstData = rows.findIndex(r => r.filter(c => numOr(c) !== null).length >= 2);
  if (firstData < 1) return false;
  const header = rows[firstData - 1].map(c => String(c).toLowerCase());
  const body = rows.slice(firstData);
  if (!header.some(h => /280/.test(h))) return false;      // nothing to read
  if (body.length > 200) return false;                     // that is a trace
  const named = body.filter(r => r[0] && numOr(r[0]) === null).length;
  if (named >= Math.max(1, body.length * 0.5)) return true;
  return /sample|nanodrop|nucleic acid|260\s*\/\s*280/.test(header.join(' '));
}

/** Read a spectrophotometer export into rows.  Unmapped columns are kept as
 *  notes rather than dropped, so nothing measured disappears on the way in. */
function parseNanodropText(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length);
  if (!lines.length) throw new Error('the file is empty');
  const tabs = (lines[0].match(/\t/g) || []).length;
  const semis = (lines[0].match(/;/g) || []).length;
  const commas = (lines[0].match(/,/g) || []).length;
  const sep = tabs >= Math.max(commas, semis) ? '\t' : semis > commas ? ';' : ',';
  const rows = lines.map(l => splitRow(l, sep));

  // The header is the last row before the numbers start.
  let first = rows.findIndex(r => r.filter(c => numOr(c) !== null).length >= 2);
  if (first < 1) first = 1;
  const header = rows[first - 1].map(c => String(c).trim());

  const map = {};
  header.forEach((h, i) => {
    if (!h) return;
    for (const [key, re] of ND_COLUMNS) {
      if (map[key] === undefined && re.test(h)) { map[key] = i; return; }
    }
  });
  if (map.a280 === undefined) throw new Error('no A280 column — is this a spectrophotometer export?');

  const used = new Set(Object.values(map));
  const out = [];
  rows.slice(first).forEach(r => {
    if (numOr(r[map.a280]) === null) return;
    const note = header.map((h, i) => (!used.has(i) && h && String(r[i] || '').trim())
      ? `${h} ${String(r[i]).trim()}` : '').filter(Boolean).join('; ');
    out.push({
      id: uid(),
      sample: map.sample !== undefined ? String(r[map.sample] || '').trim() : '',
      a280: numOr(r[map.a280]),
      a260: map.a260 !== undefined ? numOr(r[map.a260]) : null,
      dil: map.dil !== undefined ? (numOr(r[map.dil]) || null) : null,
      vol: null,
      instrument: map.conc !== undefined ? numOr(r[map.conc]) : null,
      instrumentUnit: map.unit !== undefined ? String(r[map.unit] || '').trim() : '',
      note: note.slice(0, 120),
    });
  });
  if (!out.length) throw new Error('found an A280 column but no readings under it');
  return { rows: out, header, mapped: Object.keys(map) };
}
