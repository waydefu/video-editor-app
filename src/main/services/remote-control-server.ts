import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import QRCode from "qrcode";
import type { RemoteControlStatus, RemoteRenderSnapshot } from "../../shared/domain";
import { REMOTE_CSS, REMOTE_HTML, REMOTE_JS } from "./remote-control-ui";
import type { RenderCommandState } from "./render-command-state";

const PAIRING_TTL_MS = 10 * 60_000;
const SESSION_TTL_MS = 8 * 60 * 60_000;
const SESSION_IDLE_MS = 30 * 60_000;
const MAX_BODY_BYTES = 4_096;

interface PairingSecret {
  tokenHash: string;
  expiresAt: number;
  consumed: boolean;
}

interface SessionRecord {
  expiresAt: number;
  lastSeenAt: number;
  remoteAddress: string;
  csrfHash: string;
  cancelNonceHash?: string;
  cancelNonceExpiresAt?: number;
  cancelJobGeneration?: number;
}

interface RateRecord {
  startedAt: number;
  count: number;
}

function token(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeAddress(value?: string): string {
  const raw = value ?? "";
  return raw.startsWith("::ffff:") ? raw.slice(7) : raw;
}

export function isPrivateLanAddress(value?: string): boolean {
  const address = normalizeAddress(value);
  if (address === "127.0.0.1" || address === "::1") return true;
  if (/^10\./.test(address) || /^192\.168\./.test(address)) return true;
  const match = /^172\.(\d{1,3})\./.exec(address);
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true;
  return /^169\.254\./.test(address) || /^f[cd][0-9a-f]{2}:/i.test(address);
}

function lanAddresses(): string[] {
  const result = new Set<string>();
  for (const records of Object.values(networkInterfaces())) {
    for (const record of records ?? []) {
      if (record.family !== "IPv4" || record.internal || !isPrivateLanAddress(record.address)) continue;
      result.add(record.address);
    }
  }
  const priority = (address: string) => (address.startsWith("192.168.") ? 0 : address.startsWith("10.") ? 1 : 2);
  return [...result].sort((left, right) => priority(left) - priority(right) || left.localeCompare(right));
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  response.end(JSON.stringify(body));
}

function text(response: ServerResponse, status: number, contentType: string, body: string): void {
  response.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  });
  response.end(body);
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("請求內容過大。");
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("請求格式無效。");
  return parsed as Record<string, unknown>;
}

export class RemoteControlServer {
  private server?: Server;
  private pairing?: PairingSecret;
  private rawPairingToken?: string;
  private port?: number;
  private addresses: string[] = [];
  private qrDataUrl?: string;
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly clients = new Map<ServerResponse, SessionRecord>();
  private readonly rates = new Map<string, RateRecord>();
  private readonly pairingRates = new Map<string, RateRecord>();
  private unsubscribe?: () => void;
  private statusListener?: (status: RemoteControlStatus) => void;

  constructor(private readonly renderState: RenderCommandState) {}

  setStatusListener(listener: (status: RemoteControlStatus) => void): void {
    this.statusListener = listener;
  }

