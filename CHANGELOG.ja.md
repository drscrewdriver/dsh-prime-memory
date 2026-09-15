# 更新履歴（日本語 changelog）

- [更新日志（中文）](./CHANGELOG.md)
- [Changelog (English)](./CHANGELOG.en.md)
- [日本語 changelog](./CHANGELOG.ja.md)
- [한국어 changelog](./CHANGELOG.ko.md)

> **互換性の注意**：本プラグインは日本語ドキュメントを提供しますが、公式 DSH の `LocaleRuntime` が登録する言語は `zh` / `en` のみです。`ja` を選択すると `locale "ja" is not registered` となります。DSH を fork して `LOCALE_IDS` と `LOCALES` ラベルを更新し再ビルドすることで利用可能になります。

本ファイルは **0.11.0** リリースノートと現在の**未リリース**変更の日本語版です。全履歴は [CHANGELOG.md](./CHANGELOG.md)（中文）を参照してください。

## [未リリース]

### 追加

- **§B L1 決定証跡チェーン（追跡可能性の基盤）**。L1 レコードはすべて重複排除判断の**結果**ですが、判断自体は痕跡を残していませんでした（結果は見えるが、何に基づいたかは見えない）。新テーブル `l1_receipts` が判断ごとに証跡を残します（`run_id` / `record_id` / `kind` / **候補プールの順序付き sha256 ダイジェスト** / `decided_at`）。新ツール **`memory_receipts`** と RPC 端点 **`dsh-memory/receipts`** で、レコード単位・バッチ単位の**二次元遡及**ができます。証跡はイベントの**前に**存在しなければなりません——入力スナップショットは**後から補填できない**ためです（[ADR-0006](./docs/adr/0006-l1-decision-receipts.md)）。
  - 保持方針は **run 数**単位（`RECEIPTS_MAX_RUNS = 1000`）——時間窓では行数の上界を与えられません。またトリミングは **run 単位であり行単位ではありません**（行単位では「半端なバッチ」が生まれ、完全に見えて実は欠落した結論を出してしまいます——「見つからない」より有害）。
  - レッドライン:トリミングは **`l1_receipts` のみに触れ、`l1_records` には絶対に触れない**。
  - 失敗隔離:証跡は側路インフラであり、書き込み失敗は `warn` のみで **L1 蒸留を絶対に中断しません**。

- **§C 矛盾凍結（オプション、既定オフ）**。従来の重複排除**決定語彙**は `store` / `update` / `merge` / `skip` のみ——「衝突検出器」が矛盾を検出しても **LLM が直接裁定して書き込み**、**「止めて人に聞く」という選択肢がありませんでした**。`conflictFreeze.enabled` を有効にすると語彙に `conflict` が加わり、どちらも正しそうで機械には判定できない場合にペアを `conflict_pending` に**待機**させます——**新しい記憶は通常どおり保存され、双方の内容は書き換えられません**。裁定は新ツール **`memory_resolve_conflict`**（RPC: `dsh-memory/conflict-resolve`）で行い、結論は `winner` / `loser` / `both` です。
  - **凍結は「書き込みを止める」ではなく「自動裁定しない」**——前者は情報を失い、解こうとした問題より悪くなります。
  - **安全弁**:`maxPending`（キュー上限）/ `timeoutDays`（タイムアウト降格）。意味は「**新しいものを受け取らない**」であり「古いものを黙って消す」ではありません——自動決着したペアも**キューの行として残り**、`resolution = auto` で人の結論と区別されます。
  - **グラフ側**:凍結された記録をソースに含むノードは `disputed` になります（既存状態。検索候補には残るため「通常どおり召回されるが状態が見える」中間状態）。この付与は**派生同期**であり片方向フラグではありません——裁定は争いを**取り消す**ため、片方向だと解決済みノードが永久に `disputed` のままになり、**派生グラフが事実と食い違います**。
  - **ゼロドリフト**:無効時、重複排除プロンプトは変更前と**バイト単位で同一**。これは**構造的**な保証（無効パスは base 定数をそのまま返す）であり、人手の比較ではありません（[ADR-0010](./docs/adr/0010-conflict-freeze-default-off-and-timeout.md)）。

### 変更

