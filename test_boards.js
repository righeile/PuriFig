/* Artboards: one canvas showing, the rest parked.
 *
 *     node test_boards.js
 *
 * The invariant worth a test is that the content lives in exactly one place.
 * The board on the canvas keeps its panels in `doc.nodes` and nothing in its
 * own entry; every other board keeps them in its entry and nothing on the
 * canvas. Get that wrong in one direction and a switch loses the panels, in
 * the other and every save writes a stale second copy of them.
 */
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

// The board block alone: it is the only part of app.js that needs no DOM.
const app = fs.readFileSync(__dirname + '/app.js', 'utf8');
// The slice runs in the real global scope, so its plumbing has to live there
// too: a `const` in this module would be invisible to it.
let n = 0;
Object.assign(globalThis, {
  asked: null, hinted: null,
  $: () => null,                      // no toolbar here, so no menu to repaint
  esc: s => s,
  uid: () => 'b' + ++n,
  fitView() {}, render() {}, inspector() {}, syncPage() {}, mark() {},
  hint(m, bad) { hinted = m; return bad; },
  confirm(q) { asked = q; return true; },
});
vm.runInThisContext(app.slice(app.indexOf('const boardOf = id =>'),
                              app.indexOf('/** A panel that shows less')),
                    { filename: 'app.js (boards)' });

const panel = name => ({ id: name, kind: 'box', text: name });
globalThis.doc = { boards: [{ id: 'figure', name: 'Figure', kind: 'figure' }], sheet: 'figure',
        page: { w: 183, h: 150 }, nodes: [panel('a'), panel('b')], edges: [] };
globalThis.view = { k: 1, x: 0, y: 0 };

addBoard();
const two = doc.boards[1].id;
assert.strictEqual(doc.sheet, two, 'a new artboard is not the one showing');
assert.deepStrictEqual(doc.nodes, [], 'a new artboard came up with panels on it');
assert.strictEqual(doc.page.w, 183, 'a new artboard did not take the page size of the last');
assert.ok(doc.page !== doc.boards[0].page, 'the two boards share one page object');
assert.deepStrictEqual(doc.boards[0].nodes.map(x => x.id), ['a', 'b'],
  'the figure did not park its panels');

doc.nodes.push(panel('c'));
showBoard('figure');
assert.deepStrictEqual(doc.nodes.map(x => x.id), ['a', 'b'], 'the figure came back short');
assert.strictEqual(boardOf('figure').nodes, null,
  'the board showing still holds a copy of its panels: every save writes it twice');
assert.deepStrictEqual(boardOf(two).nodes.map(x => x.id), ['c'], 'the other board lost its panel');

// The figure is what the others are beside, so it cannot be the one deleted.
delBoard('figure');
assert.strictEqual(doc.boards.length, 2, 'the figure was deleted');
assert.ok(/figure/i.test(hinted), 'deleting the figure said nothing');

// Deleting the board you are looking at counts the panels on the canvas, not
// the empty entry it parked them out of.
showBoard(two);
asked = null;
delBoard(two);
assert.ok(/\b1 panel\b/.test(asked), `asked "${asked}" about a board with one panel on it`);
assert.deepStrictEqual(doc.boards.map(b => b.id), ['figure'], 'the artboard outlived its delete');
assert.strictEqual(doc.sheet, 'figure', 'deleting the board showing left nothing on the canvas');
assert.deepStrictEqual(doc.nodes.map(x => x.id), ['a', 'b'], 'the figure did not come back');

console.log('ok — a board switch moves the panels rather than copying them,\n' +
            '     and a delete asks about the ones that are on the canvas');
