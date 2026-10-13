/**
 * Epic app names → Steam appids for games whose Steam store page is delisted, so Steam's search
 * cannot find them by name even though the CDN still serves their artwork. Games that are still
 * sold on Steam are matched by name at fetch time and do not belong here.
 */
export const EPIC_STEAM_APP_IDS: Readonly<Record<string, string>> = {
  Sugar: '252950', // Rocket League, delisted from the Steam store when it went free to play on Epic
};
