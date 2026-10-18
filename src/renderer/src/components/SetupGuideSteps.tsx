import { Check, FlaskConical, FolderSearch, Gamepad2, Images, KeyRound, Loader2, Repeat, ShieldCheck } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { LAUNCHER_DISPLAY_NAMES, LAUNCHER_EXE_NAMES, LAUNCHER_IDS, type LauncherId, type LauncherStatus, type RememberedAccount } from '@shared/models';
import { ipc, IpcError } from '../lib/ipc';
import { useCountUp } from '../lib/motion';
import { BrandMark } from './BrandMark';
import { Button } from './Button';
import { launcherDot } from './LauncherBadge';
import { FlowArt, PhaseDemo } from './SetupGuideArt';
import { StatusPill } from './StatusPill';

export const IMPORT_LAUNCHERS = ['steam', 'battlenet'] as const satisfies readonly LauncherId[];
export type ImportLauncher = (typeof IMPORT_LAUNCHERS)[number];

/** What one launcher remembers, while it is being read, once it is in, or when reading it failed. */
export interface RememberedList {
  loading: boolean;
  error: string | null;
  entries: RememberedAccount[];
}

/** One list per launcher that is installed and keeps one; a launcher that is not installed has no entry. */
export type Remembered = Partial<Record<ImportLauncher, RememberedList>>;

/** What identifies a remembered entry: the launcher's account id, or the login for launchers that record none. */
export function uidOf(entry: RememberedAccount): string {
  return entry.launcherUid || entry.login;
}

export function entryKey(launcher: ImportLauncher, entry: RememberedAccount): string {
  return `${launcher}:${uidOf(entry)}`;
}

