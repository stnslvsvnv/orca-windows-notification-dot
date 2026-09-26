# Work Notification Dot — taskbar badge host.
#
# Orca's Windows build has no taskbar badge, and a plugin worker cannot reach
# Electron's BrowserWindow. This host is the missing half: it runs detached
# next to Orca, reads the badge state the plugin worker writes, and calls
# ITaskbarList3::SetOverlayIcon on Orca's top-level window. The call is
# cross-process (verified: the overlay appears while Orca owns the window and
# survives the death of the process that set it), so no Orca patch is needed.
#
# The badge is a "come back" signal, not an in-app unread list. Orca tells
# plugins nothing about what the user has looked at, so the host watches the one
# thing it can see for itself: the foreground window. Only activity that arrived
# while Orca was *not* in front counts, and bringing Orca to the front — which is
# what clicking its taskbar button does — clears the badge within a poll.
# Consequences, both deliberate:
#   * an agent that finishes while you are already inside Orca is left to Orca's
#     own chip and bell, and never raises a badge you could not clear;
#   * the watermark that encodes "already in front" is persisted in badge.json,
#     so a host restart cannot resurrect a badge the user has seen.
#
# Usage (the plugin worker starts it this way):
#   powershell -NoProfile -ExecutionPolicy Bypass -File badge-host.ps1 -Root <dir>
# Options:
#   -Once      apply the current state once and exit (used by tests)
#   -Seconds N run for N seconds, then exit leaving the overlay as is
#   -Stop      clear the overlay, stop a running host, and exit
param(
  [Parameter(Mandatory = $true)][string]$Root,
  [switch]$Stop,
  [switch]$Once,
  [int]$Seconds = 0
)
$ErrorActionPreference = 'Stop'

$StatePath = Join-Path $Root 'state.json'
$BadgePath = Join-Path $Root 'badge.json'
$LogPath = Join-Path $Root 'host.log'
$PidPath = Join-Path $Root 'host.pid'
$HeartbeatPath = Join-Path $Root 'heartbeat'

# The badge may not outlive its usefulness: a state file nobody has touched for
# a day is treated as empty, so a forgotten badge cannot survive forever.
$MaxAgeMs = 24 * 60 * 60 * 1000
$ReapplySeconds = 5
$HeartbeatSeconds = 2
$PollMilliseconds = 300

function Write-Log([string]$Message) {
  try {
    $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    if ((Test-Path $LogPath) -and ((Get-Item $LogPath).Length -gt 1MB)) { Remove-Item $LogPath -Force }
    Add-Content -Path $LogPath -Value $line
  } catch {
    # logging must never take the host down
  }
}

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.Runtime.InteropServices;

