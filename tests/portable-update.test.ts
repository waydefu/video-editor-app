import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { compareVersions, PortableUpdateService, verifyPortableManifest } from "../src/main/services/portable-update";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const archive = Buffer.from("fixture archive");
const manifest = {
  schemaVersion: 1,
  version: "0.89.0",
  file: "scenerywalker-portable-win-x64.zip",
  bytes: archive.length,
  sha256: createHash("sha256").update(archive).digest("hex"),
};

function signed(payload: unknown): string {
  const bytes = Buffer.from(JSON.stringify(payload));
  return JSON.stringify({
    payload: bytes.toString("base64"),
    signature: sign(null, bytes, privateKey).toString("base64"),
  });
}

function mockFetch(bytes = archive) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.endsWith("/releases/latest"))
      return Response.json({
        tag_name: "v0.89.0",
        draft: false,
        prerelease: false,
        assets: [{ name: manifest.file }, { name: "scenerywalker-portable-update.json" }],
      });
    if (url.endsWith(".json")) return new Response(signed(manifest));
    return new Response(new Uint8Array(bytes));
  });
}

describe("portable updates", () => {
  it("compares numeric stable versions and rejects malformed versions", () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("0.88.0", "0.88.0")).toBe(0);
    expect(() => compareVersions("0.89.0-beta", "0.88.0")).toThrow();
  });

  it("rejects modified signatures, wrong versions and signed traversal filenames", () => {
    const envelope = JSON.parse(signed(manifest));
    envelope.payload = Buffer.from(JSON.stringify({ ...manifest, version: "0.99.0" })).toString("base64");
    expect(() => verifyPortableManifest(JSON.stringify(envelope), publicPem, "0.99.0")).toThrow(/簽章/);
    expect(() => verifyPortableManifest(signed(manifest), publicPem, "0.90.0")).toThrow();
    expect(() => verifyPortableManifest(signed({ ...manifest, file: "../evil.zip" }), publicPem, "0.89.0")).toThrow();
  });

  it("never fetches updates in development or accepts a downgrade", async () => {
    const fetcher = mockFetch();
    const disabled = new PortableUpdateService("0.88.0", false, "unused", "unused", fetcher);
    expect((await disabled.check()).state).toBe("DISABLED");
    expect(fetcher).not.toHaveBeenCalled();
    const newer = new PortableUpdateService("0.90.0", true, "unused", "unused", fetcher);
    expect((await newer.check()).state).toBe("CURRENT");
  });

  it("rejects unsigned bootstrap and never creates a staged package", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "portable-update-"));
    try {
      const fetcher = mockFetch();
      const service = new PortableUpdateService("0.88.0", true, root, path.join(root, "missing.pem"), fetcher);
      expect((await service.download()).state).toBe("MANUAL");
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stages only digest-matching bytes, and revalidates the archive before revealing it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "portable-update-"));
    try {
      const keyPath = path.join(root, "public.pem");
      await writeFile(keyPath, publicPem);
      const updateRoot = path.join(root, "updates");
      const corruptFetch = mockFetch(Buffer.alloc(archive.length));
      const corrupt = new PortableUpdateService("0.88.0", true, updateRoot, keyPath, corruptFetch);
      await expect(corrupt.download()).rejects.toThrow(/SHA-256/);
      expect(await readdir(updateRoot)).toEqual([]);
      const good = new PortableUpdateService("0.88.0", true, updateRoot, keyPath, mockFetch());
      expect((await good.check()).state).toBe("AVAILABLE");
      expect((await good.download()).state).toBe("READY");
      const staged = await good.verifiedArchive();
      expect(await readFile(staged)).toEqual(archive);
      await writeFile(staged, Buffer.alloc(archive.length));
      await expect(good.verifiedArchive()).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to follow redirects to arbitrary hosts", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.redirect("https://example.com/attack", 302));
    const service = new PortableUpdateService("0.88.0", true, "unused", "unused", fetcher);
    await expect(service.check()).rejects.toThrow(/不可信/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

interface FakeRelease {
  version: string;
  gate?: Promise<void>;
}

function releaseFetch(release: FakeRelease) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.endsWith("/releases/latest"))
      return Response.json({
        tag_name: `v${release.version}`,
        draft: false,
        prerelease: false,
        assets: [{ name: manifest.file }, { name: "scenerywalker-portable-update.json" }],
      });
    if (url.endsWith(".json")) return new Response(signed({ ...manifest, version: release.version }));
    await release.gate;
    return new Response(new Uint8Array(archive));
  });
}

async function updateFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "portable-update-"));
  const keyPath = path.join(root, "public.pem");
  await writeFile(keyPath, publicPem);
  return { root, keyPath, updateRoot: path.join(root, "updates") };
}

describe("portable update state priority (R2-04)", () => {
  it("keeps a verified staged package READY when checking again", async () => {
    const fixture = await updateFixture();
    try {
      const service = new PortableUpdateService(
        "0.88.0",
        true,
        fixture.updateRoot,
        fixture.keyPath,
        releaseFetch({ version: "0.89.0" }),
      );
      expect((await service.download()).state).toBe("READY");
      const again = await service.check();
      expect(again.state).toBe("READY");
      expect(again.latestVersion).toBe("0.89.0");
      expect(await readFile(await service.verifiedArchive())).toEqual(archive);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("re-verifies a corrupt staged package on check, reports it and allows re-download", async () => {
    const fixture = await updateFixture();
    try {
      const service = new PortableUpdateService(
        "0.88.0",
        true,
        fixture.updateRoot,
        fixture.keyPath,
        releaseFetch({ version: "0.89.0" }),
      );
      expect((await service.download()).state).toBe("READY");
      await writeFile(await service.verifiedArchive(), Buffer.alloc(archive.length));
      const status = await service.check();
      expect(status.state).toBe("AVAILABLE");
      expect(status.message).toMatch(/未通過重新驗證/);
      expect(await readdir(fixture.updateRoot)).toEqual([]);
      expect((await service.download()).state).toBe("READY");
      expect(await readFile(await service.verifiedArchive())).toEqual(archive);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("does not regress the UI state while a download is in progress", async () => {
    const fixture = await updateFixture();
    try {
      const release: FakeRelease = { version: "0.89.0" };
      const service = new PortableUpdateService(
        "0.88.0",
        true,
        fixture.updateRoot,
        fixture.keyPath,
        releaseFetch(release),
      );
      expect((await service.download()).state).toBe("READY");
      release.version = "0.90.0";
      let openGate!: () => void;
      release.gate = new Promise<void>((resolve) => (openGate = resolve));
      const inFlight = service.download();
      const during = await service.check();
      expect(during.state).toBe("READY");
      expect(during.latestVersion).toBe("0.89.0");
      openGate();
      expect((await inFlight).state).toBe("READY");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("keeps the verified staged package usable when a newer version appears", async () => {
    const fixture = await updateFixture();
    try {
      const release: FakeRelease = { version: "0.89.0" };
      const service = new PortableUpdateService(
        "0.88.0",
        true,
        fixture.updateRoot,
        fixture.keyPath,
        releaseFetch(release),
      );
      expect((await service.download()).state).toBe("READY");
      release.version = "0.90.0";
      const status = await service.check();
      expect(status.state).toBe("READY");
      expect(status.latestVersion).toBe("0.89.0");
      expect(status.message).toMatch(/0\.90\.0/);
      expect(await readFile(await service.verifiedArchive())).toEqual(archive);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
