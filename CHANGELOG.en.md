# Changelog (English)

- [中文更新日志](./CHANGELOG.md)
- [English Changelog](./CHANGELOG.en.md)
- [日本語 changelog](./CHANGELOG.ja.md)
- [한국어 changelog](./CHANGELOG.ko.md)

This file covers the **0.12.0** release notes and the current **unreleased** changes in English. For the full history, see [CHANGELOG.md](./CHANGELOG.md) (Chinese).

## [Unreleased]

### Added

- **Source anchors (R7) — a memory can now be traced back to a real position in the session.** Until now the traceability chain was broken: L1 carried `source_message_ids`, but those are **L0 message ids** (`msg_<epoch_ms>_<hex>`) while the L0 table had no `turn`/`step` columns, and the id list was never written to the retrieval DB at all (the store kept only `metadata`, silently dropping the field). Result: **no memory could be located in the original conversation**.
  - `l0_conversations` gains `turn`/`step` columns (idempotent `ALTER TABLE`; old rows stay NULL = "no anchor", never back-filled with a guess) plus an `(session_id, turn)` index.
  - The capture hook now folds `step/start`, so `user/message` events — which do not carry `step` in the kernel payload — still get their **same-turn** coordinate. `assistant/message` uses the `{turn, step}` it already carries. Messages before the first `step/start` keep `step` empty on purpose: **a missing coordinate is never invented.**
  - Anchors live under the reserved `metadata_json` key `dsh_source_anchors` (rendered as `t12 s3` in the UI). No new column, no disk-contract change. Both the fresh-store path and the **merge/update** path carry anchors — otherwise a single merge would lose the coordinate.
  - New host API `MemoryDb.l0ByAnchor(sessionId, turn, step?)` fetches L0 messages **by coordinate** instead of by recency; this is the single read entry point for the upcoming evidence reader.
- **The records panel now shows the source anchor** where it previously always showed a dash.

### Fixed

- **`UiRecord.sourceMessageIds` was a dead field.** It read a column `l1_records` never had, so it always resolved to `[]` and the panel's source row **never rendered**. Replaced by `sourceAnchors`, which reads real data.

## [0.12.0] — 2026-09-17

### Added

- **Manual vector-index rebuild (`dsh-memory/embedding-reindex` + the "Vector index" block in settings).** A rebuild previously had exactly two triggers: the `db.init` change-detection chain at startup, and the periodic backfill that fills in missing vectors — **there was no manual entry point**. The settings page showed only "Cancel" (and only while a rebuild was already running): no "Start", no count of what was embedded versus outstanding.
  - **Endpoint surface 31 → 32.** New `EmbeddingReindexStartResponse` (`{accepted:true}`). **Accepting returns immediately and does not carry progress** — the client keeps polling `reindex` on `embedding-state-get`. Two progress vocabularies eventually disagree, so there is deliberately only one. All four places were updated together (`contract.ts` maps / the `MEMORY_ENDPOINTS` allowlist / the dispatcher `case` / the endpoint-count assertion) — **missing any one pins the endpoint at a permanent 404**, and since the client `rpc` catch swallows that silently, the whole panel just vanishes.
  - **`EmbeddingStateView` gained `vectors`**: `embedded` / `total` / `missing` / `skipped` for L1 and L0, which is where "X of Y embedded" comes from. The db layer's **`-1` sentinel passes through verbatim** — "vector capability unavailable" and "nothing embedded yet" must stay two different sentences; collapsing them into one number sends the user to click a button that can never respond.

### Fixed

