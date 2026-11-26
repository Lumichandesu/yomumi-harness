# Changelog

## Unreleased

### Fixed

- Treat explicit Bun JUnit retry markers (`flakyFailure`, `rerunFailure`) as incomplete evidence instead of ignoring them. Both commands stop with exit 2 even when the runner's final exit is 0. Plain reports keep their existing behavior.
- Reports from a runner that discards retry history cannot be checked for retries from XML alone. See [Retry limitations](docs/guide/04-reference.md#retries).

### Added
- Built-in help for `compact` and `compare`, including scope inputs and exit meanings. Normal invocations still return JSON.

- [No-Bun replay](examples/replay/README.md), [local review integration](docs/guide/08-integrate.md), and [examples where the failure total doesn't move](docs/guide/09-equal-counts.md).
