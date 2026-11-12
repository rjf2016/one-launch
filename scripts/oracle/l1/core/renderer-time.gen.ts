import { adversarial, vectorFile, type Case } from '../lib/index';
import '../../lib/clock.setup.mjs';
import { LOCALE_NOTE } from './renderer/locale';
import { ORACLE_CLOCK } from '../../lib/clock.mjs';
import { formatDateTime, formatRelative } from '../../../../src/renderer/src/lib/time';

const SOURCE = 'src/renderer/src/lib/time.ts';
const NOW = new Date(ORACLE_CLOCK);
const at = (seconds: number): string => new Date(NOW.getTime() + seconds * 1000).toISOString();
const DAY = 86_400;

const OFFSETS: [string, number, string][] = [
  ['same-instant', 0, 'no difference'],
  ['future-30s', 30, 'half a minute ahead'],
  ['past-30s', -30, 'half a minute ago'],
  ['past-59s', -59, 'just under a minute'],
  ['future-59s', 59, 'just under a minute ahead'],
  ['past-60s', -60, 'exactly a minute'],
  ['future-60s', 60, 'exactly a minute ahead'],
  ['past-89s', -89, '1.48 minutes, rounds to 1'],
  ['past-3599s', -3599, 'one second under an hour: 59.98 minutes rounds to 60'],
  ['past-3600s', -3600, 'exactly an hour'],
  ['future-3600s', 3600, 'exactly an hour ahead'],
  ['past-86399s', -86399, 'one second under a day: 23.99 hours rounds to 24'],
  ['past-1d', -DAY, 'exactly a day: numeric auto says yesterday'],
  ['future-1d', DAY, 'exactly a day ahead: tomorrow'],
  ['past-2d', -2 * DAY, 'two days'],
  ['future-2d', 2 * DAY, 'two days ahead'],
  ['past-6d', -6 * DAY, 'six days'],
  ['past-7d', -7 * DAY, 'exactly a week: last week'],
  ['future-7d', 7 * DAY, 'exactly a week ahead: next week'],
  ['past-13d', -13 * DAY, '1.86 weeks, rounds to 2'],
  ['past-29d', -29 * DAY, '4.14 weeks'],
  ['past-30d', -30 * DAY, 'exactly a 30-day month: last month'],
  ['future-30d', 30 * DAY, 'a 30-day month ahead: next month'],
  ['past-364d', -364 * DAY, '12.13 thirty-day months'],
  ['past-365d', -365 * DAY, 'exactly a 365-day year: last year'],
  ['future-365d', 365 * DAY, 'a year ahead: next year'],
  ['past-730d', -730 * DAY, 'two years'],
  ['past-100y', -36_500 * DAY, 'a hundred 365-day years'],
];

const ROUNDING: [string, number, string][] = [
  ['past-59.4s', -59.4, 'Math.round(-59.4) is -59: just now'],
  ['past-59.5s', -59.5, 'Math.round(-59.5) is -59 (half rounds up, toward +infinity), so just now; Rust f64::round gives -60, a minute ago'],
  ['future-59.5s', 59.5, 'Math.round(59.5) is 60: in 1 minute'],
  ['past-90s', -90, 'Math.round(-1.5) is -1: 1 minute ago; half away from zero would say 2'],
  ['future-90s', 90, 'Math.round(1.5) is 2: in 2 minutes'],
  ['past-5400s', -5400, 'Math.round(-1.5) hours is -1: 1 hour ago'],
  ['future-5400s', 5400, 'Math.round(1.5) hours is 2: in 2 hours'],
  ['past-6.5d', -6.5 * DAY, 'Math.round(-6.5) days is -6: 6 days ago'],
  ['future-6.5d', 6.5 * DAY, 'Math.round(6.5) days is 7: in 7 days, not next week'],
  ['past-45d', -45 * DAY, 'Math.round(-1.5) months is -1: last month'],
  ['future-45d', 45 * DAY, 'Math.round(1.5) months is 2: in 2 months'],
  ['past-547.5d', -547.5 * DAY, 'Math.round(-1.5) years is -1: last year'],
];

const PARSE: [string, string, string][] = [
  ['empty', '', 'an empty string: Invalid Date, so the empty string'],
  ['garbage', 'not a date', 'free text: Invalid Date'],
  ['date-only', '2026-11-05', 'a date-only ISO form, which Date.parse reads as UTC midnight'],
  ['local-form', '2026-11-05T16:46:23', 'a date-time with no offset, which Date.parse reads as local time (UTC here)'],
  ['offset', '2026-11-06T22:16:23+05:30', 'an explicit +05:30 offset: the same instant as the clock'],
  ['lowercase-t-z', '2026-11-05t16:46:23z', 'lower-case t and z, which V8 accepts'],
  ['rfc-2822', 'Thu, 05 Nov 2026 16:46:23 GMT', 'an RFC 2822 date, read by the legacy parser'],
  ['us-slashes', '11/05/2026', 'a US-style date, read by the legacy parser as local midnight'],
  ['year-only', '2026', 'a bare year: UTC midnight on 1 January'],
  ['digits', '1700000000000', 'a millisecond count as text: not a timestamp to Date.parse'],
  ['leading-space', ' 2026-11-05T16:46:23Z', 'a leading space'],
  ['trailing-newline', '2026-11-05T16:46:23Z\n', 'a trailing newline'],
  ['feb-30', '2026-02-30T00:00:00Z', 'the 30th of February'],
  ['month-13', '2026-13-01T00:00:00Z', 'month 13'],
  ['hour-24', '2026-11-06T24:00:00Z', 'hour 24, which ISO allows as the end of the day'],
  ['leap-second', '2026-11-06T16:46:60Z', 'second 60'],
  ['max-date', '+275760-09-13T00:00:00.000Z', 'the last instant a Date can hold'],
  ['over-max-date', '+275760-09-13T00:00:00.001Z', 'one millisecond past it: Invalid Date'],
  ['min-date', '-271821-04-20T00:00:00.000Z', 'the first instant a Date can hold'],
  ['expanded-year-zero', '-000000-01-01T00:00:00Z', 'minus zero as an expanded year, which ECMAScript forbids'],
  ['ms-precision', '2026-11-06T16:46:23.9999999Z', 'more than three fractional digits'],
];