- **Rebuild requests that would be accepted but never actually run are now rejected.** The first line of `L1Store.reindex` / `L0Store.reindex` **silently short-circuits** to `0/0/0` when vector capability is not ready. Ungated, the UI would report "rebuild complete, nothing outstanding" while the rebuild **never started**. That trap was already documented at `src/index.ts:240`, but only for the startup chain; the manual entry point was a new hole. `startReindex()` hoists all five gates, each with an **actionable** message: unloaded / already running / source switch holds the lock / **embedding source off** (`currentInfo` empty) / **service not ready**. ("Turn it on first" and "wait a bit" are different instructions and must not be merged.) This required a `vectorsReady()` accessor on both stores — `helper` is private, so nothing outside could ask.
- **Incomplete `db` test double in `embedding-subsystem.test.ts`.** It carried only `swapProvider` / `markEmbeddingSynced` and bypassed type checking via `as never`, so the gap never surfaced; once `snapshot()` began including vector counts it crashed (`getVecSkipSet is not a function`). **The double was completed rather than making `vectorCounts` defensive**: the signature declares a full `MemoryDb`, and swallowing missing methods swallows real wiring errors with them.

### Tests

- 5 new cases: rejected when off / rejected when not ready / accepted and drives L1+L0 with an immediate concurrent rejection / rejected after unload / `snapshot` count semantics. **Every rejection path asserts both "throws" and "downstream never called"** — asserting only the throw would let an implementation that calls downstream *and then* throws pass.
- **Falsified**: temporarily removing the readiness guard turns `向量能力未就绪 → 拒绝` red (`expected [Function] to throw an error`); restored and green again.
- Full suite **39 files / 403 cases**; `typecheck` (three tsconfigs), `build` and `smoke` all green.

## [Unreleased]

### Added

