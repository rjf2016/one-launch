import { randomUUID } from 'node:crypto';
import { ACCOUNT_LIMITS, isLauncherId, normalizeTags, type Account, type AccountCreateInput, type AccountPatch, type LauncherId } from '@shared/models';
import type { Db } from '../db';
import { redactAccountNames } from './logger';
import type { Vault } from './vault';

export class AccountNotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  constructor(id: string) {
    super(`Account ${id} does not exist`);
    this.name = 'AccountNotFoundError';
  }
}

export class AccountValidationError extends Error {
  readonly code = 'BAD_REQUEST';
  constructor(message: string) {
    super(message);
    this.name = 'AccountValidationError';
  }
}

/**
 * Two accounts on one launcher with the same login or the same launcher id cannot both be right, and
 * the adapters attribute a launcher's session by exactly those fields.
 */
export class DuplicateAccountError extends Error {
  readonly code = 'DUPLICATE';
  constructor(
    readonly field: 'login' | 'launcherUid',
    readonly existing: Account,
  ) {
    super(
      field === 'login'
        ? `"${existing.displayName}" already uses this login on ${existing.launcher}. Edit that account instead, or change its login first.`
        : `"${existing.displayName}" is already linked to this ${existing.launcher} account id. Edit that account instead, or clear its id first.`,
    );
    this.name = 'DuplicateAccountError';
  }
}

