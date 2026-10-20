import type { ExecFileOptionsWithStringEncoding } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

/** node:child_process loads on the first process check, not at startup. */
async function execFileAsync(file: string, args: string[], options: ExecFileOptionsWithStringEncoding): Promise<{ stdout: string; stderr: string }> {
  const { execFile } = await import('node:child_process');
  return promisify(execFile)(file, args, options);
}

export interface ProcessInfo {
  name: string;
  pid: number;
  /** Where the executable really is (junctions, links and subst drives already followed), or null when Windows names no file for it. */
  path: string | null;
}

export interface ProcessLister {
  isRunning(imageName: string): Promise<boolean>;
  /** Whether any of these image names is running, from one listing: a watch that polls a game's every image name asks this. */
  anyRunning(imageNames: readonly string[]): Promise<boolean>;
  /** Every running image name, lower-case and without `.exe`, from one listing that opens no process. An empty list is an error, never "nothing runs". */
  runningNames(): Promise<Set<string>>;
  /** Every process with its executable path. Slower than isRunning; used for preflight only. */
  listProcesses(): Promise<ProcessInfo[]>;
}

/** Starting and stopping processes. Only the switch path uses these, after confirmation. */
export interface ProcessRunner {
  /** Start a detached process and return immediately. */
  start(exe: string, args: readonly string[], opts?: { cwd?: string }): Promise<void>;
  /** Ask every process with this image name to close (window close message); does not wait. */
  close(imageName: string): Promise<void>;
  /** Force-terminate every process with this image name; with `tree` (the default) its children too. */
  kill(imageName: string, opts?: { tree?: boolean }): Promise<void>;
}

export type ProcessController = ProcessLister & ProcessRunner;

// Single interior spaces only: the Riot Client's window process is `Riot Client.exe`. The name lands inside a single-quoted PowerShell string, so quotes and `$` stay refused.
const IMAGE_NAME = /^[A-Za-z0-9_.-]+(?: [A-Za-z0-9_.-]+)*$/;

/** Windows refused a close or a kill: in practice a launcher that runs as administrator while One Launch does not. */
export class ProcessAccessDeniedError extends Error {
  readonly code = 'PROCESS_ACCESS_DENIED';
  constructor(readonly imageName: string) {
    super(
      `Windows would not let One Launch close ${imageName}. It is most likely running as administrator: close it yourself, or start One Launch as administrator too, then try again.`,
    );
    this.name = 'ProcessAccessDeniedError';
  }
}

function system32(exe: string): string {
  const root = process.env['SystemRoot'] ?? process.env['windir'];
  return root ? join(root, 'System32', exe) : exe;
}

/** Names only, and no process is opened. tasklist lists through WMI, whose host then asks every process for memory-read access. */
export const LIST_PROCESS_NAMES_PS = String.raw`[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$ErrorActionPreference = 'Stop'
[System.Diagnostics.Process]::GetProcesses() | ForEach-Object { $_.ProcessName }`;

/** How LIST_PROCESS_NAMES_PS names a process: the image name without a final ".exe". */
export function processNameOf(imageName: string): string {
  return imageName.replace(/\.exe$/i, '').toLowerCase();
}

/** Parses the names LIST_PROCESS_NAMES_PS prints, one per line. */
export function parseProcessNames(stdout: string): Set<string> {
  const names = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const name = line.trim().toLowerCase();
    if (name) names.add(name);
  }
  return names;
}

/** Parses the JSON emitted by the PowerShell script in listProcesses(). Tolerates a single object. */
export function parseProcessJson(stdout: string): ProcessInfo[] {
  const text = stdout.trim();
  if (!text) return [];
  const raw: unknown = JSON.parse(text);
  const items = Array.isArray(raw) ? raw : [raw];
  const out: ProcessInfo[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const o = item as { Name?: unknown; Id?: unknown; Path?: unknown };
    if (typeof o.Name !== 'string' || typeof o.Id !== 'number') continue;
    out.push({ name: o.Name, pid: o.Id, path: typeof o.Path === 'string' && o.Path ? o.Path : null });
  }
  return out;
}

/**
 * Opens no process: the kernel's pid-to-image table names each file. Get-Process's Path and WMI's ExecutablePath ask every process for memory-read access, which anti-cheat drivers watch for.
 * Windows PowerShell writes a pipe in the OEM code page and turns what that page lacks into "?", so a non-ASCII install path needs the UTF-8 line.
 */
