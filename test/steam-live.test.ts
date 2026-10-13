/**
 * Read-only check against the real Steam install on this PC. Skipped unless ONELAUNCH_LIVE=1:
 *
 *     $env:ONELAUNCH_LIVE = '1'; npx vitest run test/steam-live.test.ts
 *
 * Prints the health report, the installed games, the remembered accounts (names and IDs only),
 * and the dry-run switch plans for the two most recently used remembered accounts. It then proves
 * nothing was written: loginusers.vdf and the registry values are compared before and after.
 */

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SteamAdapter, STEAM_HKCU_KEY } from '../src/main/launchers/steam/adapter';
import type { AccountRef } from '../src/main/launchers/types';
import { WindowsProcessController } from '../src/main/platform/processes';
import { WindowsRegistry } from '../src/main/platform/registry';
import { BackupService } from '../src/main/services/backup';
import { createLogger } from '../src/main/services/logger';
import type { SwitchPlan } from '../src/shared/models';

const live = process.platform === 'win32' && process.env['ONELAUNCH_LIVE'] === '1';

function renderPlan(plan: SwitchPlan): string {
  const lines: string[] = [];
  lines.push(`Switch plan: ${plan.account.displayName} (${plan.account.login}, ${plan.account.launcherUid ?? 'no SteamID64'})`);
  lines.push(`  strategy: ${plan.strategy}   executable: ${plan.executable}`);
  lines.push(
    `  current:  most recent = ${plan.current.mostRecentLogin ?? '-'}, registry AutoLoginUser = ${plan.current.autoLoginUser ?? '-'}, running = ${plan.current.running}`,
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

describe.skipIf(!live)('Steam adapter against the real machine (read-only)', () => {
  it('detects, scans, lists remembered accounts, health-checks, and plans two switches without writing', async () => {
    const registry = new WindowsRegistry();
    const adapter = new SteamAdapter({
      registry,
      processes: new WindowsProcessController(),
      backups: new BackupService(join(process.env['APPDATA'] ?? '', 'OneLaunch', 'backups'), { keep: () => 20 }),
      log: createLogger('live:steam'),
      backupsToKeep: () => 20,
      openExternal: async () => {
        throw new Error('the live check never launches anything');
      },
    });

    const install = await adapter.detectInstall();
    expect(install).not.toBeNull();
    const loginUsersPath = adapter.loginUsersPath(install!);
    const before = {
      text: readFileSync(loginUsersPath, 'utf8'),
      mtime: statSync(loginUsersPath).mtimeMs,
      autoLoginUser: await registry.getString('HKCU', STEAM_HKCU_KEY, 'AutoLoginUser'),
      rememberPassword: await registry.getDword('HKCU', STEAM_HKCU_KEY, 'RememberPassword'),
    };

    const out: string[] = [];
    out.push(`Install: ${install!.installDir} (${install!.source}), exe ${install!.exePath}`);
    out.push(`Running: ${await adapter.isRunning()}`);
    const game = await adapter.runningGame();
    out.push(`Running game: ${game ? `${game.name} (${game.launcherGameId}, via ${game.source})` : 'none'}`);

    const health = await adapter.healthCheck();
    out.push(`Health: ${health.status}`);
    for (const c of health.checks) out.push(`  [${c.status}] ${c.label}: ${c.detail}`);

    const games = await adapter.listInstalledGames();
    const byLibrary = new Map<string, number>();
    for (const g of games) byLibrary.set(g.libraryPath, (byLibrary.get(g.libraryPath) ?? 0) + 1);
    out.push(`Installed games: ${games.length}`);
    for (const [lib, n] of byLibrary) out.push(`  ${lib}: ${n}`);
    for (const g of games) out.push(`  ${g.launcherGameId.padStart(8)}  ${g.name}${g.needsUpdate ? '  (update pending)' : ''}`);

    const remembered = await adapter.listRememberedAccounts();
    out.push(`Remembered accounts: ${remembered.length}`);
    for (const r of remembered) {
      out.push(
        `  ${r.login}  persona="${r.personaName}"  ${r.launcherUid}  remembered=${r.rememberPassword}  mostRecent=${r.mostRecent}  last=${r.lastLoginAt ?? '-'}`,
      );
    }

    const plans: SwitchPlan[] = [];
    for (const r of remembered.slice(0, 2)) {
      const ref: AccountRef = { id: null, displayName: r.personaName || r.login, login: r.login, launcherUid: r.launcherUid, hasSecret: false };
      const plan = await adapter.switchAccount(ref, { dryRun: true });
      plans.push(plan);
      out.push('');
      out.push(renderPlan(plan));
    }

    console.log(`\n${out.join('\n')}\n`);

    expect(health.status).not.toBe('fail');
    expect(games.length).toBeGreaterThan(0);
    expect(plans.length).toBeGreaterThan(0);

    // Nothing was written.
    expect(readFileSync(loginUsersPath, 'utf8')).toBe(before.text);
    expect(statSync(loginUsersPath).mtimeMs).toBe(before.mtime);
    expect(await registry.getString('HKCU', STEAM_HKCU_KEY, 'AutoLoginUser')).toBe(before.autoLoginUser);
    expect(await registry.getDword('HKCU', STEAM_HKCU_KEY, 'RememberPassword')).toBe(before.rememberPassword);
  }, 60_000);
});
