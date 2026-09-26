// Work Notification Dot — Orca plugin worker.
//
// Orca mirrors unread agent activity as a Dock badge on macOS, and its Windows
// build has no equivalent. A plugin worker cannot fill that gap by itself: it
// is a plain Node child process behind an IPC bridge, with no Electron window
// and no setOverlayIcon. What a worker does get is the `agent.status.changed`
// stream.
//
// So this worker projects that stream into one small state file per user and
// keeps a detached PowerShell + C# host (`assets/badge-host.ps1`) in charge of
// drawing: the host finds Orca's top-level window and calls
// ITaskbarList3::SetOverlayIcon on it. That call works across processes, which
// is what makes an orange dot / numbered badge possible without patching Orca.
//
// Attention model, per pane and aggregated per worktree:
//   * `working`                       — clears the pane: the user answered.
//   * `done` / `waiting` / `blocked`  — the interesting end of a turn: the
//                                       agent finished, wants input, or is
//                                       stuck. Its worktree counts once until
//                                       one of the above happens.
// Entries older than MAX_AGE_MS stop counting, so a forgotten badge cannot
// outlive its usefulness — and `work dot: clear badge` clears on demand.
//
// Everything is best-effort: handlers and commands log and return text, and
// never throw at Orca.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const HOST_SCRIPT = 'badge-host.ps1';
const ASSETS_DIR = fileURLToPath(new URL('./assets/', import.meta.url));

const ATTENTION_STATES = new Set(['done', 'waiting', 'blocked']);
const WORKING_STATE = 'working';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

// USERPROFILE is the Windows profile even when Node reports homedir() from a
// different source; homedir() is only the fallback when it is unset. The
// plugin worker inherits a whitelisted environment that does carry it.
const PROFILE = process.env.USERPROFILE || os.homedir();
const ROOT = path.join(PROFILE, '.orca', 'work-notification-dot');
const HOST_PS1 = path.join(ROOT, HOST_SCRIPT);
const STATE_PATH = path.join(ROOT, 'state.json');
const PID_PATH = path.join(ROOT, 'host.pid');
const HEARTBEAT_PATH = path.join(ROOT, 'heartbeat');
// Written by the host: what is actually painted, and whether Orca was in front.
const BADGE_PATH = path.join(ROOT, 'badge.json');

const HEARTBEAT_STALE_SECONDS = 30;
const START_QUICK_MS = 1500;
const START_COMMAND_MS = 8000;
const START_RETRY_MS = 5000;
const COMMAND_TIMEOUT_MS = 20_000;

// A worker environment is whitelisted and may not carry System32 on PATH, so
// PowerShell and tasklist are addressed absolutely when SYSTEMROOT is known.
const SYSTEM32 = process.env.SYSTEMROOT ? path.join(process.env.SYSTEMROOT, 'System32') : null;
const POWERSHELL = SYSTEM32
  ? path.join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe';
const TASKLIST = SYSTEM32 ? path.join(SYSTEM32, 'tasklist.exe') : 'tasklist.exe';
const PS_FILE_PREFIX = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'];

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Orca does not queue worker event deliveries: two `deliverEvent` messages can
// interleave at any await inside a handler, and the badge state is a
// read-modify-write of one file. Every mutation goes through this chain so a
// burst of status changes cannot lose one.
let mutations = Promise.resolve();

