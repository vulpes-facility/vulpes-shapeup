import test from 'node:test';
import assert from 'node:assert/strict';
import { badgeLabel, chartUrl, escapeXml, pointAt, renderHill } from '../src/render.mjs';

test('curve endpoints and peak of the normal curve', () => {
  assert.deepEqual(pointAt(0), { x: 80, y: 342 });
  assert.deepEqual(pointAt(50), { x: 600, y: 112 });
  assert.deepEqual(pointAt(100), { x: 1120, y: 342 });
  assert.equal(pointAt(30).y, pointAt(70).y);
  assert.equal(pointAt(25).y, 269.075); // tails bend below the straight line (y 227), unlike a sine
  assert.throws(() => pointAt(101));
});
test('render sorted scopes deterministically and escape XML', () => {
  const pitch = { number: 100, title: '<Pitch "one"> & friends' };
  const scopes = [{ number: 102, title: '<script>alert("a")</script> & \'', position: 50 },
    { number: 101, title: 'Zero', position: 0 }, { number: 103, title: 'Done', position: 100 }];
  const svg = renderHill(pitch, scopes);
  assert.equal(svg, renderHill(pitch, scopes.toReversed()));
  assert.match(svg, /&lt;script&gt;alert\(&quot;a&quot;\)&lt;\/script&gt; &amp; &apos;/);
  assert.doesNotMatch(svg, /<script|href=/);
  assert.match(svg, /data-scope="101" data-position="0" cx="80" cy="342"/);
  assert.match(svg, /data-scope="102" data-position="50" cx="600" cy="112"/);
  assert.match(svg, />Figuring things out</);
  assert.match(svg, />Making it happen</);
  assert.equal(escapeXml('\u0001<&>"\''), '�&lt;&amp;&gt;&quot;&apos;');
});
test('badge labels join consecutive runs and cap long lists', () => {
  assert.equal(badgeLabel([1]), '1');
  assert.equal(badgeLabel([1, 2]), '1, 2');
  assert.equal(badgeLabel([1, 2, 3]), '1–3');
  assert.equal(badgeLabel([1, 4, 7, 8, 9]), '1, 4, 7–9');
  assert.equal(badgeLabel(Array.from({ length: 15 }, (_, i) => i * 2 + 1)), '1, 3, 5, 7, 9, 11, 13 +8');
});
test('scopes at one position share a badge, and no connector crosses a badge', () => {
  const scopes = Array.from({ length: 30 }, (_, i) => ({ number: i + 1, title: `Scope ${i}`, position: 100 }))
    .concat([{ number: 31, title: 'Near', position: 98 }]);
  const svg = renderHill({ number: 60, title: 'Crowded' }, scopes);
  assert.equal((svg.match(/<rect x=/g) ?? []).length, 2);
  assert.match(svg, />1–30<\/text>/);
  assert.match(svg, />31<\/text><\/g>\n<g><title>#1 /);
  assert.ok(svg.lastIndexOf('<line') < svg.indexOf('<rect x='));
});
test('dense equal positions retain all names in separate legend rows', () => {
  const scopes = Array.from({ length: 40 }, (_, i) => ({ number: i + 1, title: `Scope ${i} ${'long'.repeat(30)}`, position: 50 }));
  const svg = renderHill({ number: 50, title: 'Dense' }, scopes);
  assert.equal((svg.match(/data-position="50"/g) ?? []).length, 40);
  assert.match(svg, /viewBox="0 0 1200 1975"/);
  assert.match(svg, /…/);
  assert.match(svg, /Scope 39/);
});
test('an empty chart says so', () => {
  assert.match(renderHill({ number: 1, title: 'Empty' }, []), />No scopes yet\.</);
});
test('chart link follows the naming rule with a 7-character SHA', () => {
  assert.equal(chartUrl('owner/repo', 'generated/shapeup', 7, '1a2b3c4d5e6f'),
    'https://github.com/owner/repo/blob/generated/shapeup/hills/pitch-7.svg?raw=true&v=1a2b3c4');
});
