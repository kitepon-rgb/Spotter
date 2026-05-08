// Phase B (hook parity, 2026-05-08): host-neutral pending-context queue.
//
// Stop hook が pass:false を出した時、当ターンで block するのではなく次の UserPromptSubmit
// で `additionalContext` として配信するための queue ファイル。Claude / Codex 両 host から
// 同じヘルパを通すことで、ファイル形式・パス命名を統一する。
//
// File path: `<projectRoot>/.spotter/pending/<sanitizedSessionId>.json`
// File format: JSON 配列 `[<text>, <text>, ...]` (Codex 側 `codex-pending/` 既存形式と互換)
//
// 同 session 内のみ参照される。drain (= UserPromptSubmit が読み出す) で file は削除される。
// session が事故等で残った pending file は次 session の sanitizedSessionId と一致しない
// 限り読まれない (= 副作用なし) ので、cleanup は best-effort。

import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const PENDING_DIR = 'pending';

export function pendingPath({ projectRoot, sessionId } = {}) {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) return null;
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
  const clean = sessionId.replace(/[^A-Za-z0-9_-]/g, '');
  if (!clean) return null;
  return join(projectRoot, '.spotter', PENDING_DIR, `${clean}.json`);
}

export async function readPendingContexts(path) {
  if (typeof path !== 'string' || path.length === 0) return [];
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
      : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

export async function appendPendingContext({ projectRoot, sessionId, text } = {}) {
  const path = pendingPath({ projectRoot, sessionId });
  const value = String(text ?? '').trim();
  if (!path || !value) return false;
  const contexts = await readPendingContexts(path);
  // De-dupe so repeated identical findings within the same session don't pile up.
  if (!contexts.includes(value)) contexts.push(value);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(contexts, null, 2) + '\n', 'utf8');
  return true;
}

export async function drainPendingContexts({ projectRoot, sessionId } = {}) {
  const path = pendingPath({ projectRoot, sessionId });
  if (!path) return [];
  const contexts = await readPendingContexts(path);
  if (contexts.length > 0) {
    try {
      await unlink(path);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  return contexts;
}