export const LIST_PROCESSES_PS = String.raw`[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class OneLaunchImagePaths
{
  [StructLayout(LayoutKind.Sequential)]
  struct UnicodeString { public ushort Length; public ushort MaximumLength; public IntPtr Buffer; }

  [StructLayout(LayoutKind.Sequential)]
  struct ProcessIdInformation { public IntPtr ProcessId; public UnicodeString ImageName; }

  [DllImport("ntdll.dll")]
  static extern int NtQuerySystemInformation(int infoClass, ref ProcessIdInformation info, int length, IntPtr returnLength);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  static extern int QueryDosDevice(string drive, StringBuilder device, int capacity);

  const int SystemProcessIdInformation = 88;
  const int StatusInfoLengthMismatch = unchecked((int)0xC0000004);
  const string Network = @"\Device\Mup\";

  static readonly List<KeyValuePair<string, string>> Volumes = LoadVolumes();

  static List<KeyValuePair<string, string>> LoadVolumes()
  {
    List<KeyValuePair<string, string>> volumes = new List<KeyValuePair<string, string>>();
    StringBuilder device = new StringBuilder(1024);
    foreach (string root in Environment.GetLogicalDrives())
    {
      string drive = root.Substring(0, 2);
      if (QueryDosDevice(drive, device, device.Capacity) != 0) volumes.Add(new KeyValuePair<string, string>(device.ToString() + @"\", drive + @"\"));
    }
    return volumes;
  }

  static string NativePath(int pid)
  {
    int size = 2048;
    for (int attempt = 0; attempt < 2; attempt++)
    {
      IntPtr buffer = Marshal.AllocHGlobal(size);
      try
      {
        ProcessIdInformation info = new ProcessIdInformation();
        info.ProcessId = (IntPtr)pid;
        info.ImageName.MaximumLength = (ushort)size;
        info.ImageName.Buffer = buffer;
        int status = NtQuerySystemInformation(SystemProcessIdInformation, ref info, Marshal.SizeOf(typeof(ProcessIdInformation)), IntPtr.Zero);
        if (status == 0) return Marshal.PtrToStringUni(buffer, info.ImageName.Length / 2);
        if (status != StatusInfoLengthMismatch) return null;
        size = info.ImageName.MaximumLength;
      }
      finally { Marshal.FreeHGlobal(buffer); }
    }
    return null;
  }

  public static string Of(int pid)
  {
    string native = NativePath(pid);
    if (String.IsNullOrEmpty(native)) return null;
    foreach (KeyValuePair<string, string> volume in Volumes)
    {
      if (native.StartsWith(volume.Key, StringComparison.OrdinalIgnoreCase)) return volume.Value + native.Substring(volume.Key.Length);
    }
    if (!native.StartsWith(Network, StringComparison.OrdinalIgnoreCase)) return null;
    string rest = native.Substring(Network.Length);
    while (rest.StartsWith(";", StringComparison.Ordinal))
    {
      int next = rest.IndexOf('\\');
      if (next < 0) return null;
      rest = rest.Substring(next + 1);
    }
    return @"\\" + rest;
  }
}
'@
if (-not [OneLaunchImagePaths]::Of($PID)) { throw 'Windows did not name the file of this very process.' }
[System.Diagnostics.Process]::GetProcesses() | ForEach-Object { [pscustomobject]@{ Name = $_.ProcessName; Id = $_.Id; Path = [OneLaunchImagePaths]::Of($_.Id) } } | ConvertTo-Json -Compress`;

/**
 * Close and kill by image name. taskkill finds its processes through WMI, so this reads the kernel's process table itself and opens only the processes it ends, for the right to end them.
 * Close posts WM_CLOSE to the topmost visible window without an owner, the one `taskkill /IM` picks. A process showing no window gets it on
 * every hidden top-level window without an owner: the one that quits the process can sit under a later-made one that ignores the message.
 */
