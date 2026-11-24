import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { AppUpdateStatus } from "../../shared/domain";
import { finalizePartialOutput } from "./atomic-output";

const REPOSITORY = "waydefu/video-editor-app";
const RELEASES = `https://github.com/${REPOSITORY}/releases`;
const API = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
const ARCHIVE = "scenerywalker-portable-win-x64.zip";
const MANIFEST = "scenerywalker-portable-update.json";
const MAX_ARCHIVE_BYTES = 1024 ** 3;
const MAX_METADATA_BYTES = 256 * 1024;

export interface PortableManifest {
  schemaVersion: 1;
  version: string;
  file: string;
  bytes: number;
  sha256: string;
}

function versionParts(version: string): number[] {
  if (!/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(version))
    throw new Error("不支援的版本格式。");
  return version.split(".").map(Number);
}

export function compareVersions(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

export function verifyPortableManifest(raw: string, publicKey: string, expectedVersion: string): PortableManifest {
  const envelope = JSON.parse(raw) as { payload?: unknown; signature?: unknown };
  if (typeof envelope.payload !== "string" || typeof envelope.signature !== "string")
    throw new Error("更新簽章格式無效。");
  const payload = Buffer.from(envelope.payload, "base64");
  const signature = Buffer.from(envelope.signature, "base64");
  const key = createPublicKey(publicKey);
  if (key.asymmetricKeyType !== "ed25519" || signature.length !== 64 || !verify(null, payload, key, signature))
    throw new Error("更新簽章驗證失敗。");
  const manifest = JSON.parse(payload.toString("utf8")) as PortableManifest;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.version !== expectedVersion ||
    manifest.file !== ARCHIVE ||
    !Number.isSafeInteger(manifest.bytes) ||
    manifest.bytes <= 0 ||
    manifest.bytes > MAX_ARCHIVE_BYTES ||
    typeof manifest.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(manifest.sha256)
  )
    throw new Error("更新資訊與預期版本不符。");
  versionParts(manifest.version);
  return manifest;
}

function assetUrl(version: string, name: string): string {
  versionParts(version);
  return `${RELEASES}/download/v${version}/${name}`;
}

