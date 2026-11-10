import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkoutCard } from './Results.js';
import { number, type MarkoutRungs } from './dto.js';

const rung = (label: string, horizonSec: number, bps: string | null, observed: number, total: number): MarkoutRungs[number] =>
  ({ label, horizonSec, bps, observed, total });

// Built with the same formatter the card uses, so the assertions say what the card means
// whatever locale renders it, and still fail when the card picks the wrong number.
const at = (bps: string) => `${number(Number(bps), 1)} bps`;
const shown = (r: MarkoutRungs[number]) => `${r.label} ${r.bps === null ? 'no mark' : at(r.bps)}`;

const full: MarkoutRungs = [
  rung('1 h', 3_600, '200', 6, 6),
  rung('4 h', 14_400, '150', 6, 6),
  rung('24 h', 86_400, '-80', 6, 6),
];

test('the card headlines the shortest horizon and shows the shape out to a day', () => {
  const markup = renderToStaticMarkup(MarkoutCard({ rungs: full }));
  assert.match(markup, /Markout · 1 h/, 'the big number has to carry the horizon it belongs to');
  assert.ok(markup.includes(`id="markout">${at('200')}`), `headline is not the first rung: ${markup}`);
  const positions = full.map((r) => markup.indexOf(shown(r)));
  assert.deepEqual(positions.filter((p) => p < 0), [], `a rung is missing from the shape line: ${markup}`);
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), 'the rungs stay in horizon order');
});

test('a decaying edge and a persisting one do not render the same card', () => {
  const persisting: MarkoutRungs = [
    rung('1 h', 3_600, '200', 6, 6),
    rung('4 h', 14_400, '210', 6, 6),
    rung('24 h', 86_400, '220', 6, 6),
  ];
  assert.notEqual(
    renderToStaticMarkup(MarkoutCard({ rungs: full })),
    renderToStaticMarkup(MarkoutCard({ rungs: persisting })),
    'two ladders with opposite meanings must not print alike',
  );
});

test('an unobserved horizon is never drawn as a flat zero', () => {
  const truncated: MarkoutRungs = [
    rung('1 h', 3_600, '99', 2, 2),
    rung('4 h', 14_400, null, 0, 2),
    rung('24 h', 86_400, null, 0, 2),
  ];
  const markup = renderToStaticMarkup(MarkoutCard({ rungs: truncated }));
  assert.ok(markup.includes(shown(truncated[0]!)), 'the observed rung still prints its number');
  assert.ok(markup.includes('4 h no mark · 24 h no mark'), `unobserved rungs are not labelled: ${markup}`);
  assert.equal(markup.includes(at('0')), false, 'a horizon nobody observed must not claim a flat outcome');
});

test('a report with no ladder says it has none', () => {
  const markup = renderToStaticMarkup(MarkoutCard({ rungs: [] }));
  assert.match(markup, /No horizons published for this run/);
  assert.equal(markup.includes('Markout · '), false, 'a horizon label with nothing behind it would be invented');
  assert.doesNotMatch(markup, /bps/);
});
