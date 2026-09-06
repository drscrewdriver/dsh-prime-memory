# Changelog (English)

- [中文更新日志](./CHANGELOG.md)
- [English Changelog](./CHANGELOG.en.md)
- [日本語 changelog](./CHANGELOG.ja.md)
- [한국어 changelog](./CHANGELOG.ko.md)

This file covers the **0.9.0** release notes in English. For the full history, see [CHANGELOG.md](./CHANGELOG.md) (Chinese).

## [0.9.0] — 2026-09-01

### Added

- **Hall coarse-classification channel**: a coarse attribute axis orthogonal to `family`/`type`. `types.ts` defines `HALL_CATALOG` (canonical source: `work` / `relationships` / `general` enabled by default, plus experimental `finance` / `journey`); `config.hall.enabled` controls which halls participate. The L1 extraction stage auto-tags `metadata.hall` from the enabled list (omitted when no clear fit — no forced `general`). `ListRecordsRequest.hall` and `UiRecord.hall` extend the contract, and the Records browser gains a Hall filter dropdown plus a Hall tag on each card.
- **Remote embedding runtime override**: the embedding `baseUrl` / `apiKey` / `model` / `dimensions` become **editable in the settings UI** and override the deploy YAML at runtime (injected by `effectiveCfg` into `cfg.embedding`, in a subtree independent of the LLM channel). `EmbeddingManager` gains `getEff()` to read the runtime-overridden effective config so the settings edits take effect live.
- **High-privilege write/delete tools**: `memory_add` (explicit "remember X" → a direct L1 write, optional `hall`) and `memory_delete` (semantic-hit delete, up to 10) are registered, gated behind `live.memoryMutate` (the high-privilege mode toggle in settings). The Records browser adds a high-privilege switch (with confirmation) and a per-record delete button.
- **Multilingual docs** (per the `multilingual-docs-skill` spec): `README` / `INSTALL` / `CHANGELOG` across `zh` / `en` / `ja` / `ko`, with top-of-page language switchers (native-language links) and a DSH-compatibility note on the `ja` / `ko` pages.
- **Tooling**: ESLint 9 (flat config) and Vitest are wired in; `npm run lint` and `npm run test` are added, with the first Vitest cases covering `HALL_CATALOG` and the Hall extraction prompt.

### Changed

- **Remote embedding `apiKey` is now optional**: key-less self-hosted `/embeddings` services are accepted (`remoteCeiling` no longer requires `apiKey`); the request omits the `authorization` header when no key is set, so an empty `Bearer` no longer gets rejected.

### Fixed

- Remote embedding no longer sends an empty `Bearer` header when `apiKey` is empty.

### Known limitations

- The `getEff()` wiring at the `EmbeddingManager` construction site (`src/index.ts`) is not yet connected, so the runtime override does not yet flow into the manager's internal embedding service — expected to be completed in a follow-up.
