export const ORACLE_CLOCK = '2026-11-06T16:46:23.000Z';

const INSTALLED = Symbol.for('one-launch.oracle-clock');

export function installOracleClock() {
  const RealDate = globalThis.Date;
  if (RealDate[INSTALLED]) return;
  const offset = RealDate.parse(ORACLE_CLOCK) - RealDate.now();
  const now = () => RealDate.now() + offset;
  const OracleDate = function (...args) {
    if (!new.target) return new RealDate(now()).toString();
    return Reflect.construct(RealDate, args.length === 0 ? [now()] : args, new.target);
  };
  // The shared prototype keeps `instanceof Date` true for dates this constructor did not make, such as file times.
  OracleDate.prototype = RealDate.prototype;
  Object.defineProperties(OracleDate, { name: { value: 'Date' }, length: { value: 7 } });
  Object.assign(OracleDate, { now, parse: RealDate.parse, UTC: RealDate.UTC, [INSTALLED]: true });
  globalThis.Date = OracleDate;
}
