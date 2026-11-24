import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { PortableManifest } from "./portable-update";

const runFile = promisify(execFile);
const PACKAGE_DIR = "SceneryWalkerSourceOrganizer-win32-x64";

// Extract only ordinary files into a fresh directory. The same open, read-only
// archive handle is hashed and extracted, preventing a verify/extract swap.
const EXTRACT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
$archive = [IO.File]::Open($env:SW_UPDATE_ARCHIVE, 'Open', 'Read', 'Read')
try {
  if ($archive.Length -ne [long]$env:SW_UPDATE_BYTES) { throw 'Archive size mismatch' }
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $digest = [BitConverter]::ToString($sha.ComputeHash($archive)).Replace('-', '').ToLowerInvariant()
  } finally { $sha.Dispose() }
  if ($digest -ne $env:SW_UPDATE_HASH) { throw 'Archive hash mismatch' }
  $archive.Position = 0
  $zip = New-Object IO.Compression.ZipArchive($archive, [IO.Compression.ZipArchiveMode]::Read, $true)
  try {
    $root = [IO.Path]::GetFullPath($env:SW_UPDATE_DEST).TrimEnd([char]92) + [char]92
    $entries = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    $total = [long]0
    if ($zip.Entries.Count -gt 30000) { throw 'Too many entries' }
    foreach ($entry in $zip.Entries) {
      $name = $entry.FullName.Replace([char]92, '/')
      $directory = $name.EndsWith('/')
      $name = $name.TrimEnd('/')
      $parts = $name.Split('/')
      if ($parts[0] -cne 'SceneryWalkerSourceOrganizer-win32-x64') { throw 'Unexpected package root' }
      if (-not $directory -and $parts.Length -lt 2) { throw 'Invalid root file' }
      foreach ($part in $parts) {
        if ([string]::IsNullOrEmpty($part) -or $part -eq '.' -or $part -eq '..' -or
            $part -match '[<>:"|?*\x00-\x1f]' -or $part.EndsWith('.') -or $part.EndsWith(' ') -or
            $part -match '^(CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³])(?:\.|$)') {
          throw 'Invalid archive path'
        }
      }
      $dest = [IO.Path]::GetFullPath([IO.Path]::Combine($root, $name.Replace('/', [char]92)))
      if (-not $dest.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -or -not $entries.Add($dest)) {
        throw 'Duplicate or escaping archive path'
      }
      $total += $entry.Length
      if ($total -gt 3221225472) { throw 'Expanded package too large' }
      if ($directory) {
        if ($entry.Length -ne 0) { throw 'Invalid directory entry' }
        [void][IO.Directory]::CreateDirectory($dest)
        continue
      }
      [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($dest))
      $input = $entry.Open()
      try {
        $output = [IO.File]::Open($dest, 'CreateNew', 'Write', 'None')
        try {
          $buffer = New-Object byte[] 65536
          $written = [long]0
          while (($count = $input.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $written += $count
            if ($written -gt $entry.Length) { throw 'Expanded entry exceeds declared size' }
            $output.Write($buffer, 0, $count)
          }
          if ($written -ne $entry.Length) { throw 'Expanded entry size mismatch' }
        } finally { $output.Dispose() }
      } finally { $input.Dispose() }
    }
  } finally { $zip.Dispose() }
} finally { $archive.Dispose() }
`;

export interface PreparedPortableVersion {
  version: string;
  executable: string;
  directory: string;
  treeHash: string;
}

export interface PortableInstallAdapter {
  extract(archive: string, destination: string, manifest: PortableManifest): Promise<void>;
  smoke(executable: string, isolatedRoot: string): Promise<void>;
}

export async function extractSignedPortable(
  archive: string,
  destination: string,
  manifest: PortableManifest,
): Promise<void> {
  if (process.platform !== "win32") throw new Error("可攜版安裝僅支援 Windows。");
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !path.isAbsolute(systemRoot)) throw new Error("找不到 Windows 系統目錄。");
  const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const encoded = Buffer.from(EXTRACT_SCRIPT, "utf16le").toString("base64");
  await runFile(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
    timeout: 300_000,
    windowsHide: true,
    env: {
      ...process.env,
      SW_UPDATE_ARCHIVE: archive,
      SW_UPDATE_DEST: destination,
      SW_UPDATE_BYTES: String(manifest.bytes),
      SW_UPDATE_HASH: manifest.sha256,
    },
  });
}

async function smokePortable(executable: string, isolatedRoot: string): Promise<void> {
  const marker = path.join(isolatedRoot, "ready.txt");
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith("APP_") || name === "VITE_DEV_SERVER_URL" || name === "ELECTRON_RUN_AS_NODE") delete env[name];
  }
  await runFile(executable, [], {
    cwd: path.dirname(executable),
    timeout: 90_000,
    windowsHide: true,
    env: {
      ...env,
      APP_SMOKE_TEST: "1",
      APP_SMOKE_MARKER_PATH: marker,
      APP_TEST_USER_DATA_PATH: path.join(isolatedRoot, "user-data"),
    },
  });
  if ((await readFile(marker, "utf8")).trim() !== "SMOKE_READY") throw new Error("新版啟動驗證未通過。");
}

export async function hashPortableTree(directory: string): Promise<string> {
  const hash = createHash("sha256");
  const walk = async (relative: string): Promise<void> => {
    const entries = await readdir(path.join(directory, relative), { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await walk(name);
      } else if (entry.isFile() && !entry.isSymbolicLink()) {
        const filePath = path.join(directory, name);
        const file = await lstat(filePath);
        hash.update(JSON.stringify([name, file.size]));
        for await (const chunk of createReadStream(filePath)) hash.update(chunk);
      } else {
        throw new Error("新版套件包含非一般檔案，拒絕啟動。");
      }
    }
  };
  await walk("");
  return hash.digest("hex");
}

export async function preparePortableVersion(
  archive: string,
  manifest: PortableManifest,
  root: string,
  adapter: PortableInstallAdapter = { extract: extractSignedPortable, smoke: smokePortable },
): Promise<PreparedPortableVersion> {
  await mkdir(root, { recursive: true });
  const work = await mkdtemp(path.join(root, "version-"));
  try {
    await adapter.extract(archive, work, manifest);
    const directory = path.join(work, PACKAGE_DIR);
    const executable = path.join(directory, `SceneryWalkerSourceOrganizer-v${manifest.version}.exe`);
    const asar = path.join(directory, "resources", "app.asar");
    if (!(await lstat(executable)).isFile() || !(await lstat(asar)).isFile())
      throw new Error("新版套件缺少必要程式檔案。");
    const treeHash = await hashPortableTree(directory);
    const isolated = path.join(work, ".smoke");
    await mkdir(isolated);
    await adapter.smoke(executable, isolated);
    await rm(isolated, { recursive: true, force: true });
    if ((await hashPortableTree(directory)) !== treeHash) throw new Error("啟動測試期間套件發生變更。");
    return { version: manifest.version, executable, directory, treeHash };
  } catch (error) {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
