export const LOCALE = 'en-US';
export const TIME_ZONE = 'UTC';

process.env.TZ = TIME_ZONE;

const BaseRelative = Intl.RelativeTimeFormat;
class PinnedRelative extends BaseRelative {
  constructor(locales?: Intl.LocalesArgument, options?: Intl.RelativeTimeFormatOptions) {
    super(locales ?? LOCALE, options);
  }
}
Intl.RelativeTimeFormat = PinnedRelative as typeof Intl.RelativeTimeFormat;

const toLocaleString = Date.prototype.toLocaleString;
Date.prototype.toLocaleString = function (this: Date, locales?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions): string {
  return toLocaleString.call(this, locales ?? LOCALE, { timeZone: TIME_ZONE, ...options });
};

const localeCompare = String.prototype.localeCompare;
String.prototype.localeCompare = function (this: string, that: string, locales?: Intl.LocalesArgument, options?: Intl.CollatorOptions): number {
  return localeCompare.call(this, that, locales ?? LOCALE, options);
};

if (new Date(2026, 0, 1).getTimezoneOffset() !== 0) throw new Error(`TZ=${TIME_ZONE} did not take: local time is not UTC`);
if (new Intl.RelativeTimeFormat().resolvedOptions().locale !== LOCALE) throw new Error(`the relative-time locale is not ${LOCALE}`);

export const LOCALE_NOTE = `Locale and time zone are pinned by scripts/oracle/l1/core/renderer/locale.ts, loaded before the app module: process.env.TZ = '${TIME_ZONE}', and Intl.RelativeTimeFormat, Date.prototype.toLocaleString and String.prototype.localeCompare get '${LOCALE}' when the app passes undefined (toLocaleString also gets timeZone '${TIME_ZONE}'), as the UI captures run. Node's own ICU (Node ${process.versions.node}, ICU ${process.versions.icu}, CLDR ${process.versions.cldr}) produces the text.`;