export const CONTROL_PROCESSES_PS = String.raw`$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class OneLaunchProcessControl
{
  [StructLayout(LayoutKind.Sequential)]
  struct UnicodeString { public ushort Length; public ushort MaximumLength; public IntPtr Buffer; }

  [StructLayout(LayoutKind.Sequential)]
  struct SystemProcessInformation
  {
    public uint NextEntryOffset;
    public uint NumberOfThreads;
    public long WorkingSetPrivateSize;
    public uint HardFaultCount;
    public uint NumberOfThreadsHighWatermark;
    public ulong CycleTime;
    public long CreateTime;
    public long UserTime;
    public long KernelTime;
    public UnicodeString ImageName;
    public int BasePriority;
    public IntPtr ProcessId;
    public IntPtr ParentProcessId;
  }

  class Entry { public int Pid; public int Parent; public long Created; public string Name; }

  delegate bool WindowCallback(IntPtr window, IntPtr state);

  [DllImport("ntdll.dll")]
  static extern int NtQuerySystemInformation(int infoClass, IntPtr info, int length, out int needed);

  [DllImport("user32.dll")]
  static extern bool EnumWindows(WindowCallback callback, IntPtr state);

  [DllImport("user32.dll")]
  static extern uint GetWindowThreadProcessId(IntPtr window, out int processId);

  [DllImport("user32.dll")]
  static extern IntPtr GetWindow(IntPtr window, uint relation);

  [DllImport("user32.dll", EntryPoint = "GetWindowLongW")]
  static extern int GetWindowLong(IntPtr window, int index);

  [DllImport("user32.dll", EntryPoint = "PostMessageW", SetLastError = true)]
  static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(uint access, bool inherit, int processId);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool TerminateProcess(IntPtr process, uint exitCode);

  [DllImport("kernel32.dll")]
  static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr handle);

  [DllImport("kernel32.dll")]
  static extern int GetCurrentProcessId();

  const int ProcessInformationClass = 5;
  const int StatusInfoLengthMismatch = unchecked((int)0xC0000004);
  const uint GwOwner = 4;
  const int GwlStyle = -16;
  const int WsVisible = 0x10000000;
  const uint WmClose = 0x0010;
  const uint ProcessTerminate = 0x0001;
  const uint Synchronize = 0x00100000;
  const int AccessDenied = 5;

  static string Short(string name)
  {
    return name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? name.Substring(0, name.Length - 4) : name;
  }

  static bool Named(Entry entry, string image)
  {
    return String.Equals(Short(entry.Name), Short(image), StringComparison.OrdinalIgnoreCase);
  }

  static List<Entry> Snapshot()
  {
    int size = 1 << 20;
    for (int attempt = 0; attempt < 8; attempt++)
    {
      IntPtr buffer = Marshal.AllocHGlobal(size);
      try
      {
        int needed;
        int status = NtQuerySystemInformation(ProcessInformationClass, buffer, size, out needed);
        if (status == StatusInfoLengthMismatch) { size = Math.Max(size, needed) + (1 << 16); continue; }
        if (status != 0) break;
        List<Entry> entries = new List<Entry>();
        IntPtr at = buffer;
        while (true)
        {
          SystemProcessInformation info = (SystemProcessInformation)Marshal.PtrToStructure(at, typeof(SystemProcessInformation));
          Entry entry = new Entry();
          entry.Pid = (int)info.ProcessId.ToInt64();
          entry.Parent = (int)info.ParentProcessId.ToInt64();
          entry.Created = info.CreateTime;
          entry.Name = info.ImageName.Buffer == IntPtr.Zero ? "" : Marshal.PtrToStringUni(info.ImageName.Buffer, info.ImageName.Length / 2);
          entries.Add(entry);
          if (info.NextEntryOffset == 0) break;
          at = new IntPtr(at.ToInt64() + info.NextEntryOffset);
        }
        // A table read with the wrong layout must not pick the processes to end: .NET's own reading has to agree on this process.
        string own = System.Diagnostics.Process.GetCurrentProcess().ProcessName;
        foreach (Entry entry in entries)
        {
          if (entry.Pid == GetCurrentProcessId() && Named(entry, own)) return entries;
        }
        break;
      }
      finally { Marshal.FreeHGlobal(buffer); }
    }
    throw new InvalidOperationException("Windows did not list its processes.");
  }

  static Dictionary<int, Entry> Index(List<Entry> entries)
  {
    Dictionary<int, Entry> byPid = new Dictionary<int, Entry>();
    foreach (Entry entry in entries) byPid[entry.Pid] = entry;
    return byPid;
  }

  // Windows reuses process ids, so a parent id counts only when that process is older than the child.
  static Entry ParentOf(Entry child, Dictionary<int, Entry> byPid)
  {
    Entry parent;
    return byPid.TryGetValue(child.Parent, out parent) && parent.Pid != child.Pid && parent.Created <= child.Created ? parent : null;
  }

  static void Collect(Entry node, bool tree, List<Entry> all, Dictionary<int, Entry> byPid, List<int> spared, List<int> visited, List<Entry> targets)
  {
    if (visited.Contains(node.Pid)) return;
    visited.Add(node.Pid);
    if (tree)
    {
      foreach (Entry child in all)
      {
        if (ParentOf(child, byPid) == node && !spared.Contains(child.Pid)) Collect(child, tree, all, byPid, spared, visited, targets);
      }
    }
    targets.Add(node);
  }

  static string Report(int found, int signalled, int denied, int failed, int error)
  {
    return String.Format("{{\"found\":{0},\"signalled\":{1},\"denied\":{2},\"failed\":{3},\"error\":{4}}}", found, signalled, denied, failed, error);
  }

  public static string Close(string image)
  {
    List<IntPtr> windows = new List<IntPtr>();
    EnumWindows(delegate(IntPtr window, IntPtr state) { windows.Add(window); return true; }, IntPtr.Zero);
    int found = 0, signalled = 0, denied = 0;
    foreach (Entry entry in Snapshot())
    {
      if (!Named(entry, image)) continue;
      found++;
      List<IntPtr> targets = new List<IntPtr>();
      foreach (IntPtr window in windows)
      {
        int pid;
        GetWindowThreadProcessId(window, out pid);
        if (pid != entry.Pid || GetWindow(window, GwOwner) != IntPtr.Zero) continue;
        if ((GetWindowLong(window, GwlStyle) & WsVisible) != 0) { targets.Clear(); targets.Add(window); break; }
        targets.Add(window);
      }
      bool posted = false, refused = false;
      foreach (IntPtr window in targets)
      {
        if (PostMessage(window, WmClose, IntPtr.Zero, IntPtr.Zero)) posted = true;
        else if (Marshal.GetLastWin32Error() == AccessDenied) refused = true;
      }
      if (posted) signalled++;
      else if (refused) denied++;
    }
    return Report(found, signalled, denied, 0, 0);
  }

  public static string Kill(string image, bool tree)
  {
    List<Entry> all = Snapshot();
    Dictionary<int, Entry> byPid = Index(all);
    int self = GetCurrentProcessId();

    // One Launch may itself have been started by the launcher: the tree walk never enters this process or the ones it descends from.
    List<int> spared = new List<int>();
    Entry step;
    for (byPid.TryGetValue(self, out step); step != null && !spared.Contains(step.Pid); step = ParentOf(step, byPid)) spared.Add(step.Pid);

    List<Entry> targets = new List<Entry>();
    List<int> visited = new List<int>();
    int found = 0;
    foreach (Entry root in all)
    {
      if (!Named(root, image) || root.Pid == self) continue;
      found++;
      Collect(root, tree, all, byPid, spared, visited, targets);
    }

    IntPtr[] handles = new IntPtr[targets.Count];
    int[] codes = new int[targets.Count];
    for (int i = 0; i < targets.Count; i++)
    {
      handles[i] = OpenProcess(ProcessTerminate | Synchronize, false, targets[i].Pid);
      codes[i] = handles[i] == IntPtr.Zero ? Marshal.GetLastWin32Error() : 0;
    }

    // An open handle keeps its process id from being reused, so an id that a second listing still shows with the same start time is the process that was chosen.
    Dictionary<int, Entry> now = Index(Snapshot());
    int signalled = 0, denied = 0, failed = 0, error = 0;
    for (int i = 0; i < targets.Count; i++)
    {
      Entry target = targets[i];
      Entry current;
      int refusal = 0;
      if (now.TryGetValue(target.Pid, out current) && current.Created == target.Created)
      {
        if (handles[i] == IntPtr.Zero) refusal = codes[i];
        else if (TerminateProcess(handles[i], 1)) signalled++;
        else
        {
          refusal = Marshal.GetLastWin32Error();
          if (WaitForSingleObject(handles[i], 0) == 0) refusal = 0;
        }
      }
      if (handles[i] != IntPtr.Zero) CloseHandle(handles[i]);
      if (refusal == 0 || !Named(target, image)) continue;
      if (refusal == AccessDenied) denied++;
      else { failed++; error = refusal; }
    }
    return Report(found, signalled, denied, failed, error);
  }
}
'@
`;