export function errorMessage(err: unknown): string {
  if (err instanceof IpcError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

function Title({ children, lead }: { children: string; lead: string }) {
  return (
    <>
      <h2 id="setup-title" className="text-xl font-semibold tracking-tight text-text-strong">
        {children}
      </h2>
      <p className="mt-1.5 max-w-2xl text-sm text-muted">{lead}</p>
    </>
  );
}

// ---------------------------------------------------------------------------
// 1. Welcome
// ---------------------------------------------------------------------------

export function WelcomeStep() {
  return (
    <div className="flex min-h-full flex-col items-center justify-center text-center">
      <div className="guide-rise relative mb-5">
        <span aria-hidden className="absolute inset-0 -m-5 rounded-full bg-accent/25 blur-2xl" />
        <BrandMark className="relative size-16 text-accent" />
      </div>
      <h2 id="setup-title" className="guide-rise text-2xl font-semibold tracking-tight text-text-strong" style={{ animationDelay: '60ms' }}>
        Welcome to One Launch
      </h2>
      <p className="guide-rise mt-2 max-w-md text-sm text-muted" style={{ animationDelay: '120ms' }}>
        Launch any game, from any launcher, on any account.
      </p>
      <div className="guide-rise mt-7" style={{ animationDelay: '200ms' }}>
        <FlowArt />
      </div>
      <p className="guide-rise mt-6 inline-flex items-center gap-2 text-xs text-muted" style={{ animationDelay: '320ms' }}>
        <ShieldCheck className="size-3.5 shrink-0 text-success" />
        Everything stays on this PC. There is no account, no sync, no telemetry.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 2. Your launchers
// ---------------------------------------------------------------------------

function LauncherRow({ status, delay, onLocated }: { status: LauncherStatus; delay: number; onLocated: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const found = status.install !== null;

  async function locate(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const { install } = await ipc.invoke('launchers:locate', { launcher: status.launcher });
      if (install) onLocated();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="guide-rise flex items-center gap-3 px-4 py-2.5" style={{ animationDelay: `${delay}ms` }}>
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-2">
        <span className={`size-2.5 rounded-full ${launcherDot[status.launcher]}`} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-text-strong">{status.displayName}</div>
        <div className={`truncate text-xs ${status.install ? 'font-mono text-muted select-text' : 'text-faint'}`}>
          {status.install ? status.install.installDir : `Not found. If it is installed, point One Launch at ${LAUNCHER_EXE_NAMES[status.launcher]}.`}
        </div>
        {error ? (
          <p role="alert" className="mt-1 text-xs text-danger">
            {error}
          </p>
        ) : null}
      </div>
      {found ? (
        <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-success">
          <span className="guide-pop flex size-5 items-center justify-center rounded-full bg-success/15" style={{ animationDelay: `${delay + 160}ms` }}>
            <Check className="size-3" />
          </span>
          Found
        </span>
      ) : (
        <Button icon={busy ? <Loader2 className="animate-spin" /> : <FolderSearch />} disabled={busy} onClick={() => void locate()}>
          Locate…
        </Button>
      )}
    </li>
  );
}

function SkeletonRow() {
  return (
    <li className="flex items-center gap-3 px-4 py-2.5" aria-hidden>
      <span className="size-9 shrink-0 rounded-lg bg-surface-2" />
      <div className="flex-1">
        <div className="h-4 w-24 animate-pulse rounded bg-surface-3" />
        <div className="mt-1 h-3 w-56 animate-pulse rounded bg-surface-2" />
      </div>
    </li>
  );
}

function artworkLine(artworkOn: boolean): string {
  return artworkOn
    ? "Cover art is downloaded for you: One Launch looks your games up on Steam's store and image servers and, with an API key from Settings, on SteamGridDB. Only game names and store ids are sent, never anything about your accounts. Settings › Artwork turns this off."
    : "Cover art downloads are off. Settings › Artwork turns them on; One Launch then looks your games up on Steam's store and image servers, and only game names and store ids are sent, never anything about your accounts.";
}

function GamesLine({ games }: { games: number | null }) {
  const shown = useCountUp(games ?? 0);
  return (
    <p role="status" className="flex items-center gap-2 text-sm text-muted">
      <Gamepad2 className="size-4 shrink-0 text-accent" />
      {games === null ? (
        <>
          <span>Looking for installed games</span>
          <Loader2 className="size-3.5 animate-spin" />
        </>
      ) : (
        <span>
          <span className="font-semibold text-text-strong tabular-nums">{shown}</span> installed {games === 1 ? 'game' : 'games'} found
        </span>
      )}
    </p>
  );
}

interface LaunchersStepProps {
  /** Null while the check is still running. */
  launchers: LauncherStatus[] | null;
  error: string | null;
  /** Installed games counted so far; null until the first scan has finished. */
  games: number | null;
  artworkOn: boolean;
  onLocated: () => void;
}

export function LaunchersStep({ launchers, error, games, artworkOn, onLocated }: LaunchersStepProps) {
  const found = launchers?.filter((l) => l.install !== null).length ?? null;
  const lead =
    found === null
      ? 'One Launch is checking which launchers are installed on this PC.'
      : found === 0
        ? 'No launcher was found on this PC. Install one, or point One Launch at one that is installed somewhere unusual.'
        : `One Launch found ${found === 1 ? 'this launcher' : 'these launchers'} on this PC. Point it at any other that is installed somewhere unusual.`;
  return (
    <div className="flex min-h-full flex-col">
      <Title lead={lead}>Your launchers</Title>
      {error ? (
        <p role="alert" className="mt-5 text-sm text-danger">
          Could not check launchers: {error}
        </p>
      ) : (
        <ul className="mt-5 divide-y divide-border/60 rounded-xl border border-border bg-surface-2/40">
          {launchers
            ? launchers.map((l, i) => <LauncherRow key={l.launcher} status={l} delay={i * 70} onLocated={onLocated} />)
            : LAUNCHER_IDS.map((id) => <SkeletonRow key={id} />)}
        </ul>
      )}
      <div className="mt-4 flex flex-col gap-2">
        <GamesLine games={games} />
        <p className="flex items-start gap-2 text-xs leading-relaxed text-muted">
          <Images className="mt-0.5 size-4 shrink-0 text-accent" />
          <span>{artworkLine(artworkOn)}</span>
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 3. How Play works
// ---------------------------------------------------------------------------

function Point({ icon, title, delay, children }: { icon: ReactNode; title: string; delay: number; children: string }) {
  return (
    <li className="guide-rise flex items-start gap-3" style={{ animationDelay: `${delay}ms` }}>
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border border-accent/30 bg-accent-soft text-accent [&>svg]:size-4">
        {icon}
      </span>
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-text-strong">{title}</h3>
        <p className="mt-0.5 text-xs leading-relaxed text-muted">{children}</p>
      </div>
    </li>
  );
}

export function PlayStep({ previewMode }: { previewMode: boolean }) {
  return (
    <div className="grid min-h-full grid-cols-[minmax(0,1fr)_17rem] items-center gap-8">
      <div>
        <Title lead="Press Play on a game, pick the account to play it on, and One Launch does the rest.">Play switches accounts for you</Title>
        <ol className="mt-5 flex flex-col gap-4">
          <Point icon={<Repeat />} title="The launcher is switched for you" delay={80}>
            One Launch closes it, signs it in as the account you picked, starts it again and launches the game.
          </Point>
          <Point icon={<KeyRound />} title="Sign in once per account" delay={160}>
            The first time you play on an account you may have to sign in once, in the launcher's own window. One Launch waits for you and carries on.
          </Point>
          <Point icon={<ShieldCheck />} title="Backed up before every switch" delay={240}>
            The launcher's sign-in files are saved first and put back if anything fails. Settings › Backups can restore one by hand.
          </Point>
        </ol>
        {previewMode ? (
          <p className="guide-rise mt-5 flex items-start gap-2 text-xs text-muted" style={{ animationDelay: '320ms' }}>
            <FlaskConical className="mt-0.5 size-3.5 shrink-0 text-warning" />
            <span>Preview mode is on, so Play only shows what a switch would do and changes nothing. Settings › Advanced turns it off.</span>
          </p>
        ) : null}
      </div>
      <div className="guide-rise" style={{ animationDelay: '200ms' }}>
        <PhaseDemo />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 4. Your accounts
// ---------------------------------------------------------------------------

function RememberedRow({ entry, checked, imported, onToggle }: { entry: RememberedAccount; checked: boolean; imported: boolean; onToggle: () => void }) {
  const linked = entry.linkedAccountId !== null;
  const locked = linked || imported;
  return (
    <label
      className={`flex items-center gap-3 px-4 py-2 not-last:border-b not-last:border-border/60 ${locked ? 'cursor-default' : 'cursor-pointer hover:bg-surface-2/60'} ${
        linked ? 'opacity-60' : ''
      }`}
    >
      <input type="checkbox" className="size-4 accent-accent" checked={imported || checked} disabled={locked} onChange={onToggle} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-text-strong">{entry.personaName || entry.login}</span>
          {imported ? (
            <StatusPill tone="ok">
              <Check className="size-3" /> Imported
            </StatusPill>
          ) : linked ? (
            <StatusPill tone="info">Already in One Launch</StatusPill>
          ) : entry.mostRecent ? (
            <StatusPill tone="ok">Signed in</StatusPill>
          ) : null}
        </span>
        <span className="block truncate text-xs text-muted">{entry.login}</span>
      </span>
    </label>
  );
}

function RememberedSection({
  launcher,
  list,
  selected,
  importedKeys,
  onToggle,
}: {
  launcher: ImportLauncher;
  list: RememberedList;
  selected: ReadonlySet<string>;
  importedKeys: ReadonlySet<string>;
  onToggle: (key: string) => void;
}) {
  const name = LAUNCHER_DISPLAY_NAMES[launcher];
  const n = list.entries.length;
  return (
    <section className="guide-rise overflow-hidden rounded-xl border border-border bg-surface-2/40" aria-label={`${name} remembered accounts`}>
      <header className="flex items-center gap-2 border-b border-border/60 px-4 py-2">
        <span className={`size-2 rounded-full ${launcherDot[launcher]}`} />
        <span className="text-sm font-medium text-text-strong">{name}</span>
        <span className="text-xs text-muted">{list.loading ? 'reading…' : list.error ? '' : `remembers ${n} account${n === 1 ? '' : 's'}`}</span>
      </header>
      {list.error ? (
        <p className="px-4 py-3 text-xs text-danger">
          Could not read {name}'s remembered accounts: {list.error}
        </p>
      ) : list.loading ? (
        <div className="px-4 py-2.5" aria-hidden>
          <div className="h-4 w-40 animate-pulse rounded bg-surface-3" />
          <div className="mt-1 h-3 w-28 animate-pulse rounded bg-surface-2" />
        </div>
      ) : n === 0 ? (
        <p className="px-4 py-3 text-xs text-muted">{name} has not remembered any account on this PC yet.</p>
      ) : (
        list.entries.map((e) => {
          const key = entryKey(launcher, e);
          return <RememberedRow key={key} entry={e} checked={selected.has(key)} imported={importedKeys.has(key)} onToggle={() => onToggle(key)} />;
        })
      )}
    </section>
  );
}

/** The installed launchers that keep no account list, in one sentence pointing at Add by hand; empty when every installed launcher keeps one. */
function byHandOnlyText(launchers: LauncherStatus[]): string {
  const names = launchers
    .filter((l) => l.install !== null && !(IMPORT_LAUNCHERS as readonly LauncherId[]).includes(l.launcher))
    .map((l) => LAUNCHER_DISPLAY_NAMES[l.launcher]);
  if (names.length === 0) return '';
  if (names.length === 1) return `${names[0]} keeps no account list. Add it under Add by hand.`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} keep no account list. Add those under Add by hand.`;
}

function noImportText(launchers: LauncherStatus[]): string {
  if (launchers.every((l) => l.install === null))
    return 'No launcher was found on this PC, so there is nothing to import yet. Accounts can still be added by hand.';
  return byHandOnlyText(launchers);
}

interface AccountsStepProps {
  launchers: LauncherStatus[] | null;
  remembered: Remembered;
  selected: ReadonlySet<string>;
  importedKeys: ReadonlySet<string>;
  importing: boolean;
  byHand: LauncherId | null;
  onToggle: (key: string) => void;
  onImport: () => void;
  onByHand: (launcher: LauncherId | null) => void;
}

export function AccountsStep({ launchers, remembered, selected, importedKeys, importing, byHand, onToggle, onImport, onByHand }: AccountsStepProps) {
  const sections = IMPORT_LAUNCHERS.filter((l) => remembered[l] !== undefined);
  const lists = sections.map((l) => remembered[l]!);
  const loading = launchers === null || lists.some((l) => l.loading);
  const entries = lists.reduce((n, l) => n + l.entries.length, 0);
  const selectable = sections.reduce(
    (n, l) => n + remembered[l]!.entries.filter((e) => e.linkedAccountId === null && !importedKeys.has(entryKey(l, e))).length,
    0,
  );
  const count = selected.size;
  const byHandOnly = launchers === null ? '' : byHandOnlyText(launchers);
  const summary = loading
    ? 'Reading what your launchers remember…'
    : selectable === 0
      ? entries === 0
        ? 'Your launchers have not remembered any account on this PC yet.'
        : 'Everything here is in One Launch.'
      : `${count} of ${selectable} selected`;

  return (
    <div className="flex min-h-full flex-col">
      <Title lead="Import the ones your launchers already remember, or add them by hand. Passwords are optional and stay on this PC.">Add your accounts</Title>

      {launchers !== null && sections.length === 0 ? (
        <p className="mt-5 rounded-xl border border-border bg-surface-2/40 px-4 py-3 text-sm text-muted">{noImportText(launchers)}</p>
      ) : (
        <div className="mt-5 flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <p role="status" className="text-xs text-muted">
              {launchers === null ? 'Checking your launchers…' : summary}
            </p>
            <Button
              variant="primary"
              icon={importing ? <Loader2 className="animate-spin" /> : <Check />}
              disabled={importing || count === 0}
              onClick={onImport}
            >
              {importing ? 'Importing…' : count === 0 ? 'Import' : `Import ${count} account${count === 1 ? '' : 's'}`}
            </Button>
          </div>
          {sections.map((l) => (
            <RememberedSection key={l} launcher={l} list={remembered[l]!} selected={selected} importedKeys={importedKeys} onToggle={onToggle} />
          ))}
          {byHandOnly ? <p className="px-1 text-xs text-muted">{byHandOnly}</p> : null}
        </div>
      )}

      <section className="mt-6" aria-labelledby="setup-by-hand">
        <h3 id="setup-by-hand" className="text-xs font-medium tracking-wide text-muted uppercase">
          Add by hand
        </h3>
        <p className="mt-1 text-xs text-faint">Pick a launcher here and its account form opens when you finish.</p>
        <div className="mt-2.5 flex flex-wrap gap-2">
          {LAUNCHER_IDS.map((id) => {
            const on = byHand === id;
            return (
              <button
                key={id}
                type="button"
                aria-pressed={on}
                onClick={() => onByHand(on ? null : id)}
                className={`inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors duration-150 ${
                  on ? 'border-accent bg-accent-soft text-text-strong' : 'border-border bg-surface-2 text-text hover:border-border-strong hover:bg-surface-3'
                }`}
              >
                <span className={`size-2 rounded-full ${launcherDot[id]}`} />
                {LAUNCHER_DISPLAY_NAMES[id]}
                {on ? <Check className="size-3.5 text-accent" /> : null}
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 5. Ready
// ---------------------------------------------------------------------------

function Stat({ label, value, delay }: { label: string; value: number | null; delay: number }) {
  const shown = useCountUp(value ?? 0);
  return (
    <div className="guide-rise rounded-xl border border-border bg-surface-2/50 px-3 py-3" style={{ animationDelay: `${delay}ms` }}>
      <dt className="text-[11px] font-medium tracking-wide text-muted uppercase">{label}</dt>
      <dd className="mt-0.5 text-xl font-semibold text-text-strong tabular-nums">{value === null ? '…' : shown}</dd>
    </div>
  );
}

interface ReadyStepProps {
  launchersFound: number | null;
  games: number | null;
  accounts: number | null;
  byHand: LauncherId | null;
}

export function ReadyStep({ launchersFound, games, accounts, byHand }: ReadyStepProps) {
  const ready = (accounts ?? 0) > 0;
  const lead = ready
    ? 'Pick a game in the Library, pick the account to play it on, and press Play.'
    : byHand
      ? `Add your ${LAUNCHER_DISPLAY_NAMES[byHand]} account next. Then pick a game in the Library, pick the account, and press Play.`
      : 'Add an account from the Accounts page whenever you like. Then pick a game in the Library, pick the account, and press Play.';
  return (
    <div className="flex min-h-full flex-col items-center justify-center text-center">
      <span className="guide-pop mb-4 flex size-14 items-center justify-center rounded-full bg-success/15 text-success">
        <Check className="size-7" />
      </span>
      <h2 id="setup-title" className="guide-rise text-2xl font-semibold tracking-tight text-text-strong" style={{ animationDelay: '80ms' }}>
        {ready ? "You're all set" : 'Almost there'}
      </h2>
      <p className="guide-rise mt-2 max-w-md text-sm text-muted" style={{ animationDelay: '140ms' }}>
        {lead}
      </p>
      <dl className="mt-7 grid w-full max-w-md grid-cols-3 gap-3">
        <Stat label="Launchers found" value={launchersFound} delay={200} />
        <Stat label="Games found" value={games} delay={260} />
        <Stat label="Accounts" value={accounts} delay={320} />
      </dl>
    </div>
  );
}
