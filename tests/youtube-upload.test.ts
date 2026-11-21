import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CredentialProtector } from "../src/main/services/ai-settings";
import {
  defaultDelay,
  YoutubeSettingsStore,
  YoutubeUploadService,
  type BrowserLauncher,
} from "../src/main/services/youtube-upload";

const roots: string[] = [];
const protector: CredentialProtector = {
  isAvailable: () => true,
  protect: (value) => `protected:${Buffer.from(value).toString("base64")}`,
  unprotect: (value) => Buffer.from(value.replace(/^protected:/, ""), "base64").toString(),
};
const browsers: BrowserLauncher = {
  discover: async () => [
    { id: "CHROME", label: "Google Chrome", available: true },
    { id: "EDGE", label: "Microsoft Edge", available: true },
  ],
  open: vi.fn(async () => ({ browserLabel: "Google Chrome", usedFallback: false })),
};

async function sha256(filePath: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

describe("secure YouTube preview upload", () => {
  it("detaches retry-delay abort listeners after normal completion", async () => {
    const signal = new AbortController().signal;
    const detached = vi.spyOn(signal, "removeEventListener");
    await defaultDelay(1, signal);
    expect(detached).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("rejects retry delays promptly on cancellation", async () => {
    const controller = new AbortController();
    const pending = defaultDelay(10000, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("stores secrets protected and uploads a completed MP4 as unlisted with resumable parameters", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "youtube-upload-"));
    roots.push(root);
    const clientPath = path.join(root, "oauth client 中文.json");
    await writeFile(
      clientPath,
      JSON.stringify({
        installed: { client_id: "12345678.apps.googleusercontent.com", client_secret: "client-secret-private" },
      }),
    );
    const settings = new YoutubeSettingsStore(root, protector, browsers);
    await settings.initialize();
    await settings.importOAuthClient(clientPath);
    await settings.saveConnection("refresh-token-private", "channel-1", "漫步風光");
    const credentialBytes = await readFile(settings.credentialsPath, "utf8");
    expect(credentialBytes).not.toContain("client-secret-private");
    expect(credentialBytes).not.toContain("refresh-token-private");

    const outputPath = path.join(root, "河內 預覽 480p.mp4");
    await writeFile(outputPath, Buffer.alloc(1_024, 7));
    const before = await sha256(outputPath);
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.includes("oauth2.googleapis.com/token"))
        return new Response(JSON.stringify({ access_token: "access-token" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (url.includes("uploadType=resumable"))
        return new Response(null, {
          status: 200,
          headers: { location: "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=test" },
        });
      return new Response(
        JSON.stringify({
          id: "abc12345XYZ",
          snippet: { title: "河內預覽", channelId: "channel-1", channelTitle: "漫步風光" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const progress: number[] = [];
    const result = await new YoutubeUploadService(settings, browsers, fetcher).upload(
      outputPath,
      {
        jobId: "job-1",
        title: "河內預覽",
        description: "人工檢查",
        privacyStatus: "unlisted",
        madeForKids: false,
      },
      undefined,
      (item) => progress.push(item.percent),
    );

    const start = requests.find((item) => item.url.includes("uploadType=resumable"))!;
    expect(start.url).toContain("notifySubscribers=false");
    expect(JSON.parse(String(start.init?.body))).toMatchObject({
      status: { privacyStatus: "unlisted", selfDeclaredMadeForKids: false },
    });
    expect(requests.at(-1)?.init?.headers).toMatchObject({ "content-range": "bytes 0-1023/1024" });
    expect(result).toMatchObject({
      videoId: "abc12345XYZ",
      requestedPrivacyStatus: "unlisted",
      channelTitle: "漫步風光",
    });
    expect(progress.at(-1)).toBe(100);
    expect(await sha256(outputPath)).toBe(before);
  });

  it("blocks a channel mismatch before reading or uploading media chunks", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "youtube-mismatch-"));
    roots.push(root);
    const clientPath = path.join(root, "oauth.json");
    await writeFile(
      clientPath,
      JSON.stringify({
        installed: { client_id: "12345678.apps.googleusercontent.com", client_secret: "secret-value" },
      }),
    );
    const settings = new YoutubeSettingsStore(root, protector, browsers);
    await settings.initialize();
    await settings.importOAuthClient(clientPath);
    await settings.saveConnection("refresh", "channel-2", "另一個頻道");
    const outputPath = path.join(root, "preview.mp4");
    await writeFile(outputPath, "safe-output");
    const fetcher = vi.fn() as unknown as typeof fetch;
    await expect(
      new YoutubeUploadService(settings, browsers, fetcher).upload(outputPath, {
        jobId: "job",
        title: "預覽",
        description: "",
        privacyStatus: "unlisted",
        madeForKids: false,
      }),
    ).rejects.toThrow(/不是目標「漫步風光」/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reports video success separately when thumbnail upload fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "youtube-thumbnail-"));
    roots.push(root);
    const clientPath = path.join(root, "oauth.json");
    await writeFile(
      clientPath,
      JSON.stringify({
        installed: { client_id: "12345678.apps.googleusercontent.com", client_secret: "secret-value" },
      }),
    );
    const settings = new YoutubeSettingsStore(root, protector, browsers);
    await settings.initialize();
    await settings.importOAuthClient(clientPath);
    await settings.saveConnection("refresh", "channel-1", "漫步風光");
    const outputPath = path.join(root, "preview.mp4");
    const thumbnailPath = path.join(root, "thumbnail.jpg");
    await writeFile(outputPath, Buffer.alloc(32, 3));
    await writeFile(thumbnailPath, Buffer.alloc(128, 4));
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("oauth2.googleapis.com/token"))
        return new Response(JSON.stringify({ access_token: "access-token" }), { status: 200 });
      if (url.includes("uploadType=resumable"))
        return new Response(null, {
          status: 200,
          headers: { location: "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=test" },
        });
      if (url.includes("thumbnails/set"))
        return new Response(JSON.stringify({ error: { message: "thumbnail denied" } }), { status: 403 });
      return new Response(
        JSON.stringify({
          id: "abc12345XYZ",
          snippet: { title: "預覽", channelId: "channel-1", channelTitle: "漫步風光" },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const result = await new YoutubeUploadService(settings, browsers, fetcher).upload(outputPath, {
      jobId: "job",
      title: "預覽",
      description: "",
      privacyStatus: "unlisted",
      madeForKids: false,
      thumbnailPath,
    });
    expect(result.videoId).toBe("abc12345XYZ");
    expect(result.thumbnailStatus).toBe("FAILED");
    expect(result.thumbnailError).toMatch(/thumbnail denied|縮圖/);
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining("thumbnails/set"),
      expect.objectContaining({ method: "POST" }),
    );
  });
  it("resends unacknowledged bytes after a 308 without Range and resumes partial chunks exactly", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "youtube-resume-range-"));
    roots.push(root);
    const oauthPath = path.join(root, "oauth.json");
    await writeFile(
      oauthPath,
      JSON.stringify({
        installed: { client_id: "12345678.apps.googleusercontent.com", client_secret: "secret-value" },
      }),
    );
    const settings = new YoutubeSettingsStore(root, protector, browsers);
    await settings.initialize();
    await settings.importOAuthClient(oauthPath);
    await settings.saveConnection("refresh", "channel-1", "漫步風光");
    const filePath = path.join(root, "clip.mp4");
    await writeFile(filePath, Buffer.alloc(1024, 9));
    const transmitted: string[] = [];
    const mockFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("oauth2.googleapis.com/token"))
        return new Response(JSON.stringify({ access_token: "token" }), { status: 200 });
      if (url.includes("uploadType=resumable"))
        return new Response(null, {
          status: 200,
          headers: { location: "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=resume-test" },
        });
      transmitted.push((init?.headers as Record<string, string>)["content-range"]);
      if (transmitted.length === 1) return new Response(null, { status: 308 });
      if (transmitted.length === 2) return new Response(null, { status: 308, headers: { range: "bytes=0-99" } });
      return new Response(JSON.stringify({ id: "abc12345XYZ" }), { status: 200 });
    }) as unknown as typeof fetch;
    const upload = new YoutubeUploadService(settings, browsers, mockFetch, async () => undefined);
    const result = await upload.upload(filePath, {
      jobId: "resume-job",
      title: "完整續傳測試",
      description: "",
      privacyStatus: "unlisted",
      madeForKids: false,
    });
    expect(result.videoId).toBe("abc12345XYZ");
    expect(transmitted).toEqual(["bytes 0-1023/1024", "bytes 0-1023/1024", "bytes 100-1023/1024"]);
  });

  it("queries the resumable session when the last chunk receives 308 with all bytes acknowledged", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "youtube-finalize-308-"));
    roots.push(root);
    const oauthPath = path.join(root, "oauth.json");
    await writeFile(
      oauthPath,
      JSON.stringify({
        installed: { client_id: "12345678.apps.googleusercontent.com", client_secret: "secret-value" },
      }),
    );
    const settings = new YoutubeSettingsStore(root, protector, browsers);
    await settings.initialize();
    await settings.importOAuthClient(oauthPath);
    await settings.saveConnection("refresh", "channel-1", "漫步風光");
    const filePath = path.join(root, "clip.mp4");
    await writeFile(filePath, Buffer.alloc(1024, 9));
    const ranges: string[] = [];
    const mockFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("oauth2.googleapis.com/token"))
        return new Response(JSON.stringify({ access_token: "token" }), { status: 200 });
      if (url.includes("uploadType=resumable"))
        return new Response(null, {
          status: 200,
          headers: { location: "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=finalize-test" },
        });
      ranges.push((init?.headers as Record<string, string>)["content-range"]);
      return ranges.length === 1
        ? new Response(null, { status: 308, headers: { range: "bytes=0-1023" } })
        : new Response(JSON.stringify({ id: "finalized123" }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await new YoutubeUploadService(settings, browsers, mockFetch, async () => undefined).upload(
      filePath,
      {
        jobId: "finalize-job",
        title: "完成後驗證",
        description: "",
        privacyStatus: "unlisted",
        madeForKids: false,
      },
    );
    expect(result.videoId).toBe("finalized123");
    expect(ranges).toEqual(["bytes 0-1023/1024", "bytes */1024"]);
  });

  it("stops safely after five 308 responses with no acknowledged bytes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "youtube-resume-stall-"));
    roots.push(root);
    const oauthPath = path.join(root, "oauth.json");
    await writeFile(
      oauthPath,
      JSON.stringify({
        installed: { client_id: "12345678.apps.googleusercontent.com", client_secret: "secret-value" },
      }),
    );
    const settings = new YoutubeSettingsStore(root, protector, browsers);
    await settings.initialize();
    await settings.importOAuthClient(oauthPath);
    await settings.saveConnection("refresh", "channel-1", "漫步風光");
    const filePath = path.join(root, "clip.mp4");
    await writeFile(filePath, Buffer.alloc(1024, 9));
    let uploads = 0;
    const mockFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("oauth2.googleapis.com/token"))
        return new Response(JSON.stringify({ access_token: "token" }), { status: 200 });
      if (url.includes("uploadType=resumable"))
        return new Response(null, {
          status: 200,
          headers: { location: "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=stall-test" },
        });
      uploads += 1;
      return new Response(null, { status: 308 });
    }) as unknown as typeof fetch;
    const upload = new YoutubeUploadService(settings, browsers, mockFetch, async () => undefined);
    await expect(
      upload.upload(filePath, {
        jobId: "stall-job",
        title: "重試上限測試",
        description: "",
        privacyStatus: "unlisted",
        madeForKids: false,
      }),
    ).rejects.toThrow(/多次未確認/);
    expect(uploads).toBe(5);
  });
});
