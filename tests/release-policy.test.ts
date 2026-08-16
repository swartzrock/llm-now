import { describe, expect, test } from "bun:test";
import { validateVoiceDependencies } from "../scripts/release-validate.ts";
import { NATIVE_VAULT_COMPATIBILITY } from "../packages/cli/src/credentials.ts";

const releaseWorkflow = await Bun.file(
  new URL("../.github/workflows/release.yml", import.meta.url),
).text();
const ciWorkflow = await Bun.file(new URL("../.github/workflows/ci.yml", import.meta.url)).text();
const changesetsWorkflow = await Bun.file(
  new URL("../.github/workflows/changesets.yml", import.meta.url),
).text();
const rootPackage = await Bun.file(new URL("../package.json", import.meta.url)).json();
const releaseCoordinatorExists = await Bun.file(
  new URL("../.github/workflows/release-coordinator.yml", import.meta.url),
).exists();

describe("release workflow policy", () => {
  test("gates every enabled native archive on its exact compiled credential lifecycle", () => {
    for (const workflow of [ciWorkflow, releaseWorkflow]) {
      const nativeJob = workflow.slice(workflow.indexOf("\n  native:"));
      const gate = nativeJob.indexOf("bun scripts/release-validate.ts secrets");
      const upload = nativeJob.indexOf("uses: actions/upload-artifact@v7.0.1");
      expect(gate).toBeGreaterThan(-1);
      expect(upload).toBeGreaterThan(gate);
      expect(workflow.match(/bun scripts\/release-validate\.ts secrets/g)).toHaveLength(2);
      expect(workflow).toContain("bun scripts/release-validate.ts secrets ${{ matrix.target }}");
    }
  });

  test("builds the core workspace before native credential gates import the CLI", () => {
    for (const workflow of [ciWorkflow, releaseWorkflow]) {
      const nativeJob = workflow.slice(
        workflow.indexOf("\n  native:"),
        workflow.indexOf(workflow === ciWorkflow ? "\n  release-assets:" : "\n  unsigned-assets:"),
      );
      const install = nativeJob.indexOf("run: bun install --frozen-lockfile");
      const coreBuild = nativeJob.indexOf("run: bun run core:build");
      const credentialGate = nativeJob.indexOf("bun scripts/release-validate.ts secrets");

      expect(install).toBeGreaterThan(-1);
      expect(coreBuild).toBeGreaterThan(install);
      expect(credentialGate).toBeGreaterThan(coreBuild);
    }
  });

  test("keeps all target IDs buildable and enabled IDs in gate parity", () => {
    const enabled = NATIVE_VAULT_COMPATIBILITY
      .filter((target) => target.enabled)
      .map((target) => target.id);
    const allTargets = NATIVE_VAULT_COMPATIBILITY.map((target) => target.id);
    const ciNativeJob = ciWorkflow.slice(
      ciWorkflow.indexOf("\n  native:"),
      ciWorkflow.indexOf("\n  release-assets:"),
    );
    expect([...ciNativeJob.matchAll(/^\s+- target:\s+(\S+)$/gm)].map((match) => match[1]))
      .toEqual(allTargets);
    for (const workflow of [ciWorkflow, releaseWorkflow]) {
      const gateLists = [...workflow.matchAll(
        /contains\(fromJSON\('(\[[^']+\])'\), matrix\.target\)/g,
      )].map((match) => JSON.parse(match[1]!));
      expect(gateLists).toHaveLength(3);
      expect(gateLists.every((targets) => JSON.stringify(targets) === JSON.stringify(enabled)))
        .toBe(true);
    }
  });

  test("provisions a real isolated Secret Service session for both Linux targets", () => {
    for (const workflow of [ciWorkflow, releaseWorkflow]) {
      expect(workflow).toContain("matrix.target == 'linux-x64' || matrix.target == 'linux-arm64'");
      expect(workflow).toContain("dbus-run-session");
      expect(workflow).toContain('export XDG_RUNTIME_DIR="$1/runtime"');
      expect(workflow).toContain("gnome-keyring-daemon --unlock --components=secrets");
      expect(workflow).toContain("libsecret-1-0");
      expect(workflow).not.toContain("continue-on-error");
    }
  });

  test("keeps the native-vault gate coupled to the pinned Bun version", () => {
    for (const workflow of [ciWorkflow, releaseWorkflow]) {
      const versions = [...workflow.matchAll(/^\s+bun-version:\s+(.+)$/gm)]
        .map((match) => match[1]);
      expect(versions.length).toBeGreaterThan(0);
      expect(versions.every((version) => version === "1.3.14")).toBe(true);
    }
  });

  test("pins every build checkout to the validated source input", () => {
    const refs = [...releaseWorkflow.matchAll(/^\s+ref:\s+(.+)$/gm)].map((match) => match[1]);
    expect(refs).toEqual([
      "${{ github.sha }}",
      "${{ needs.classify.outputs.release-sha }}",
      ...Array(6).fill("${{ needs.validate-ref.outputs.release-sha }}"),
    ]);
    expect(releaseWorkflow).toContain('git rev-parse "refs/tags/${TAG}^{commit}"');
    expect(releaseWorkflow).toContain('gh release create "$TAG"');
    expect(releaseWorkflow).toContain("--verify-tag");
    expect(releaseWorkflow).not.toContain("target_commitish:");
  });

  test("binds publication and provenance to one protected-main source commit", () => {
    expect(releaseWorkflow).toContain("if: needs.classify.outputs.publish == 'true'");
    expect(releaseWorkflow).toContain(
      'test "${{ github.event.repository.visibility }}" = "public"',
    );
    expect(releaseWorkflow).toContain('test "$RELEASE_SHA" = "$GITHUB_SHA"');
    expect(releaseWorkflow).toContain('git merge-base --is-ancestor "$RELEASE_SHA" origin/main');
    expect(releaseWorkflow).toContain("RELEASE_SHA: ${{ needs.classify.outputs.release-sha }}");
    expect(releaseWorkflow).toContain("bun scripts/release-plan.ts \"$parent_sha\" \"$RELEASE_SHA\"");
    expect(releaseWorkflow).toContain("untagged publication requires a release-shaped first-parent transition");
  });

  test("derives native version, tag, and changelog only from the CLI workspace", async () => {
    const buildScript = await Bun.file(new URL("../scripts/build.ts", import.meta.url)).text();
    const releasePlan = await Bun.file(
      new URL("../scripts/release-plan.ts", import.meta.url),
    ).text();
    const releaseValidation = await Bun.file(
      new URL("../scripts/release-validate.ts", import.meta.url),
    ).text();

    for (const source of [buildScript, releasePlan, releaseValidation]) {
      expect(source).toContain("packages/cli/package.json");
      expect(source).not.toMatch(/from\s+["']\.\.\/package\.json["']/);
    }
    expect(releasePlan).toContain('const cliChangelogPath = "packages/cli/CHANGELOG.md"');
    expect(releaseWorkflow).toContain(
      `VERSION="$(bun -p 'require("./packages/cli/package.json").version')"`,
    );
    expect(releaseWorkflow).toContain(
      'bun scripts/release-notes.ts "$VERSION" "$RELEASE_SHA" packages/cli/CHANGELOG.md dist/RELEASE_NOTES.md',
    );
    expect(releaseWorkflow).not.toMatch(/packages\/core\/(?:package\.json|CHANGELOG\.md).*\b(?:VERSION|TAG)\b/);
  });

  test("classifies pushes inside the top-level release workflow", () => {
    expect(releaseCoordinatorExists).toBe(false);
    expect(releaseWorkflow).toContain(`on:
  push:
    branches: [main]`);
    expect(releaseWorkflow).toContain("workflow_dispatch:");
    expect(releaseWorkflow).not.toContain("workflow_call:");
    expect(releaseWorkflow).toContain(`permissions:
  contents: read`);
    const classifyJob = releaseWorkflow.slice(
      releaseWorkflow.indexOf("\n  classify:"),
      releaseWorkflow.indexOf("\n  validate-ref:"),
    );
    expect(classifyJob).toContain("fetch-depth: 0");
    expect(classifyJob).toContain('bun scripts/release-plan.ts "$BEFORE_SHA" "$RELEASE_SHA"');
    expect(classifyJob).toContain("BEFORE_SHA: ${{ github.event.before }}");
    expect(classifyJob).toContain("RELEASE_SHA: ${{ github.sha }}");
    expect(classifyJob).toContain('echo "publish=true" >> "$GITHUB_OUTPUT"');
    expect(classifyJob).toContain("if: github.event_name == 'workflow_dispatch'");
    expect(classifyJob).toContain('echo "should-release=true" >> "$GITHUB_OUTPUT"');
    expect(classifyJob).toContain('echo "release-sha=$RELEASE_SHA" >> "$GITHUB_OUTPUT"');
    expect(classifyJob).toContain('echo "publish=$PUBLISH" >> "$GITHUB_OUTPUT"');
    expect(classifyJob).not.toContain("secrets:");
    const validateJob = releaseWorkflow.slice(
      releaseWorkflow.indexOf("\n  validate-ref:"),
      releaseWorkflow.indexOf("\n  native:"),
    );
    expect(validateJob).toContain("needs: classify");
    expect(validateJob).toContain("if: needs.classify.outputs.should-release == 'true'");
    expect(validateJob).toContain("publish: ${{ steps.metadata.outputs.publish }}");
    expect(releaseWorkflow).toContain("environment: release-signing");
    expect(releaseWorkflow).not.toContain("uses: ./.github/workflows/release.yml");
  });

  test("does not run repository scripts in steps holding Apple signing secrets", () => {
    const steps = releaseWorkflow.split(/^\s{6}- /m);
    for (const step of steps.filter((candidate) =>
      candidate.includes("secrets.") && candidate.includes("APPLE_")
    )) {
      expect(step).not.toContain("bun scripts/");
    }
  });

  test("uses current release tags for GitHub actions and pins third-party actions", () => {
    const githubActions = new Set([
      "actions/attest@f7c74d28b9d84cb8768d0b8ca14a4bac6ef463e6",
      "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0",
      "actions/checkout@v7.0.0",
      "actions/download-artifact@v8.0.1",
      "actions/setup-python@a309ff8b426b58ec0e2a45f0f869d46889d02405",
      "actions/upload-artifact@v7.0.1",
    ]);
    for (const workflow of [ciWorkflow, releaseWorkflow, changesetsWorkflow]) {
      const actions = [...workflow.matchAll(/^\s+- uses:\s+([^\s#]+)/gm)].map((match) => match[1]!);
      expect(actions.length).toBeGreaterThan(0);
      expect(actions.every((action) => action.startsWith("actions/")
        ? githubActions.has(action)
        : /@[a-f0-9]{40}$/.test(action))).toBe(true);
    }
  });

  test("runs the locked macOS voice router suite in source CI only", () => {
    const sourceJob = ciWorkflow.slice(
      ciWorkflow.indexOf("\n  source:"),
      ciWorkflow.indexOf("\n  native:"),
    );
    const nativeJob = ciWorkflow.slice(
      ciWorkflow.indexOf("\n  native:"),
      ciWorkflow.indexOf("\n  release-assets:"),
    );

    expect(sourceJob).toContain(
      "uses: actions/setup-python@a309ff8b426b58ec0e2a45f0f869d46889d02405",
    );
    expect(sourceJob).toContain(
      "uses: astral-sh/setup-uv@08807647e7069bb48b6ef5acd8ec9567f424441b",
    );
    expect(sourceJob).toContain('python-version: "3.11"');
    expect(sourceJob).toContain('version: "0.11.16"');
    expect(sourceJob).toContain("run: bun run release:validate");
    expect(rootPackage.scripts["release:validate"]).toBe(
      "bun run core:build && bun scripts/release-validate.ts packages",
    );
    expect(sourceJob).toContain("run: bun run check");
    expect(sourceJob).toContain(
      "run: uv run --project examples/macos-voice-router --locked python -m unittest discover -s examples/macos-voice-router/tests",
    );
    expect(nativeJob).not.toContain("setup-python");
    expect(nativeJob).not.toContain("setup-uv");
    expect(nativeJob).not.toContain("macos-voice-router");
    expect(nativeJob.toLowerCase()).not.toContain("python");
    expect(nativeJob).not.toMatch(/\buv\b/);
    expect(nativeJob).toContain("if: startsWith(matrix.target, 'macos-')");
    expect(nativeJob).toContain("run: bun run runtime:smoke");
    expect(nativeJob.indexOf("run: bun run runtime:smoke")).toBeLessThan(
      nativeJob.indexOf("run: bun scripts/build.ts --target"),
    );

    const releaseAssetsJob = ciWorkflow.slice(ciWorkflow.indexOf("\n  release-assets:"));
    expect(releaseAssetsJob).not.toContain("setup-python");
    expect(releaseAssetsJob).not.toContain("setup-uv");
    expect(releaseAssetsJob).not.toContain("macos-voice-router");
    expect(releaseWorkflow).not.toContain("setup-python");
    expect(releaseWorkflow).not.toContain("setup-uv");
    expect(releaseWorkflow).not.toContain("macos-voice-router");
  });

  test("audits the serializer as a self-contained pure-JavaScript runtime dependency", async () => {
    const audit = await validateVoiceDependencies();

    expect(audit.metric).toMatchObject({
      loader: "lazy-embedded-base64-initSync",
      standaloneWasmFiles: [],
    });
    expect(audit.serializer).toMatchObject({
      name: "smol-toml",
      version: "1.7.1",
      integrity: "sha512-PPlsspAZ4jbMBu5DMFhfUGDQLu/vrL4SyBROVS37x8ynnVmFIs1VPBz1Co8Xks3TvpIaZXmU85y4DrQ+UyVFoQ==",
      license: "BSD-3-Clause",
      entrypoint: "./dist/index.js",
      runtimeDependencies: [],
      installLifecycleScripts: [],
      standaloneAssets: [],
      nativeAddons: [],
      standaloneWasmFiles: [],
      embeddedWasmMarkers: [],
      activeRuntimeAccess: [],
    });
    expect(audit.serializer.jsImports.length).toBeGreaterThan(0);
    expect(audit.serializer.jsImports.every((specifier) => /^\.\/.+\.js$/.test(specifier)))
      .toBeTrue();
  });

  // test("maintains one version-only release PR with narrow cancelable permissions", () => {
  //   expect(changesetsWorkflow).toContain(`on:
  // push:
  //   branches: [main]`);
  //   expect(changesetsWorkflow).toContain(`permissions:
  // contents: read`);
  //   expect(changesetsWorkflow).toContain(`concurrency:
  // group: changesets-\${{ github.ref }}
  // cancel-in-progress: true`);

  //   const versionJob = changesetsWorkflow.slice(changesetsWorkflow.indexOf("\n  version:"));
  //   expect(versionJob).toContain(`permissions:
  //     contents: write
  //     pull-requests: write`);
  //   expect(
  //     [...versionJob.matchAll(/^\s{6}([a-z-]+): write$/gm)].map((match) => match[1]),
  //   ).toEqual(["contents", "pull-requests"]);
  //   expect(versionJob).toContain(
  //     "uses: changesets/action@a45c4d594aa4e2c509dc14a9f2b3b67ba3780d0d # v1.9.0",
  //   );
  //   expect(versionJob).toContain("version: bun run changeset:version");
  //   expect(versionJob).toContain('commit: "chore: release"');
  //   expect(versionJob).toContain('title: "chore: release"');
  //   expect(versionJob).toContain("GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}");

  //   expect(changesetsWorkflow).not.toContain("publish:");
  //   expect(changesetsWorkflow).not.toContain("changeset publish");
  //   expect(changesetsWorkflow).not.toContain("NPM_TOKEN");
  //   expect(changesetsWorkflow).not.toContain("environment:");
  //   expect(changesetsWorkflow).not.toContain("id-token:");
  //   expect(changesetsWorkflow).not.toContain("attestations:");
  //   expect(changesetsWorkflow).not.toContain("actions: write");
  //   expect(changesetsWorkflow).not.toContain("pull_request:");
  //   expect(changesetsWorkflow).not.toContain("workflow_run:");
  // });

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
    const publishJob = releaseWorkflow.slice(
      releaseWorkflow.indexOf("\n  publish:"),
      releaseWorkflow.indexOf("\n  homebrew-sync:"),
    );
    expect(publishJob).toContain("persist-credentials: false");
    expect(publishJob).toContain("GH_TOKEN: ${{ github.token }}");
    expect(publishJob).toContain(
      `GIT_AUTH_HEADER="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$GH_TOKEN" | base64 -w 0)"`,
    );
    expect(publishJob).toContain(
      'git --config-env=http.https://github.com/.extraheader=GIT_AUTH_HEADER push origin "refs/tags/$TAG"',
    );
    expect(publishJob).toContain(
      'git --config-env=http.https://github.com/.extraheader=GIT_AUTH_HEADER fetch --force origin "refs/tags/$TAG:refs/tags/$TAG"',
    );
    expect(publishJob).not.toContain("https://x-access-token:");
  });

  test("verifies and attests final checksums with publish-only permissions", () => {
    const publishJob = releaseWorkflow.slice(
      releaseWorkflow.indexOf("\n  publish:"),
      releaseWorkflow.indexOf("\n  homebrew-sync:"),
    );
    expect(publishJob).toContain(`permissions:
      contents: write
      id-token: write
      attestations: write
      artifact-metadata: write`);
    expect(
      [...publishJob.matchAll(/^\s{6}([a-z-]+): write$/gm)].map((match) => match[1]),
    ).toEqual(["contents", "id-token", "attestations", "artifact-metadata"]);

    const assetDownload = publishJob.indexOf("name: release-assets");
    const checksumVerification = publishJob.indexOf("sha256sum --check SHA256SUMS");
    const attestation = publishJob.indexOf(
      "uses: actions/attest@f7c74d28b9d84cb8768d0b8ca14a4bac6ef463e6 # v4.2.0",
    );
    const tagCreation = publishJob.indexOf('git tag "$TAG" "$RELEASE_SHA"');
    const tagRevalidation = publishJob.lastIndexOf(
      'test "$(git rev-parse "refs/tags/${TAG}^{commit}")" = "$RELEASE_SHA"',
    );
    const release = publishJob.indexOf('gh release create "$TAG"');
    expect(checksumVerification).toBeGreaterThan(assetDownload);
    expect(attestation).toBeGreaterThan(checksumVerification);
    expect(tagCreation).toBeGreaterThan(attestation);
    expect(tagRevalidation).toBeGreaterThan(tagCreation);
    expect(release).toBeGreaterThan(attestation);
    expect(release).toBeGreaterThan(tagRevalidation);
    expect(publishJob).toContain("subject-checksums: dist/SHA256SUMS");
    expect(publishJob.slice(attestation)).not.toContain("scripts/repack-archive.ts");
    expect(publishJob.slice(attestation)).not.toContain("scripts/build.ts");
  });

  test("generates inert changelog notes before the privileged publisher", () => {
    const finalAssetsJob = releaseWorkflow.slice(
      releaseWorkflow.indexOf("\n  final-assets:"),
      releaseWorkflow.indexOf("\n  publish:"),
    );
    const publishJob = releaseWorkflow.slice(
      releaseWorkflow.indexOf("\n  publish:"),
      releaseWorkflow.indexOf("\n  homebrew-sync:"),
    );
    expect(finalAssetsJob).toContain(
      'bun scripts/release-notes.ts "$VERSION" "$RELEASE_SHA" packages/cli/CHANGELOG.md dist/RELEASE_NOTES.md',
    );
    expect(finalAssetsJob).toContain("dist/RELEASE_NOTES.md");
    expect(publishJob).toContain('--notes-file dist/RELEASE_NOTES.md');
    expect(publishJob).toContain('gh release create "$TAG" dist/*.zip dist/SHA256SUMS');
    expect(publishJob).not.toContain("bun scripts/");
    expect(publishJob).not.toContain('gh release create "$TAG" dist/RELEASE_NOTES.md');
    expect(publishJob).not.toContain("--notes-from-tag");
  });

  test("reconciles complete, resumable, conflicting, and out-of-order public state", () => {
    expect(releaseWorkflow).toContain("should-build: ${{ steps.state.outputs.should-build }}");
    expect(releaseWorkflow).toContain("gh release download \"$TAG\" --dir .published-release");
    expect(releaseWorkflow).toContain("sha256sum --check SHA256SUMS");
    expect(releaseWorkflow).toContain("gh attestation verify \"$archive\"");
    expect(releaseWorkflow).toContain('--signer-workflow "$GITHUB_REPOSITORY/.github/workflows/release.yml"');
    expect(releaseWorkflow).toContain('--source-digest "$RELEASE_SHA"');
    expect(releaseWorkflow).toContain('echo "should-build=false" >> "$GITHUB_OUTPUT"');
    expect(releaseWorkflow).toContain("Release $TAG exists without its tag");
    expect(releaseWorkflow).toContain("$TAG already points to another commit");
    expect(releaseWorkflow).toContain("higher stable Release $published_tag is already public");
    expect(releaseWorkflow.match(/elif \[\[ "\$tag_probe_status" -ne 2 \]\]/g)).toHaveLength(2);
    const releaseCore = releaseWorkflow.slice(0, releaseWorkflow.indexOf("\n  homebrew-sync:"));
    expect(releaseCore.match(/--connect-timeout 10 --max-time 30/g)).toHaveLength(2);
    expect(releaseWorkflow.match(/published_tags="\$\(gh api --paginate/g)).toHaveLength(2);
    expect(releaseWorkflow).not.toContain("done < <(gh api --paginate");
    const preflight = releaseWorkflow.slice(
      releaseWorkflow.indexOf("\n      - id: state"),
      releaseWorkflow.indexOf("\n  native:"),
    );
    expect(preflight.indexOf('published_tags="$(gh api --paginate'))
      .toBeLessThan(preflight.lastIndexOf('echo "should-build=true"'));
    expect(releaseWorkflow).toContain(`concurrency:
  group: release-\${{ inputs.release-sha || github.sha }}
  cancel-in-progress: false`);
  });

  test("admits Homebrew sync only after fresh or verified-existing publication", () => {
    const start = releaseWorkflow.indexOf("\n  homebrew-sync:");
    expect(start).toBeGreaterThan(-1);
    const homebrewJob = releaseWorkflow.slice(start);
    expect(homebrewJob).toContain("needs: [validate-ref, publish]");
    expect(homebrewJob).toContain("always()");
    expect(homebrewJob).toContain("needs.validate-ref.result == 'success'");
    expect(homebrewJob).toContain("needs.validate-ref.outputs.publish == 'true'");
    expect(homebrewJob).toContain(
      "needs.validate-ref.outputs.should-build == 'true' && needs.publish.result == 'success'",
    );
    expect(homebrewJob).toContain(
      "needs.validate-ref.outputs.should-build == 'false' && needs.publish.result == 'skipped'",
    );
    expect(homebrewJob).not.toContain("needs.publish.result == 'failure'");
    expect(homebrewJob).not.toContain("needs.publish.result == 'cancelled'");
  });

  test("reverifies public Release evidence before Homebrew rendering", () => {
    const homebrewJob = releaseWorkflow.slice(releaseWorkflow.indexOf("\n  homebrew-sync:"));
    for (const asset of [
      "SHA256SUMS",
      "linux-arm64.zip",
      "linux-x64.zip",
      "macos-arm64.zip",
      "macos-x64.zip",
      "windows-x64.zip",
    ]) expect(homebrewJob).toContain(asset);
    expect(homebrewJob).toContain('git ls-remote --exit-code --refs origin "refs/tags/$TAG"');
    expect(homebrewJob).toContain(".draft == false");
    expect(homebrewJob).toContain(".prerelease == false");
    expect(homebrewJob).toContain('gh release download "$TAG"');
    expect(homebrewJob).toContain('manifest_assets="$(sed -nE');
    expect(homebrewJob).toContain("expected_archives() {");
    expect(homebrewJob).toContain('test "$manifest_assets" = "$(expected_archives)"');
    expect(homebrewJob).toContain("sha256sum --check --strict --status SHA256SUMS");
    expect(homebrewJob).toContain('gh attestation verify "$archive"');
    expect(homebrewJob).toContain('--signer-workflow "$GITHUB_REPOSITORY/.github/workflows/release.yml"');
    expect(homebrewJob).toContain('--source-digest "$RELEASE_SHA"');
    expect(homebrewJob.indexOf("bun scripts/package-render.ts"))
      .toBeGreaterThan(homebrewJob.indexOf('gh attestation verify "$archive"'));
  });

  test("confines the tap token to one pinned mutation step", () => {
    const homebrewJob = releaseWorkflow.slice(releaseWorkflow.indexOf("\n  homebrew-sync:"));
    expect(homebrewJob).toContain("environment: homebrew-publication");
    expect(homebrewJob).toContain(`permissions:
      contents: read
      attestations: read`);
    const secretSteps = homebrewJob.split(/^\s{6}- /m)
      .filter((step) => step.includes("HOMEBREW_TAP_TOKEN"));
    expect(secretSteps).toHaveLength(1);
    expect(secretSteps[0]).toContain("bun scripts/homebrew-reconcile.ts");
    expect(secretSteps[0]).not.toContain("uses:");
    const actions = [...homebrewJob.matchAll(/^\s+- uses:\s+([^\s#]+)/gm)]
      .map((match) => match[1]!);
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every((action) => /@[a-f0-9]{40}$/.test(action))).toBe(true);
    expect(homebrewJob).toContain("persist-credentials: false");
    expect(homebrewJob).not.toContain("contents: write");
    expect(homebrewJob).not.toContain("gh release create");
    expect(homebrewJob).not.toContain('git tag "$TAG"');
  });

  test("summarizes trusted Homebrew outcomes after every stage", () => {
    const homebrewJob = releaseWorkflow.slice(releaseWorkflow.indexOf("\n  homebrew-sync:"));
    for (const id of ["verify-public", "render-formula", "reconcile-tap", "summarize-homebrew"]) {
      expect(homebrewJob).toContain(`id: ${id}`);
    }
    const summary = homebrewJob.slice(homebrewJob.indexOf("id: summarize-homebrew"));
    expect(summary).toContain("if: always()");
    expect(summary).toContain("steps.verify-public.outcome");
    expect(summary).toContain("steps.render-formula.outcome");
    expect(summary).toContain("steps.reconcile-tap.outcome");
    expect(summary).toContain("failed-before-write");
    expect(summary).toContain("write-outcome-unconfirmed");
    expect(summary).not.toContain("release.json");
    expect(summary).not.toContain("SHA256SUMS");
  });

  test("keeps Chocolatey outside the release workflow", () => {
    for (const workflow of [ciWorkflow, releaseWorkflow]) {
      expect(workflow.toLowerCase()).not.toContain("chocolatey");
    }
  });
});