vectorFile({
  area: 'core',
  function: 'formatRelative',
  source: SOURCE,
  name: 'renderer.time.formatRelative',
  clock: true,
  note: [
    LOCALE_NOTE,
    "The relative-time formatter is built once, at module load, with numeric 'auto' (yesterday, last week).",
    `Every case passes now (arg1) as a Date except the two default-now cases, which leave it out so the function reads new Date(): the clock is on for those, and their iso is placed days or hours from ${ORACLE_CLOCK} so the seconds the oracle clock runs on cannot change the answer.`,
    'arg0 goes through new Date(iso), so the parse cases record V8 Date.parse leniency; a Rust port must accept and refuse exactly the same strings.',
    'gap: src/renderer/src/lib/time.ts:13:57 default parameter, not measured by V8; the two default-now cases run it.',
  ].join('\n'),
  call: formatRelative,
  cases: (): Case[] => [
    ...OFFSETS.map(([id, seconds, what]) => ({
      id,
      origin: adversarial('date', `formatRelative ${what}`),
      args: [at(seconds), NOW],
      expect: 'out' as const,
    })),
    ...ROUNDING.map(([id, seconds, what]) => ({
      id,
      origin: adversarial('number', `formatRelative ${what}`),
      args: [at(seconds), NOW],
      expect: 'out' as const,
    })),
    ...PARSE.map(([id, iso, what]) => ({
      id: `parse-${id}`,
      origin: adversarial('date', `formatRelative of ${what}`),
      args: [iso, NOW],
      expect: 'out' as const,
    })),
    {
      id: 'now-far-past-instant',
      origin: adversarial('date', 'now is the year 1970 and the iso the oracle clock: 56 years ahead'),
      args: [ORACLE_CLOCK, new Date('1970-01-01T00:00:00.000Z')],
      expect: 'out',
    },
    {
      id: 'default-now-past-3d',
      origin: adversarial('date', 'now left out: new Date() under the oracle clock, three days after the iso'),
      args: [at(-3 * DAY)],
      expect: 'out',
    },
    {
      id: 'default-now-future-2h',
      origin: adversarial('date', 'now left out: two hours before the iso'),
      args: [at(2 * 3600)],
      expect: 'out',
    },
  ],
});

const STAMPS: [string, string, string][] = [
  ['oracle-clock', ORACLE_CLOCK, 'an afternoon time'],
  ['midnight', '2026-01-01T00:00:00.000Z', 'midnight, 12:00 AM in en-US'],
  ['noon', '2026-07-04T12:00:00.000Z', 'noon, 12:00 PM'],
  ['seconds-dropped', '2026-07-04T12:30:59.999Z', 'timeStyle short drops the seconds: no rounding up'],
  ['offset', '2026-07-04T12:00:00+05:30', 'an offset, shown in UTC'],
  ['date-only', '2024-02-29', 'a leap day, date only'],
  ['feb-29-not-leap', '2026-02-29T00:00:00Z', 'the 29th of February in a common year'],
  ['two-digit-year', '0099-01-01T00:00:00.000Z', 'the year 99, which must not become 1999'],
  ['negative-year', '-000001-06-01T00:00:00.000Z', 'the year 2 BC (ISO year -1)'],
  ['max-date', '+275760-09-13T00:00:00.000Z', 'the last instant a Date can hold'],
  ['empty', '', 'an empty string: Invalid Date, so the empty string'],
  ['garbage', 'yesterday', 'free text'],
  ['local-form', '2026-11-06T16:46', 'no offset: local time, which is UTC here'],
];

vectorFile({
  area: 'core',
  function: 'formatDateTime',
  source: SOURCE,
  name: 'renderer.time.formatDateTime',
  note: [
    LOCALE_NOTE,
    "toLocaleString with dateStyle 'medium' and timeStyle 'short'. The out strings are ICU's exactly, separators included (this ICU puts a plain space before AM and PM, where some ICU versions put U+202F). Years before 1 are shown without an era: ISO year -1 prints as 2.",
  ].join('\n'),
  call: formatDateTime,
  cases: STAMPS.map(([id, iso, what]) => ({ id, origin: adversarial('date', `formatDateTime of ${what}`), args: [iso], expect: 'out' as const })),
});
