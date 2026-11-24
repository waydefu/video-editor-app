import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const [archive, manifestPath, privateKeyPath, publicKeyPath, tag] = process.argv.slice(2);
if (!archive || !manifestPath || !privateKeyPath || !publicKeyPath || !/^v\d+\.\d+\.\d+$/.test(tag ?? ""))
  throw new Error("Usage: sign-portable-update.mjs archive manifest private-key public-key vX.Y.Z");
const version = tag.slice(1);
const packageMeta = JSON.parse(await readFile("package.json", "utf8"));
if (packageMeta.version !== version || path.basename(archive) !== "scenerywalker-portable-win-x64.zip")
  throw new Error("Release tag, version or archive name mismatch.");
const privateKey = createPrivateKey(await readFile(privateKeyPath));
const publicKey = createPublicKey(await readFile(publicKeyPath));
if (
  privateKey.asymmetricKeyType !== "ed25519" ||
  !createPublicKey(privateKey).export({ type: "spki", format: "der" }).equals(
    publicKey.export({ type: "spki", format: "der" }),
  )
)
  throw new Error("Release signing key does not match the pinned public key.");
const bytes = (await stat(archive)).size;
if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > 1024 ** 3) throw new Error("Invalid archive size.");
const hash = createHash("sha256");
for await (const chunk of createReadStream(archive)) hash.update(chunk);
const payload = Buffer.from(
  JSON.stringify({
    schemaVersion: 1,
    version,
    file: path.basename(archive),
    bytes,
    sha256: hash.digest("hex"),
  }),
);
await writeFile(
  manifestPath,
  JSON.stringify({ payload: payload.toString("base64"), signature: sign(null, payload, privateKey).toString("base64") }),
  { flag: "wx" },
);
