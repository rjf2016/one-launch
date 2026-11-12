$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class PerfProbe {
  [StructLayout(LayoutKind.Sequential)]
  struct MemCounters {
    public uint cb;
    public uint PageFaultCount;
    public UIntPtr PeakWorkingSetSize;
    public UIntPtr WorkingSetSize;
    public UIntPtr QuotaPeakPagedPoolUsage;
    public UIntPtr QuotaPagedPoolUsage;
    public UIntPtr QuotaPeakNonPagedPoolUsage;
    public UIntPtr QuotaNonPagedPoolUsage;
    public UIntPtr PagefileUsage;
    public UIntPtr PeakPagefileUsage;
    public UIntPtr PrivateUsage;
    public UIntPtr PrivateWorkingSetSize;
    public ulong SharedCommitUsage;
  }

  delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);

  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("psapi.dll", SetLastError = true)] static extern bool GetProcessMemoryInfo(IntPtr process, ref MemCounters counters, uint cb);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
  [DllImport("user32.dll", SetLastError = true)] static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);

  const uint QUERY_LIMITED = 0x1000;
  const uint STILL_ACTIVE = 259;
  const uint GW_OWNER = 4;
  const uint WM_CLOSE = 0x0010;

  static string Num(ulong v) { return v.ToString(System.Globalization.CultureInfo.InvariantCulture); }

  static string One(uint pid) {
    IntPtr h = OpenProcess(QUERY_LIMITED, false, pid);
    if (h == IntPtr.Zero) return "{\"pid\":" + pid + ",\"error\":\"open " + Marshal.GetLastWin32Error() + "\"}";
    try {
      uint code;
      if (!GetExitCodeProcess(h, out code) || code != STILL_ACTIVE) return "{\"pid\":" + pid + ",\"error\":\"exited\"}";
      long creation, exit, kernel, user;
      if (!GetProcessTimes(h, out creation, out exit, out kernel, out user)) return "{\"pid\":" + pid + ",\"error\":\"times " + Marshal.GetLastWin32Error() + "\"}";
      MemCounters c = new MemCounters();
      c.cb = (uint)Marshal.SizeOf(typeof(MemCounters));
      bool ex2 = GetProcessMemoryInfo(h, ref c, c.cb);
      if (!ex2) {
        c = new MemCounters();
        c.cb = (uint)(Marshal.SizeOf(typeof(MemCounters)) - IntPtr.Size - 8);
        if (!GetProcessMemoryInfo(h, ref c, c.cb)) return "{\"pid\":" + pid + ",\"error\":\"memory " + Marshal.GetLastWin32Error() + "\"}";
      }
      StringBuilder s = new StringBuilder();
      s.Append("{\"pid\":").Append(pid);
      s.Append(",\"creationFileTime\":\"").Append(Num((ulong)creation)).Append("\"");
      s.Append(",\"kernel100ns\":").Append(Num((ulong)kernel));
      s.Append(",\"user100ns\":").Append(Num((ulong)user));
      s.Append(",\"workingSet\":").Append(Num(c.WorkingSetSize.ToUInt64()));
      s.Append(",\"peakWorkingSet\":").Append(Num(c.PeakWorkingSetSize.ToUInt64()));
      s.Append(",\"privateBytes\":").Append(Num(c.PrivateUsage.ToUInt64()));
      s.Append(",\"privateWorkingSet\":").Append(ex2 ? Num(c.PrivateWorkingSetSize.ToUInt64()) : "null");
      s.Append(",\"pageFaults\":").Append(c.PageFaultCount);
      s.Append("}");
      return s.ToString();
    } finally {
      CloseHandle(h);
    }
  }

  public static string Counters(string pids) {
    List<string> parts = new List<string>();
    foreach (string p in pids.Split(new char[] { ' ' }, StringSplitOptions.RemoveEmptyEntries)) parts.Add(One(uint.Parse(p)));
    return "{\"ok\":true,\"processes\":[" + string.Join(",", parts.ToArray()) + "]}";
  }

  public static string Close(uint pid) {
    List<IntPtr> windows = new List<IntPtr>();
    EnumWindows(delegate (IntPtr hwnd, IntPtr lParam) {
      uint owner;
      GetWindowThreadProcessId(hwnd, out owner);
      if (owner == pid && IsWindowVisible(hwnd) && GetWindow(hwnd, GW_OWNER) == IntPtr.Zero) windows.Add(hwnd);
      return true;
    }, IntPtr.Zero);
    int posted = 0;
    foreach (IntPtr hwnd in windows) if (PostMessage(hwnd, WM_CLOSE, IntPtr.Zero, IntPtr.Zero)) posted++;
    return "{\"ok\":true,\"posted\":" + posted + "}";
  }
}
'@

[Console]::Out.WriteLine('{"ok":true,"ready":true}')
[Console]::Out.Flush()
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $parts = $line.Trim() -split ' ', 2
  try {
    switch ($parts[0]) {
      'counters' { $reply = [PerfProbe]::Counters($parts[1]) }
      'close' { $reply = [PerfProbe]::Close([uint32]$parts[1]) }
      default { $reply = '{"ok":false,"error":"unknown command"}' }
    }
  } catch {
    $reply = '{"ok":false,"error":"' + ($_.Exception.Message -replace '[\\"]', ' ') + '"}'
  }
  [Console]::Out.WriteLine($reply)
  [Console]::Out.Flush()
}