/** `denied` and `failed` count only processes with the image name: a child that a tree kill could not end is not an error. `error` is the last Windows error code. */
export interface ProcessControlResult {
  found: number;
  signalled: number;
  denied: number;
  failed: number;
  error: number;
}

/** Anything but the one JSON line throws, so a close or a kill never passes for done on output nobody understood. */
export function parseProcessControlResult(stdout: string): ProcessControlResult {
  const raw: unknown = JSON.parse(stdout.trim());
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const count = (key: string): number => {
    const value = o[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new Error(`No ${key} count in the result`);
    return value;
  };
  return { found: count('found'), signalled: count('signalled'), denied: count('denied'), failed: count('failed'), error: count('error') };
}

// Never err.message: Node puts the whole command line in it, and here that is one of the scripts above.
function powershellFailure(err: unknown): string {
  const e = (typeof err === 'object' && err !== null ? err : {}) as { code?: unknown; killed?: unknown; stderr?: unknown };
  if (e.killed === true) return 'PowerShell timed out';
  const code = typeof e.code === 'number' ? `exit code ${e.code}` : typeof e.code === 'string' ? e.code : 'no exit code';
  const stderr = typeof e.stderr === 'string' ? e.stderr.replace(/\s+/g, ' ').trim() : '';
  return stderr ? `${code}: ${stderr.slice(0, 200)}` : code;
}

export type ProcessExec = (file: string, args: string[]) => Promise<{ stdout: string }>;
/** Resolves once the process exists; rejects when it could not be started (EACCES, ENOENT, a sharing violation). */
export type ProcessSpawn = (exe: string, args: readonly string[], opts: { cwd?: string }) => Promise<void>;

const defaultExec: ProcessExec = async (file, args) => {
  const { stdout } = await execFileAsync(file, args, { windowsHide: true, timeout: 15_000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' });
  return { stdout };
};

const defaultSpawn: ProcessSpawn = async (exe, args, opts) => {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd: opts.cwd, detached: true, stdio: 'ignore', windowsHide: false });
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
    child.once('error', (err) => reject(new Error(`Could not start ${exe}: ${err.message}`)));
  });
};

