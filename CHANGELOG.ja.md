# 更新履歴（日本語 changelog）

- [更新日志（中文）](./CHANGELOG.md)
- [Changelog (English)](./CHANGELOG.en.md)
- [日本語 changelog](./CHANGELOG.ja.md)
- [한국어 changelog](./CHANGELOG.ko.md)

> **互換性の注意**：本プラグインは日本語ドキュメントを提供しますが、公式 DSH の `LocaleRuntime` が登録する言語は `zh` / `en` のみです。`ja` を選択すると `locale "ja" is not registered` となります。DSH を fork して `LOCALE_IDS` と `LOCALES` ラベルを更新し再ビルドすることで利用可能になります。

本ファイルは **0.9.0** リリースノートの日本語版です。全履歴は [CHANGELOG.md](./CHANGELOG.md)（中文）を参照してください。

## [0.9.0] — 2026-09-01

### 追加

- **Hall 粗分類チャネル**：`family` / `type` と直交する粗属性軸。`types.ts` が `HALL_CATALOG`（正典ソース：既定有効の `work` / `relationships` / `general` に加え、実験的な `finance` / `journey`）を定義。`config.hall.enabled` で参加する Hall を制御。L1 抽出段階が有効リストから `metadata.hall` を自動タグ付け（明確な該当がない場合は省略、強制 `general` なし）。`ListRecordsRequest.hall` と `UiRecord.hall` が契約を拡張し、レコードブラウザに Hall フィルタ dropdown と各カードの Hall タグが追加。
- **リモート埋め込みのランタイム上書き**：埋め込み `baseUrl` / `apiKey` / `model` / `dimensions` が**設定 UI で編集可能**になり、デプロイ YAML をランタイムで上書き（`effectiveCfg` が `cfg.embedding` へ注入、LLM チャネルとは独立したサブツリー）。`EmbeddingManager` に `getEff()` が追加され、設定編集が即時反映される。
- **高権限書き込み/削除ツール**：`memory_add`（明示的な「覚えておいて X」→ L1 直接書き込み、任意の `hall`）と `memory_delete`（意味検索ヒット削除、最大 10 件）を登録。`live.memoryMutate`（設定の高権限モード）でゲート。レコードブラウザに高権限スイッチ（確認付き）と各レコード削除ボタンを追加。
- **多言語ドキュメント**（`multilingual-docs-skill` 仕様準拠）：`README` / `INSTALL` / `CHANGELOG` を `zh` / `en` / `ja` / `ko` で整備。各ページ冒頭に言語切替（各言語母語表記）と、ja/ko ページの DSH 互換性注意を配置。
- **ツールチェイン**：ESLint 9（flat config）と Vitest を導入。`npm run lint` / `npm run test` を追加。`HALL_CATALOG` と Hall 抽出プロンプトをカバーする最初の Vitest ケースを追加。

### 変更

- **リモート埋め込みの `apiKey` が任意に**：キー不要な自己ホスト `/embeddings` サービスを受け入れ（`remoteCeiling` は `apiKey` を必須としなくなった）。キー未設定時は `authorization` ヘッダを省略し、空 `Bearer` が拒否されることを防ぐ。

### 修正

- `apiKey` が空のとき、リモート埋め込みが空 `Bearer` ヘッダを送らなくなった。

### 既知の制限

- `EmbeddingManager` 構築箇所（`src/index.ts`）の `getEff()` 配線がまだ接続されておらず、ランタイム上書きがマネージャ内部の埋め込みサービスにまだ反映されません。フォローアップで完了予定。
