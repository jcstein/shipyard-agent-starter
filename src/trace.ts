import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REDACTED = "[redacted]";
const TRACE_FETCH = Symbol.for("shipyard.traceFetch");

export type TraceExchange = {
  at: string;
  step: string;
  method: string;
  url: string;
  request: { headers: Record<string, string>; body: unknown };
  response: { status: number; headers: Record<string, string>; body: unknown };
};

export type PaymentTraceFile = {
  version: 1;
  startedAt: string;
  signField: string;
  retryOtherSignField: boolean;
  note: string;
  exchanges: TraceExchange[];
};

export type Tracer = {
  path: string;
  record(exchange: TraceExchange): void;
  flush(): void;
};

type TraceFetch = typeof fetch & { [TRACE_FETCH]?: boolean };

export function isTraceFetch(fn: typeof fetch): boolean {
  return (fn as TraceFetch)[TRACE_FETCH] === true;
}

function secretNeedles(secrets: string[]): string[] {
  const needles: string[] = [];
  for (const secret of secrets) {
    const trimmed = secret.trim();
    if (trimmed.length < 16) continue;
    needles.push(trimmed);
    const hex = trimmed.startsWith("0x") || trimmed.startsWith("0X") ? trimmed.slice(2) : trimmed;
    if (/^[0-9a-fA-F]{64}$/.test(hex)) {
      needles.push(hex);
      needles.push(`0x${hex}`);
      needles.push(`0X${hex}`);
    }
  }
  return [...new Set(needles)];
}

function scrub(text: string, needles: string[]): string {
  let out = text;
  for (const needle of needles) {
    if (/^[0-9a-fA-Fx]+$/.test(needle)) {
      out = out.replace(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), REDACTED);
    } else {
      out = out.split(needle).join(REDACTED);
    }
  }
  return out;
}

function isSecretKey(key: string, parent: string | null): boolean {
  const flat = key.replace(/[_-]/g, "").toLowerCase();
  if (flat === "privatekey" || flat === "cookie" || flat === "setcookie") return true;
  // HTTP Authorization is a credential. A JSON field named authorization is the
  // gate Authorization, which the receipt stores only as a sha256.
  return flat === "authorization" && parent === "headers";
}

/** Deep-copy `value`, removing private keys and other configured secrets. */
export function redactSecrets<T>(value: T, secrets: string[]): T {
  const needles = secretNeedles(secrets);
  const walk = (item: unknown, parent: string | null): unknown => {
    if (typeof item === "string") return scrub(item, needles);
    if (typeof item === "number" || typeof item === "boolean" || item === null) return item;
    if (Array.isArray(item)) return item.map((child) => walk(child, parent));
    if (typeof item === "object" && item !== null) {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(item)) {
        out[key] = isSecretKey(key, parent) ? REDACTED : walk(child, key);
      }
      return out;
    }
    return item;
  };
  return walk(value, null) as T;
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) out[key] = value;
    return out;
  }
  return { ...headers };
}

function responseHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function parseBody(text: string): unknown {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function requestBody(body: BodyInit | null | undefined): unknown {
  if (typeof body === "string") return parseBody(body);
  if (body == null) return null;
  return "[unrecorded body]";
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function inferStep(url: string, headers: Record<string, string>): string {
  if (url.includes("/deposit/build")) return "deposit-build";
  if (url.includes("/deposit/send")) return "deposit-send";
  if (url.includes("/deposit/status")) return "deposit-status";
  if (url.includes("/chat/completions")) {
    const signed = headers["payment-signature"] ?? headers["Payment-Signature"];
    return signed ? "paid-retry" : "quote";
  }
  return "http";
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(".", "");
}

export function openPaymentTrace(
  options: { dir: string; signField: string; retryOtherSignField: boolean; secrets: string[] },
  now = new Date(),
): Tracer {
  mkdirSync(options.dir, { recursive: true });
  const path = join(options.dir, `${stamp(now)}.json`);
  const file: PaymentTraceFile = {
    version: 1,
    startedAt: now.toISOString(),
    signField: options.signField,
    retryOtherSignField: options.retryOtherSignField,
    note: "Redacted HTTP trace of one live Houston payment. The private key is removed. The signed deposit transaction and Payment-Signature are included; do not commit this file.",
    exchanges: [],
  };
  const write = () => writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
  write();
  return {
    path,
    record(exchange) {
      file.exchanges.push(redactSecrets(exchange, options.secrets));
      try {
        write();
      } catch (error) {
        console.error(`trace write failed: ${error instanceof Error ? error.message : error}`);
      }
    },
    flush: write,
  };
}

/** Record each HTTP exchange, then return a fresh Response whose body can still be read. */
export function tracingFetch(inner: typeof fetch, tracer: Tracer): typeof fetch {
  const wrapped: TraceFetch = async (input, init) => {
    const url = requestUrl(input);
    const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
    const headers = headersToRecord(init?.headers);
    const explicit = headers["x-shipyard-trace-step"];
    delete headers["x-shipyard-trace-step"];
    const step = explicit || inferStep(url, headers);
    const request = { headers, body: requestBody(init?.body) };
    let res: Response;
    try {
      res = await inner(url, { ...init, headers });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      tracer.record({
        at: new Date().toISOString(),
        step,
        method,
        url,
        request,
        response: { status: 0, headers: {}, body: { error: message } },
      });
      throw error;
    }
    const text = await res.text();
    tracer.record({
      at: new Date().toISOString(),
      step,
      method,
      url,
      request,
      response: { status: res.status, headers: responseHeaders(res.headers), body: parseBody(text) },
    });
    const outbound = new Headers(res.headers);
    outbound.delete("content-encoding");
    outbound.delete("content-length");
    return new Response(text, { status: res.status, statusText: res.statusText, headers: outbound });
  };
  wrapped[TRACE_FETCH] = true;
  return wrapped;
}
