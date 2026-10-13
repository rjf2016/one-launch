/**
 * Read-only check against the real Battle.net install on this PC. Skipped unless ONELAUNCH_LIVE=1:
 *
 *     $env:ONELAUNCH_LIVE = '1'; npx vitest run test/battlenet-live.test.ts --reporter=verbose --silent=false
 *
 * Prints the health report, the installed products, the saved account names (masked), the current
 * session state (fingerprint only), and the dry-run switch plans for a brand-new account and for the
 * account the client is signed in as. It then proves nothing was written: Battle.net.config, the
 * per-account configs, the client log, and the UnifiedAuth registry values are compared before and
 * after, no backup snapshot exists, and no session was stored.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BattlenetAdapter } from '../src/main/launchers/battlenet/adapter';
import { maskLogin } from '../src/main/launchers/battlenet/config';
import { UNIFIED_AUTH_KEY } from '../src/main/launchers/battlenet/session';
import type { AccountDirectory, AccountRef } from '../src/main/launchers/types';
import { WindowsProcessController } from '../src/main/platform/processes';
import { WindowsRegistry } from '../src/main/platform/registry';
import { migrate, openDatabase } from '../src/main/db';
import { BackupService } from '../src/main/services/backup';
import { createLogger } from '../src/main/services/logger';
import { LauncherSessionStore } from '../src/main/services/sessions';
import type { Vault } from '../src/main/services/vault';
import type { SwitchPlan, VaultStatus } from '../src/shared/models';

const live = process.platform === 'win32' && process.env['ONELAUNCH_LIVE'] === '1';

/** In-memory only: the live check never stores a session or a snapshot. */
class NoVault implements Vault {
  readonly backend = 'dpapi' as const;
  isAvailable(): boolean {
    return false;
  }
  status(): VaultStatus {
    return { available: false, backend: 'none' };
  }
  encrypt(): Buffer {
    throw new Error('the live check never stores a session');
  }
  decrypt(): string {
    throw new Error('the live check never decrypts a session');
  }
}

function renderPlan(plan: SwitchPlan): string {
  const lines: string[] = [];
  lines.push(
    `Switch plan: ${plan.account.displayName} (${plan.account.login}, id ${plan.account.launcherUid ? `…${plan.account.launcherUid.slice(-4)}` : 'unknown'})`,
  );
  lines.push(`  strategy: ${plan.strategy}   executable: ${plan.executable}`);
  lines.push(
    `  current:  token owner = ${plan.current.mostRecentLogin ? maskLogin(plan.current.mostRecentLogin) : '-'}, first saved name = ${plan.current.autoLoginUser ? maskLogin(plan.current.autoLoginUser) : '-'}, running = ${plan.current.running}`,
  );
  plan.steps.forEach((s, i) => {
    lines.push(`  ${i + 1}. [${s.kind}] ${s.title}${s.skipped ? '  (skipped)' : ''}`);
    lines.push(`       target: ${s.target}`);
    lines.push(`       ${s.detail}`);
    for (const c of s.changes) lines.push(`       ${c.where}: ${c.before || '(none)'}  ->  ${c.after}`);
  });
  if (plan.warnings.length > 0) {
    lines.push('  warnings:');
    for (const w of plan.warnings) lines.push(`    - ${w}`);
  }
  return lines.join('\n');
}

