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

  test("uses current release tags for GitHub actions and pins third-party actions", () => {
    const githubActions = new Set([
      "actions/checkout@v7.0.0",
      "actions/download-artifact@v8.0.1",
      "actions/upload-artifact@v7.0.1",
    ]);
    for (const workflow of [ciWorkflow, releaseWorkflow]) {
      const actions = [...workflow.matchAll(/^\s+- uses:\s+([^\s#]+)/gm)].map((match) => match[1]!);
      expect(actions.length).toBeGreaterThan(0);
      expect(actions.every((action) => action.startsWith("actions/")
        ? githubActions.has(action)
        : /@[a-f0-9]{40}$/.test(action))).toBe(true);
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

  test("defers package-manager integration outside GitHub Actions", () => {
    for (const workflow of [ciWorkflow, releaseWorkflow]) {
      expect(workflow.toLowerCase()).not.toContain("homebrew");
      expect(workflow.toLowerCase()).not.toContain("chocolatey");
      expect(workflow).not.toContain("scripts/package-render.ts");
    }
    expect(releaseWorkflow).toContain("needs: [signed-assets, validate-ref]");
  });
});
