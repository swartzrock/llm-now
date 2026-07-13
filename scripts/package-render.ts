import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import packageMetadata from "../package.json" with { type: "json" };
import { RELEASE_TARGETS, archiveName } from "./build.ts";

export function parseChecksumManifest(text: string): Map<string, string> {
  const checksums = new Map<string, string>();
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    const match = /^([a-f0-9]{64})  (llm-now-v[^/\\]+\.zip)$/.exec(line);
    if (!match) throw new Error(`invalid checksum manifest line: ${line}`);
    const [, checksum, name] = match;
    if (checksums.has(name!)) throw new Error(`duplicate checksum: ${name}`);
    checksums.set(name!, checksum!);
  }
  return checksums;
}

interface RenderOptions {
  version: string;
  packageVersion: string;
  baseUrl: string;
  checksums: ReadonlyMap<string, string>;
}

function asset(options: RenderOptions, targetId: (typeof RELEASE_TARGETS)[number]["id"]): {
  url: string;
  checksum: string;
} {
  const target = RELEASE_TARGETS.find((candidate) => candidate.id === targetId);
  if (!target) throw new Error(`unknown release target: ${targetId}`);
  const name = archiveName(options.version, target);
  const checksum = options.checksums.get(name);
  if (!checksum) throw new Error(`missing checksum: ${name}`);
  return { url: `${options.baseUrl.replace(/\/$/, "")}/${name}`, checksum };
}

function replaceAll(template: string, replacements: ReadonlyMap<string, string>): string {
  let rendered = template;
  for (const [token, value] of replacements) rendered = rendered.replaceAll(token, value);
  const unresolved = rendered.match(/__[A-Z0-9_]+__/);
  if (unresolved) throw new Error(`unresolved package template token: ${unresolved[0]}`);
  return rendered;
}

export async function renderHomebrewFormula(options: RenderOptions): Promise<string> {
  const macosArm64 = asset(options, "macos-arm64");
  const macosX64 = asset(options, "macos-x64");
  const linuxArm64 = asset(options, "linux-arm64");
  const linuxX64 = asset(options, "linux-x64");
  const template = await Bun.file(join(import.meta.dir, "../packaging/homebrew/llm-now.rb")).text();
  return replaceAll(template, new Map([
    ["__PACKAGE_VERSION__", options.packageVersion],
    ["__MACOS_ARM64_URL__", macosArm64.url],
    ["__MACOS_ARM64_SHA256__", macosArm64.checksum],
    ["__MACOS_X64_URL__", macosX64.url],
    ["__MACOS_X64_SHA256__", macosX64.checksum],
    ["__LINUX_ARM64_URL__", linuxArm64.url],
    ["__LINUX_ARM64_SHA256__", linuxArm64.checksum],
    ["__LINUX_X64_URL__", linuxX64.url],
    ["__LINUX_X64_SHA256__", linuxX64.checksum],
  ]));
}

export async function renderChocolateyInstall(
  options: Omit<RenderOptions, "packageVersion">,
): Promise<string> {
  const windows = asset({ ...options, packageVersion: options.version }, "windows-x64");
  const template = await Bun.file(
    join(import.meta.dir, "../packaging/chocolatey/tools/chocolateyinstall.ps1"),
  ).text();
  return replaceAll(template, new Map([
    ["__WINDOWS_X64_URL__", windows.url],
    ["__WINDOWS_X64_SHA256__", windows.checksum],
  ]));
}

async function renderChocolateyPackage(options: RenderOptions, output: string): Promise<void> {
  const nuspec = await Bun.file(join(import.meta.dir, "../packaging/chocolatey/llm-now.nuspec")).text();
  await mkdir(join(output, "tools"), { recursive: true });
  await Bun.write(join(output, "llm-now.nuspec"), replaceAll(nuspec, new Map([
    ["__PACKAGE_VERSION__", options.packageVersion],
  ])));
  await Bun.write(join(output, "tools/chocolateyinstall.ps1"), await renderChocolateyInstall(options));
}

async function main(): Promise<void> {
  const [kind, manifestPath, output, baseUrl, packageVersion = packageMetadata.version] = Bun.argv.slice(2);
  if (!kind || !manifestPath || !output || !baseUrl) {
    throw new Error("usage: package-render <homebrew|chocolatey> MANIFEST OUTPUT BASE_URL [PACKAGE_VERSION]");
  }
  const options: RenderOptions = {
    version: packageMetadata.version,
    packageVersion,
    baseUrl,
    checksums: parseChecksumManifest(await Bun.file(manifestPath).text()),
  };
  if (kind === "homebrew") {
    await mkdir(dirname(output), { recursive: true });
    await Bun.write(output, await renderHomebrewFormula(options));
  } else if (kind === "chocolatey") {
    await renderChocolateyPackage(options, output);
  } else {
    throw new Error(`unknown package kind: ${kind}`);
  }
}

if (import.meta.main) await main();
