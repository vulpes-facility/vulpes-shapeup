import { ShapeUpError } from 'gh-vulpes-shapeup/domain';

// Five numeric fields, in UTC: minute, hour, day of month, month, day of week (0 or 7 is Sunday).
// Each is *, a number, a range a-b, a step */n or a-b/n, or a comma-separated list of those.
// Names (JAN, MON) and macros (@hourly) are not taken.
const fields = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 7 },
];

function parseField(text, { name, min, max }) {
  const values = new Set();
  for (const part of text.split(',')) {
    const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!match) throw new ShapeUpError('cron', `The ${name} field "${part}" is not a number, range, step or *.`);
    const [, , first, last, step] = match;
    const from = first === undefined ? min : Number(first);
    const to = first === undefined ? max : last === undefined ? (step === undefined ? from : max) : Number(last);
    const by = step === undefined ? 1 : Number(step);
    if (from < min || to > max || from > to || by < 1) throw new ShapeUpError('cron', `The ${name} field "${part}" is outside ${min}-${max}.`);
    for (let value = from; value <= to; value += by) values.add(value);
  }
  // As in cron, a field that starts with * counts as unrestricted when the two day fields are combined.
  return { values, any: text.startsWith('*') };
}

export function parseCron(expression) {
  const parts = String(expression).trim().split(/\s+/);
  if (parts.length !== 5) throw new ShapeUpError('cron', `"${expression}" must have five fields: minute, hour, day of month, month, day of week.`);
  const [minute, hour, day, month, weekday] = parts.map((part, i) => parseField(part, fields[i]));
  if (weekday.values.delete(7)) weekday.values.add(0);
  return { minute, hour, day, month, weekday };
}

// As in cron, when both day fields are restricted a date matches either of them.
export function matches(schedule, date) {
  const { minute, hour, day, month, weekday } = schedule;
  if (!minute.values.has(date.getUTCMinutes()) || !hour.values.has(date.getUTCHours()) || !month.values.has(date.getUTCMonth() + 1)) return false;
  const byDay = day.values.has(date.getUTCDate());
  const byWeekday = weekday.values.has(date.getUTCDay());
  if (day.any && weekday.any) return true;
  if (day.any) return byWeekday;
  if (weekday.any) return byDay;
  return byDay || byWeekday;
}
