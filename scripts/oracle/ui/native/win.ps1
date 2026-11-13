param(
  [Parameter(Mandatory = $true, Position = 0)][string]$Command,
  [Parameter(Mandatory = $true)][int]$ProcessId,
  [long]$Hwnd = 0,
  [string]$Class = '',
  [string]$Out = '',
  [string]$Path = '',
  [string]$Kinds = '',
  [int]$Id = 0,
  [int]$TimeoutMs = 15000
)

$ErrorActionPreference = 'Stop'

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;

public static class NativeWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }

  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr h);
  [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr h);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern IntPtr SendMessageTimeout(IntPtr h, uint msg, IntPtr w, string l, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);

  const uint PW_RENDERFULLCONTENT = 2;
  const uint WM_SETTEXT = 0x000C;
  const uint WM_CLOSE = 0x0010;
  const uint WM_COMMAND = 0x0111;
  const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
  const int FILE_NAME_COMBO = 0x047C;

  public static void PerMonitorAware() {
    SetThreadDpiAwarenessContext(new IntPtr(-4));
  }

  public static uint OwnerPid(IntPtr h) {
    uint pid;
    GetWindowThreadProcessId(h, out pid);
    return pid;
  }

  public static string Text(IntPtr h) {
    StringBuilder s = new StringBuilder(1024);
    GetWindowText(h, s, s.Capacity);
    return s.ToString();
  }

  public static string ClassOf(IntPtr h) {
    StringBuilder s = new StringBuilder(256);
    GetClassName(h, s, s.Capacity);
    return s.ToString();
  }

  public static int[] Rect(IntPtr h) {
    RECT r;
    GetWindowRect(h, out r);
    return new int[] { r.Left, r.Top, r.Right, r.Bottom };
  }

  public static int[] Frame(IntPtr h) {
    RECT r;
    if (DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, out r, Marshal.SizeOf(typeof(RECT))) != 0) return Rect(h);
    return new int[] { r.Left, r.Top, r.Right, r.Bottom };
  }

  public static long Owner(IntPtr h) {
    return GetWindow(h, 4).ToInt64();
  }

  public static List<IntPtr> TopLevel(uint pid) {
    List<IntPtr> found = new List<IntPtr>();
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      if (IsWindowVisible(h) && OwnerPid(h) == pid) found.Add(h);
      return true;
    }, IntPtr.Zero);
    return found;
  }

  public static void Require(IntPtr h, uint pid) {
    if (!IsWindow(h)) throw new Exception("no such window");
    if (OwnerPid(h) != pid) throw new Exception("the window belongs to another process");
  }

  public static int[] Capture(IntPtr h, string file) {
    int[] w = Rect(h);
    int[] f = Frame(h);
    int width = w[2] - w[0];
    int height = w[3] - w[1];
    using (Bitmap whole = new Bitmap(width, height, PixelFormat.Format32bppArgb)) {
      bool printed;
      using (Graphics g = Graphics.FromImage(whole)) {
        IntPtr dc = g.GetHdc();
        printed = PrintWindow(h, dc, PW_RENDERFULLCONTENT);
        g.ReleaseHdc(dc);
      }
      if (!printed) throw new Exception("PrintWindow failed");
      Rectangle crop = new Rectangle(f[0] - w[0], f[1] - w[1], f[2] - f[0], f[3] - f[1]);
      crop.Intersect(new Rectangle(0, 0, width, height));
      using (Bitmap visible = whole.Clone(crop, PixelFormat.Format24bppRgb)) {
        visible.Save(file, ImageFormat.Png);
      }
      return new int[] { crop.Width, crop.Height };
    }
  }

  public static IntPtr FileNameEdit(IntPtr dialog) {
    IntPtr hit = IntPtr.Zero;
    EnumChildWindows(dialog, delegate (IntPtr h, IntPtr l) {
      if (ClassOf(h) != "Edit") return true;
      for (IntPtr up = GetParent(h); up != IntPtr.Zero && up != dialog; up = GetParent(up)) {
        if (ClassOf(up) == "ComboBoxEx32" && GetDlgCtrlID(up) == FILE_NAME_COMBO) {
          hit = h;
          return false;
        }
      }
      return true;
    }, IntPtr.Zero);
    return hit;
  }

  public static void SetText(IntPtr h, string text) {
    IntPtr result;
    if (SendMessageTimeout(h, WM_SETTEXT, IntPtr.Zero, text, 2, 5000, out result) == IntPtr.Zero) throw new Exception("WM_SETTEXT timed out");
  }

  [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW")]
  static extern IntPtr SendMessageTimeoutRaw(IntPtr h, uint msg, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "SendMessageTimeoutW")]
  static extern IntPtr SendMessageTimeoutText(IntPtr h, uint msg, IntPtr w, StringBuilder l, uint flags, uint timeout, out IntPtr result);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern IntPtr VirtualAllocEx(IntPtr p, IntPtr at, UIntPtr size, uint type, uint protect);
  [DllImport("kernel32.dll")] static extern bool VirtualFreeEx(IntPtr p, IntPtr at, UIntPtr size, uint type);
  [DllImport("kernel32.dll")] static extern bool WriteProcessMemory(IntPtr p, IntPtr at, byte[] data, UIntPtr size, out UIntPtr done);
  [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr p, IntPtr at, byte[] data, UIntPtr size, out UIntPtr done);

  const uint WM_GETTEXT = 0x000D;
  const uint TVM_DELETEITEM = 0x1101;
  const uint TVM_GETNEXTITEM = 0x110A;
  const uint TVM_GETITEMW = 0x113E;

  static IntPtr Send(IntPtr h, uint msg, IntPtr w, IntPtr l) {
    IntPtr result;
    if (SendMessageTimeoutRaw(h, msg, w, l, 2, 5000, out result) == IntPtr.Zero) throw new Exception("a message to the dialog timed out");
    return result;
  }

  public static string ControlText(IntPtr h) {
    StringBuilder s = new StringBuilder(1024);
    IntPtr result;
    SendMessageTimeoutText(h, WM_GETTEXT, new IntPtr(s.Capacity), s, 2, 5000, out result);
    return s.ToString();
  }

  public static List<object[]> Controls(IntPtr dialog) {
    List<object[]> found = new List<object[]>();
    EnumChildWindows(dialog, delegate (IntPtr h, IntPtr l) {
      string cls = ClassOf(h);
      if (IsWindowVisible(h) && (cls == "Button" || cls == "ComboBox" || cls == "Static" || cls == "ToolbarWindow32")) {
        found.Add(new object[] { cls, GetDlgCtrlID(h), ControlText(h) });
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  static List<IntPtr> Trees(IntPtr dialog) {
    List<IntPtr> found = new List<IntPtr>();
    EnumChildWindows(dialog, delegate (IntPtr h, IntPtr l) {
      if (ClassOf(h) == "SysTreeView32" && IsWindowVisible(h)) found.Add(h);
      return true;
    }, IntPtr.Zero);
    return found;
  }

  static string ItemText(IntPtr process, IntPtr remote, IntPtr tree, IntPtr item) {
    const int textAt = 64;
    const int chars = 260;
    byte[] tv = new byte[56];
    BitConverter.GetBytes((uint)1).CopyTo(tv, 0);
    BitConverter.GetBytes(item.ToInt64()).CopyTo(tv, 8);
    BitConverter.GetBytes(remote.ToInt64() + textAt).CopyTo(tv, 24);
    BitConverter.GetBytes(chars).CopyTo(tv, 32);
    UIntPtr done;
    if (!WriteProcessMemory(process, remote, tv, new UIntPtr((uint)tv.Length), out done)) throw new Exception("could not write the item request");
    Send(tree, TVM_GETITEMW, IntPtr.Zero, remote);
    byte[] text = new byte[chars * 2];
    if (!ReadProcessMemory(process, new IntPtr(remote.ToInt64() + textAt), text, new UIntPtr((uint)text.Length), out done)) throw new Exception("could not read the item text");
    string s = Encoding.Unicode.GetString(text);
    int end = s.IndexOf('\0');
    return end < 0 ? s : s.Substring(0, end);
  }

  static void Walk(IntPtr process, IntPtr remote, IntPtr tree, IntPtr first, List<IntPtr> items, List<string> names, List<long> parents, long parent) {
    for (IntPtr item = first; item != IntPtr.Zero; item = Send(tree, TVM_GETNEXTITEM, new IntPtr(1), item)) {
      items.Add(item);
      names.Add(ItemText(process, remote, tree, item));
      parents.Add(parent);
      Walk(process, remote, tree, Send(tree, TVM_GETNEXTITEM, new IntPtr(4), item), items, names, parents, item.ToInt64());
    }
  }

  public static int[] PruneNavigation(IntPtr dialog, uint pid, string[] keep) {
    List<IntPtr> trees = Trees(dialog);
    if (trees.Count != 1) throw new Exception("expected one navigation tree, found " + trees.Count);
    IntPtr tree = trees[0];
    IntPtr process = OpenProcess(0x0008 | 0x0010 | 0x0020, false, pid);
    if (process == IntPtr.Zero) throw new Exception("could not open the process");
    IntPtr remote = VirtualAllocEx(process, IntPtr.Zero, new UIntPtr(4096), 0x3000, 0x04);
    try {
      List<IntPtr> items = new List<IntPtr>();
      List<string> names = new List<string>();
      List<long> parents = new List<long>();
      Walk(process, remote, tree, Send(tree, TVM_GETNEXTITEM, IntPtr.Zero, IntPtr.Zero), items, names, parents, 0);
      HashSet<string> seen = new HashSet<string>();
      int removed = 0;
      for (int i = items.Count - 1; i >= 0; i--) {
        bool drive = System.Text.RegularExpressions.Regex.IsMatch(names[i], @"\([A-Z]:\)$");
        bool known = Array.IndexOf(keep, names[i]) >= 0;
        if (drive || known) continue;
        Send(tree, TVM_DELETEITEM, IntPtr.Zero, items[i]);
        removed++;
      }
      items.Clear();
      names.Clear();
      parents.Clear();
      Walk(process, remote, tree, Send(tree, TVM_GETNEXTITEM, IntPtr.Zero, IntPtr.Zero), items, names, parents, 0);
      for (int i = 0; i < items.Count; i++) {
        if (!seen.Add(parents[i] + "|" + names[i])) {
          Send(tree, TVM_DELETEITEM, IntPtr.Zero, items[i]);
          removed++;
        }
      }
      items.Clear();
      names.Clear();
      parents.Clear();
      Walk(process, remote, tree, Send(tree, TVM_GETNEXTITEM, IntPtr.Zero, IntPtr.Zero), items, names, parents, 0);
      return new int[] { items.Count, removed };
    } finally {
      VirtualFreeEx(process, remote, UIntPtr.Zero, 0x8000);
      CloseHandle(process);
    }
  }

  public static void Close(IntPtr h) {
    if (!PostMessage(h, WM_CLOSE, IntPtr.Zero, IntPtr.Zero)) throw new Exception("could not post WM_CLOSE");
  }

  public static void Command(IntPtr h, int id) {
    if (!PostMessage(h, WM_COMMAND, new IntPtr(id), IntPtr.Zero)) throw new Exception("could not post WM_COMMAND");
  }
}
'@

[NativeWin]::PerMonitorAware()
$target = [uint32]$ProcessId

function Describe([IntPtr]$h) {
  [ordered]@{
    hwnd = $h.ToInt64()
    cls = [NativeWin]::ClassOf($h)
    title = [NativeWin]::Text($h)
    owner = [NativeWin]::Owner($h)
    rect = [NativeWin]::Rect($h)
    frame = [NativeWin]::Frame($h)
  }
}

function Windows {
  @([NativeWin]::TopLevel($target) | ForEach-Object { Describe $_ })
}

function Emit($value) {
  ConvertTo-Json -InputObject $value -Depth 6 -Compress
}

function Window {
  $h = [IntPtr]$Hwnd
  [NativeWin]::Require($h, $target)
  $h
}

function UiElements([IntPtr]$h, [string[]]$types) {
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($h)
  $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $items = @()
  foreach ($e in $all) {
    $type = $e.Current.ControlType.ProgrammaticName -replace '^ControlType\.', ''
    if ($types.Count -gt 0 -and $types -notcontains $type) { continue }
    $items += [ordered]@{ type = $type; name = $e.Current.Name; id = $e.Current.AutomationId }
  }
  @($items)
}

switch ($Command) {
  'windows' { Emit (Windows) }
  'wait' {
    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
    do {
      $list = Windows
      if (@($list | Where-Object { $_.cls -eq $Class }).Count -gt 0) { Emit $list; exit 0 }
      Start-Sleep -Milliseconds 150
    } while ([DateTime]::UtcNow -lt $deadline)
    Emit $list
    exit 3
  }
  'capture' {
    $size = [NativeWin]::Capture((Window), $Out)
    Emit ([ordered]@{ width = $size[0]; height = $size[1] })
  }
  'read' {
    $h = Window
    $types = @($Kinds -split ',' | Where-Object { $_ -ne '' })
    Emit ([ordered]@{ title = [NativeWin]::Text($h); elements = (UiElements $h $types) })
  }
  'controls' {
    $h = Window
    $items = @([NativeWin]::Controls($h) | ForEach-Object { [ordered]@{ cls = $_[0]; id = $_[1]; text = $_[2] } })
    Emit ([ordered]@{ title = [NativeWin]::Text($h); controls = $items })
  }
  'prune' {
    $keep = @('Home', 'Gallery', 'Desktop', 'Downloads', 'Documents', 'Pictures', 'Music', 'Videos', 'This PC', 'Network')
    $result = [NativeWin]::PruneNavigation((Window), $target, $keep)
    Emit ([ordered]@{ kept = $result[0]; removed = $result[1] })
  }
  'navigate' {
    $h = Window
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { throw "not a folder: $Path" }
    $edit = [NativeWin]::FileNameEdit($h)
    if ($edit -eq [IntPtr]::Zero) { throw 'no file name field in that dialog' }
    [NativeWin]::SetText($edit, $Path.TrimEnd('\') + '\')
    [NativeWin]::Command($h, 1)
    Emit ([ordered]@{ ok = $true })
  }
  'close' {
    [NativeWin]::Close((Window))
    Emit ([ordered]@{ ok = $true })
  }
  'command' {
    [NativeWin]::Command((Window), $Id)
    Emit ([ordered]@{ ok = $true })
  }
  default { throw "unknown command $Command" }
}