- **§E Storage scope `scope` (visibility range, orthogonal to `family`)**. Until now every project shared one memory store: `work`-family memories distilled in project A were recalled in project B. New `scope` setting (`global` default / `workspace`), **orthogonal** to `family` — `family` answers "what kind of content is this", `scope` answers "how far should it be visible". "In `workspace` mode the `work` family is isolated per workspace while `chat` stays global" is a **default, not a derivation rule** (personal memories are meant to cross projects; contamination lives between projects).
  - **Zero drift is constructed, not compared**: when `cfg.scope` is not `workspace`, the shared `scopeFilterOf` always returns `undefined` (= no filtering), so no call site can accidentally pass a workspace id. Existing deployments (key absent) behave **byte-identically**.
  - **Isolation sits on the same layer as family isolation**: not just the retrieval exit — **dedup candidate recall** is filtered too. The candidate pool decides the next dedup decision; leaving it cross-workspace produces memories that are "invisible in project B yet already decided project A's fate", which is worse than no isolation ([`ADR-0008`](./docs/adr/0008-storage-scope-vs-family.md)). The graph lane filters on the **source record's** ownership at the same layer; all write paths share one `resolveRecordScope`.
  - **The workspace identifier is the canonical cwd, not the host's `dsh-workspace` `WorkspaceId` (uuid)**: same header channel as §A's `parentSession`, synchronously available; declaring `inject` would fail the whole plugin tree on hosts lacking the service; the host's own membership rule is "session header's canonical cwd == workspace path"; a uuid requires a *registered* workspace, so unregistered directories would silently lose isolation. Known boundary: **symlinks are not resolved**, which over-isolates (the safe direction) rather than leaking ([`ADR-0009`](./docs/adr/0009-workspace-identity-source.md)).
  - **Migration labels ownership only, never moves or deletes**: `l1_records` / `l1_fts` each gain `scope` + `workspace_id`; existing data is graded `global` by the `ALTER` default — row count, id, content and created_time stay byte-identical.
  - **Two real defects caught during execution**: ① an FTS rebuild backfill that dropped scope would **silently erase isolation** (its per-row `catch` swallows the column-count mismatch, leaving `count=0` and an empty index); ② a missing **shape normalization** on the write side meant memories could be written and then be unreachable (retrieval passes a normalized lower-case path while the store kept the caller's upper-case string). Both were caught by end-to-end tests and mutation probes.
- **§F Graph node vector column `graph_node_vec` (storage and degradation groundwork)**. The graph only had lexical weighted scoring, so semantically equivalent but literally different entities ("云深处" vs "DeepRobotics") could not resolve to each other. Adds a vec0 virtual table **same-pattern** as `l1_vec` (one shared encoding, one `float[N] distance_metric=cosine` declaration); dimensions **reuse** the existing capability probe rather than adding a second one.
  - **Degradation is absorbed in an inner `try/catch`**: a missing vec0 makes table creation throw, and if that reached `GraphStore.init`'s outer catch the graph would degrade from "vector lane unavailable" to "**the entire graph domain unavailable**", taking lexical retrieval, projection and adjudication with it ([`ADR-0011`](./docs/adr/0011-graph-node-vector-storage-and-degradation.md)).
  - **This wave ships a door, not a producer or consumer**: projection does not yet compute embeddings. Recorded as incomplete — it is §F's starting point, not its end.

- **§B L1 decision-receipt chain (traceability infrastructure)**. Every L1 record is the *result* of a dedup decision (store / update / merge / skip), but the decision itself left no trace — you could see the outcome, never what it was based on. New `l1_receipts` table records one receipt per decision (`run_id` / `record_id` / `kind` / **a sha256 digest of the ordered candidate pool** / `decided_at`), with the new **`memory_receipts`** tool and **`dsh-memory/receipts`** RPC endpoint for **two-dimensional backtracking** (by record or by run; both = AND). Receipts must exist *before* the event — input snapshots **cannot be backfilled**, so this shipped as a prerequisite rather than waiting for a symptom ([ADR-0006](./docs/adr/0006-l1-decision-receipts.md)).
  - Retention is **by run count** (`RECEIPTS_MAX_RUNS = 1000`) — a time window **cannot bound the row count**. Trimming is **per run, not per row**: cutting rows yields *half batches*, which produce conclusions that look complete but silently omit entries — worse than finding nothing.
  - Hard line: trimming **touches `l1_receipts` only, never `l1_records`** (discardable observation data vs. the user's source of truth).
  - Failure isolation: receipts are a side channel — a write failure logs a warning and **never interrupts L1 distillation**.

- **§C conflict freeze (opt-in, off by default)**. The dedup **action vocabulary** was `store` / `update` / `merge` / `skip` — so the "conflict detector" adjudicated contradictions itself (`update` overwrite or `merge`), with **no "stop and ask a human" option**. With `conflictFreeze.enabled`, the vocabulary gains `conflict`: when the model judges that both sides look right and it cannot tell, the pair is **parked** in `conflict_pending` — **the new memory is still stored and neither side is rewritten** — and a human adjudicates via the new **`memory_resolve_conflict`** tool (RPC: `dsh-memory/conflict-resolve`) with `winner` / `loser` / `both`.
  - **Freeze is not "block the write", it is "do not auto-adjudicate"** — the former loses information, which is worse than the problem it solves.
  - **Safety valves**: `maxPending` (queue cap) and `timeoutDays` (timeout fallback). The semantics are "**stop taking new ones**", not "quietly delete old ones" — auto-settled pairs **are still written to the queue** with `resolution = auto`, distinguishable from a human verdict.
  - **Graph side**: nodes whose sources hit a frozen record are marked `disputed` (an existing status; still a retrieval candidate, i.e. "recalled as usual but visibly contested"). The mark is a **derived sync**, not a one-way flag: adjudication **cancels** the dispute, and a one-way flag would leave resolved nodes stuck at `disputed` — a derived graph lying about the facts.
  - **Zero drift**: while off, the dedup prompt is **byte-identical** to before. This is **structural** (the off path returns the base constant directly), not a manual diff ([ADR-0010](./docs/adr/0010-conflict-freeze-default-off-and-timeout.md)).

### Changed

- **New settings** `conflictFreeze.enabled` (off) / `conflictFreeze.maxPending` (100) / `conflictFreeze.timeoutDays` (30; `0` = no timeout fallback). **New endpoints** `dsh-memory/receipts` and `dsh-memory/conflict-resolve` (endpoint surface 26 → 28).
- **`L1ReceiptKind` gains `conflict`**. Extending an action vocabulary requires checking **every consumer of that vocabulary** (receipt normalisation, stats logs, rendered text, schema descriptions) — measured during this work: a missed registration recorded "the model **explicitly** said it cannot tell" as `skip_missing` ("the model **did not answer**"), and since §C's auditability depends **entirely** on the receipt chain, the audit conclusion was the exact opposite of the facts.

### Fixed

- **Unrecognised actions silently absorbed by the fallback branch.** The apply loop in `pipeline/l1.ts` branches explicitly only on `store` / `skip`; **every other action falls through to the update/merge branch**. A `conflict` decision carries no `target_ids` by design, so `targets=[]` and the record was appended as a "merged product that replaced 0 rows" with `version = 1`. **No error, no data loss — the only trace was a version number**, i.e. `conflict` had been silently downgraded to merge/update: exactly the behaviour §C exists to remove. **Fix**: an explicit `conflict` branch; when validation fails or the switch is off it falls back to `store`, never to the fallback branch.
- **The endpoint gate was a hand-copied list.** `tests/contract-keys.test.ts` duplicated the real registry instead of importing it, so both assertions were self-consistent with the copy. When §B added `receipts` the real registry went to 27 while the copy stayed at 26 and the count assertion stayed at `toBe(26)` — it went green regardless. Adding `conflict-resolve` this round **still** went green. **Fix**: assert the local list equals `MEMORY_ENDPOINTS` item by item.

## [0.11.0] — 2026-09-13

### Compatibility (adapted to the DSH plugin framework docs)

- **Cross-version settings registration (0.1.1-rc.2 ~ 0.1.5-rc.2)**. `src/settings.ts` previously **value-imported** `settingsNamespace()` from `@deepseek-ai/dsh-settings`, an export that v0.1.3+ removed — on newer hosts the module fails at load time with `Failed to load plugins`, taking down the whole plugin tree. Now:
  - The namespace is the string literal `'dsh-memory'` (the browser half only reads the raw string; equivalent on old and new hosts). Only type imports remain (erased at compile time, no load risk).
  - Registration uses a three-way runtime branch: prefer `settings.register()` (present in every target version; returns a get/watch/update scope used by the live toggles and UI writes); fall back to an `settings.installSection()` bridge (v0.1.2+ service surface, only when `register` is absent; runtime writes reject with a business error); if neither exists, degrade to always-on — the "settings failure must never take down the host" rule is unchanged.
  - `SettingsScope` is now a local structural type, no longer tied to package-level type exports.
- **Added `dsh.plugin.json`** (DSH discovery manifest: id / `engines.dsh` `>=0.1.1-rc.2 <0.2.0-0` / components pointing at `dist/` artifacts), aligned with the `dsh-plugin-template` standard file structure.
- **`@deepseek-ai/dsh-*` peerDependencies are now optional with widened ranges** (`^0.1.1-rc.2 || ^0.1.2-rc.1 || ^0.1.3-rc.1 || ^0.1.5-rc.2`); `@deepseek-ai/cordis` stays required — per awesome-dsh-plugin submission requirement B.3.
- **Added `screenshots.json`** (8 entries referencing `assets/img/`) for the submission card.

### Changed

- `package.json` version bumped to 0.11.0; npm `files` adds `dsh.plugin.json` (`screenshots.json` stays git-only per the awesome-dsh-plugin probe convention, not shipped in the npm package).

### Pending field verification

- The `conversation.input.left` / `settings.section` slots and the Session V3 `session.surface.nodes` semantics (occupancy estimate) on v0.1.5-rc.2 are not yet field-tested; see the compatibility matrix in the README.
