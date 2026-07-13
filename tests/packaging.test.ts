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

describe("package-manager rendering", () => {
  test("parses a strict checksum manifest and rejects duplicate names", () => {
    const manifest = [...checksums].map(([name, checksum]) => `${checksum}  ${name}`).join("\n");
    expect(parseChecksumManifest(`${manifest}\n`)).toEqual(checksums);
    expect(() => parseChecksumManifest(`${manifest}\n${"6".repeat(64)}  llm-now-v0.1.0-linux-x64.zip\n`))
      .toThrow("duplicate checksum");
  });

  test("renders immutable GitHub release URLs for every Homebrew platform", async () => {
    const formula = await renderHomebrewFormula({
      version: "0.1.0",
      packageVersion: "0.1.0",
      baseUrl: "https://github.com/swartzrock/llm-now/releases/download/v0.1.0",
      checksums,
    });
    for (const [name, checksum] of checksums) {
      if (name.includes("windows")) continue;
      expect(formula).toContain(`https://github.com/swartzrock/llm-now/releases/download/v0.1.0/${name}`);
      expect(formula).toContain(checksum);
    }
    expect(formula).not.toContain("__");
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
