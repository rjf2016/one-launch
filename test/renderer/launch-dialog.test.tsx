// @vitest-environment jsdom
import './setup';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LaunchDialog } from '../../src/renderer/src/components/LaunchDialog';
import { LaunchHost } from '../../src/renderer/src/components/LaunchHost';
import { useUiStore } from '../../src/renderer/src/store/ui';
import { account, BridgeError, deferred, game, installBridge, job, jobStep, plan, preflight, resetUi, type Handlers } from './harness';
import type { LaunchPreflight } from '../../src/shared/models';

resetUi();

const MAIN = account({ id: 'acct-main', displayName: 'Main', login: 'user_1', lastUsedAt: '2026-09-10T10:00:00.000Z' });
const ALT = account({ id: 'acct-alt', displayName: 'Alt', login: 'user_2', lastUsedAt: '2026-09-17T10:00:00.000Z' });
const EPIC = account({ id: 'acct-epic', launcher: 'epic', displayName: 'Epic one', login: 'someone@example.com' });

function open(handlers: Handlers = {}, props: { initialAccountId?: string | null; game?: ReturnType<typeof game> | null } = {}) {
  const bridge = installBridge({ 'accounts:list': () => ({ accounts: [MAIN, ALT, EPIC] }), ...handlers });
  const onClose = vi.fn();
  const view = render(
    <LaunchDialog game={props.game === undefined ? game() : props.game} initialAccountId={props.initialAccountId ?? null} onClose={onClose} />,
  );
  return { bridge, onClose, user: userEvent.setup(), ...view };
}

/** The Play button once the accounts have loaded and one is selected. */
const playButton = (): Promise<HTMLElement> =>
  waitFor(() => {
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Play' });
    expect(button.disabled).toBe(false);
    return button;
  });
/** The screen reader's line. It repeats text that is also on screen, so the visible copy is looked up with `shown`. */
const status = (): string => screen.getByRole('status').textContent ?? '';
const shown = (text: string): Promise<HTMLElement> =>
  waitFor(() => {
    const found = screen.getAllByText(text).filter((el) => el.getAttribute('role') !== 'status');
    expect(found).toHaveLength(1);
    return found[0]!;
  });