  async start(): Promise<RemoteControlStatus> {
    if (this.server) return this.status();
    this.addresses = lanAddresses();
    const server = createServer((request, response) => void this.handle(request, response));
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, this.addresses[0] ?? "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
      this.port = (server.address() as { port: number }).port;
      this.unsubscribe = this.renderState.subscribe((snapshot) => this.broadcast(snapshot));
      await this.rotatePairing();
      return this.status();
    } catch (error) {
      // A failed bind or QR setup must not leave a phantom "enabled" server.
      if (server.listening) await this.stop();
      else {
        this.server = undefined;
        this.port = undefined;
        this.pairing = undefined;
        this.rawPairingToken = undefined;
        this.qrDataUrl = undefined;
        this.notifyStatus();
      }
      throw error;
    }
  }

  async stop(): Promise<RemoteControlStatus> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const client of this.clients.keys()) client.end();
    this.clients.clear();
    this.sessions.clear();
    this.rates.clear();
    this.pairingRates.clear();
    this.pairing = undefined;
    this.rawPairingToken = undefined;
    this.qrDataUrl = undefined;
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    this.port = undefined;
    this.notifyStatus();
    return this.status();
  }

  async rotatePairing(): Promise<RemoteControlStatus> {
    if (!this.server || !this.port) throw new Error("請先啟動 iPhone 遠端控制。");
    const raw = token();
    this.rawPairingToken = raw;
    this.pairing = { tokenHash: hash(raw), expiresAt: Date.now() + PAIRING_TTL_MS, consumed: false };
    const url = this.pairingUrl();
    this.qrDataUrl = await QRCode.toDataURL(url, { width: 320, margin: 2, errorCorrectionLevel: "M" });
    this.notifyStatus();
    return this.status();
  }

  status(): RemoteControlStatus {
    return {
      enabled: Boolean(this.server),
      port: this.port,
      addresses: [...this.addresses],
      pairingUrl: this.server && this.pairing && !this.pairing.consumed ? this.pairingUrl() : undefined,
      qrDataUrl: this.server && this.pairing && !this.pairing.consumed ? this.qrDataUrl : undefined,
      pairingExpiresAt: this.pairing ? new Date(this.pairing.expiresAt).toISOString() : undefined,
      render: this.renderState.snapshot(),
    };
  }

  private pairingUrl(): string {
    const address = this.addresses[0] ?? "127.0.0.1";
    return `http://${address}:${this.port}/#pair=${encodeURIComponent(this.rawPairingToken ?? "")}`;
  }

  private notifyStatus(): void {
    this.statusListener?.(this.status());
  }

  private allowedOrigin(request: IncomingMessage): boolean {
    const origin = request.headers.origin;
    if (!origin) return true;
    if (!this.port) return false;
    return ["127.0.0.1", "localhost", ...this.addresses].some((address) => origin === `http://${address}:${this.port}`);
  }

  private allowedHost(request: IncomingMessage): boolean {
    if (!this.port) return false;
    const host = request.headers.host ?? "";
    return ["127.0.0.1", "localhost", ...this.addresses].some((address) => host === `${address}:${this.port}`);
  }

  private rateAllowed(request: IncomingMessage): boolean {
    const key = normalizeAddress(request.socket.remoteAddress);
    const now = Date.now();
    const current = this.rates.get(key);
    if (!current || now - current.startedAt > 60_000) {
      this.rates.set(key, { startedAt: now, count: 1 });
      return true;
    }
    current.count += 1;
    return current.count <= 120;
  }

  private pairingAllowed(request: IncomingMessage): boolean {
    const key = normalizeAddress(request.socket.remoteAddress);
    const now = Date.now();
    const current = this.pairingRates.get(key);
    if (!current || now - current.startedAt > 10 * 60_000) {
      this.pairingRates.set(key, { startedAt: now, count: 1 });
      return true;
    }
    current.count += 1;
    return current.count <= 10;
  }

  private sessionValid(session: SessionRecord): boolean {
    const now = Date.now();
    return session.expiresAt > now && now - session.lastSeenAt <= SESSION_IDLE_MS;
  }

  private authenticate(request: IncomingMessage): SessionRecord | undefined {
    const match = /(?:^|;\s*)scenery_remote=([A-Za-z0-9_-]{40,})(?:;|$)/.exec(request.headers.cookie ?? "");
    if (!match) return undefined;
    const key = hash(match[1]);
    const session = this.sessions.get(key);
    const now = Date.now();
    if (!session || !this.sessionValid(session)) {
      this.sessions.delete(key);
      return undefined;
    }
    if (session.remoteAddress !== normalizeAddress(request.socket.remoteAddress)) return undefined;
    const csrf = request.headers["x-scenery-csrf"];
    if (typeof csrf !== "string" || hash(csrf) !== session.csrfHash) return undefined;
    session.lastSeenAt = now;
    return session;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (
        !isPrivateLanAddress(request.socket.remoteAddress) ||
        !this.allowedHost(request) ||
        !this.allowedOrigin(request)
      ) {
        json(response, 403, { error: "只允許同一區域網路的安全連線。" });
        return;
      }
      if (!this.rateAllowed(request)) {
        json(response, 429, { error: "請求過於頻繁，請稍後再試。" });
        return;
      }
      const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
      if (request.method === "GET" && url.pathname === "/")
        return text(response, 200, "text/html; charset=utf-8", REMOTE_HTML);
      if (request.method === "GET" && url.pathname === "/styles.css")
        return text(response, 200, "text/css; charset=utf-8", REMOTE_CSS);
      if (request.method === "GET" && url.pathname === "/app.js")
        return text(response, 200, "text/javascript; charset=utf-8", REMOTE_JS);
      if (request.method === "POST" && url.pathname === "/api/pair") {
        if (!this.pairingAllowed(request)) {
          json(response, 429, { error: "配對失敗次數過多，請在 Windows 端重新產生 QR Code 後稍候再試。" });
          return;
        }
        const body = await readJsonBody(request);
        const raw = typeof body.token === "string" ? body.token : "";
        if (
          !this.pairing ||
          this.pairing.consumed ||
          this.pairing.expiresAt <= Date.now() ||
          hash(raw) !== this.pairing.tokenHash
        ) {
          json(response, 401, { error: "一次性配對連結無效或已使用，請在 Windows 端重新產生。" });
          return;
        }
        this.pairing.consumed = true;
        this.rawPairingToken = undefined;
        const sessionToken = token(36);
        const csrfToken = token(24);
        this.sessions.set(hash(sessionToken), {
          expiresAt: Date.now() + SESSION_TTL_MS,
          lastSeenAt: Date.now(),
          remoteAddress: normalizeAddress(request.socket.remoteAddress),
          csrfHash: hash(csrfToken),
        });
        this.pairingRates.delete(normalizeAddress(request.socket.remoteAddress));
        this.notifyStatus();
        response.setHeader(
          "Set-Cookie",
          `scenery_remote=${sessionToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
        );
        json(response, 200, { csrfToken, expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString() });
        return;
      }
      const authenticatedSession = this.authenticate(request);
      if (!authenticatedSession) {
        json(response, 401, { error: "遠端控制授權已失效，請重新掃描 QR Code。" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/state") {
        json(response, 200, { render: this.renderState.snapshot() });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/events") {
        response.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        const initial = this.renderState.snapshot();
        response.write(`id: ${initial.revision}\nevent: snapshot\ndata:${JSON.stringify(initial)}\n\n`);
        const keepAlive = setInterval(() => {
          if (!this.sessionValid(authenticatedSession)) response.end();
          else response.write(": keepalive\n\n");
        }, 15_000);
        this.clients.set(response, authenticatedSession);
        response.once("close", () => {
          clearInterval(keepAlive);
          this.clients.delete(response);
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/command/cancel-intent") {
        await readJsonBody(request);
        if (!["RUNNING", "PAUSING", "PAUSED"].includes(this.renderState.snapshot().state)) {
          json(response, 409, { error: "目前沒有可取消的轉檔工作。" });
          return;
        }
        const cancelNonce = token(24);
        authenticatedSession.cancelNonceHash = hash(cancelNonce);
        authenticatedSession.cancelNonceExpiresAt = Date.now() + 30_000;
        authenticatedSession.cancelJobGeneration = this.renderState.currentJobGeneration();
        json(response, 200, {
          cancelNonce,
          expiresAt: new Date(authenticatedSession.cancelNonceExpiresAt).toISOString(),
        });
        return;
      }
      const command =
        request.method === "POST" ? /^\/api\/command\/(start|pause|resume|cancel)$/.exec(url.pathname)?.[1] : undefined;
      if (command) {
        const body = await readJsonBody(request);
        if (
          command === "cancel" &&
          (body.confirmation !== "CANCEL" ||
            typeof body.cancelNonce !== "string" ||
            !authenticatedSession.cancelNonceHash ||
            authenticatedSession.cancelNonceExpiresAt! <= Date.now() ||
            hash(body.cancelNonce) !== authenticatedSession.cancelNonceHash ||
            authenticatedSession.cancelJobGeneration !== this.renderState.currentJobGeneration() ||
            !["RUNNING", "PAUSING", "PAUSED"].includes(this.renderState.snapshot().state))
        ) {
          json(response, 409, { error: "取消轉檔需要第二次確認。" });
          return;
        }
        if (command === "cancel") {
          authenticatedSession.cancelNonceHash = undefined;
          authenticatedSession.cancelNonceExpiresAt = undefined;
          authenticatedSession.cancelJobGeneration = undefined;
        }
        if (command === "start") await this.renderState.startPrepared();
        if (command === "pause") this.renderState.requestPause();
        if (command === "resume") await this.renderState.resumeCheckpoint();
        if (command === "cancel") await this.renderState.cancel();
        json(response, 202, { accepted: true, render: this.renderState.snapshot() });
        return;
      }
      json(response, 404, { error: "找不到此遠端控制功能。" });
    } catch (error) {
      json(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private broadcast(snapshot: RemoteRenderSnapshot): void {
    const packet = `id: ${snapshot.revision}\nevent: snapshot\ndata:${JSON.stringify(snapshot)}\n\n`;
    for (const [client, session] of this.clients) {
      if (!this.sessionValid(session)) client.end();
      else client.write(packet);
    }
    this.notifyStatus();
  }
}
