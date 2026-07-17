import { describe, expect, test } from "bun:test";
import { extractChangelogSection, renderReleaseNotes } from "../scripts/release-notes.ts";

const sourceSha = "a".repeat(40);
const changelog = "# llm-now\n\n## 1.2.0\n\n### Minor Changes\n\n- Current release.\n\n## 1.1.0\n\n- Previous release.\n";

describe("release notes", () => {
  test("extracts exactly the requested changelog section", () => {
    expect(extractChangelogSection(changelog, "1.2.0")).toBe("## 1.2.0\n\n### Minor Changes\n\n- Current release.");
  });
  test("renders fixed trust guidance, exact source digest, and no adjacent release", () => {
    const notes = renderReleaseNotes(changelog, "1.2.0", sourceSha);
    expect(notes).toContain("macOS x64 and ARM64 archives are signed and notarized.");
    expect(notes).toContain("Linux x64 and ARM64 archives require glibc");
    expect(notes).toContain("Windows x64 is unsigned early access.");
    expect(notes).toContain("SmartScreen");
    expect(notes).toContain("Do not weaken or disable security controls");
    expect(notes).toContain("Get-FileHash $Archive -Algorithm SHA256");
    expect(notes).toContain("--signer-workflow swartzrock/llm-now/.github/workflows/release.yml");
    expect(notes).toContain(`--source-digest ${sourceSha}`);
    expect(notes).toContain(`Release source digest: \`${sourceSha}\``);
    expect(notes).toContain("## 1.2.0");
    expect(notes).not.toContain("## 1.1.0");
  });
  test("rejects missing, duplicate, malformed version, and malformed source digest", () => {
    expect(() => extractChangelogSection(changelog, "1.3.0")).toThrow("exactly one");
    expect(() => extractChangelogSection(`${changelog}\n## 1.2.0\n\nDuplicate.\n`, "1.2.0")).toThrow("exactly one");
    expect(() => extractChangelogSection(changelog, "v1.2.0")).toThrow("stable X.Y.Z");
    expect(() => renderReleaseNotes(changelog, "1.2.0", "not-a-sha")).toThrow("source digest");
  });
  test("keeps changelog content inert", () => {
    const notes = renderReleaseNotes("## 1.2.0\n\n`$(touch /tmp/never-run)`\n\n<script>alert(1)</script>\n", "1.2.0", sourceSha);
    expect(notes).toContain("`$(touch /tmp/never-run)`");
    expect(notes).toContain("<script>alert(1)</script>");
  });
});