describe('LaunchDialog: picking an account', () => {
  it('says so when the launcher wants to update the game first', async () => {
    const { unmount } = open({}, { game: game({ launcher: 'battlenet', name: 'Overwatch', needsUpdate: true }) });
    await shown('Battle.net wants to update Overwatch first. The switch still runs, but the game only starts once you update it in the Battle.net window.');
    unmount();
    const riot = open({}, { game: game({ launcher: 'riot', name: 'VALORANT', needsUpdate: true }) });
    await shown(
      'The Riot Client wants to update VALORANT first. The switch still runs, but the game only starts once you update it in the Riot Client window.',
    );
    riot.unmount();
    open({}, { game: game({ name: 'Rocket League', needsUpdate: true }) });
    await shown('Steam updates Rocket League before it starts, so the launch may take a while.');
    await playButton();
  });

  it("lists only the game's launcher's accounts and preselects the most recently used one", async () => {
    open();
    const rows = await screen.findAllByRole('button', { name: /user_/ });
    expect(rows.map((r) => within(r).getByText(/^user_/).textContent)).toEqual(['user_2', 'user_1']);
    expect(screen.queryByText('someone@example.com')).toBeNull();
    await waitFor(() => expect(screen.getByRole('button', { name: /user_2/ }).getAttribute('aria-pressed')).toBe('true'));
    expect(screen.getByText('Play as Alt')).toBeTruthy();
  });

  it('puts the focus on Play once an account is selected, so Enter plays instead of closing', async () => {
    open();
    const play = await playButton();
    await waitFor(() => expect(document.activeElement).toBe(play));
  });

  it('preselects the account it was opened for, and a plain switch says Switch instead of Play', async () => {
    open({}, { initialAccountId: 'acct-main', game: null });
    await waitFor(() => expect(screen.getByRole('button', { name: /user_1/ }).getAttribute('aria-pressed')).toBe('true'));
    expect(screen.getByRole('heading', { name: 'Switch account' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Switch' })).toBeTruthy();
    expect(screen.getByText('Switch Steam to Main')).toBeTruthy();
  });

  it('offers the import when the launcher has no account yet, and going there closes the dialog and remembers the game', async () => {
    const dota = game({ needsUpdate: true });
    const { user, onClose } = open({ 'accounts:list': () => ({ accounts: [EPIC] }) }, { game: dota });
    expect(await screen.findByText(/No Steam accounts yet\. Import the ones Steam remembers, or add one by hand on the Accounts page\./)).toBeTruthy();
    expect(screen.getByText('Add an account first')).toBeTruthy();
    expect(screen.queryByText(/updates Dota 2 before it starts/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Play' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Import Steam accounts' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(useUiStore.getState().view).toBe('accounts'));
    expect(useUiStore.getState().accountRoute).toEqual({ kind: 'list' });
    expect(useUiStore.getState().importIntent).toBe('steam');
    expect(useUiStore.getState().returnTo).toEqual(dota);
  });

  it('opens the new-account form straight away for a launcher with nothing to import, remembering the game', async () => {
    const rocket = game({ launcher: 'epic', name: 'Rocket League' });
    const { user, onClose } = open({ 'accounts:list': () => ({ accounts: [MAIN] }) }, { game: rocket });
    expect(await screen.findByText('No Epic Games accounts yet.')).toBeTruthy();
    expect(screen.queryByText(/Accounts page/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Add Epic Games account' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(useUiStore.getState().accountRoute).toEqual({ kind: 'new', launcher: 'epic' }));
    expect(useUiStore.getState().view).toBe('accounts');
    expect(useUiStore.getState().returnTo).toEqual(rocket);
  });

  it('forgets the game on the next navigation, so a later form never jumps back to a stale Play', async () => {
    const { user } = open({ 'accounts:list': () => ({ accounts: [MAIN] }) }, { game: game({ launcher: 'epic', name: 'Rocket League' }) });
    await user.click(await screen.findByRole('button', { name: 'Add Epic Games account' }));
    await waitFor(() => expect(useUiStore.getState().returnTo).not.toBeNull());
    useUiStore.getState().setView('settings');
    await waitFor(() => expect(useUiStore.getState().view).toBe('settings'));
    expect(useUiStore.getState().returnTo).toBeNull();
  });
});

describe('LaunchDialog: preview mode', () => {
  it('shows what a switch would do and starts nothing', async () => {
    const { bridge, user } = open({
      'launch:preflight': () => ({ preflight: preflight({ dryRun: true, plan: plan({ warnings: ['The saved session is 70 days old.'] }) }) }),
    });
    await user.click(await playButton());
    expect(await screen.findByText('Preview mode is on, so nothing happened. A real switch would do this:')).toBeTruthy();
    expect(
      within(screen.getAllByRole('list')[0]!)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['1.Close Steam', '2.Switch to Alt', '3.Start Steam', '4.Sign in', '5.Launch Dota 2']);
    expect(screen.getAllByText('The saved session is 70 days old.').length).toBeGreaterThan(0);
    expect(bridge.sent('launch:preflight')).toEqual([{ accountId: 'acct-alt', gameId: 'game-1' }]);
    expect(bridge.sent('launch:start')).toEqual([]);
  });

  it('calls the Riot Client by its name in the phases, not the company', async () => {
    const riot = account({ id: 'acct-riot', launcher: 'riot', displayName: 'Riot one', login: 'riot_1' });
    const { user } = open(
      { 'accounts:list': () => ({ accounts: [riot] }), 'launch:preflight': () => ({ preflight: preflight({ dryRun: true }) }) },
      { game: game({ launcher: 'riot', name: 'VALORANT' }) },
    );
    await user.click(await playButton());
    expect(await screen.findByText('Preview mode is on, so nothing happened. A real switch would do this:')).toBeTruthy();
    expect(
      within(screen.getAllByRole('list')[0]!)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['1.Close the Riot Client', '2.Switch to Riot one', '3.Start the Riot Client', '4.Sign in', '5.Launch VALORANT']);
  });

  it('"Turn preview off and play now" writes the setting, checks again, and starts the real switch', async () => {
    let dryRun = true;
    const { bridge, user } = open({
      'launch:preflight': () => ({ preflight: preflight({ dryRun }) }),
      'settings:set': (req) => {
        if (req.key === 'dryRun') dryRun = req.value !== 'false';
        return { ok: true };
      },
      'launch:start': () => ({ job: job() }),
    });
    await user.click(await playButton());
    await user.click(await screen.findByRole('button', { name: 'Turn preview off and play now' }));
    await waitFor(() => expect(bridge.sent('launch:start')).toEqual([{ accountId: 'acct-alt', gameId: 'game-1', confirmClose: false }]));
    expect(bridge.sent('settings:set')).toEqual([{ key: 'dryRun', value: 'false' }]);
    expect(bridge.sent('launch:preflight')).toHaveLength(2);
    expect(useUiStore.getState().settingsRevision).toBe(1);
    expect(await shown('Switch to Alt…')).toBeTruthy();
  });

  it('stays on an error when the setting cannot be saved, and still starts nothing', async () => {
    const { bridge, user } = open({
      'launch:preflight': () => ({ preflight: preflight({ dryRun: true }) }),
      'settings:set': () => {
        throw new BridgeError('INTERNAL', 'database is locked');
      },
    });
    await user.click(await playButton());
    await user.click(await screen.findByRole('button', { name: 'Turn preview off and play now' }));
    expect((await screen.findByRole('alert')).textContent).toBe('database is locked');
    expect(bridge.sent('launch:start')).toEqual([]);
  });
});

describe('LaunchDialog: confirmation and refusals', () => {
  it('asks before closing a running launcher and sends the confirmation with the start', async () => {
    const { bridge, user } = open({
      'launch:preflight': () => ({
        preflight: preflight({ launcherRunning: true, needsConfirmation: true, closeMessage: 'Steam is running Dota 2. Switching closes both.' }),
      }),
      'launch:start': () => ({ job: job() }),
    });
    await user.click(await playButton());
    expect(await screen.findByText('Steam is running Dota 2. Switching closes both.')).toBeTruthy();
    expect(bridge.sent('launch:start')).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Close Steam and continue' }));
    await waitFor(() => expect(bridge.sent('launch:start')).toEqual([{ accountId: 'acct-alt', gameId: 'game-1', confirmClose: true }]));
  });

  it('shows plan warnings behind Continue without claiming a confirmation', async () => {
    const { bridge, user } = open({
      'launch:preflight': () => ({ preflight: preflight({ plan: plan({ warnings: ['No password is stored; Steam may ask you to sign in.'] }) }) }),
      'launch:start': () => ({ job: job() }),
    });
    await user.click(await playButton());
    expect(within(await screen.findByRole('dialog')).getAllByText('No password is stored; Steam may ask you to sign in.').length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(bridge.sent('launch:start')).toEqual([{ accountId: 'acct-alt', gameId: 'game-1', confirmClose: false }]));
  });

  const NOTE = 'Steam is already set to sign in as user_2. The real switch would change nothing.';

  it('does not stop for a plan note: the switch starts at once', async () => {
    const { bridge, user } = open({
      'launch:preflight': () => ({ preflight: preflight({ plan: plan({ notes: [NOTE] }) }) }),
      'launch:start': () => ({ job: job() }),
    });
    await user.click(await playButton());
    await waitFor(() => expect(bridge.sent('launch:start')).toEqual([{ accountId: 'acct-alt', gameId: 'game-1', confirmClose: false }]));
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
  });

  it('preview mode still shows a plan note', async () => {
    const { bridge, user } = open({ 'launch:preflight': () => ({ preflight: preflight({ dryRun: true, plan: plan({ notes: [NOTE] }) }) }) });
    await user.click(await playButton());
    expect((await screen.findAllByText(NOTE)).length).toBeGreaterThan(0);
    expect(bridge.sent('launch:start')).toEqual([]);
  });

  it('goes straight to the switch when nothing needs asking, and Back from a confirmation returns to the picker', async () => {
    let answer: LaunchPreflight = preflight({ needsConfirmation: true, closeMessage: 'Steam is running. Switching closes it.' });
    const { bridge, user } = open({ 'launch:preflight': () => ({ preflight: answer }), 'launch:start': () => ({ job: job() }) });
    await user.click(await playButton());
    await user.click(await screen.findByRole('button', { name: 'Back' }));
    answer = preflight();
    await user.click(await playButton());
    await waitFor(() => expect(bridge.sent('launch:start')).toHaveLength(1));
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
  });

  it('shows why a switch cannot run and offers only the way back, not a start', async () => {
    const { bridge, user } = open({ 'launch:preflight': () => ({ preflight: preflight({ blocked: 'Steam is not installed on this PC.' }) }) });
    await user.click(await playButton());
    expect(await screen.findByText('Steam is not installed on this PC.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open Accounts' })).toBeNull();
    const back = screen.getByRole('button', { name: 'Back' });
    expect(document.activeElement).toBe(back);
    await user.click(back);
    await playButton();
    expect(bridge.sent('launch:start')).toEqual([]);
  });

  it('starts only once when Continue is pressed twice (A1)', async () => {
    const started = deferred<{ job: ReturnType<typeof job> }>();
    const { bridge } = open({
      'launch:preflight': () => ({ preflight: preflight({ plan: plan({ warnings: ['w'] }) }) }),
      'launch:start': () => started.promise,
    });
    fireEvent.click(await playButton());
    const go = await screen.findByRole('button', { name: 'Continue' });
    // Two clicks before React has re-rendered the button as disabled: only the ref guard stands between them.
    act(() => {
      go.click();
      go.click();
    });
    expect(bridge.sent('launch:start')).toHaveLength(1);
    await act(async () => started.resolve({ job: job() }));
  });

  it('says so when another switch is already running (BUSY), with a way back', async () => {
    const { user } = open({
      'launch:preflight': () => ({ preflight: preflight() }),
      'launch:start': () => {
        throw new BridgeError('BUSY', 'Another switch is still running. Wait for it to finish.');
      },
    });
    await user.click(await playButton());
    expect((await screen.findByRole('alert')).textContent).toBe('Another switch is still running. Wait for it to finish.');
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(await playButton()).toBeTruthy();
  });

  it('turns CONFIRM_REQUIRED from the start into the confirmation instead of a dead end (B9)', async () => {
    let running = false;
    const { bridge, user } = open({
      'launch:preflight': () => ({
        preflight: running
          ? preflight({ launcherRunning: true, needsConfirmation: true, closeMessage: 'Steam is running. Switching closes it.' })
          : preflight(),
      }),
      'launch:start': (req) => {
        if (!req.confirmClose) {
          running = true;
          throw new BridgeError('CONFIRM_REQUIRED', 'Steam is running. Switching closes it.');
        }
        return { job: job() };
      },
    });
    await user.click(await playButton());
    await user.click(await screen.findByRole('button', { name: 'Close Steam and continue' }));
    await waitFor(() => expect(bridge.sent('launch:start').map((r) => r.confirmClose)).toEqual([false, true]));
  });

  it('reports a failed preflight as an error', async () => {
    const { user } = open({
      'launch:preflight': () => {
        throw new BridgeError('LAUNCHER_FILE', 'Steam: loginusers.vdf could not be read');
      },
    });
    await user.click(await playButton());
    expect((await screen.findByRole('alert')).textContent).toBe('Steam: loginusers.vdf could not be read');
  });
});

describe('LaunchDialog: Escape and closing', () => {
  it('Escape closes the picker, but not while the launcher is being checked', async () => {
    const pending = deferred<{ preflight: LaunchPreflight }>();
    const { onClose } = open({ 'launch:preflight': () => pending.promise });
    const play = await playButton();
    fireEvent.click(play);
    expect(await screen.findByRole('button', { name: 'Checking…' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => pending.resolve({ preflight: preflight({ dryRun: true }) }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('never starts a switch for a dialog that went away during the check (A6)', async () => {
    const pending = deferred<{ preflight: LaunchPreflight }>();
    const { bridge, unmount } = open({ 'launch:preflight': () => pending.promise, 'launch:start': () => ({ job: job() }) });
    fireEvent.click(await playButton());
    await screen.findByRole('button', { name: 'Checking…' });
    unmount();
    await act(async () => pending.resolve({ preflight: preflight() }));
    expect(bridge.sent('launch:start')).toEqual([]);
  });

  it('a running switch can only be hidden: Escape and the backdrop do nothing, Hide keeps the job', async () => {
    const { user, onClose, container } = open({ 'launch:preflight': () => ({ preflight: preflight() }), 'launch:start': () => ({ job: job() }) });
    await user.click(await playButton());
    await screen.findByRole('button', { name: 'Hide' });
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(container.querySelector('[role="presentation"]')!);
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Hide' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().activeLaunch?.job.id).toBe('job-1');
  });
});

describe('LaunchDialog: progress and outcome', () => {
  const running = { 'launch:preflight': () => ({ preflight: preflight() }), 'launch:start': () => ({ job: job() }) } satisfies Handlers;

  it('shows the phases, follows the job in the store, and announces each phase once', async () => {
    const { user } = open(running);
    await user.click(await playButton());
    await screen.findByRole('button', { name: 'Hide' });
    expect(status()).toBe('Switch to Alt…');
    expect(screen.getByText('Take a snapshot')).toBeTruthy();
    expect(screen.queryByText('backup')).toBeNull();

    act(() =>
      useUiStore.getState().setActiveLaunch({
        game: game(),
        job: job({
          steps: [
            jobStep('close', 'done'),
            jobStep('backup', 'done'),
            jobStep('start', 'running', 'Start Steam'),
            jobStep('verify', 'pending'),
            jobStep('launch', 'pending'),
          ],
        }),
      }),
    );
    expect(status()).toBe('Start Steam…');
    await user.click(screen.getByRole('button', { name: 'Show details' }));
    expect(screen.getByText('backup')).toBeTruthy();
  });

  it('hands over to the user with copy buttons, and Stop waiting cancels the job', async () => {
    const attention = {
      kind: 'sign-in' as const,
      title: 'Steam is asking you to sign in as user_2',
      message: 'Sign in once.',
      steps: ['In the Steam window, enter the account name user_2 and your password.', 'Keep “Remember me” ticked.', 'Sign in.'],
      reason: 'Expired',
      canCopyPassword: true,
      until: new Date(Date.now() + 300_000).toISOString(),
    };
    const { bridge, user } = open({
      ...running,
      'launch:start': () => ({ job: job({ attention }) }),
      'accounts:copy': () => ({ clearAfterMs: 30_000, historyExcluded: true }),
      'launch:cancel': () => ({ job: job({ state: 'cancelled' }) }),
    });
    await user.click(await playButton());
    expect(await shown('Steam is asking you to sign in as user_2')).toBeTruthy();
    expect(status()).toBe('Steam is asking you to sign in as user_2');
    const steps = within(screen.getByRole('list', { name: 'What to do' })).getAllByRole('listitem');
    expect(steps.map((s) => s.textContent)).toEqual([
      'In the Steam window, enter the account name user_2 and your password.',
      'Keep “Remember me” ticked.',
      'Sign in.',
    ]);
    expect(steps[1]!.querySelector('strong')?.textContent).toBe('“Remember me”');
    await user.click(screen.getByRole('button', { name: 'Copy password' }));
    expect(await screen.findByText('Password copied · clipboard clears in 30s while One Launch is open')).toBeTruthy();
    expect(bridge.sent('accounts:copy')).toEqual([{ id: 'acct-alt', field: 'password' }]);
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Stop waiting' }));
    expect(bridge.sent('launch:cancel')).toEqual([{ jobId: 'job-1' }]);
  });

  it('Stop cancels a running switch at any step and stays disabled until the job ends', async () => {
    const { bridge, user } = open({ ...running, 'launch:cancel': () => ({ job: job() }) });
    await user.click(await playButton());
    await user.click(await screen.findByRole('button', { name: 'Stop' }));
    expect(bridge.sent('launch:cancel')).toEqual([{ jobId: 'job-1' }]);
    expect((screen.getByRole('button', { name: 'Stopping…' }) as HTMLButtonElement).disabled).toBe(true);
    act(() =>
      useUiStore.getState().setActiveLaunch({
        game: game(),
        job: job({ state: 'cancelled', error: 'Stopped before Steam was started as user_2. Nothing had been changed.', finishedAt: 'x' }),
      }),
    );
    expect(await shown('Stopped before Steam was started as user_2. Nothing had been changed.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Stopping…' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('says why a Stop did not go through and offers it again', async () => {
    const { user } = open({
      ...running,
      'launch:cancel': () => {
        throw new BridgeError('INTERNAL', 'the main process is not answering');
      },
    });
    await user.click(await playButton());
    await user.click(await screen.findByRole('button', { name: 'Stop' }));
    expect(await screen.findByText('the main process is not answering')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Stop' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('a finished launch says who it launched as, and Done clears the job and closes', async () => {
    const { user, onClose } = open(running);
    await user.click(await playButton());
    await screen.findByRole('button', { name: 'Hide' });
    act(() =>
      useUiStore.getState().setActiveLaunch({ game: game(), job: job({ state: 'done', switched: true, steps: [jobStep('launch', 'done')], finishedAt: 'x' }) }),
    );
    expect(await shown('Launched as Alt')).toBeTruthy();
    expect(status()).toBe('Launched as Alt');
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(useUiStore.getState().activeLaunch).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('says what is left for the user when the launcher only opened the game’s page', async () => {
    const { user, onClose } = open(running);
    await user.click(await playButton());
    await screen.findByRole('button', { name: 'Hide' });
    const handOff = "Press Play in the Riot Client window to start VALORANT; it is open on the game's page.";
    act(() =>
      useUiStore.getState().setActiveLaunch({
        game: game({ launcher: 'riot', name: 'VALORANT', launcherGameId: 'valorant.live' }),
        job: job({ launcher: 'riot', state: 'done', switched: true, handOff, steps: [jobStep('launch', 'done')], finishedAt: 'x' }),
      }),
    );
    expect(await shown('Switched to Alt')).toBeTruthy();
    expect(await shown(handOff)).toBeTruthy();
    expect(screen.queryAllByText('Launched as Alt').filter((el) => el.getAttribute('role') !== 'status')).toEqual([]);
    expect(status()).toContain('Switched to Alt');
    expect(status()).toContain(handOff);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ restored: true }, 'Steam was put back the way it was and left closed. Start it to check which account it signs in as.'],
    [{ restored: false }, 'Steam could not be put back automatically. Open Settings › Backups and restore the latest snapshot.'],
    [{ restored: null, switched: true }, 'Steam is signed in as Alt; only the game launch failed. Press Play again to retry the launch.'],
    [{ restored: null, switched: false }, 'Nothing had been changed yet.'],
  ])('a failed switch says what state the launcher was left in: %o', async (over, sentence) => {
    const { user } = open(running);
    await user.click(await playButton());
    await screen.findByRole('button', { name: 'Hide' });
    act(() => useUiStore.getState().setActiveLaunch({ game: game(), job: job({ state: 'failed', error: 'Steam did not start.', finishedAt: 'x', ...over }) }));
    expect(await shown('Steam did not start.')).toBeTruthy();
    expect(screen.getByText(sentence)).toBeTruthy();
    expect(status()).toBe('Steam did not start.');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await playButton()).toBeTruthy();
    expect(useUiStore.getState().activeLaunch).toBeNull();
  });
});

describe('LaunchHost', () => {
  it('keeps polling a hidden job, shows it in the banner, and reopens the dialog on it (A7)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let current = job();
      const bridge = installBridge({ 'accounts:list': () => ({ accounts: [MAIN, ALT] }), 'launch:status': () => ({ job: current }) });
      useUiStore.getState().setActiveLaunch({ job: current, game: game() });
      render(<LaunchHost />);
      expect(screen.getByRole('status').textContent).toContain('Switching to Alt and launching Dota 2…');

      current = job({ state: 'done', switched: true, finishedAt: 'x' });
      await act(async () => vi.advanceTimersByTimeAsync(450));
      expect(bridge.sent('launch:status')).toEqual([{ jobId: 'job-1' }]);
      expect(screen.getByRole('status').textContent).toContain('Launched Dota 2 as Alt');

      fireEvent.click(screen.getByRole('button', { name: 'Show' }));
      expect(await shown('Launched as Alt')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('the banner says what is left for the user after a hand-over, never "Launched"', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const handOff = "Press Play in the Riot Client window to start VALORANT; it is open on the game's page.";
      let current = job({ launcher: 'riot' });
      installBridge({ 'accounts:list': () => ({ accounts: [MAIN, ALT] }), 'launch:status': () => ({ job: current }) });
      useUiStore.getState().setActiveLaunch({ job: current, game: game({ launcher: 'riot', name: 'VALORANT', launcherGameId: 'valorant.live' }) });
      render(<LaunchHost />);
      current = job({ launcher: 'riot', state: 'done', switched: true, handOff, finishedAt: 'x' });
      await act(async () => vi.advanceTimersByTimeAsync(450));
      const text = screen.getByRole('status').textContent ?? '';
      expect(text).toContain(`Switched to Alt. ${handOff}`);
      expect(text.includes('Launched')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('turns a status call that fails into a failed job instead of spinning forever', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      installBridge({
        'launch:status': () => {
          throw new BridgeError('NOT_FOUND', 'No such job');
        },
      });
      useUiStore.getState().setActiveLaunch({ job: job(), game: game() });
      render(<LaunchHost />);
      await act(async () => vi.advanceTimersByTimeAsync(450));
      expect(useUiStore.getState().activeLaunch?.job).toMatchObject({ state: 'failed', error: 'No such job' });
      expect(screen.getByRole('status').textContent).toContain('The switch to Alt failed');
    } finally {
      vi.useRealTimers();
    }
  });
});
