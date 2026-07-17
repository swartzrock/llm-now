import { describe, expect, test } from "bun:test";

const releaseWorkflow = await Bun.file(
  new URL("../.github/workflows/release.yml", import.meta.url),
).text();
const ciWorkflow = await Bun.file(new URL("../.github/workflows/ci.yml", import.meta.url)).text();

describe("release workflow policy", () => {
  test("pins downstream checkouts to the validated commit", () => {
    expect(releaseWorkflow).toContain('test "$GITHUB_REF" = "refs/heads/main"');
    const refs = [...releaseWorkflow.matchAll(/^\s+ref:\s+(.+)$/gm)].map((match) => match[1]);
    expect(refs.filter((ref) => ref === "${{ inputs.tag }}")).toHaveLength(1);
    expect(refs.slice(1).every((ref) => ref === "${{ needs.validate-ref.outputs.release-sha }}"))
      .toBe(true);
    expect(releaseWorkflow).toContain('git rev-parse "refs/tags/${TAG}^{commit}"');
    expect(releaseWorkflow).toContain('gh release create "$TAG"');
    expect(releaseWorkflow).toContain("--verify-tag");
    expect(releaseWorkflow).not.toContain("target_commitish:");
  });

  test("publishes only the validated dispatch commit from a public repository", () => {
    expect(releaseWorkflow).toContain("if: ${{ inputs.publish }}");
    expect(releaseWorkflow).toContain(
      'test "${{ github.event.repository.visibility }}" = "public"',
    );
    expect(releaseWorkflow).toContain('test "$RELEASE_SHA" = "$GITHUB_SHA"');
    expect(releaseWorkflow).toContain(
      "RELEASE_SHA: ${{ steps.release-sha.outputs.value }}",
    );
  });

  test("does not run repository scripts in steps holding signing secrets", () => {
    const steps = releaseWorkflow.split(/^\s{6}- /m);
    for (const step of steps.filter((candidate) => candidate.includes("secrets."))) {
      expect(step).not.toContain("bun scripts/");
    }
  });

  test("uses current release tags for GitHub actions and pins third-party actions", () => {
    const githubActions = new Set([
      "actions/attest@f7c74d28b9d84cb8768d0b8ca14a4bac6ef463e6",
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

  test("stamps native and repacked archives with the source commit time", () => {
    const sourceDateStep = 'echo "SOURCE_DATE_EPOCH=$(git show -s --format=%ct HEAD)"';
    expect(ciWorkflow.split(sourceDateStep)).toHaveLength(2);
    expect(releaseWorkflow.split(sourceDateStep)).toHaveLength(3);
  });

  test("publishes signed macOS and unsigned Linux and Windows archives", () => {
    expect(releaseWorkflow).not.toContain("\n  sign-windows:");
    expect(releaseWorkflow).not.toContain("\n  promote-linux:");
    expect(releaseWorkflow).not.toContain("\n  promote-windows:");
    expect(releaseWorkflow).not.toContain("WINDOWS_CERTIFICATE_PFX_BASE64");
    expect(releaseWorkflow).not.toContain("WINDOWS_CERTIFICATE_PASSWORD");
    expect(releaseWorkflow.toLowerCase()).not.toContain("signtool");
    expect(releaseWorkflow).toContain(
      'target: [macos-x64, macos-arm64, linux-x64, linux-arm64, windows-x64]',
    );
    const finalAssetsJob = releaseWorkflow.slice(
      releaseWorkflow.indexOf("\n  final-assets:"),
      releaseWorkflow.indexOf("\n  publish:"),
    );
    expect(finalAssetsJob).toContain("needs: [native, sign-macos, validate-ref]");
    expect(finalAssetsJob).toContain(`pattern: release-macos-*
          path: .release-artifacts/macos`);
    expect(finalAssetsJob).toContain(`pattern: native-linux-*
          path: .release-artifacts/linux`);
    expect(finalAssetsJob).toContain(`pattern: native-windows-*
          path: .release-artifacts/windows`);
    expect(finalAssetsJob).not.toContain("merge-multiple: true");
    expect(finalAssetsJob).toContain(
      "bun scripts/release-validate.ts assemble .release-artifacts dist",
    );
    expect(finalAssetsJob).not.toContain("dist macos-x64 macos-arm64");
    expect(releaseWorkflow).toContain("https://api.github.com/repos/$GITHUB_REPOSITORY/releases/tags/$TAG");
    expect(releaseWorkflow).toContain("404) ;;");
    expect(releaseWorkflow).toContain("Release $TAG already exists");
  });

  test("checks notarization for standalone macOS executables", () => {
    expect(releaseWorkflow).not.toMatch(/\bspctl\b[^\n]*signed\/llm-now/);
    expect(releaseWorkflow).toContain(
      'codesign -vvvv -R="notarized" --check-notarization signed/llm-now',
    );
  });

  test("smokes final macOS archives after repacking and notarization", () => {
    const signMacosJob = releaseWorkflow.slice(
      releaseWorkflow.indexOf("\n  sign-macos:"),
      releaseWorkflow.indexOf("\n  final-assets:"),
    );
    expect(signMacosJob.indexOf("bun scripts/repack-archive.ts")).toBeGreaterThan(-1);
    expect(signMacosJob.indexOf("xcrun notarytool submit")).toBeGreaterThan(
      signMacosJob.indexOf("bun scripts/repack-archive.ts"),
    );
    expect(signMacosJob.indexOf("bun scripts/release-validate.ts smoke .release-artifacts/*.zip"))
      .toBeGreaterThan(signMacosJob.indexOf("xcrun notarytool submit"));
  });

  test("uploads signed archives from the hidden staging directory", () => {
    expect(releaseWorkflow).toContain(
      `name: release-\${{ matrix.target }}
          path: .release-artifacts/*.zip
          if-no-files-found: error
          include-hidden-files: true`,
    );
  });

  test("authenticates the publication tag refresh without persisting checkout credentials", () => {
    const publishJob = releaseWorkflow.slice(releaseWorkflow.indexOf("\n  publish:"));
    expect(publishJob).toContain("persist-credentials: false");
    expect(publishJob).toContain("GH_TOKEN: ${{ github.token }}");
    expect(publishJob).toContain(
      `GIT_AUTH_HEADER="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$GH_TOKEN" | base64 -w 0)"`,
    );
    expect(publishJob).toContain(
      'git --config-env=http.https://github.com/.extraheader=GIT_AUTH_HEADER fetch origin "+refs/tags/${TAG}:refs/tags/${TAG}"',
    );
    expect(publishJob).not.toContain("https://x-access-token:");
  });

  test("verifies and attests final checksums with publish-only permissions", () => {
    const publishJob = releaseWorkflow.slice(releaseWorkflow.indexOf("\n  publish:"));
    expect(publishJob).toContain(`permissions:
      contents: write
      id-token: write
      attestations: write`);
    expect(
      [...publishJob.matchAll(/^\s{6}([a-z-]+): write$/gm)].map((match) => match[1]),
    ).toEqual(["contents", "id-token", "attestations"]);

    const tagRevalidation = publishJob.indexOf(
      'test "$(git rev-parse "refs/tags/${TAG}^{commit}")" = "$RELEASE_SHA"',
    );
    const assetDownload = publishJob.indexOf("name: release-assets");
    const checksumVerification = publishJob.indexOf("sha256sum --check SHA256SUMS");
    const attestation = publishJob.indexOf(
      "uses: actions/attest@f7c74d28b9d84cb8768d0b8ca14a4bac6ef463e6 # v4.2.0",
    );
    const release = publishJob.indexOf('gh release create "$TAG"');
    expect(checksumVerification).toBeGreaterThan(tagRevalidation);
    expect(checksumVerification).toBeGreaterThan(assetDownload);
    expect(attestation).toBeGreaterThan(checksumVerification);
    expect(release).toBeGreaterThan(attestation);
    expect(publishJob).toContain("subject-checksums: dist/SHA256SUMS");
    expect(publishJob.slice(attestation)).not.toContain("scripts/repack-archive.ts");
    expect(publishJob.slice(attestation)).not.toContain("scripts/build.ts");
  });

  test("prepends fixed release trust guidance to inert tag-authored notes", () => {
    const publishJob = releaseWorkflow.slice(releaseWorkflow.indexOf("\n  publish:"));
    expect(publishJob).toContain("macOS x64 and ARM64");
    expect(publishJob).toContain(
      "Linux x64 and ARM64 archives require glibc; musl and Alpine are not supported.",
    );
    expect(publishJob).toContain("Windows x64 is unsigned early access.");
    expect(publishJob).toContain("SmartScreen");
    expect(publishJob).toContain("Smart App Control or enterprise policy may block execution");
    expect(publishJob).toContain("Do not weaken or disable security controls");
    expect(publishJob).toContain("sha256sum --check SHA256SUMS");
    expect(publishJob).toContain(
      "gh attestation verify <downloaded-archive.zip> --repo swartzrock/llm-now --signer-workflow swartzrock/llm-now/.github/workflows/release.yml --source-digest %s\\n' \"$RELEASE_SHA\"",
    );
    expect(publishJob).toContain(
      `git for-each-ref --format='%(contents)' "refs/tags/\${TAG}" >> "$NOTES_FILE"`,
    );
    expect(publishJob).not.toContain('eval "$(git for-each-ref');
    expect(publishJob).not.toContain('source "$(git for-each-ref');
    expect(publishJob).toContain('--verify-tag --notes-file "$NOTES_FILE" --title');
    expect(publishJob).not.toContain("--notes-from-tag");
  });

  test("defers package-manager integration outside GitHub Actions", () => {
    for (const workflow of [ciWorkflow, releaseWorkflow]) {
      expect(workflow.toLowerCase()).not.toContain("homebrew");
      expect(workflow.toLowerCase()).not.toContain("chocolatey");
      expect(workflow).not.toContain("scripts/package-render.ts");
    }
    expect(releaseWorkflow).toContain("needs: [final-assets, validate-ref]");
  });
});
