# Changesets

Changesets record release intent for `llm-now` and `@swartzrock/llm-now-core`.
They update versions and changelogs; the separate protected release workflows
handle native `vX.Y.Z` and GitHub core Release `core-vX.Y.Z` distribution.
Nothing in this directory publishes a package or creates a release tag.

For a release-worthy change:

1. Run `bun run changeset`.
2. Select every package whose public contract changes. Use `llm-now` for CLI-only
   changes, `@swartzrock/llm-now-core` for core-only changes, and both for shared
   observable changes. Their versions are independent.
3. Choose `patch`, `minor`, or `major` based on the user-visible impact. Before
   core 1.0, use `minor` for incompatible public API changes.
4. Write a concise summary and commit the generated Markdown file with the change.

Use `bun run changeset:status` to inspect pending intent. Maintainers use `bun run changeset:version` through the reviewed release-PR workflow; contributors should not bump `package.json` directly.

Core's current `0.1.0` is the unreleased extracted version. The pending core
patch Changeset makes the next reviewed version pull request advance it to
`0.1.1`; merging that pull request triggers the first GitHub core Release.