describe.skipIf(!live)('Battle.net adapter against the real machine (read-only)', () => {
  it('detects, scans, reads the session state, health-checks, and plans two switches without writing', async () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const sessions = new LauncherSessionStore(db, new NoVault());
    const none: AccountDirectory = { byLauncherUid: () => null, byId: () => null, setLauncherUid: () => undefined };
    const registry = new WindowsRegistry();
    const backups = new BackupService(join(process.env['APPDATA'] ?? '', 'OneLaunch', 'backups'), { keep: () => 20 });
    const adapter = new BattlenetAdapter({
      registry,
      processes: new WindowsProcessController(),
      backups,
      sessions,
      accounts: none,
      vault: new NoVault(),
      log: createLogger('live:battlenet'),
      backupsToKeep: () => 20,
      openExternal: async () => {
        throw new Error('the live check never launches anything');
      },
      launchForm: () => 'uri',
    });

    const install = await adapter.detectInstall();
    expect(install).not.toBeNull();
    const configDir = adapter.configDir();
    const snap = (p: string): { text: string | null; mtime: number | null } =>
      existsSync(p) ? { text: readFileSync(p, 'utf8'), mtime: statSync(p).mtimeMs } : { text: null, mtime: null };
    const configFiles = existsSync(configDir) ? readdirSync(configDir).filter((n) => n.toLowerCase().endsWith('.config')) : [];
    const logDir = adapter.logDir();
    const logFiles = existsSync(logDir) ? readdirSync(logDir) : [];
    const before = {
      configs: configFiles.map((n) => snap(join(configDir, n))),
      logs: logFiles.map((n) => snap(join(logDir, n))),
      tokens: await registry.listValues('HKCU', UNIFIED_AUTH_KEY),
      backups: backups.list('battlenet').length,
    };

    const out: string[] = [];
    out.push(`Install: ${install!.installDir} (${install!.source}), exe ${install!.exePath}, starts ${adapter.startExe(install!)}`);
    out.push(`Running: ${await adapter.isRunning()}`);
    const game = await adapter.runningGame();
    out.push(`Running game: ${game ? `${game.name} (${game.launcherGameId}, via ${game.source})` : 'none'}`);

    const health = await adapter.healthCheck();
    out.push(`Health: ${health.status}`);
    for (const c of health.checks) out.push(`  [${c.status}] ${c.label}: ${c.detail}`);

    const games = await adapter.listInstalledGames();
    out.push(`Installed games: ${games.length}`);
    for (const g of games) out.push(`  ${g.launcherGameId.padEnd(12)}  ${g.name}  (${g.installPath})  last played ${g.lastPlayedAt ?? '-'}`);

    const remembered = await adapter.listRememberedAccounts();
    out.push(`Saved account names: ${remembered.length}`);
    for (const r of remembered) out.push(`  ${maskLogin(r.login)}  current=${r.mostRecent}`);

    const state = await adapter.sessionState();
    out.push(
      `Session state: remembered=${state.remembered} fingerprint=${state.fingerprint?.slice(0, 8) ?? '-'} id=${state.launcherUid ? `…${state.launcherUid.slice(-4)}` : '-'} running=${state.launcherRunning} lastSignIn=${state.lastSignIn ? (state.lastSignIn.ok ? 'ok' : `failed: ${state.lastSignIn.reason}`) : '-'}`,
    );

    const plans: SwitchPlan[] = [];
    const fresh: AccountRef = { id: null, displayName: 'Preview (new account)', login: 'someone@example.com', launcherUid: null, hasSecret: false };
    plans.push(await adapter.switchAccount(fresh, { dryRun: true }));
    // A placeholder login keeps the printed plan free of real saved account names.
    const known: AccountRef = {
      id: null,
      displayName: 'Preview (signed-in account)',
      login: 'current@example.com',
      launcherUid: state.launcherUid,
      hasSecret: false,
    };
    plans.push(await adapter.switchAccount(known, { dryRun: true }));
    for (const plan of plans) {
      out.push('');
      out.push(renderPlan(plan));
    }

    console.log(`\n${out.join('\n')}\n`);

    expect(health.status).not.toBe('fail');
    expect(games.some((g) => g.launcherGameId === 'prometheus')).toBe(true);
    expect(plans.length).toBe(2);
    const text = JSON.stringify({ health, games, remembered, state, plans });
    for (const t of before.tokens) expect(text.toLowerCase()).not.toContain(t.data.toLowerCase());

    // Nothing was written.
    expect(configFiles.map((n) => snap(join(configDir, n)))).toEqual(before.configs);
    expect(logFiles.map((n) => snap(join(logDir, n)))).toEqual(before.logs);
    expect(await registry.listValues('HKCU', UNIFIED_AUTH_KEY)).toEqual(before.tokens);
    expect(backups.list('battlenet').length).toBe(before.backups);
    expect(sessions.list('battlenet')).toEqual([]);
  }, 60_000);
});
