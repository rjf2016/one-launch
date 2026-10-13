/**
 * Riot's product metadata as the client keeps it under %ProgramData%\Riot Games (docs/adapters/riot.md).
 * Everything here parses text; the adapter decides what to read.
 */

export interface RiotProductInfo {
  name: string;
  /** Image names of the game's own processes. Matched by name only: a Riot game process is never opened or asked for its path. */
  gameImages: readonly string[];
}

/** Known product ids. League and Teamfight Tactics share one client, so a running League client counts for both. */
export const RIOT_PRODUCTS: Readonly<Record<string, RiotProductInfo>> = {
  valorant: { name: 'VALORANT', gameImages: ['VALORANT.exe', 'VALORANT-Win64-Shipping.exe'] },
  league_of_legends: {
    name: 'League of Legends',
    gameImages: ['LeagueClient.exe', 'LeagueClientUx.exe', 'LeagueClientUxRender.exe', 'League of Legends.exe'],
  },
  teamfighttactics: {
    name: 'Teamfight Tactics',
    gameImages: ['LeagueClient.exe', 'LeagueClientUx.exe', 'LeagueClientUxRender.exe', 'League of Legends.exe'],
  },
  bacon: { name: 'Legends of Runeterra', gameImages: ['LoR.exe'] },
  lion: { name: '2XKO', gameImages: ['2XKO.exe', '2XKO-Win64-Shipping.exe'] },
};

function imageKey(name: string): string {
  return name.replace(/\.exe$/i, '').toLowerCase();
}

/** The product one of these process names (with or without `.exe`) belongs to, or null. */
export function productWithRunningImage(processNames: Iterable<string>): string | null {
  const running = new Set<string>();
  for (const name of processNames) running.add(imageKey(name));
  for (const [product, info] of Object.entries(RIOT_PRODUCTS)) {
    if (info.gameImages.some((image) => running.has(imageKey(image)))) return product;
  }
  return null;
}

export interface RiotProductId {
  /** `<product>.<patchline>`, the metadata folder name and the id --launch-product / --launch-patchline are built from. */
  id: string;
  product: string;
  patchline: string;
}

const PRODUCT_FOLDER = /^([a-z0-9_]+)\.([a-z0-9_]+)$/i;

/** `valorant.live` → its parts; `Riot Client` and `league_of_legends.live.game_patch` are not products. */
export function parseProductId(folderName: string): RiotProductId | null {
  const m = PRODUCT_FOLDER.exec(folderName);
  return m ? { id: folderName, product: m[1]!.toLowerCase(), patchline: m[2]!.toLowerCase() } : null;
}

export function productDisplayName(product: string): string {
  return RIOT_PRODUCTS[product]?.name ?? product;
}

/** The image names the product's game runs as, or none for a product the table does not know. */
export function gameImagesOf(product: string): readonly string[] {
  return RIOT_PRODUCTS[product]?.gameImages ?? [];
}

/** The shortcut's arguments for a product: `--launch-product=<product> --launch-patchline=<patchline>`. */
export function launchArgs(id: RiotProductId): string[] {
  return [`--launch-product=${id.product}`, `--launch-patchline=${id.patchline}`];
}

export interface RiotProductSettings {
  installPath: string | null;
  installRoot: string | null;
  /** The product this one shares an install with (League and Teamfight Tactics name each other). */
  dependency: string | null;
}

const TOP_LEVEL_SCALAR = /^([A-Za-z0-9_.-]+):[ \t]*(.*?)[ \t]*$/;

function unquote(value: string): string | null {
  if (!value) return null;
  const quoted = /^"(.*)"$/.exec(value) ?? /^'(.*)'$/.exec(value);
  const text = quoted ? quoted[1]! : value;
  return text.length > 0 ? text : null;
}

/** The top-level scalars of `<product>.<patchline>.product_settings.yaml`. Nested blocks are skipped. */
export function parseProductSettings(text: string): RiotProductSettings {
  const values = new Map<string, string | null>();
  for (const raw of text.split(/\r?\n/)) {
    if (!raw || raw.startsWith(' ') || raw.startsWith('\t') || raw.startsWith('#') || raw.startsWith('-')) continue;
    const m = TOP_LEVEL_SCALAR.exec(raw);
    if (m) values.set(m[1]!, unquote(m[2]!));
  }
  return {
    installPath: values.get('product_install_full_path') ?? null,
    installRoot: values.get('product_install_root') ?? null,
    dependency: values.get('product_dependency') ?? null,
  };
}

export interface RiotInstalls {
  /** The client exe Riot's own games are associated with. */
  rcDefault: string | null;
  rcLive: string | null;
  /** Game folder → client exe. */
  associatedClients: Map<string, string>;
}

const EMPTY_INSTALLS: RiotInstalls = { rcDefault: null, rcLive: null, associatedClients: new Map() };

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/** `RiotClientInstalls.json`. Anything malformed reads as nothing known. */
export function parseInstalls(text: string): RiotInstalls {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return EMPTY_INSTALLS;
  }
  if (!parsed || typeof parsed !== 'object') return EMPTY_INSTALLS;
  const obj = parsed as Record<string, unknown>;
  const associatedClients = new Map<string, string>();
  const assoc = obj['associated_client'];
  if (assoc && typeof assoc === 'object') {
    for (const [folder, exe] of Object.entries(assoc as Record<string, unknown>)) {
      const value = stringOrNull(exe);
      if (value) associatedClients.set(folder, value);
    }
  }
  return { rcDefault: stringOrNull(obj['rc_default']), rcLive: stringOrNull(obj['rc_live']), associatedClients };
}

const TIMESTAMP_LINE = /^(\s*)([A-Za-z0-9_.-]+):[ \t]*"?(\d{9,13})"?[ \t]*$/;
const BLOCK_START = /^(\s*)last-session-timestamp:[ \t]*$/;

/**
 * `install.last-session-timestamp` from RiotClientSettings.yaml: product id → ISO time of the last session.
 * Values are Unix seconds (milliseconds are accepted). Reads only that block; the rest of the file is not looked at.
 */
export function parseLastSessionTimestamps(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const start = BLOCK_START.exec(lines[i]!);
    if (!start) continue;
    const indent = start[1]!.length;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]!;
      if (line.trim().length === 0) continue;
      const m = TIMESTAMP_LINE.exec(line);
      if (!m || m[1]!.length <= indent) break;
      const n = Number(m[3]);
      const ms = m[3]!.length >= 12 ? n : n * 1000;
      if (Number.isFinite(ms) && ms > 0) out.set(m[2]!.toLowerCase(), new Date(ms).toISOString());
    }
    break;
  }
  return out;
}
