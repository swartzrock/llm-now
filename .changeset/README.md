# Changesets

Changesets record release intent for `llm-now`. They update the version and changelog; GitHub's protected binary release workflow handles distribution. Nothing in this directory publishes to npm or creates a release tag.

For a release-worthy change:

1. Run `bun run changeset`.
2. Select `llm-now` and choose `patch`, `minor`, or `major` based on the user-visible impact.
3. Write a concise summary and commit the generated Markdown file with the change.

Use `bun run changeset:status` to inspect pending intent. Maintainers use `bun run changeset:version` through the reviewed release-PR workflow; contributors should not bump `package.json` directly.