async function getResponse(fetcher: typeof fetch, initialUrl: string, timeoutMs: number): Promise<Response> {
  let url = new URL(initialUrl);
  const signal = AbortSignal.timeout(timeoutMs);
  for (let redirects = 0; redirects <= 4; redirects++) {
    if (
      url.protocol !== "https:" ||
      url.port ||
      url.username ||
      url.password ||
      !["api.github.com", "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(
        url.hostname,
      )
    )
      throw new Error("拒絕不可信的更新下載來源。");
    const response = await fetcher(url, { redirect: "manual", signal, headers: { Accept: "*/*" } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("更新下載重新導向無效。");
      url = new URL(location, url);
      continue;
    }
    return response;
  }
  throw new Error("更新下載重新導向過多。");
}

async function* chunks(response: Response, limit: number): AsyncGenerator<Uint8Array> {
  if (!response.ok || !response.body) throw new Error(`更新服務回傳 HTTP ${response.status}。`);
  const reader = response.body.getReader();
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > limit) throw new Error("更新資料超過允許大小。");
      yield next.value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function metadata(response: Response): Promise<string> {
  const buffers: Buffer[] = [];
  for await (const chunk of chunks(response, MAX_METADATA_BYTES)) buffers.push(Buffer.from(chunk));
  return Buffer.concat(buffers).toString("utf8");
}

async function fileDigest(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

/** Only official, signed stable packages are staged. No downloaded program is executed here. */
export class PortableUpdateService {
  private busy = false;
  private staged?: { filePath: string; manifest: PortableManifest };

  constructor(
    private readonly currentVersion: string,
    private readonly enabled: boolean,
    private readonly root: string,
    private readonly publicKeyPath: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private result(state: AppUpdateStatus["state"], message: string, version?: string): AppUpdateStatus {
    return { state, currentVersion: this.currentVersion, latestVersion: version, message };
  }

  private async discover(): Promise<{ status: AppUpdateStatus; manifest?: PortableManifest }> {
    if (!this.enabled) return { status: this.result("DISABLED", "僅正式 Windows 封裝支援更新檢查。") };
    const response = await getResponse(this.fetcher, API, 30_000);
    if (response.status === 404) return { status: this.result("CURRENT", "目前尚無正式發布版本。") };
    const release = JSON.parse(await metadata(response)) as {
      tag_name?: string;
      draft?: boolean;
      prerelease?: boolean;
      assets?: Array<{ name?: string }>;
    };
    const version = release.tag_name?.replace(/^v/, "");
    if (!version || release.tag_name !== `v${version}` || release.draft || release.prerelease)
      throw new Error("未找到有效的正式版本。");
    if (compareVersions(version, this.currentVersion) <= 0)
      return { status: this.result("CURRENT", "目前已是最新正式版本。", version) };
    const names = release.assets?.map((asset) => asset.name) ?? [];
    if (!names.includes(ARCHIVE) || !names.includes(MANIFEST))
      return { status: this.result("MANUAL", "新版尚未提供已簽署的 Windows 可攜套件。", version) };
    const publicKey = await readFile(this.publicKeyPath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!publicKey)
      return { status: this.result("MANUAL", "本版本尚未內建更新驗證金鑰，請至官方發布頁手動更新。", version) };
    const raw = await metadata(await getResponse(this.fetcher, assetUrl(version, MANIFEST), 30_000));
    const manifest = verifyPortableManifest(raw, publicKey, version);
    return { status: this.result("AVAILABLE", "已驗證新版資訊，可下載到獨立位置。", version), manifest };
  }

  async check(): Promise<AppUpdateStatus> {
    return (await this.discover()).status;
  }

  async download(): Promise<AppUpdateStatus> {
    if (this.busy) throw new Error("已有更新下載正在進行。");
    this.busy = true;
    let partial: string | undefined;
    try {
      const { status, manifest } = await this.discover();
      if (!manifest) return status;
      await mkdir(this.root, { recursive: true });
      const filePath = path.join(this.root, `SceneryWalker-v${manifest.version}-${manifest.sha256.slice(0, 12)}.zip`);
      const existing = await stat(filePath).catch(() => undefined);
      if (existing?.isFile() && existing.size === manifest.bytes && (await fileDigest(filePath)) === manifest.sha256) {
        this.staged = { filePath, manifest };
        return this.result("READY", "已驗證更新套件，可在完成工作後手動切換。", manifest.version);
      }
      partial = `${filePath}.${randomUUID()}.partial`;
      const response = await getResponse(this.fetcher, assetUrl(manifest.version, ARCHIVE), 20 * 60_000);
      const file = await open(partial, "wx");
      const hash = createHash("sha256");
      let bytes = 0;
      try {
        for await (const chunk of chunks(response, manifest.bytes)) {
          hash.update(chunk);
          bytes += chunk.byteLength;
          await file.writeFile(chunk);
        }
        if (bytes !== manifest.bytes || hash.digest("hex") !== manifest.sha256)
          throw new Error("下載檔案大小或 SHA-256 不符，已拒絕更新。");
        await file.sync();
      } finally {
        await file.close();
      }
      await finalizePartialOutput(partial, filePath);
      this.staged = { filePath, manifest };
      return this.result("READY", "更新套件已下載及驗證，可在完成工作後手動切換。", manifest.version);
    } finally {
      if (partial) await rm(partial, { force: true }).catch(() => undefined);
      this.busy = false;
    }
  }

  async verifiedArchive(): Promise<string> {
    const staged = this.staged;
    if (
      !staged ||
      (await stat(staged.filePath)).size !== staged.manifest.bytes ||
      (await fileDigest(staged.filePath)) !== staged.manifest.sha256
    )
      throw new Error("找不到完整的已驗證套件，請重新下載。");
    return staged.filePath;
  }
}

export const officialReleasesUrl = RELEASES;