interface AccountRow {
  id: string;
  launcher: string;
  display_name: string;
  login: string;
  has_secret: number;
  has_session: number;
  launcher_uid: string | null;
  tags: string;
  notes: string;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Columns every read selects. The ciphertext column is never part of this list. */
const PUBLIC_COLUMNS = `id, launcher, display_name, login,
       CASE WHEN secret_enc IS NULL THEN 0 ELSE 1 END AS has_secret,
       EXISTS (SELECT 1 FROM launcher_sessions s WHERE s.account_id = accounts.id) AS has_session,
       launcher_uid, tags, notes, last_used_at, created_at, updated_at`;

function parseTags(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

function toAccount(row: AccountRow): Account | null {
  if (!isLauncherId(row.launcher)) return null;
  redactAccountNames([row.login, row.display_name]);
  return {
    id: row.id,
    launcher: row.launcher,
    displayName: row.display_name,
    login: row.login,
    hasSecret: row.has_secret === 1,
    hasSession: row.has_session === 1,
    launcherUid: row.launcher_uid,
    tags: parseTags(row.tags),
    notes: row.notes,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Field validation. The IPC layer checks shapes; this is the business-rule layer.
// ---------------------------------------------------------------------------

function requireText(value: string, name: string, max: number): string {
  const v = value.trim();
  if (!v) throw new AccountValidationError(`${name} is required`);
  if (v.length > max) throw new AccountValidationError(`${name} must be at most ${max} characters`);
  return v;
}

function optionalUid(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const v = value.trim();
  if (!v) return null;
  if (v.length > ACCOUNT_LIMITS.launcherUid) {
    throw new AccountValidationError(`Launcher ID must be at most ${ACCOUNT_LIMITS.launcherUid} characters`);
  }
  return v;
}

function checkNotes(value: string): string {
  if (value.length > ACCOUNT_LIMITS.notes) {
    throw new AccountValidationError(`Notes must be at most ${ACCOUNT_LIMITS.notes} characters`);
  }
  return value;
}

function checkPassword(value: string): string {
  if (!value) throw new AccountValidationError('Password must not be empty');
  if (value.length > ACCOUNT_LIMITS.password) {
    throw new AccountValidationError(`Password must be at most ${ACCOUNT_LIMITS.password} characters`);
  }
  return value;
}

/**
 * Account CRUD. Passwords are encrypted through the vault on the way in and only ever decrypted
 * by decryptPassword(), whose callers (clipboard, launcher adapters) must use the plaintext
 * immediately and drop it. No method here returns ciphertext or logs a password.
 */
export class AccountsService {
  private readonly listStmt;
  private readonly listByLauncherStmt;
  private readonly getStmt;
  private readonly findByLoginStmt;
  private readonly findByUidStmt;
  private readonly insertStmt;
  private readonly updateStmt;
  private readonly deleteStmt;
  private readonly setSecretStmt;
  private readonly selectSecretStmt;
  private readonly touchStmt;

  constructor(
    db: Db,
    private readonly vault: Vault,
  ) {
    this.listStmt = db.prepare<[], AccountRow>(`SELECT ${PUBLIC_COLUMNS} FROM accounts ORDER BY launcher, display_name COLLATE NOCASE`);
    this.listByLauncherStmt = db.prepare<[string], AccountRow>(
      `SELECT ${PUBLIC_COLUMNS} FROM accounts WHERE launcher = ? ORDER BY display_name COLLATE NOCASE`,
    );
    this.getStmt = db.prepare<[string], AccountRow>(`SELECT ${PUBLIC_COLUMNS} FROM accounts WHERE id = ?`);
    this.findByLoginStmt = db.prepare<[string, string], AccountRow>(`SELECT ${PUBLIC_COLUMNS} FROM accounts WHERE launcher = ? AND login = ? COLLATE NOCASE`);
    this.findByUidStmt = db.prepare<[string, string], AccountRow>(
      `SELECT ${PUBLIC_COLUMNS} FROM accounts WHERE launcher = ? AND launcher_uid = ? COLLATE NOCASE`,
    );
    this.insertStmt = db.prepare<[string, string, string, string, Buffer | null, string | null, string, string, string, string]>(
      `INSERT INTO accounts (id, launcher, display_name, login, secret_enc, launcher_uid, tags, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.updateStmt = db.prepare<[string, string, string | null, string, string, string, string]>(
      `UPDATE accounts
          SET display_name = ?, login = ?, launcher_uid = ?, tags = ?, notes = ?, updated_at = ?
        WHERE id = ?`,
    );
    this.deleteStmt = db.prepare<[string]>('DELETE FROM accounts WHERE id = ?');
    this.setSecretStmt = db.prepare<[Buffer | null, string, string]>('UPDATE accounts SET secret_enc = ?, updated_at = ? WHERE id = ?');
    this.selectSecretStmt = db.prepare<[string], { secret_enc: Buffer | null }>('SELECT secret_enc FROM accounts WHERE id = ?');
    this.touchStmt = db.prepare<[string, string]>('UPDATE accounts SET last_used_at = ? WHERE id = ?');
  }

  // --- reads ---------------------------------------------------------------

  list(): Account[] {
    return this.listStmt
      .all()
      .map(toAccount)
      .filter((a): a is Account => a !== null);
  }

  listByLauncher(launcher: LauncherId): Account[] {
    return this.listByLauncherStmt
      .all(launcher)
      .map(toAccount)
      .filter((a): a is Account => a !== null);
  }

  get(id: string): Account | null {
    const row = this.getStmt.get(id);
    return row ? toAccount(row) : null;
  }

  /** Like get(), but throws a NOT_FOUND error the IPC layer forwards verbatim. */
  require(id: string): Account {
    const account = this.get(id);
    if (!account) throw new AccountNotFoundError(id);
    return account;
  }

  /** Case-insensitive match on login within one launcher. Used to reconcile imported accounts. */
  findByLogin(launcher: LauncherId, login: string): Account | null {
    const row = this.findByLoginStmt.get(launcher, login.trim());
    return row ? toAccount(row) : null;
  }

  findByLauncherUid(launcher: LauncherId, uid: string): Account | null {
    const row = this.findByUidStmt.get(launcher, uid);
    return row ? toAccount(row) : null;
  }

  // --- writes --------------------------------------------------------------

  create(input: AccountCreateInput): Account {
    if (!isLauncherId(input.launcher)) throw new AccountValidationError('Unknown launcher');
    const displayName = requireText(input.displayName, 'Display name', ACCOUNT_LIMITS.displayName);
    const login = requireText(input.login, 'Login', ACCOUNT_LIMITS.login);
    const launcherUid = optionalUid(input.launcherUid);
    const tags = normalizeTags(input.tags ?? []);
    const notes = checkNotes(input.notes ?? '');
    const password = input.password ? checkPassword(input.password) : null;
    this.checkUnique(input.launcher, login, launcherUid, null);
    // Encrypt before touching the database so a vault failure leaves no half-created row.
    const secretEnc = password === null ? null : this.vault.encrypt(password);

    const id = randomUUID();
    const now = new Date().toISOString();
    this.insertStmt.run(id, input.launcher, displayName, login, secretEnc, launcherUid, JSON.stringify(tags), notes, now, now);
    return this.require(id);
  }

  update(id: string, patch: AccountPatch): Account {
    const current = this.require(id);
    const displayName = patch.displayName === undefined ? current.displayName : requireText(patch.displayName, 'Display name', ACCOUNT_LIMITS.displayName);
    const login = patch.login === undefined ? current.login : requireText(patch.login, 'Login', ACCOUNT_LIMITS.login);
    const launcherUid = patch.launcherUid === undefined ? current.launcherUid : optionalUid(patch.launcherUid);
    const tags = patch.tags === undefined ? current.tags : normalizeTags(patch.tags);
    const notes = patch.notes === undefined ? current.notes : checkNotes(patch.notes);
    this.checkUnique(current.launcher, login, launcherUid, id);

    this.updateStmt.run(displayName, login, launcherUid, JSON.stringify(tags), notes, new Date().toISOString(), id);
    return this.require(id);
  }

  /** Case-insensitive uniqueness of login and launcher id within a launcher, ignoring the row being edited. */
  private checkUnique(launcher: LauncherId, login: string, launcherUid: string | null, selfId: string | null): void {
    const byLogin = this.findByLogin(launcher, login);
    if (byLogin && byLogin.id !== selfId) throw new DuplicateAccountError('login', byLogin);
    if (launcherUid) {
      const byUid = this.listByLauncher(launcher).find((a) => a.id !== selfId && a.launcherUid?.toLowerCase() === launcherUid.toLowerCase());
      if (byUid) throw new DuplicateAccountError('launcherUid', byUid);
    }
  }

  delete(id: string): void {
    const result = this.deleteStmt.run(id);
    if (result.changes === 0) throw new AccountNotFoundError(id);
  }

  /** Re-encrypts and overwrites the stored password. Never touches the launcher. */
  setPassword(id: string, password: string): Account {
    this.require(id);
    const enc = this.vault.encrypt(checkPassword(password));
    this.setSecretStmt.run(enc, new Date().toISOString(), id);
    return this.require(id);
  }

  clearPassword(id: string): Account {
    this.require(id);
    this.setSecretStmt.run(null, new Date().toISOString(), id);
    return this.require(id);
  }

  /**
   * Decrypts the stored password. Returns null when none is stored.
   * Callers must use the value immediately and must never log or persist it.
   */
  decryptPassword(id: string): string | null {
    const row = this.selectSecretStmt.get(id);
    if (!row) throw new AccountNotFoundError(id);
    if (!row.secret_enc) return null;
    return this.vault.decrypt(row.secret_enc);
  }

  touchLastUsed(id: string, at: Date = new Date()): void {
    this.touchStmt.run(at.toISOString(), id);
  }
}
