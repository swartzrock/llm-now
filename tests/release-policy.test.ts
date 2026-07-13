import { describe, expect, test } from "bun:test";

const releaseWorkflow = await Bun.file(
  new URL("../.github/workflows/release.yml", import.meta.url),
).text();
const ciWorkflow = await Bun.file(new URL("../.github/workflows/ci.yml", import.meta.url)).text();

describe("release workflow policy", () => {
  test("pins downstream checkouts to the validated commit", () => {
    const refs = [...releaseWorkflow.matchAll(/^\s+ref:\s+(.+)$/gm)].map((match) => match[1]);
    expect(refs.filter((ref) => ref === "${{ inputs.tag }}")).toHaveLength(1);
    expect(refs.slice(1).every((ref) => ref === "${{ needs.validate-ref.outputs.release-sha }}"))
      .toBe(true);
    expect(releaseWorkflow).toContain('git rev-parse "refs/tags/${TAG}^{commit}"');
    expect(releaseWorkflow).toContain("target_commitish: ${{ needs.validate-ref.outputs.release-sha }}");
  });

  test("does not run repository scripts in steps holding signing secrets", () => {
    const steps = releaseWorkflow.split(/^\s{6}- /m);
    for (const step of steps.filter((candidate) => candidate.includes("secrets."))) {
      expect(step).not.toContain("bun scripts/");
    }
  });

  test("pins every third-party action to a full commit SHA", () => {
    for (const workflow of [ciWorkflow, releaseWorkflow]) {
      const actions = [...workflow.matchAll(/^\s+- uses:\s+([^\s#]+)/gm)].map((match) => match[1]!);
      expect(actions.length).toBeGreaterThan(0);
      expect(actions.every((action) => /@[a-f0-9]{40}$/.test(action))).toBe(true);
    }
  });

  test("uses baseline Bun to compile the baseline Windows executable", () => {
    const baselineUrl =
      "https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-windows-x64-baseline.zip";
    for (const workflow of [ciWorkflow, releaseWorkflow]) {
      expect(workflow).toContain("if: matrix.target == 'windows-x64'");
      expect(workflow).toContain(`bun-download-url: ${baselineUrl}`);
    }
  });

  test("configures a Git identity before Homebrew creates test taps", () => {
    for (const workflow of [ciWorkflow, releaseWorkflow]) {
      const identity = workflow.indexOf('git config --global user.name "llm-now CI"');
      expect(identity).toBeGreaterThan(-1);
      expect(identity).toBeLessThan(workflow.indexOf("brew tap-new"));
    }
  });

  test("removes every installed test version before untapping Homebrew", () => {
    for (const workflow of [ciWorkflow, releaseWorkflow]) {
      expect(workflow).toContain("brew uninstall --force llm-now");
      expect(workflow.indexOf("brew uninstall --force llm-now"))
        .toBeLessThan(workflow.indexOf("brew untap"));
    }
  });
});