/**
 * Asks Windows for its process list rather than Steam's own HKCU\...\ActiveProcess\pid, which was observed stale
 * (non-zero with no steam.exe running) during the Phase 2 survey. Everything goes through Windows PowerShell and
 * nothing through WMI: tasklist and taskkill make the WMI host ask every running process for memory-read access.
 */
export class WindowsProcessController implements ProcessController {
  constructor(
    private readonly exec: ProcessExec = defaultExec,
    private readonly spawnFn: ProcessSpawn = defaultSpawn,
  ) {}

  private async powershell(script: string, action: string): Promise<string> {
    const ran = await this.exec(system32(join('WindowsPowerShell', 'v1.0', 'powershell.exe')), ['-NoProfile', '-NonInteractive', '-Command', script]).catch(
      (err: unknown) => {
        throw new Error(`Could not ${action} (${powershellFailure(err)})`);
      },
    );
    return ran.stdout;
  }

  private async control(call: string, action: string): Promise<ProcessControlResult> {
    const stdout = await this.powershell(`${CONTROL_PROCESSES_PS}[OneLaunchProcessControl]::${call}`, action);
    try {
      return parseProcessControlResult(stdout);
    } catch {
      throw new Error(`Could not ${action} (PowerShell printed no result)`);
    }
  }

  async isRunning(imageName: string): Promise<boolean> {
    return this.anyRunning([imageName]);
  }

  async anyRunning(imageNames: readonly string[]): Promise<boolean> {
    for (const imageName of imageNames) if (!IMAGE_NAME.test(imageName)) throw new Error('Refusing to query an unexpected image name');
    if (imageNames.length === 0 || process.platform !== 'win32') return false;
    const names = await this.runningNames();
    return imageNames.some((imageName) => names.has(processNameOf(imageName)));
  }

  async runningNames(): Promise<Set<string>> {
    if (process.platform !== 'win32') return new Set();
    const names = parseProcessNames(await this.powershell(LIST_PROCESS_NAMES_PS, 'list the running processes'));
    // An empty list would read as "the launcher is closed", and the switch would write its files under a running launcher.
    if (names.size === 0) throw new Error('Could not list the running processes (PowerShell printed no names)');
    return names;
  }

  async listProcesses(): Promise<ProcessInfo[]> {
    if (process.platform !== 'win32') return [];
    return parseProcessJson(await this.powershell(LIST_PROCESSES_PS, 'list the running processes'));
  }

