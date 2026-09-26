# orca-windows-notification-dot

An orange dot — or a numbered badge — on **Orca's Windows taskbar button** while
worktrees have agent activity you have not come back to yet.

![badge on the Orca taskbar button](docs/taskbar-badge.png)

## Why this exists

Orca keeps an unread list and a header bell, and on macOS it mirrors the unread
count as a Dock badge. The Windows build has no taskbar equivalent, so if the
agent that finished is not the pane you happen to be looking at, the notification
is easy to miss.

A plugin cannot simply ask Electron for this: a plugin worker is a plain Node
process behind an IPC bridge — no `BrowserWindow`, no `setOverlayIcon`. What a
worker *does* get is the `agent.status.changed` event stream. So the job is split
in two:

* `main.mjs` — the plugin worker: events in, an attention model out, written to
  one small state file next to it;
* `assets/badge-host.ps1` — a detached PowerShell + C# host that reads that file
  and calls `ITaskbarList3::SetOverlayIcon` on Orca's top-level window.

That call works **across processes** — verified here by a probe process painting
an overlay on Orca's button, and the overlay surviving the death of the process
that set it — which is what makes a taskbar badge possible without patching Orca.

## When the badge lights up, and when it goes away

The badge is a **"come back" signal**, not an in-app unread list. Orca tells
plugins nothing about what the user has looked at, so the host watches the one
thing it can see for itself: the foreground window.

| What happens | Badge |
| --- | --- |
| `done` / `waiting` / `blocked` while Orca is **not** in front | lights with the number of such worktrees |
| Orca comes to the front — taskbar click, alt-tab, restoring it | clears within a poll (≈300 ms) |
| `done` / `waiting` / `blocked` while Orca **is** in front | never lights; Orca's own chip and bell own that case |
| any pane of a worktree resumes `working` | that worktree stops counting |
| the worktree is removed | stops counting |
| 24 h without a new event | stops counting |
| `Work dot: clear badge` | everything stops counting |

An agent finishing inside the window you are already looking at would raise a
badge you could not honestly clear — that is the trap this rule exists to avoid.
The watermark that records "already in front" lives in `badge.json`, so a host
restart never resurrects a badge you have seen.

## Install