namespace WorkDotHost
{
    [ComImport, Guid("ea1afb91-9e28-4b86-90e9-9e9f8a5eefaf"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface ITaskbarList3
    {
        void HrInit();
        void AddTab(IntPtr hwnd);
        void DeleteTab(IntPtr hwnd);
        void ActivateTab(IntPtr hwnd);
        void SetActiveAlt(IntPtr hwnd);
        void MarkFullscreenWindow(IntPtr hwnd, [MarshalAs(UnmanagedType.Bool)] bool fFullscreen);
        void SetProgressValue(IntPtr hwnd, ulong completed, ulong total);
        void SetProgressState(IntPtr hwnd, int flags);
        void RegisterTab(IntPtr hwndTab, IntPtr hwndMDI);
        void UnregisterTab(IntPtr hwndTab);
        void SetTabOrder(IntPtr hwndTab, IntPtr hwndInsertBefore);
        void SetTabActive(IntPtr hwndTab, IntPtr hwndInsertBefore, int dwReserved);
        void ThumbBarAddButtons(IntPtr hwnd, uint cButtons, IntPtr pButtons);
        void ThumbBarUpdateButtons(IntPtr hwnd, uint cButtons, IntPtr pButtons);
        void ThumbBarSetImageList(IntPtr hwnd, IntPtr himl);
        void SetOverlayIcon(IntPtr hwnd, IntPtr hIcon, [MarshalAs(UnmanagedType.LPWStr)] string pszDescription);
        void SetThumbnailTooltip(IntPtr hwnd, [MarshalAs(UnmanagedType.LPWStr)] string pszTip);
        void SetThumbnailClip(IntPtr hwnd, IntPtr prcClip);
    }

    public static class Host
    {
        [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr hWnd);
        [DllImport("user32.dll")] private static extern int GetSystemMetrics(int nIndex);
        [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

        private const int SM_CXSMICON = 49;

        // Overlay icons are drawn at taskbar scale; the cache keeps one HICON
        // per look, and Alive pins the bitmaps the handles came from.
        private static readonly Dictionary<string, IntPtr> Cache = new Dictionary<string, IntPtr>();
        private static readonly List<Bitmap> Alive = new List<Bitmap>();

        public static void MakeDpiAware()
        {
            try { SetProcessDPIAware(); } catch { }
        }

        public static bool WindowAlive(IntPtr hwnd)
        {
            return hwnd != IntPtr.Zero && IsWindow(hwnd);
        }

        public static int ForegroundProcessId()
        {
            var hwnd = GetForegroundWindow();
            if (hwnd == IntPtr.Zero) return 0;
            uint processId;
            GetWindowThreadProcessId(hwnd, out processId);
            return (int)processId;
        }

        public static void Apply(IntPtr hwnd, int count, string mode)
        {
            if (count <= 0) { Clear(hwnd); return; }
            Create().SetOverlayIcon(hwnd, IconFor(count, mode), Describe(count));
        }

        public static void Clear(IntPtr hwnd)
        {
            Create().SetOverlayIcon(hwnd, IntPtr.Zero, "");
        }

        private static string Describe(int count)
        {
            return count == 1 ? "1 worktree needs attention" : count + " worktrees need attention";
        }

        // COM calls stay inside C#: PowerShell only sees System.__ComObject and
        // cannot late-bind a ComImport interface.
        private static ITaskbarList3 Create()
        {
            var clsid = new Guid("56FDF344-FD6D-11d0-958A-006097C9A090");
            var list = (ITaskbarList3)Activator.CreateInstance(Type.GetTypeFromCLSID(clsid));
            list.HrInit();
            return list;
        }

        private static IntPtr IconFor(int count, string mode)
        {
            string text = "";
            if (mode != "dot")
            {
                // One digit fits a 16 px icon; beyond that the badge degrades to
                // "9+" only when the icon is big enough to read it.
                text = count <= 9 ? count.ToString() : (GetSystemMetrics(SM_CXSMICON) >= 20 ? "9+" : "");
            }
            string key = mode + ":" + text;
            IntPtr cached;
            if (Cache.TryGetValue(key, out cached)) return cached;

            int size = GetSystemMetrics(SM_CXSMICON);
            if (size < 8 || size > 64) size = 16;
            var bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb);
            using (var g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
                g.Clear(Color.Transparent);
                using (var brush = new SolidBrush(Color.FromArgb(255, 255, 138, 0)))
                {
                    g.FillEllipse(brush, 0, 0, size - 1, size - 1);
                }
                if (text.Length > 0)
                {
                    float ratio = text.Length > 1 ? 0.60f : 0.74f;
                    using (var font = new Font("Segoe UI", size * ratio, FontStyle.Bold, GraphicsUnit.Pixel))
                    using (var format = new StringFormat
                    {
                        Alignment = StringAlignment.Center,
                        LineAlignment = StringAlignment.Center
                    })
                    {
                        g.DrawString(text, font, Brushes.White, new RectangleF(0, 0, size, size), format);
                    }
                }
            }
            var icon = bmp.GetHicon();
            Alive.Add(bmp);
            Cache[key] = icon;
            return icon;
        }
    }
}
'@ -ReferencedAssemblies System.Drawing

[WorkDotHost.Host]::MakeDpiAware()

function Get-OrcaProcess {
  $process = Get-Process Orca -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($null -eq $process) { return @{ hwnd = [IntPtr]::Zero; processId = 0 } }
  return @{ hwnd = $process.MainWindowHandle; processId = [int]$process.Id }
}

function Read-JsonFile([string]$Path) {
  try {
    if (-not (Test-Path $Path)) { return $null }
    $raw = [System.IO.File]::ReadAllText($Path)
    if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
    return $raw | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Write-JsonFile([string]$Path, $Value) {
  try {
    $tmp = "$Path.tmp"
    [System.IO.File]::WriteAllText($tmp, ($Value | ConvertTo-Json -Compress))
    Move-Item -Path $tmp -Destination $Path -Force
  } catch {
    # badge.json is for observers; failing to write it must not stop the badge
  }
}

function Get-Milliseconds {
  return [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
}

# The badge is the mirror image of badge.json: count is what the taskbar shows,
# pending is what the worker has recorded, seenMarker is the watermark below
# which everything counts as seen.
function Write-BadgeFile([int]$Count, [int]$Pending, [bool]$Focused, [double]$SeenMarker, $Orca) {
  Write-JsonFile $BadgePath ([ordered]@{
    count         = $Count
    pending       = $Pending
    focused       = $Focused
    seenMarker    = [double]$SeenMarker
    hwnd          = if ($null -ne $Orca) { $Orca.hwnd.ToInt64() } else { 0 }
    orcaPid       = if ($null -ne $Orca) { $Orca.processId } else { 0 }
    hostPid       = $PID
    at            = Get-Milliseconds
  })
}

# One count per worktree that has at least one pane in an attention state, was
# announced after the user last had Orca in front, and is not past its TTL.
function Get-BadgeCount($state, [double]$SeenMarker, [double]$Now) {
  if ($null -eq $state) { return 0 }
  $updatedAt = 0
  if ($null -ne $state.updatedAt) { $updatedAt = [double]$state.updatedAt }
  if ($updatedAt -le 0) { return 0 }
  if ($Now - $updatedAt -gt $MaxAgeMs) { return 0 }
  if ($null -eq $state.panes) { return 0 }
  $worktrees = New-Object 'System.Collections.Generic.HashSet[string]'
  foreach ($property in $state.panes.PSObject.Properties) {
    $entry = $property.Value
    if ($null -eq $entry) { continue }
    if (@('done', 'waiting', 'blocked') -notcontains [string]$entry.state) { continue }
    $at = 0
    if ($null -ne $entry.at) { $at = [double]$entry.at }
    if ($at -le $SeenMarker) { continue }
    if ($Now - $at -gt $MaxAgeMs) { continue }
    $id = if ($entry.worktreeId) { [string]$entry.worktreeId } else { 'pane:' + [string]$property.Name }
    [void]$worktrees.Add($id)
  }
  return $worktrees.Count
}

if ($Stop) {
  # `-Stop` is a request from a fresh caller (the plugin's repair command), not
  # from the host itself: terminate the running host first so nothing re-applies
  # the overlay after this clear.
  $stopped = $false
  if (Test-Path $PidPath) {
    $hostPid = 0
    $raw = (Get-Content $PidPath -ErrorAction SilentlyContinue) -join ''
    if ([int]::TryParse($raw.Trim(), [ref]$hostPid) -and $hostPid -gt 0 -and $hostPid -ne $PID) {
      try {
        $hostProcess = Get-Process -Id $hostPid -ErrorAction Stop
        if ($hostProcess.ProcessName -eq 'powershell') {
          Stop-Process -Id $hostPid -Force
          $stopped = $true
        }
      } catch {
        # already gone
      }
    }
  }

  $orca = Get-OrcaProcess
  if ([WorkDotHost.Host]::WindowAlive($orca.hwnd)) {
    [WorkDotHost.Host]::Clear($orca.hwnd)
    Write-Log ("overlay cleared (-Stop, host stopped={0})" -f $stopped)
  } else {
    Write-Log ("no Orca window to clear (-Stop, host stopped={0})" -f $stopped)
  }
  Remove-Item $HeartbeatPath -Force -ErrorAction SilentlyContinue
  Remove-Item $PidPath -Force -ErrorAction SilentlyContinue
  exit 0
}

Set-Content -Path $PidPath -Value $PID

# A host restart must not resurrect a badge the user has already seen, so the
# watermark survives in badge.json. Without one, a host that finds Orca in front
# starts with everything seen, and one that finds Orca in the background counts
# the pending panes.
$previous = Read-JsonFile $BadgePath
$orca = Get-OrcaProcess
$focused = $orca.processId -gt 0 -and ([WorkDotHost.Host]::ForegroundProcessId() -eq $orca.processId)
$seenMarker = 0
if ($null -ne $previous -and $null -ne $previous.seenMarker) { $seenMarker = [double]$previous.seenMarker }
if ($focused) { $seenMarker = Get-Milliseconds }

Write-Log ("host started pid={0} once={1} seconds={2} focused={3} seenMarker={4} root={5}" -f `
  $PID, $Once.IsPresent, $Seconds, $focused, $seenMarker, $Root)

$deadline = if ($Seconds -gt 0) { (Get-Date).AddSeconds($Seconds) } else { $null }
$lastKey = ''
$applied = (Get-Date).AddSeconds(-$ReapplySeconds)
$heartbeat = (Get-Date).AddSeconds(-$HeartbeatSeconds)
$lastFocused = $focused
$lastFocusedWritten = $focused
$lastCount = -1
$lastPending = -1

while ($true) {
  if ($null -ne $deadline -and (Get-Date) -gt $deadline) {
    Write-Log 'run window elapsed; exiting with the overlay in place'
    break
  }

  if (-not [WorkDotHost.Host]::WindowAlive($orca.hwnd)) { $orca = Get-OrcaProcess }

  $focused = $orca.processId -gt 0 -and ([WorkDotHost.Host]::ForegroundProcessId() -eq $orca.processId)
  $now = Get-Milliseconds
  # While Orca is in front everything is being seen, so the watermark keeps
  # moving; once it drops behind, the watermark freezes and anything newer than
  # it starts to count.
  if ($focused) { $seenMarker = $now }
  if ($focused -ne $lastFocused) {
    Write-Log ("focus changed: focused={0}" -f $focused)
    $lastFocused = $focused
  }

  $state = Read-JsonFile $StatePath
  $count = Get-BadgeCount $state $seenMarker $now
  $pending = Get-BadgeCount $state 0 $now
  $mode = if ($null -ne $state -and $state.mode) { [string]$state.mode } else { 'number' }

  $key = '{0}:{1}:{2}' -f $orca.hwnd.ToInt64(), $count, $mode
  # Re-applying every few seconds is cheap and repairs the two things we cannot
  # observe: an Explorer restart and a recreated Orca window.
  $dueForReapply = ((Get-Date) - $applied).TotalSeconds -ge $ReapplySeconds
  if ([WorkDotHost.Host]::WindowAlive($orca.hwnd) -and ($key -ne $lastKey -or $dueForReapply)) {
    try {
      [WorkDotHost.Host]::Apply($orca.hwnd, $count, $mode)
      Write-Log ("applied count={0} mode={1} focused={2} hwnd={3}" -f $count, $mode, $focused, $orca.hwnd.ToInt64())
      $lastKey = $key
      $applied = Get-Date
    } catch {
      Write-Log ('apply failed: ' + $_.Exception.Message)
      Start-Sleep -Milliseconds 500
    }
  }

  if ($count -ne $lastCount -or $pending -ne $lastPending -or $focused -ne $lastFocusedWritten) {
    Write-BadgeFile $count $pending $focused $seenMarker $orca
    $lastCount = $count
    $lastPending = $pending
    $lastFocusedWritten = $focused
  }

  if (((Get-Date) - $heartbeat).TotalSeconds -ge $HeartbeatSeconds) {
    try { Set-Content -Path $HeartbeatPath -Value ([DateTimeOffset]::UtcNow.ToUnixTimeSeconds()) } catch { }
    $heartbeat = Get-Date
  }

  if ($Once.IsPresent) {
    Write-Log 'once mode; exiting with the overlay in place'
    break
  }

  Start-Sleep -Milliseconds $PollMilliseconds
}
