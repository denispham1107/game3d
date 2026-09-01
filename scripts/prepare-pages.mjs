import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { cp, mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createBrotliDecompress, createGunzip } from "node:zlib";

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const sourceRoot = resolve(argument("--source", "."));
const outputRoot = resolve(argument("--output", join(sourceRoot, "_site")));

function assertInside(root, target, label) {
  const path = resolve(target);
  const rel = relative(root, path);
  if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    throw new Error(`${label} must be a child of ${root}: ${path}`);
  }
  return path;
}

assertInside(sourceRoot, outputRoot, "Output directory");

const deployEntries = [
  ".nojekyll", "index.html", "manifest.webmanifest", "sw.js", "unity-build-config.js",
  "TemplateData", "StreamingAssets", "icons", "styles",
];

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

for (const entry of deployEntries) {
  const source = resolve(sourceRoot, entry);
  const destination = assertInside(outputRoot, resolve(outputRoot, entry), "Deploy destination");
  try {
    await stat(source);
  } catch {
    if (entry === "StreamingAssets") continue;
    throw new Error(`Required deploy entry is missing: ${entry}`);
  }
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true });
}

// Guard the DPR baseline that must survive every future Unity ZIP import.
// iOS/iPadOS starts at DPR 1, then uses native Retina up to DPR 2; Android is
// capped at 2, while desktop receives no explicit devicePixelRatio override.
const wrapperHtml = await readFile(resolve(outputRoot, "index.html"), "utf8");
for (const marker of [
  "config.matchWebGLToCanvasSize = false",
  "Math.min(nativeDpr, 2, budgetDpr)",
  "config.devicePixelRatio = Math.min(window.devicePixelRatio || 1, 2)",
  "if (isIOS) enableIOSRetinaRendering(canvas)",
]) {
  if (!wrapperHtml.includes(marker)) throw new Error(`DPR baseline marker is missing from index.html: ${marker}`);
}
for (const forbidden of ["IOS_RENDER_PROFILE", "measureFrameHealth", "renderTier", "1.25", "1.75"]) {
  if (wrapperHtml.includes(forbidden)) throw new Error(`Adaptive DPR setting must not be present in index.html: ${forbidden}`);
}

const assetManifest = JSON.parse(await readFile(resolve(sourceRoot, "unity-assets.json"), "utf8"));
if (!Array.isArray(assetManifest.assets) || assetManifest.assets.length === 0) {
  throw new Error("unity-assets.json does not contain any Unity build assets.");
}

async function* readParts(parts, hash) {
  for (const part of parts) {
    const partPath = assertInside(sourceRoot, resolve(sourceRoot, part), "Unity asset part");
    for await (const chunk of createReadStream(partPath)) {
      hash.update(chunk);
      yield chunk;
    }
  }
}

for (const asset of assetManifest.assets) {
  if (!asset.output || !Array.isArray(asset.parts) || asset.parts.length === 0) {
    throw new Error(`Invalid Unity asset entry: ${JSON.stringify(asset)}`);
  }

  const destination = assertInside(outputRoot, resolve(outputRoot, asset.output), "Unity asset output");
  await mkdir(dirname(destination), { recursive: true });
  const hash = createHash("sha256");
  const streams = [Readable.from(readParts(asset.parts, hash))];
  if (asset.encoding === "br") streams.push(createBrotliDecompress());
  else if (asset.encoding === "gzip") streams.push(createGunzip());
  else if (asset.encoding !== "identity") throw new Error(`Unsupported encoding: ${asset.encoding}`);
  streams.push(createWriteStream(destination));
  await pipeline(...streams);

  const actualHash = hash.digest("hex");
  if (asset.sourceSha256 && actualHash !== asset.sourceSha256) {
    throw new Error(`Checksum mismatch for ${asset.output}: expected ${asset.sourceSha256}, got ${actualHash}`);
  }
}

const configText = await readFile(resolve(outputRoot, "unity-build-config.js"), "utf8");
for (const required of ["loaderUrl", "dataUrl", "frameworkUrl", "codeUrl"]) {
  if (!configText.includes(required)) throw new Error(`Unity config is missing ${required}.`);
}

const dataAsset = assetManifest.assets.find((asset) => asset.output === assetManifest.entrypoints.dataUrl);
const codeAsset = assetManifest.assets.find((asset) => asset.output === assetManifest.entrypoints.codeUrl);
if (!dataAsset || !codeAsset) throw new Error("Unity data/wasm entrypoints are not represented in the asset manifest.");

async function readHeader(path, length) {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    return buffer;
  } finally {
    await handle.close();
  }
}

async function readRuntimeHeader(asset, length) {
  // Every output has already passed through its configured decoder above.
  return readHeader(resolve(outputRoot, asset.output), length);
}

const dataHeader = await readRuntimeHeader(dataAsset, 16);
if (!dataHeader.equals(Buffer.from("UnityWebData1.0\0"))) throw new Error("Prepared Unity .data file has an invalid header.");
const wasmHeader = await readRuntimeHeader(codeAsset, 4);
if (!wasmHeader.equals(Buffer.from([0x00, 0x61, 0x73, 0x6d]))) throw new Error("Prepared Unity .wasm file has an invalid header.");

let totalBytes = 0;
for (const asset of assetManifest.assets) totalBytes += (await stat(resolve(outputRoot, asset.output))).size;
console.log(`Prepared ${assetManifest.assets.length} Unity assets (${(totalBytes / 1024 / 1024).toFixed(1)} MiB) for build ${assetManifest.version}.`);