- **新設定** `conflictFreeze.enabled`（既定オフ）/ `conflictFreeze.maxPending`（100）/ `conflictFreeze.timeoutDays`（30、`0` = タイムアウト降格なし）。**新端点** `dsh-memory/receipts` と `dsh-memory/conflict-resolve`（端点面 26 → 28）。
- **`L1ReceiptKind` に `conflict` を追加**。動作語彙を拡張する際は**その語彙を消費するすべての箇所**（証跡の正規化・統計ログ・描画文言・schema 記述）を同時に確認する必要があります——実行時に実測:登録漏れがあると「モデルが**明確に**判定不能と言った」が `skip_missing`（=「モデルが**答えなかった**」）として記録され、§C の監査可能性は**完全に**証跡チェーンに依存するため、監査結論が事実と**正反対**になります。

### 修正

- **未認識のアクションがフォールバック分岐に静かに吸収される**。`pipeline/l1.ts` の適用ループは `store` / `skip` だけを明示分岐し、**他のアクションはすべて update/merge 分岐に落ちます**。conflict 判断は設計上 `target_ids` を持たないため `targets=[]` となり、「0 件を置換した」マージ産物として追記され `version` が **1** になっていました。**エラーもなくデータ損失もなく、痕跡は version という数字だけ**——すなわち conflict が黙って merge/update に降格していた、§C がまさに排除したい挙動です。**修正**:明示的な `conflict` 分岐を追加し、検証失敗またはスイッチ無効時は **`store` にフォールバック**、フォールバック分岐には絶対に落としません。
- **端点ゲートが手書きの写しだった**。`tests/contract-keys.test.ts` は真の登録表を import せず複製していたため、両方の断言が写し自身としか整合していませんでした。§B が `receipts` を追加して真の登録表が 27 になっても写しは 26 のままで、件数断言も `toBe(26)` のまま——**緑のままでした**。今回 `conflict-resolve` を追加しても**依然として緑**でした。**修正**:ローカル一覧が `MEMORY_ENDPOINTS` と項目単位で一致することを断言します。

## [0.11.0] — 2026-09-13

### 互換性（DSH プラグインフレームワークドキュメントへの適合）

- **settings 登録のクロスバージョン対応（0.1.1-rc.2 ～ 0.1.5-rc.2）**。`src/settings.ts` は以前、`@deepseek-ai/dsh-settings` から `settingsNamespace()` を**値インポート**していましたが、v0.1.3+ ではこのエクスポートが削除されており、新しいホストではモジュールのロード時に `Failed to load plugins` が発生してプラグインツリー全体が巻き込まれます。現在は：
  - 名前空間は文字列リテラル `'dsh-memory'`（ブラウザ側は生の文字列のみを読み、新旧ホストで等価）。型インポートのみ残し（コンパイル時に消去、ロードリスクなし）。
  - 登録は 3 分岐のランタイム判定：まず `settings.register()`（全対象バージョンに存在、get/watch/update スコープを返し、ライブ切替と UI 書き込みのすべてがこれ経由）；フォールバックは `settings.installSection()` ブリッジ（v0.1.2+ のサービスマフェース、`register` がない場合のみ。ランタイム書き込みはビジネスエラーで明示拒否）；いずれも存在しなければ常時オンへ縮退——「settings 障害でホストを落とさない」原則は不変。
  - `SettingsScope` はローカル構造型に変更し、パッケージレベルの型エクスポートに依存しない。
- **`dsh.plugin.json` を追加**（DSH 発見マニフェスト：id / `engines.dsh` `>=0.1.1-rc.2 <0.2.0-0` / components は `dist/` 成果物を指す）。`dsh-plugin-template` 標準ファイル構成に準拠。
- **`@deepseek-ai/dsh-*` peerDependencies を optional 化し範囲を拡大**（`^0.1.1-rc.2 || ^0.1.2-rc.1 || ^0.1.3-rc.1 || ^0.1.5-rc.2`）。`@deepseek-ai/cordis` は必須のまま——awesome-dsh-plugin 投稿要件 B.3 に準拠。
- **`screenshots.json` を追加**（`assets/img/` 参照の 8 枚）、投稿カードに表示可能。

### 変更

- `package.json` のバージョンを 0.11.0 に更新。npm `files` に `dsh.plugin.json` を追加（`screenshots.json` は awesome-dsh-plugin の探知規約に従い git リポジトリのみ、npm パッケージには含めない）。

### 実地検証待ち

- v0.1.5-rc.2 での `conversation.input.left` / `settings.section` スロットと Session V3 の `session.surface.nodes` セマンティクス（occupancy 推定）は未検証。README の互換性マトリクスを参照。
