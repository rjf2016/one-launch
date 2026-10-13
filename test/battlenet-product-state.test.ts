import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseLogEvents } from '../src/main/launchers/battlenet/client-log';
import { gameRunning, gameStarted, productNeedsUpdate, productStates } from '../src/main/launchers/battlenet/product-state';

const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', 'battlenet', name), 'utf8');

describe('Battle.net product state and game start, from the client log', () => {
  it('reads each product install state and the --exec game start sequence (client 2.52.12, 2026-09-19)', () => {
    const events = parseLogEvents(fixture('battle.net-20260919T235113.602062.log'));
    const states = productStates(events);
    expect(states.get('prometheus')).toEqual({ operation: 'UpToDate', status: 'Paused', playable: true });
    expect(states.get('hs_beta')).toEqual({ operation: 'Update', status: 'New', playable: null });
    expect(productNeedsUpdate(states.get('prometheus'))).toBe(false);
    expect(productNeedsUpdate(states.get('hs_beta'))).toBe(true);
    expect(productNeedsUpdate(undefined)).toBe(false);

    const starts = events.filter((e) => e.kind === 'game-launching' || e.kind === 'game-running');
    expect(starts.map((e) => e.kind)).toEqual(['game-launching', 'game-launching', 'game-launching', 'game-running', 'game-running', 'game-running']);
    expect(starts.map((e) => ('codename' in e ? e.codename : null))).toEqual(Array<string>(6).fill('prometheus'));
    expect(gameStarted(events, 'prometheus', 'Pro')).toBe(true);
    expect(gameStarted(events, 'hs_beta', 'WTCG')).toBe(false);
    expect(events.some((e) => e.kind === 'launch-request')).toBe(false);
  });

  it('takes the refreshed state over the cached one, and sees no start when the client only selects the page (2026-09-24)', () => {
    const events = parseLogEvents(fixture('battle.net-20260924T220659.026162.log'));
    expect(productStates(events).get('prometheus')).toEqual({ operation: 'Update', status: 'New', playable: false });
    expect(productNeedsUpdate(productStates(events).get('prometheus'))).toBe(true);
    expect(gameStarted(events, 'prometheus', 'Pro')).toBe(false);
    // The client's own update (opType=Update agentUid=battle.net) is not a game start.
    expect(events.some((e) => e.kind === 'game-launching' || e.kind === 'game-running')).toBe(false);
  });

  it('still accepts the launch request line older builds logged, matched on the program code', () => {
    const events = parseLogEvents(
      'I 2026-09-13 03:22:00.000000 [GameLaunchController] {Main} Launch request Pro. isRunning=0 isLaunching=0 supportsMultibox=0',
    );
    expect(gameStarted(events, 'prometheus', 'Pro')).toBe(true);
    expect(gameStarted(events, 'hs_beta', 'WTCG')).toBe(false);
  });

  it('ignores the regional playable flags and a game exit', () => {
    const events = parseLogEvents(
      [
        'D 2026-09-24 22:07:03.000000 [ProductState] {Main} InstallState (wow): currentOperation=Repair currentOperationStatus=On installed=1 playable=0 regionalVersions=(us: {playable:true config_key:abc})',
        'D 2026-09-24 22:07:04.000000 [InstallInfo] {Main} Operation status changed: opType=Execute oldStatus=On newStatus=Off agentUid=wow',
      ].join('\n'),
    );
    expect(productStates(events).get('wow')).toEqual({ operation: 'Repair', status: 'On', playable: false });
    expect(productNeedsUpdate(productStates(events).get('wow'))).toBe(false);
    expect(gameStarted(events, 'wow', 'WoW')).toBe(false);
    expect(events.filter((e) => e.kind === 'game-exited')).toEqual([{ kind: 'game-exited', codename: 'wow' }]);
    expect(gameRunning(events, 'wow')).toBe(false);
  });

  it('knows a game is running from the last start or exit the client logged for it, whoever started it (2026-10-10)', () => {
    const running = parseLogEvents(
      [
        'D 2026-10-10 23:44:19.513560 [InstallInfo] {Main} Operation status changed: opType=Execute oldStatus=Off newStatus=On agentUid=prometheus',
        'D 2026-10-10 23:44:19.514172 [ProductState] {Main} InstallState (prometheus): gameRunning=1 isGameProcessRunning=1',
      ].join('\n'),
    );
    expect(gameRunning(running, 'prometheus')).toBe(true);
    expect(gameRunning(running, 'Prometheus')).toBe(true);
    expect(gameRunning(running, 'hs_beta')).toBe(false);
    expect(gameStarted(running, 'prometheus', 'Pro')).toBe(true);

    const exited = parseLogEvents(
      [
        'D 2026-10-10 23:44:19.514172 [ProductState] {Main} InstallState (prometheus): gameRunning=1 isGameProcessRunning=1',
        'D 2026-10-10 23:44:22.613138 [InstallInfo] {Main} Operation status changed: opType=Execute oldStatus=On newStatus=Off agentUid=prometheus',
        'D 2026-10-10 23:44:22.615643 [ProductState] {Main} InstallState (prometheus): gameRunning=0 isGameProcessRunning=0',
      ].join('\n'),
    );
    expect(exited.map((e) => e.kind)).toEqual(['game-running', 'game-exited', 'game-exited']);
    expect(gameRunning(exited, 'prometheus')).toBe(false);
    expect(gameRunning(parseLogEvents('D 2026-10-10 23:43:29.436396 [ProductState] {Main} InstallState (prometheus): GameLaunching=1'), 'prometheus')).toBe(
      true,
    );
    expect(gameRunning([], 'prometheus')).toBe(false);
  });
});
