import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const PART_SIZE = 64 * 1024 * 1024;

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const repoRoot = resolve(argument("--repo", "."));
const unityIndexPath = resolve(argument("--unity-index", resolve(repoRoot, "index.html")));
const buildRoot = resolve(repoRoot, "Build");

function assertInside(root, target, label) {
  const path = resolve(target);
  const rel = relative(root, path);
  if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    throw new Error(`${label} must be a child of ${root}: ${path}`);
  }
  return path;
}
assertInside(repoRoot, buildRoot, "Build directory");

const unityHtml = await readFile(unityIndexPath, "utf8");
function matchValue(pattern, label, fallback) {
  const match = unityHtml.match(pattern);
  if (match) return match[1];
  if (fallback !== undefined) return fallback;
  throw new Error(`Could not read ${label} from Unity-generated index.html.`);
}

const generated = {
  loaderUrl: `Build/${matchValue(/loaderUrl\s*=\s*buildUrl\s*\+\s*["']\/([^"']+)/, "loaderUrl")}`,
  dataUrl: `Build/${matchValue(/dataUrl\s*:\s*buildUrl\s*\+\s*["']\/([^"']+)/, "dataUrl")}`,
  frameworkUrl: `Build/${matchValue(/frameworkUrl\s*:\s*buildUrl\s*\+\s*["']\/([^"']+)/, "frameworkUrl")}`,
  codeUrl: `Build/${matchValue(/codeUrl\s*:\s*buildUrl\s*\+\s*["']\/([^"']+)/, "codeUrl")}`,
  streamingAssetsUrl: matchValue(/streamingAssetsUrl\s*:\s*["']([^"']+)/, "streamingAssetsUrl", "StreamingAssets"),
  companyName: matchValue(/companyName\s*:\s*["']([^"']*)/, "companyName", "Unity"),
  productName: matchValue(/productName\s*:\s*["']([^"']*)/, "productName", "Unity WebGL Game"),
  unityProductVersion: matchValue(/productVersion\s*:\s*["']([^"']*)/, "productVersion", "1.0"),
};

function normalizedOutput(sourcePath) {
  if (sourcePath.endsWith(".br")) return { output: sourcePath.slice(0, -3), encoding: "br" };
  if (sourcePath.endsWith(".gz")) return { output: sourcePath.slice(0, -3), encoding: "gzip" };
  return { output: sourcePath, encoding: "identity" };
}
const normalizeEntrypoint = (path) => normalizedOutput(path).output.replaceAll("\\", "/");

async function filesRecursively(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesRecursively(path));
    else if (!/\.part\d{3}$/.test(entry.name)) files.push(path);
  }
  return files.sort();
}

async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function splitFile(path) {
  const temporaryParts = [];
  let partNumber = 0;
  try {
    for await (const chunk of createReadStream(path, { highWaterMark: PART_SIZE })) {
      partNumber += 1;
      const finalPath = `${path}.part${String(partNumber).padStart(3, "0")}`;
      const temporaryPath = `${finalPath}.tmp`;
      await writeFile(temporaryPath, chunk);
      temporaryParts.push({ temporaryPath, finalPath });
    }
    for (const part of temporaryParts) await rename(part.temporaryPath, part.finalPath);
    await unlink(path);
    return temporaryParts.map((part) => part.finalPath);
  } catch (error) {
    await Promise.all(temporaryParts.flatMap((part) => [rm(part.temporaryPath, { force: true }), rm(part.finalPath, { force: true })]));
    throw error;
  }
}

const buildFiles = await filesRecursively(buildRoot);
if (buildFiles.length === 0) throw new Error("Build directory is empty.");
const assets = [];
for (const sourceFile of buildFiles) {
  const sourceRelative = relative(repoRoot, sourceFile).replaceAll("\\", "/");
  const { output, encoding } = normalizedOutput(sourceRelative);
  const sourceSha256 = await hashFile(sourceFile);
  const fileSize = (await stat(sourceFile)).size;
  const partPaths = fileSize > PART_SIZE ? await splitFile(sourceFile) : [sourceFile];
  assets.push({
    output,
    encoding,
    parts: partPaths.map((path) => relative(repoRoot, path).replaceAll("\\", "/")),
    sourceSha256,
  });
}

const combinedHash = createHash("sha256");
for (const asset of assets) combinedHash.update(`${asset.output}:${asset.sourceSha256}\n`);
const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
const version = `${date}-${combinedHash.digest("hex").slice(0, 12)}`;
const entrypoints = {
  loaderUrl: normalizeEntrypoint(generated.loaderUrl),
  dataUrl: normalizeEntrypoint(generated.dataUrl),
  frameworkUrl: normalizeEntrypoint(generated.frameworkUrl),
  codeUrl: normalizeEntrypoint(generated.codeUrl),
};

for (const [label, path] of Object.entries(entrypoints)) {
  if (!assets.some((asset) => asset.output === path)) throw new Error(`Normalized ${label} is missing: ${path}`);
}

const manifest = { version, generatedAt: new Date().toISOString(), entrypoints, assets };
const runtimeConfig = {
  ...entrypoints,
  streamingAssetsUrl: generated.streamingAssetsUrl,
  companyName: generated.companyName,
  productName: generated.productName,
  unityProductVersion: generated.unityProductVersion,
};
await writeFile(resolve(repoRoot, "unity-assets.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(resolve(repoRoot, "unity-build-config.js"), `// Generated by scripts/normalize-unity-build.mjs.\nglobalThis.UNITY_BUILD_CONFIG = Object.freeze(${JSON.stringify(runtimeConfig, null, 2)});\n`);

for (const fileName of ["index.html", "sw.js"]) {
  const path = resolve(repoRoot, fileName);
  const text = await readFile(path, "utf8");
  const replaced = text.replace(/const GAME_BUILD_VERSION = "[^"]+";/, `const GAME_BUILD_VERSION = "${version}";`);
  if (text === replaced) throw new Error(`${fileName} does not contain the GAME_BUILD_VERSION marker.`);
  await writeFile(path, replaced);
}

console.log(`Normalized ${assets.length} Unity assets as build ${version}.`);
for (const asset of assets) console.log(`- ${asset.output}: ${asset.parts.length} source part(s), ${asset.encoding}`);
