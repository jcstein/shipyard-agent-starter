import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** Readers see either the old complete file or the new one, including after a process exits. */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flush: true });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

const queues = new Map<string, Promise<void>>();

/** Queue this process; fail closed if another process (or an interrupted one) owns the file. */
export async function withFileLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  const key = resolve(path);
  const previous = queues.get(key) ?? Promise.resolve();
  let release: () => void = () => {};
  const turn = new Promise<void>((done) => { release = done; });
  const tail = previous.then(() => turn);
  queues.set(key, tail);
  await previous;
  let acquired = false;
  try {
    mkdirSync(dirname(key), { recursive: true });
    try {
      writeFileSync(key, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, { flag: "wx", mode: 0o600 });
      acquired = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      throw new Error(`Locked: ${key}. Another process may still be working. If it was interrupted, stop all writers, inspect the payment traces or published blobs, then remove this lock before retrying. No automatic retry was made.`);
    }
    return await action();
  } finally {
    if (acquired) rmSync(key, { force: true });
    release();
    if (queues.get(key) === tail) queues.delete(key);
  }
}
