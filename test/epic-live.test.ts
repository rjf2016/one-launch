/**
 * Read-only check against the real Epic Games Launcher install on this PC. Skipped unless
 * ONELAUNCH_LIVE=1:
 *
 *     $env:ONELAUNCH_LIVE = '1'; npx vitest run test/epic-live.test.ts --silent=false
 *
 * Prints the health report, the installed games, the accounts that have signed in here (ids and
 * counts only), the launcher's current session state (fingerprint only), and the dry-run switch
 * plans for a stored-snapshot account and for a brand-new one. It then proves nothing was written:
 * GameUserSettings.ini and the launcher log are compared before and after, and no snapshot exists.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EpicAdapter, type EpicAccountDirectory } from '../src/main/launchers/epic/adapter';
import type { AccountRef } from '../src/main/launchers/types';
import { WindowsProcessController } from '../src/main/platform/processes';
import { WindowsRegistry } from '../src/main/platform/registry';
import { migrate, openDatabase } from '../src/main/db';
import { BackupService } from '../src/main/services/backup';
import { createLogger } from '../src/main/services/logger';
import { LauncherSessionStore } from '../src/main/services/sessions';
import type { Vault } from '../src/main/services/vault';
import type { SwitchPlan, VaultStatus } from '../src/shared/models';

const live = process.platform === 'win32' && process.env['ONELAUNCH_LIVE'] === '1';

/** In-memory only: the live check never stores a session. */
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
    `Switch plan: ${plan.account.displayName} (${plan.account.login}, id ${plan.account.launcherUid ? `…${plan.account.launcherUid.slice(-6)}` : 'unknown'})`,
  );
  lines.push(`  strategy: ${plan.strategy}   executable: ${plan.executable}`);
  lines.push(`  current:  remembered session owner = ${plan.current.mostRecentLogin ?? '-'}, running = ${plan.current.running}`);
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

describe.skipIf(!live)('Epic adapter against the real machine (read-only)', () => {
  it('detects, scans, reads the session state, health-checks, and plans two switches without writing', async () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const sessions = new LauncherSessionStore(db, new NoVault());
    const none: EpicAccountDirectory = { byLauncherUid: () => null, byId: () => null, setLauncherUid: () => undefined };
    const adapter = new EpicAdapter({
      registry: new WindowsRegistry(),
      processes: new WindowsProcessController(),
      backups: new BackupService(join(process.env['APPDATA'] ?? '', 'OneLaunch', 'backups'), { keep: () => 20 }),
      sessions,
      accounts: none,
      log: createLogger('live:epic'),
      backupsToKeep: () => 20,
      openExternal: async () => {
        throw new Error('the live check never launches anything');
      },
      launchUriForm: () => 'catalog',
    });

    const install = await adapter.detectInstall();
    expect(install).not.toBeNull();
    const iniPath = adapter.settingsPath();
    const logPath = adapter.logPath();
    const snap = (p: string): { text: string | null; mtime: number | null } =>
      existsSync(p) ? { text: readFileSync(p, 'utf8'), mtime: statSync(p).mtimeMs } : { text: null, mtime: null };
    const before = { ini: snap(iniPath), log: snap(logPath), backups: adapter['deps'].backups.list('epic').length };

    const out: string[] = [];
    out.push(`Install: ${install!.installDir} (${install!.source}), exe ${install!.exePath}`);
    out.push(`Manifests: ${await adapter.manifestsDir()}`);
    out.push(`Running: ${await adapter.isRunning()}`);
    const game = await adapter.runningGame();
    out.push(`Running game: ${game ? `${game.name} (${game.launcherGameId}, via ${game.source})` : 'none'}`);

    const health = await adapter.healthCheck();
    out.push(`Health: ${health.status}`);
    for (const c of health.checks) out.push(`  [${c.status}] ${c.label}: ${c.detail}`);

    const games = await adapter.listInstalledGames();
    out.push(`Installed games: ${games.length}`);
    for (const g of games) out.push(`  ${g.launcherGameId.padEnd(12)}  ${g.name}  (${g.installPath})`);

    const remembered = await adapter.listRememberedAccounts();
    out.push(`Accounts that have signed in here: ${remembered.length}`);
    for (const r of remembered) out.push(`  id …${r.launcherUid.slice(-6)}  remembered=${r.rememberPassword}  linked=${r.login || '-'}`);

    const state = await adapter.sessionState();
    out.push(
      `Session state: remembered=${state.remembered} fingerprint=${state.fingerprint?.slice(0, 8) ?? '-'} id=${state.launcherUid ? `…${state.launcherUid.slice(-6)}` : '-'} running=${state.launcherRunning} lastSignIn=${state.lastSignIn ? (state.lastSignIn.ok ? 'ok' : `failed: ${state.lastSignIn.reason}`) : '-'}`,
    );

    const plans: SwitchPlan[] = [];
    const fresh: AccountRef = { id: null, displayName: 'Preview (new account)', login: 'someone@example.com', launcherUid: null, hasSecret: false };
    plans.push(await adapter.switchAccount(fresh, { dryRun: true }));
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
    expect(games.length).toBeGreaterThan(0);
    expect(plans.length).toBe(2);
    if (state.fingerprint) {
      const text = JSON.stringify({ health, games, remembered, state, plans });
      expect(text).not.toContain(before.ini.text!.match(/^Data=(.+)$/m)?.[1] ?? '\0');
    }

    // Nothing was written.
    expect(snap(iniPath)).toEqual(before.ini);
    expect(snap(logPath)).toEqual(before.log);
    expect(adapter['deps'].backups.list('epic').length).toBe(before.backups);
    expect(sessions.list('epic')).toEqual([]);
  }, 60_000);
});
