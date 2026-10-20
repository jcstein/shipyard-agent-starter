import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MOCHA_CHAIN, MOCHA_PUBLIC_RPC } from "./eden.ts";
import { sha256Hex } from "./hash.ts";

export type PostRecord = {
  at: string;
  lineStart: number;
  lineEnd: number;
  mock: boolean;
  height: number | null;
  commitment: string | null;
  payloadSha256: string;
};

export type PostLog = {
  version: 1;
  chain: typeof MOCHA_CHAIN;
  namespaceId: string;
  namespaceBase64: string;
  posts: PostRecord[];
};

export function v0Namespace(id: string): Buffer {
  const raw = Buffer.from(id, "utf8");
  if (raw.length < 1 || raw.length > 10) {
    throw new Error("namespace id must be 1 to 10 bytes");
  }
  const out = Buffer.alloc(29);
  raw.copy(out, 29 - raw.length);
  return out;
}

export function blobPayload(lines: string[]): string {
  return JSON.stringify({
    app: "shipyard-make-me-money",
    network: MOCHA_CHAIN,
    note: "Receipt log on Mocha testnet. Not revenue and not an Eden payment.",
    lines,
  });
}

export function emptyPostLog(namespaceId: string): PostLog {
  return {
    version: 1,
    chain: MOCHA_CHAIN,
    namespaceId,
    namespaceBase64: v0Namespace(namespaceId).toString("base64"),
    posts: [],
  };
}

export function readPostLog(path: string, namespaceId: string): PostLog {
  if (!existsSync(path)) return emptyPostLog(namespaceId);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as PostLog;
  if (parsed.version !== 1) throw new Error("unsupported posts.json version");
  return parsed;
}

export function writePostLog(path: string, log: PostLog): void {
  const dir = dirname(path);
  if (dir !== "." && dir !== "") mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(log, null, 2)}\n`);
}

export function unpostedLines(lines: string[], log: PostLog): { start: number; lines: string[] } {
  const start = log.posts.reduce((max, post) => Math.max(max, post.lineEnd), 0);
  if (start > lines.length) throw new Error("posts.json points past the end of the receipt log");
  return { start, lines: lines.slice(start) };
}

export function recordMockPost(log: PostLog, lines: string[], start: number, now = new Date()): PostRecord {
  const record: PostRecord = {
    at: now.toISOString(),
    lineStart: start,
    lineEnd: start + lines.length,
    mock: true,
    height: null,
    commitment: null,
    payloadSha256: sha256Hex(blobPayload(lines)),
  };
  log.posts.push(record);
  return record;
}

type RpcBlob = { namespace?: string; data?: string; commitment?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function rpc(
  url: string,
  token: string | null,
  method: string,
  params: unknown[],
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(40_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} HTTP ${res.status}: ${text.slice(0, 240)}`);
  const body = JSON.parse(text) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message ?? "rpc error"}`);
  return body.result ?? null;
}

function asBlob(value: unknown): RpcBlob | null {
  if (!isRecord(value) || typeof value.data !== "string") return null;
  return value as RpcBlob;
}

export async function submitReceiptBlob(input: {
  rpcUrl: string;
  token: string | null;
  namespaceId: string;
  lines: string[];
  fetchImpl?: typeof fetch;
}): Promise<{ height: number; commitment: string; payloadSha256: string }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const namespace = v0Namespace(input.namespaceId).toString("base64");
  const payload = blobPayload(input.lines);
  const heightRaw = await rpc(
    input.rpcUrl,
    input.token,
    "blob.Submit",
    [[{ namespace, data: Buffer.from(payload).toString("base64"), share_version: 0 }], {}],
    fetchImpl,
  );
  const height = typeof heightRaw === "number" ? heightRaw : Number(heightRaw);
  if (!Number.isInteger(height) || height < 1) {
    throw new Error(`blob.Submit returned an unexpected height: ${JSON.stringify(heightRaw)}`);
  }
  const all = await rpc(input.rpcUrl, input.token, "blob.GetAll", [height, [namespace]], fetchImpl);
  const blobs = Array.isArray(all) ? all : [];
  const match = blobs.map(asBlob).find((blob) => {
    if (!blob?.data) return false;
    return Buffer.from(blob.data, "base64").equals(Buffer.from(payload));
  });
  if (!match?.commitment) {
    throw new Error(
      `blob.Submit reported height ${height}, but blob.GetAll did not return this payload yet. Retry verify once the node has the block.`,
    );
  }
  return { height, commitment: match.commitment, payloadSha256: sha256Hex(payload) };
}

export async function fetchReceiptBlob(input: {
  rpcUrl: string;
  token: string | null;
  namespaceId: string;
  height: number;
  commitment: string;
  fetchImpl?: typeof fetch;
}): Promise<Buffer> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const namespace = v0Namespace(input.namespaceId).toString("base64");
  const result = await rpc(
    input.rpcUrl,
    input.token,
    "blob.Get",
    [input.height, namespace, input.commitment],
    fetchImpl,
  );
  const blob = asBlob(result);
  if (!blob?.data) throw new Error("blob.Get did not return data");
  return Buffer.from(blob.data, "base64");
}

export function localPostMatches(lines: string[], post: PostRecord): void {
  const slice = lines.slice(post.lineStart, post.lineEnd);
  const digest = sha256Hex(blobPayload(slice));
  if (digest !== post.payloadSha256) {
    throw new Error(`post at lines ${post.lineStart}-${post.lineEnd} does not match the local receipt lines`);
  }
}

export function mochaReadHint(): string {
  return `Reads can use ${MOCHA_PUBLIC_RPC}. Submitting a blob needs your own light node or a hosted node API with your token.`;
}