function serialize(task) {
  const run = mutations.then(task, task);
  mutations = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

async function exists(file) {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}

async function sha256(file) {
  try {
    return createHash('sha256').update(await fsp.readFile(file)).digest('hex');
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------- state --

function emptyState() {
  return { version: 1, mode: 'number', updatedAt: 0, panes: {}, worktrees: {} };
}

function normalizeState(raw) {
  const state = emptyState();
  if (!raw || typeof raw !== 'object') return state;
  if (raw.mode === 'dot' || raw.mode === 'number') state.mode = raw.mode;
  if (Number.isFinite(Number(raw.updatedAt))) state.updatedAt = Number(raw.updatedAt);
  if (raw.panes && typeof raw.panes === 'object') state.panes = { ...raw.panes };
  if (raw.worktrees && typeof raw.worktrees === 'object') state.worktrees = { ...raw.worktrees };
  return state;
}

async function readState() {
  try {
    return normalizeState(JSON.parse(await fsp.readFile(STATE_PATH, 'utf8')));
  } catch {
    return emptyState();
  }
}

function prune(state, now) {
  for (const [paneKey, entry] of Object.entries(state.panes)) {
    const at = Number(entry?.at);
    if (!Number.isFinite(at) || now - at > MAX_AGE_MS) delete state.panes[paneKey];
  }
  for (const [worktreeId, entry] of Object.entries(state.worktrees)) {
    const at = Number(entry?.at);
    if (!Number.isFinite(at) || now - at > MAX_AGE_MS) delete state.worktrees[worktreeId];
  }
}

async function writeJsonAtomic(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  try {
    await fsp.rename(tmp, file);
  } catch (error) {
    await fsp.rm(tmp, { force: true });
    throw error;
  }
}

async function persist(state) {
  state.updatedAt = Date.now();
  prune(state, state.updatedAt);
  await writeJsonAtomic(STATE_PATH, state);
}

// One entry per worktree that has at least one pane waiting for the user, the
// newest pane per worktree winning the label.
function attentionItems(state, now = Date.now()) {
  const byWorktree = new Map();
  for (const [paneKey, entry] of Object.entries(state.panes)) {
    if (!entry || !ATTENTION_STATES.has(entry.state)) continue;
    const at = Number(entry.at) || 0;
    if (now - at > MAX_AGE_MS) continue;
    const worktreeId = typeof entry.worktreeId === 'string' && entry.worktreeId ? entry.worktreeId : null;
    const id = worktreeId ?? `pane:${paneKey}`;
    const previous = byWorktree.get(id);
    if (previous && previous.at >= at) continue;
    byWorktree.set(id, {
      id,
      worktreeId,
      paneKey,
      state: entry.state,
      at,
      label: state.worktrees[worktreeId]?.branch || worktreeId || paneKey,
    });
  }
  return [...byWorktree.values()].sort((a, b) => b.at - a.at);
}

// ------------------------------------------------------------------- events --

function applyAgentStatus(state, payload) {
  const paneKey = typeof payload?.paneKey === 'string' && payload.paneKey ? payload.paneKey : null;
  const status = typeof payload?.state === 'string' ? payload.state : null;
  if (!paneKey || !status) return false;

  if (status === WORKING_STATE) {
    if (!(paneKey in state.panes)) return false;
    delete state.panes[paneKey];
    return true;
  }
  if (!ATTENTION_STATES.has(status)) return false;

  state.panes[paneKey] = {
    worktreeId: typeof payload.worktreeId === 'string' && payload.worktreeId ? payload.worktreeId : null,
    state: status,
    at: Number(payload.receivedAt) || Date.now(),
  };
  return true;
}

function applyWorktreeCreated(state, payload) {
  const worktreeId = typeof payload?.worktreeId === 'string' && payload.worktreeId ? payload.worktreeId : null;
  if (!worktreeId) return false;
  state.worktrees[worktreeId] = {
    branch: typeof payload.branch === 'string' ? payload.branch : '',
    path: typeof payload.path === 'string' ? payload.path : '',
    at: Date.now(),
  };
  return true;
}

function applyWorktreeRemoved(state, payload) {
  const worktreeId = typeof payload?.worktreeId === 'string' && payload.worktreeId ? payload.worktreeId : null;
  if (!worktreeId) return false;
  let changed = delete state.worktrees[worktreeId] === true;
  for (const [paneKey, entry] of Object.entries(state.panes)) {
    if (entry?.worktreeId === worktreeId) {
      delete state.panes[paneKey];
      changed = true;
    }
  }
  return changed;
}

// -------------------------------------------------------------------- host --

async function readHostState() {
  let pid = null;
  try {
    const parsed = Number.parseInt((await fsp.readFile(PID_PATH, 'utf8')).trim(), 10);
    if (Number.isInteger(parsed) && parsed > 0) pid = parsed;
  } catch {
    pid = null;
  }

  let heartbeatAgeSeconds = -1;
  try {
    const stat = await fsp.stat(HEARTBEAT_PATH);
    heartbeatAgeSeconds = Math.max(0, Math.floor((Date.now() - stat.mtimeMs) / 1000));
  } catch {
    heartbeatAgeSeconds = -1;
  }

  return { pid, heartbeatAgeSeconds };
}

async function processAlive(pid) {
  try {
    const { stdout } = await execFileAsync(TASKLIST, ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], {
      windowsHide: true,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    return stdout.split(/\r?\n/).some((line) => {
      const fields = line.split('","');
      return fields.length >= 2 && fields[1].replace(/"/g, '').trim() === String(pid);
    });
  } catch {
    return false;
  }
}

async function hostStatus() {
  const { pid, heartbeatAgeSeconds } = await readHostState();
  const fresh = heartbeatAgeSeconds >= 0 && heartbeatAgeSeconds <= HEARTBEAT_STALE_SECONDS;
  const alive = pid !== null && fresh && (await processAlive(pid));
  return { alive, pid, heartbeatAgeSeconds };
}

async function deployHostScript({ force = false } = {}) {
  await fsp.mkdir(ROOT, { recursive: true });
  const source = path.join(ASSETS_DIR, HOST_SCRIPT);
  const sourceHash = await sha256(source);
  if (sourceHash === null) throw new Error(`bundled asset is unreadable: ${HOST_SCRIPT}`);
  if (!force && sourceHash === (await sha256(HOST_PS1))) return { copied: false };

  const tmp = `${HOST_PS1}.${process.pid}.tmp`;
  await fsp.copyFile(source, tmp);
  try {
    await fsp.rename(tmp, HOST_PS1);
  } catch {
    // a reader holding the target open is retried as a plain overwrite
    await fsp.rm(tmp, { force: true });
    await fsp.copyFile(source, HOST_PS1);
  }
  return { copied: true };
}

// The host has to outlive this worker, so it is started the way the neon-border
// plugin starts its overlay host: `Start-Process -WindowStyle Hidden`, i.e. a
// process of its own. Node's `detached` flag is not an option here (a
// DETACHED_PROCESS PowerShell exits before running a single line of the script)
// and a plain child dies with the console it inherited.
//
// `-ArgumentList` does not quote for us, hence the explicit quotes around both
// paths: a profile directory containing a space would otherwise silently fail.
const LAUNCH_HOST_COMMAND = [
  'Start-Process -FilePath $env:WORK_DOT_POWERSHELL',
  `-ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"' + $env:WORK_DOT_HOST_PS1 + '"'),'-Root',('"' + $env:WORK_DOT_ROOT + '"'))`,
  '-WindowStyle Hidden',
  '-PassThru | Select-Object -ExpandProperty Id',
].join(' ');

async function runPowerShellCommand(command, extraEnv = null, timeout = COMMAND_TIMEOUT_MS) {
  const options = { windowsHide: true, timeout, maxBuffer: 1024 * 1024, encoding: 'utf8' };
  if (extraEnv) options.env = { ...process.env, ...extraEnv };
  const { stdout } = await execFileAsync(
    POWERSHELL,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
    options,
  );
  return stdout.trim();
}

async function launchHostProcess() {
  const stdout = await runPowerShellCommand(LAUNCH_HOST_COMMAND, {
    WORK_DOT_POWERSHELL: POWERSHELL,
    WORK_DOT_HOST_PS1: HOST_PS1,
    WORK_DOT_ROOT: ROOT,
  });
  const pid = Number.parseInt(stdout, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

async function startHost(waitMs = START_QUICK_MS) {
  const before = await hostStatus();
  if (before.alive) return before;

  const launcherPid = await launchHostProcess();
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await delay(200);
    const { heartbeatAgeSeconds } = await readHostState();
    if (heartbeatAgeSeconds >= 0 && heartbeatAgeSeconds <= HEARTBEAT_STALE_SECONDS) {
      return { ...(await hostStatus()), launcherPid };
    }
  }
  return { ...(await hostStatus()), launcherPid, starting: true };
}

async function stopHost() {
  const before = await hostStatus();
  if (!(await exists(HOST_PS1))) return { ...before, stopped: false };
  try {
    await execFileAsync(POWERSHELL, [...PS_FILE_PREFIX, HOST_PS1, '-Root', ROOT, '-Stop'], {
      windowsHide: true,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    return { ...before, stopped: true };
  } catch (error) {
    return { ...before, stopped: false, error: errorText(error) };
  }
}

let lastStartAttempt = 0;

async function ensureHost(reason) {
  if (process.platform !== 'win32') return { alive: false, unsupported: true };
  const before = await hostStatus();
  // A host that is already running executes the copy that was on disk when it
  // started; if the plugin just brought a newer script, restart it so the
  // running code is never a version behind the shipped one.
  const deployment = await deployHostScript({ force: false });
  if (before.alive && !deployment.copied) return before;
  if (Date.now() - lastStartAttempt < START_RETRY_MS) return before;
  lastStartAttempt = Date.now();
  if (before.alive) {
    await stopHost();
    reason = `${reason}; restarted for a new host script`;
  }
  return startHost(START_QUICK_MS);
}

async function readBadgeFile() {
  try {
    const raw = JSON.parse(await fsp.readFile(BADGE_PATH, 'utf8'));
    return {
      count: Number.isFinite(Number(raw.count)) ? Number(raw.count) : null,
      pending: Number.isFinite(Number(raw.pending)) ? Number(raw.pending) : null,
      focused: raw.focused === true,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- commands --

function describeHost(status) {
  if (process.platform !== 'win32') return 'unsupported (windows only)';
  const heartbeat = status.heartbeatAgeSeconds >= 0 ? `${status.heartbeatAgeSeconds}s ago` : 'missing';
  return `${status.alive ? 'alive' : 'down'} pid=${status.pid ?? 'none'} heartbeat=${heartbeat}`;
}

async function commandStatus() {
  const state = await readState();
  const items = attentionItems(state);
  const badge = items.length ? items.map((item) => `${item.state}:${item.label}`).join(', ') : 'none';
  const status = await hostStatus();
  const displayed = await readBadgeFile();
  const published = state.updatedAt ? `${Math.round((Date.now() - state.updatedAt) / 1000)}s ago` : 'never';
  const painted = displayed
    ? `displayed=${displayed.count ?? '?'} focused=${displayed.focused}`
    : 'displayed=? (badge.json missing)';
  return (
    `work dot: ${painted} pending=${items.length} [${badge}] mode=${state.mode} ` +
    `host=${describeHost(status)} state=${published} root=${ROOT}`
  );
}

async function commandClear() {
  const state = await readState();
  const cleared = attentionItems(state).length;
  state.panes = {};
  await persist(state);
  void ensureHost('clear').catch(() => {});
  return `work dot: cleared ${cleared} worktree(s)`;
}

async function commandMode() {
  const state = await readState();
  state.mode = state.mode === 'dot' ? 'number' : 'dot';
  await persist(state);
  await ensureHost('mode').catch(() => {});
  return `work dot: mode=${state.mode}`;
}

async function commandRepair() {
  if (process.platform !== 'win32') return 'work dot: the badge host is windows only — nothing to repair';
  await deployHostScript({ force: true });
  const stopped = await stopHost();
  const started = await startHost(START_COMMAND_MS);
  const note = started.starting ? ' (waiting for its first heartbeat)' : '';
  return (
    `work dot: repaired (host pid ${stopped.pid ?? 'none'} -> ${started.pid ?? 'unknown'}, ` +
    `alive=${started.alive}${note})`
  );
}

// ------------------------------------------------------------------ plugin --

export default async function activate(api) {
  const log = (message) => {
    try {
      api.log(`[work-dot] ${message}`);
    } catch {
      // logging must never break a handler
    }
  };

  const run = (name, action) => async (args) => {
    try {
      const text = await action(args);
      log(text);
      return text;
    } catch (error) {
      const message = errorText(error);
      log(`${name} failed: ${message}`);
      return `work dot: ${name} failed — ${message}`;
    }
  };

  const handlers = {
    'agent.status.changed': applyAgentStatus,
    'worktree.created': applyWorktreeCreated,
    'worktree.removed': applyWorktreeRemoved,
  };

  for (const [event, apply] of Object.entries(handlers)) {
    api.events.on(event, (payload) =>
      serialize(async () => {
        try {
          const state = await readState();
          if (!apply(state, payload)) return;
          await persist(state);
          const items = attentionItems(state);
          log(`${event} -> badge=${items.length}`);
          // Never awaited: an event must be acknowledged long before a cold
          // PowerShell + C# start finishes.
          void ensureHost(`event ${event}`).catch((error) => log(`host start failed: ${errorText(error)}`));
        } catch (error) {
          log(`${event} failed: ${errorText(error)}`);
        }
      }),
    );
  }

  api.commands.register('status', run('status', commandStatus));
  api.commands.register('clear', run('clear', () => serialize(commandClear)));
  api.commands.register('mode', run('mode', () => serialize(commandMode)));
  api.commands.register('repair', run('repair', commandRepair));

  try {
    const state = await readState();
    const dropped = Object.keys(state.panes).length;
    await persist(state);
    log(
      `activated (root ${ROOT}); mode=${state.mode} badge=${attentionItems(state).length} ` +
        `panes=${dropped} platform=${process.platform}`,
    );
    // Activation has a ten-second ready budget in Orca; a host start does not
    // fit in it, so the first start is fire-and-forget too.
    void ensureHost('activation').catch((error) => log(`host start failed: ${errorText(error)}`));
  } catch (error) {
    log(`activation sync failed: ${errorText(error)}`);
  }
}

// Worker reaping and Orca shutdown both land here; the badge host is a separate
// process on purpose and keeps the taskbar button showing the last state.
export function deactivate() {}