  async start(exe: string, args: readonly string[], opts: { cwd?: string } = {}): Promise<void> {
    await this.spawnFn(exe, args, opts);
  }

  /** A process without a window gets nothing, and kill() follows. */
  async close(imageName: string): Promise<void> {
    if (!IMAGE_NAME.test(imageName)) throw new Error('Refusing to close an unexpected image name');
    if (process.platform !== 'win32') return;
    const result = await this.control(`Close('${imageName}')`, `close ${imageName}`);
    if (result.denied > 0) throw new ProcessAccessDeniedError(imageName);
  }

  async kill(imageName: string, opts: { tree?: boolean } = {}): Promise<void> {
    if (!IMAGE_NAME.test(imageName)) throw new Error('Refusing to kill an unexpected image name');
    if (process.platform !== 'win32') return;
    const result = await this.control(`Kill('${imageName}', $${opts.tree !== false})`, `end ${imageName}`);
    if (result.denied > 0) throw new ProcessAccessDeniedError(imageName);
    if (result.failed > 0) throw new Error(`Could not end ${imageName} (Windows error ${result.error})`);
  }
}

export interface StaticProcessEvent {
  kind: 'start' | 'close' | 'kill';
  exe: string;
  args: string[];
}

/**
 * Test double. `start(steam.exe -shutdown)` marks steam.exe as stopping after `shutdownPolls`
 * further isRunning() calls; `start(steam.exe)` marks it running; kill() stops it at once.
 */
export class StaticProcessController implements ProcessController {
  readonly events: StaticProcessEvent[] = [];
  processes: ProcessInfo[] = [];
  /** How many isRunning() polls a graceful shutdown takes. Set very high to simulate a hang. */
  shutdownPolls = 2;
  /** Set to true to make a started launcher never show up as running. */
  startFails = false;
  /** Test hook, called on every start() so a test can simulate what the launcher does (e.g. sign in). */
  onStart: ((exe: string, args: readonly string[]) => void) | null = null;
  private readonly running = new Set<string>();
  private pendingShutdown: { image: string; polls: number } | null = null;

  constructor(running: readonly string[] = []) {
    for (const r of running) this.running.add(r.toLowerCase());
  }

  setRunning(imageName: string, running: boolean): void {
    if (running) this.running.add(imageName.toLowerCase());
    else this.running.delete(imageName.toLowerCase());
  }

  async isRunning(imageName: string): Promise<boolean> {
    const image = imageName.toLowerCase();
    if (this.pendingShutdown && this.pendingShutdown.image === image) {
      if (--this.pendingShutdown.polls <= 0) {
        this.running.delete(image);
        this.pendingShutdown = null;
      }
    }
    return this.running.has(image);
  }

  async anyRunning(imageNames: readonly string[]): Promise<boolean> {
    for (const imageName of imageNames) if (await this.isRunning(imageName)) return true;
    return false;
  }

  /** Both views of the fake process list, as on a real machine: the running names and the table with paths. */
  async runningNames(): Promise<Set<string>> {
    const names = new Set<string>();
    for (const image of this.running) names.add(processNameOf(image));
    for (const p of this.processes) names.add(processNameOf(p.name));
    return names;
  }

  async listProcesses(): Promise<ProcessInfo[]> {
    return this.processes;
  }

  async start(exe: string, args: readonly string[]): Promise<void> {
    this.events.push({ kind: 'start', exe, args: [...args] });
    this.onStart?.(exe, args);
    const image = exe.replace(/^.*[\\/]/, '').toLowerCase();
    if (args.includes('-shutdown')) {
      this.pendingShutdown = { image, polls: this.shutdownPolls };
    } else if (!this.startFails) {
      this.running.add(image);
    }
  }

  /** Like `steam.exe -shutdown`: the process goes away after `shutdownPolls` polls. */
  async close(imageName: string): Promise<void> {
    this.events.push({ kind: 'close', exe: imageName, args: [] });
    this.onStart?.(imageName, ['<close>']);
    this.pendingShutdown = { image: imageName.toLowerCase(), polls: this.shutdownPolls };
  }

  async kill(imageName: string, opts: { tree?: boolean } = {}): Promise<void> {
    this.events.push({ kind: 'kill', exe: imageName, args: opts.tree === false ? [] : ['tree'] });
    this.running.delete(imageName.toLowerCase());
    this.pendingShutdown = null;
  }
}
