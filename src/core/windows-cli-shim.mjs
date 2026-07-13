import { spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { win32 } from 'node:path';

// Windows の npm global CLI は多くが `<name>.cmd` shim であり、Node の shell:false
// 直接 spawn では PATHEXT 解決されない。cmd.exe を明示して Node 24 の shell:true
// deprecation を避けつつ、POSIX と実体 .exe は従来どおり直接起動する。
export function buildWindowsCompatibleInvocation({
  command,
  args = [],
  platform = process.platform,
  env = process.env,
  processExecPath = process.execPath,
  fileExistsFn = defaultFileExists,
  readFileFn = defaultReadFile,
  allowCmdFallback = true,
} = {}) {
  if (typeof command !== 'string' || command.length === 0) {
    throw new TypeError('buildWindowsCompatibleInvocation: command must be a non-empty string');
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    throw new TypeError('buildWindowsCompatibleInvocation: args must be an array of strings');
  }
  if (platform !== 'win32' || /\.exe$/i.test(command)) {
    return { command, args };
  }
  const direct = resolveWindowsNpmShim({
    command,
    args,
    env,
    processExecPath,
    fileExistsFn,
    readFileFn,
  });
  if (direct) return direct;
  if (!allowCmdFallback) {
    const error = new Error(`Windows CLI shim could not be resolved safely: ${command}`);
    error.code = 'E_WINDOWS_CLI_SHIM_UNRESOLVED';
    throw error;
  }
  return {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', command, ...args],
  };
}

export function resolveWindowsNpmShim({
  command,
  args = [],
  env = process.env,
  processExecPath = process.execPath,
  fileExistsFn = defaultFileExists,
  readFileFn = defaultReadFile,
} = {}) {
  const pathValue = env?.Path ?? env?.PATH ?? env?.path ?? '';
  const hasPathSeparator = /[\\/]/.test(command);
  const candidates = [];
  if (hasPathSeparator) {
    candidates.push(command);
    if (!/\.[^\\/]+$/.test(command)) candidates.push(`${command}.exe`, `${command}.cmd`);
  } else {
    for (const rawDir of String(pathValue).split(';')) {
      const dir = rawDir.trim();
      if (!dir) continue;
      candidates.push(win32.join(dir, `${command}.exe`), win32.join(dir, `${command}.cmd`));
    }
  }

  for (const candidate of candidates) {
    if (!fileExistsFn(candidate)) continue;
    if (/\.exe$/i.test(candidate)) return { command: candidate, args };
    if (!/\.cmd$/i.test(candidate)) continue;
    const script = npmShimEntryPath(readFileFn(candidate), win32.dirname(candidate));
    if (!script || !fileExistsFn(script)) continue;
    const bundledNode = win32.join(win32.dirname(candidate), 'node.exe');
    return {
      command: fileExistsFn(bundledNode) ? bundledNode : processExecPath,
      args: [script, ...args],
    };
  }
  return null;
}

export function npmShimEntryPath(source, shimDir) {
  if (typeof source !== 'string') return null;
  const match = source.match(/"%dp0%\\(node_modules\\[^"\r\n]+\.(?:cjs|mjs|js))"\s+%\*\s*$/im);
  if (!match) return null;
  const segments = match[1].split(/[\\/]/);
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
  return win32.join(shimDir, ...segments);
}

// cmd.exe shim のみ kill すると孫の CLI が残り得るため、Windows は process tree を
// taskkill で終了する。taskkill 自体の起動・終了に失敗した時だけ direct kill へ戻す。
export function terminateProcessTree(child, {
  platform = process.platform,
  spawnFn = spawn,
  timeoutMs = 5_000,
} = {}) {
  if (!child || typeof child.kill !== 'function') return Promise.resolve();
  if (platform !== 'win32' || !Number.isSafeInteger(child.pid) || child.pid <= 0) {
    child.kill();
    return Promise.resolve();
  }

  const fallback = () => {
    try { child.kill(); } catch { /* process may already have exited */ }
  };
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        fallback();
        reject(error);
      } else {
        resolve();
      }
    };
    const timer = setTimeout(() => {
      const error = new Error(`taskkill did not finish within ${timeoutMs}ms`);
      error.code = 'E_PROCESS_TREE_TERMINATION_TIMEOUT';
      finish(error);
    }, timeoutMs);
    try {
      const killer = spawnFn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.once('error', (cause) => {
        const error = new Error(`taskkill failed to start: ${cause.message}`);
        error.code = 'E_PROCESS_TREE_TERMINATION';
        error.cause = cause;
        finish(error);
      });
      killer.once('close', (code) => {
        if (code === 0) {
          finish();
          return;
        }
        const error = new Error(`taskkill exited with code ${code}`);
        error.code = 'E_PROCESS_TREE_TERMINATION';
        finish(error);
      });
    } catch (cause) {
      const error = new Error(`taskkill spawn failed: ${cause.message}`);
      error.code = 'E_PROCESS_TREE_TERMINATION';
      error.cause = cause;
      finish(error);
    }
  });
}

function defaultFileExists(path) {
  try { return statSync(path).isFile(); } catch { return false; }
}

function defaultReadFile(path) {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}
