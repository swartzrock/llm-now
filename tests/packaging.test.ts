import { describe, expect, test } from "bun:test";
import {
  parseChecksumManifest,
  renderChocolateyInstall,
  renderHomebrewFormula,
} from "../scripts/package-render.ts";

const checksums = new Map([
  ["llm-now-v0.1.0-macos-x64.zip", "1".repeat(64)],
  ["llm-now-v0.1.0-macos-arm64.zip", "2".repeat(64)],
  ["llm-now-v0.1.0-linux-x64.zip", "3".repeat(64)],
  ["llm-now-v0.1.0-linux-arm64.zip", "4".repeat(64)],
  ["llm-now-v0.1.0-windows-x64.zip", "5".repeat(64)],
]);
const chocolateySpec = await Bun.file(
  new URL("../packaging/chocolatey/llm-now.nuspec", import.meta.url),
).text();
const homebrew220Formula = await Bun.file(
  new URL("./fixtures/homebrew/llm-now-2.2.0.rb", import.meta.url),
).text();

const homebrew220Checksums = new Map([
  ["llm-now-v2.2.0-macos-arm64.zip", "ebcbd034d2cd79087d381a8f9c8feb656d061018e2a881ca78449071e7693af9"],
  ["llm-now-v2.2.0-macos-x64.zip", "0a90f852414c6a2e2a71d955ea5897cffaf9a5006f54d33ba1511d47c1170f5b"],
  ["llm-now-v2.2.0-linux-arm64.zip", "d390322eff9d48fb7127cc608d186ad377c01407339c611e9422a1903cc08bd9"],
  ["llm-now-v2.2.0-linux-x64.zip", "ad9d81af159a716bb656af46c4f1bbcafe58dafb2fdb3cf2d55bb6b17f761cab"],
  ["llm-now-v2.2.0-windows-x64.zip", "0e8358abc7559064b4881d0c33e3f21c1aa3ed2bbc63541b5ec2593be38c13b9"],
]);

describe("package-manager rendering", () => {
  test("parses a strict checksum manifest and rejects malformed or duplicate entries", () => {
    const manifest = [...checksums].map(([name, checksum]) => `${checksum}  ${name}`).join("\n");
    expect(parseChecksumManifest(`${manifest}\n`)).toEqual(checksums);
    expect(() => parseChecksumManifest(`invalid  llm-now-v0.1.0-linux-x64.zip\n`))
      .toThrow("invalid checksum manifest line");
    expect(() => parseChecksumManifest(`${manifest}\n${"6".repeat(64)}  llm-now-v0.1.0-linux-x64.zip\n`))
      .toThrow("duplicate checksum");
  });

  test("renders four future Homebrew bindings and tolerates the Windows manifest entry", async () => {
    const version = "9.8.7";
    const futureChecksums = new Map([
      [`llm-now-v${version}-macos-x64.zip`, "1".repeat(64)],
      [`llm-now-v${version}-macos-arm64.zip`, "2".repeat(64)],
      [`llm-now-v${version}-linux-x64.zip`, "3".repeat(64)],
      [`llm-now-v${version}-linux-arm64.zip`, "4".repeat(64)],
      [`llm-now-v${version}-windows-x64.zip`, "5".repeat(64)],
    ]);
    const formula = await renderHomebrewFormula({
      version,
      packageVersion: version,
      baseUrl: `https://github.com/swartzrock/llm-now/releases/download/v${version}`,
      checksums: futureChecksums,
    });
    for (const [name, checksum] of futureChecksums) {
      if (name.includes("windows")) continue;
      expect(formula).toContain(`https://github.com/swartzrock/llm-now/releases/download/v${version}/${name}`);
      expect(formula).toContain(checksum);
    }
    expect(formula.match(/^\s+url /gm)).toHaveLength(4);
    expect(formula.match(/^\s+sha256 /gm)).toHaveLength(4);
    expect(formula.match(/^\s+version "9\.8\.7"$/gm)).toHaveLength(1);
    expect(formula).not.toContain("__");
  });

  test("requires every Homebrew target checksum", async () => {
    for (const name of checksums.keys()) {
      if (name.includes("windows")) continue;
      const missing = new Map(checksums);
      missing.delete(name);
      await expect(renderHomebrewFormula({
        version: "0.1.0",
        packageVersion: "0.1.0",
        baseUrl: "https://github.com/swartzrock/llm-now/releases/download/v0.1.0",
        checksums: missing,
      })).rejects.toThrow(`missing checksum: ${name}`);
    }
  });

  test("renders the public 2.2.0 Homebrew formula byte-for-byte", async () => {
    const formula = await renderHomebrewFormula({
      version: "2.2.0",
      packageVersion: "2.2.0",
      baseUrl: "https://github.com/swartzrock/llm-now/releases/download/v2.2.0",
      checksums: homebrew220Checksums,
    });

    expect(formula).toBe(homebrew220Formula);
  });

  test("renders Chocolatey's checksummed Windows archive", async () => {
    const script = await renderChocolateyInstall({
      version: "0.1.0",
      baseUrl: "https://github.com/swartzrock/llm-now/releases/download/v0.1.0",
      checksums,
    });
    expect(script).toContain("Install-ChocolateyZipPackage");
    expect(script).toContain("llm-now-v0.1.0-windows-x64.zip");
    expect(script).toContain("5".repeat(64));
    expect(script).not.toContain("__");
  });

  test("uses Chocolatey-compatible license metadata", () => {
    expect(chocolateySpec).toContain(
      "<licenseUrl>https://github.com/swartzrock/llm-now/blob/main/LICENSE</licenseUrl>",
    );
    expect(chocolateySpec).not.toContain("<license type=");
  });
});
