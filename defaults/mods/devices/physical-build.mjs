// Optional, pinned native capture build. Existing simulator/Android tools stay separate.
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PHYSICAL_VERSION, SOURCE_REVISION, SOURCE_SHA256, PATCH_SHA256, physicalRoot } from "./physical-spec.js";

const run = promisify(execFile);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const here = dirname(fileURLToPath(import.meta.url));
const cargo = async (args, options = {}) => run("rustup", ["run", "1.95.0", "cargo", ...args], { maxBuffer: 8 * 1024 * 1024, timeout: 600000, ...options });

export async function buildLock(path) {
  try {
    const lock = await fs.open(path, "wx");
    await lock.writeFile(JSON.stringify({ pid: process.pid }));
    return lock;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const previous = await fs.stat(path);
    const owner = JSON.parse(await fs.readFile(path, "utf8").catch(() => "{}"));
    let gone = false;
    if (Number.isInteger(owner.pid) && owner.pid > 0) {
      try { process.kill(owner.pid, 0); } catch (error) { gone = error.code === "ESRCH"; }
    }
    if (gone && (await fs.stat(path)).ino === previous.ino) { await fs.unlink(path); return buildLock(path); }
    throw new Error("Real-iPhone video tools are being built. Wait for that build to finish before retrying.");
  }
}

export async function installedPhysicalTools(toolsRoot) {
  try {
    const root = physicalRoot(toolsRoot), metadata = JSON.parse(await fs.readFile(join(root, "manifest.json"), "utf8"));
    if (metadata.version !== PHYSICAL_VERSION || metadata.source !== SOURCE_REVISION || metadata.sourceSha256 !== SOURCE_SHA256 || metadata.patchSha256 !== PATCH_SHA256) return null;
    return hash(await fs.readFile(join(root, "ios-device.node"))) === metadata.addonSha256 ? root : null;
  } catch { return null; }
}

export async function ensurePhysicalTools(toolsRoot) {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("Real-iPhone video requires an Apple Silicon Mac, Xcode 27+, and Rust 1.95.0.");
  const ready = await installedPhysicalTools(toolsRoot);
  if (ready) return ready;
  const parent = join(toolsRoot, "physical-ios");
  await fs.mkdir(parent, { recursive: true });
  // An exclusive build lock prevents a second panel from replacing an in-flight build.
  const lock = await buildLock(join(parent, "build.lock"));
  let staging;
  try {
    const ready = await installedPhysicalTools(toolsRoot);
    if (ready) return ready;
    await cargo(["--version"]);
    const patch = await fs.readFile(join(here, "physical-ios/ios-device.patch"));
    if (hash(patch) !== PATCH_SHA256) throw new Error("The pinned physical-iOS patch checksum does not match.");
    const archivePath = join(parent, `${SOURCE_REVISION}.tar.gz`);
    let archive = await fs.readFile(archivePath).catch(() => null);
    if (!archive) {
      const response = await fetch(`https://codeload.github.com/callstackincubator/codex-mobile-dev-plugin/tar.gz/${SOURCE_REVISION}`);
      if (!response.ok) throw new Error(`Could not download physical-iOS tools: HTTP ${response.status}`);
      archive = Buffer.from(await response.arrayBuffer());
      if (hash(archive) !== SOURCE_SHA256) throw new Error("The physical-iOS source archive checksum does not match.");
      await fs.writeFile(archivePath, archive, { flag: "wx" });
    }
    if (hash(archive) !== SOURCE_SHA256) throw new Error(`Physical-iOS source checksum mismatch: ${archivePath}`);
    staging = await fs.mkdtemp(join(parent, "build-"));
    const source = join(staging, "source"), target = join(staging, "target");
    await fs.mkdir(source);
    await run("tar", ["-xzf", archivePath, "--strip-components=4", "-C", source, `codex-mobile-dev-plugin-${SOURCE_REVISION}/packages/native/ios-mirror`]);
    await run("patch", ["-p1", "-F0", "-i", join(here, "physical-ios/ios-device.patch")], { cwd: source });
    const manifest = join(source, "Cargo.toml");
    const built = await cargo(["build", "--release", "--locked", "--manifest-path", manifest], { env: { ...process.env, CARGO_TARGET_DIR: target } });
    await fs.writeFile(join(staging, "build.log"), built.stdout + built.stderr);
    const addon = await fs.readFile(join(target, "release/libexpo_hub_ios_device.dylib"));
    await fs.writeFile(join(staging, "ios-device.node"), addon);
    const metadata = JSON.parse((await cargo(["metadata", "--locked", "--format-version", "1", "--manifest-path", manifest])).stdout);
    const licenses = [];
    for (const pkg of metadata.packages.filter(p => p.name !== "expo-hub-ios-device")) {
      const dir = dirname(pkg.manifest_path), files = (await fs.readdir(dir)).filter(f => /^(LICENSE|LICENCE|COPYING|NOTICE)([-._]|$)/i.test(f));
      if (pkg.name === "idevice") files.push("../LICENSE.txt");
      const texts = await Promise.all(files.map(file => fs.readFile(join(dir, file), "utf8").catch(() => "")));
      licenses.push(`${pkg.name} ${pkg.version} (${pkg.license})\n${pkg.repository ?? ""}\n\n${texts.join("\n\n")}`);
    }
    await fs.writeFile(join(staging, "THIRD-PARTY-LICENSES.txt"), licenses.join("\n\n====================\n\n"));
    for (const file of ["CALLSTACK-LICENSE.txt", "DEVICE-HUB-LICENSE.txt", "IDEVICE-LICENSE.txt", "NOTICE.md"]) await fs.copyFile(join(here, "physical-ios", file), join(staging, file));
    await fs.writeFile(join(staging, "manifest.json"), JSON.stringify({ version: PHYSICAL_VERSION, source: SOURCE_REVISION, sourceSha256: SOURCE_SHA256, patchSha256: PATCH_SHA256, addonSha256: hash(addon) }, null, 2));
    const destination = physicalRoot(toolsRoot);
    // Keep a corrupt/older result for rollback and diagnosis rather than overwriting it.
    if (await fs.stat(destination).catch(() => null)) await fs.rename(destination, `${destination}.previous-${Date.now()}`);
    await fs.rename(staging, destination);
    staging = null;
    return destination;
  } catch (error) {
    if (staging) error.message += `\nBuild files retained at ${staging}`;
    throw error;
  } finally {
    await lock.close();
    await fs.unlink(join(parent, "build.lock"));
  }
}

const entry = process.argv[1] ? await fs.realpath(process.argv[1]).catch(() => null) : null;
if (entry && import.meta.url === pathToFileURL(entry).href) {
  ensurePhysicalTools(process.argv[2]).then(root => console.log(`Real-iPhone video tools ready: ${root}`)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
