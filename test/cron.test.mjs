import test from 'node:test';
import assert from 'node:assert/strict';
import { matches, parseCron } from '../src/cron.mjs';

const at = iso => new Date(iso);
const minutesOf = (expression, from, count) => {
  const schedule = parseCron(expression);
  const hits = [];
  for (let i = 0; i < count; i++) {
    const date = new Date(at(from).getTime() + i * 60_000);
    if (matches(schedule, date)) hits.push(date.toISOString().slice(11, 16));
  }
  return hits;
};

test('fields take *, numbers, ranges, steps and lists, in UTC', () => {
  assert.deepEqual(minutesOf('0 * * * *', '2026-10-15T09:58:00Z', 125), ['10:00', '11:00', '12:00']);
  assert.deepEqual(minutesOf('*/20 10 * * *', '2026-10-15T09:58:00Z', 125), ['10:00', '10:20', '10:40']);
  assert.deepEqual(minutesOf('5-7,30 10 * * *', '2026-10-15T10:00:00Z', 60), ['10:05', '10:06', '10:07', '10:30']);
  assert.deepEqual(minutesOf('10/25 10 * * *', '2026-10-15T10:00:00Z', 60), ['10:10', '10:35']);
  assert.deepEqual([...parseCron('0 */4 * * *').hour.values], [0, 4, 8, 12, 16, 20]);
  assert.deepEqual([...parseCron('0 0 * * 1-5/2').weekday.values], [1, 3, 5]);
});

test('Sunday is 0 or 7, and two restricted day fields match either', () => {
  const sunday = at('2026-10-18T00:00:00Z');
  assert.ok(matches(parseCron('0 0 * * 7'), sunday));
  assert.ok(matches(parseCron('0 0 * * 0'), sunday));
  const both = parseCron('0 0 1 * 1');
  assert.ok(matches(both, at('2026-10-01T00:00:00Z')));
  assert.ok(matches(both, at('2026-10-19T00:00:00Z')));
  assert.ok(!matches(both, at('2026-10-18T00:00:00Z')));
  assert.ok(matches(parseCron('0 0 1 * *'), at('2026-10-01T00:00:00Z')));
  assert.ok(!matches(parseCron('0 0 1 * *'), at('2026-10-19T00:00:00Z')));
  assert.ok(!matches(parseCron('0 0 1 * */2'), at('2026-10-02T00:00:00Z')));
});

test('anything outside the five numeric fields is refused with the field it is in', () => {
  for (const [expression, message] of [
    ['@hourly', '"@hourly" must have five fields: minute, hour, day of month, month, day of week.'],
    ['* * * *', '"* * * *" must have five fields: minute, hour, day of month, month, day of week.'],
    ['60 * * * *', 'The minute field "60" is outside 0-59.'],
    ['0 0 0 * *', 'The day of month field "0" is outside 1-31.'],
    ['0 0 * JAN *', 'The month field "JAN" is not a number, range, step or *.'],
    ['0 0 * * 5-1', 'The day of week field "5-1" is outside 0-7.'],
    ['*/0 * * * *', 'The minute field "*/0" is outside 0-59.'],
  ]) {
    assert.throws(() => parseCron(expression), { code: 'cron', message }, expression);
  }
});