Windows only. The plugin needs Orca 1.4+ and one capability, `events:subscribe`
(consent dialog: *"Get notified when worktrees are created or removed and when
agent status changes"*).

1. Put the plugin folder somewhere stable:

   ```powershell
   git clone https://github.com/stnslvsvnv/orca-windows-notification-dot "$env:USERPROFILE\.orca\plugin-sources\orca-windows-notification-dot"
   ```

   (A downloaded ZIP next to it works exactly the same, as long as the folder
   contains `orca-plugin.json`.)

2. In Orca: **Settings → Plugins → Install plugin**, and paste that folder path into
   *Plugin folder path* (helper text: *"Full path to a folder containing
   orca-plugin.json on this computer. The path is used exactly as entered."*). Orca
   copies the plugin into `%APPDATA%\orca\plugins\stnslvsvnv.work-notification-dot`
   and shows its permissions for review.
3. Review and enable it. No plugin code runs until it is enabled.
4. Nothing else to configure. The first event starts the badge host; its files
   live in `%USERPROFILE%\.orca\work-notification-dot\`.

**Updating:** `git pull` in that folder, then re-install/refresh the plugin (or
add the folder to Orca's plugin **development paths** so the worker reloads on
change). When the shipped `badge-host.ps1` differs from the deployed copy, the
worker restarts the host itself — a running host is never a version behind.

## Commands (command palette)

| Command | Effect |
| --- | --- |
| `Work dot: status` | `displayed=` (what the taskbar shows) vs `pending=` (what was recorded), the worktrees, host pid/heartbeat, mode, root path |
| `Work dot: clear badge` | forget every pending worktree and drop the overlay |
| `Work dot: toggle dot/number` | plain orange dot ⇄ digit badge (default: number) |
| `Work dot: restart badge host` | reinstall the script, kill the host, start it again |

## Files

| Path | Role |
| --- | --- |
| `orca-plugin.json` | manifest: events (`agent.status.changed`, `worktree.created`, `worktree.removed`), commands, `events:subscribe` |
| `main.mjs` | worker: events → attention model → `state.json`; supervises the host; commands |
| `assets/badge-host.ps1` | detached host: foreground watermark, icon rendering, `SetOverlayIcon` on Orca's window |
| `docs/taskbar-badge.png` | the screenshot above |

Runtime files, all under `%USERPROFILE%\.orca\work-notification-dot\`:
`state.json` (what the worker recorded), `badge.json` (what is painted, whether
Orca is in front, seen watermark), `host.pid`, `heartbeat`, `host.log`.

## Windows details that matter

* **The overlay call works across processes.** `SetOverlayIcon` was called on
  Orca's HWND by a different process (PowerShell), which is what makes this
  plugin possible without patching Orca. The overlay also survives the death of
  the process that set it, so a reaped worker never blinks the badge.
* **The host is detached on purpose.** Node's `detached` flag is not an option:
  a `DETACHED_PROCESS` PowerShell exits before running a line of the script
  (verified on this machine, the same conclusion the neon-border plugin reached).
  The host is started with `Start-Process -WindowStyle Hidden`, writes a
  heartbeat every 2 s, and counts as alive only when its pid is in `tasklist`
  *and* the heartbeat is fresh.
* **Focus is compared by process, not window**: `GetForegroundWindow` →
  `GetWindowThreadProcessId`, so an Orca dialog or floating workspace still
  counts as front.
* **Re-applying every 5 s is deliberate.** Two things cannot be observed: an
  Explorer restart and a recreated Orca window. Re-applying the same HICON is
  cheap and repairs both.
* **Icon size follows `SM_CXSMICON`** (16 px at 100 % DPI, larger when scaled).
  Digits 1–9 fit one digit; above 9 the badge shows `9+` only when the icon is at
  least 20 px, and degrades to a plain dot otherwise.
* **Worker environments are whitelisted** (`PATH`, `USERPROFILE`, `SYSTEMROOT`, …),
  so PowerShell and `tasklist` are addressed through `%SYSTEMROOT%\System32`
  rather than assumed to be on `PATH`.
* **A worker event burst is serialized** before it touches `state.json`: Orca
  does not queue `deliverEvent` messages, and the state is a read-modify-write.

## Verified on Windows (2026-09-26, Orca 1.4.212)

Driven through the real worker and the real taskbar button (orange pixels counted
inside Orca's button rectangle, found through UI Automation):

| Step | Result |
| --- | --- |
| baseline, no badge | 0 orange pixels in the button |
| three away worktrees (`done`, `waiting`, `blocked`) | `displayed=3`, 129 orange pixels, digit `3` legible |
| Orca brought to the front | `displayed=0`, 0 orange pixels — cleared without any agent action |
| an agent finishing while Orca is in front | `displayed=0`, `pending=3` — recorded, never painted |
| host restart right after that | still 0 — the watermark survived in `badge.json` |
| Orca in the background again, new event | painted again (`applied count=1 … focused=False` in `host.log`) |
| `toggle dot/number` → dot | 159 orange pixels, plain dot, no digit |
| `restart badge host` | host pid `21924 → 12628`, badge unchanged |
| plugin update with a host already running | worker replaces the stale deployed host on the next event, then paints again |
| 25 h old state file | 0 orange pixels — the host dropped the overlay by itself |
| `clear badge` | `cleared 3 worktree(s)`, 0 orange pixels |

The worker logic additionally passes a 32-check harness (per-pane state
sequences, worktree removal, TTL pruning, corrupt state, concurrent events, the
`badge.json` reader, the off-Windows guard) and a 13-check focus harness (paint
while away, clear on focus, no paint in front, watermark persistence across host
restarts). A separate Windows harness stands up a *stale deployed host* and
proves the worker replaces it with the shipped copy on the next event — the path
a plugin update takes.

## Limits

* **Windows only.** macOS already badges the Dock; on Linux Orca has no taskbar
  overlay API. The worker logs that it is unsupported and does nothing.
* **Terminal agents only.** Orca emits `agent.status.changed` for hook-driven CLI
  agents (Claude Code, Codex, …). Its native structured chats (for example `omp`)
  mark the tab and workspace unread internally but do not emit that event — a
  structured-chat pane's status stayed `working` across many turns while this was
  measured on 1.4.212, so no badge can be raised for those sessions. If Orca
  starts emitting those transitions, this plugin picks them up unchanged.
* **No badge while Orca is in front.** With no way to learn that you read a
  notification, a badge raised inside the window you are looking at could never
  be honestly cleared; Orca's own chip and bell cover that case.
* Removing or disabling the plugin leaves the host running with the last state;
  run `Work dot: clear badge` first, or kill it manually:

  ```powershell
  powershell -File "$env:USERPROFILE\.orca\work-notification-dot\badge-host.ps1" -Root "$env:USERPROFILE\.orca\work-notification-dot" -Stop
  ```
