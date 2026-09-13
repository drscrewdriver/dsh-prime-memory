# 更新履歴（日本語 changelog）

- [更新日志（中文）](./CHANGELOG.md)
- [Changelog (English)](./CHANGELOG.en.md)
- [日本語 changelog](./CHANGELOG.ja.md)
- [한국어 changelog](./CHANGELOG.ko.md)

> **互換性の注意**：本プラグインは日本語ドキュメントを提供しますが、公式 DSH の `LocaleRuntime` が登録する言語は `zh` / `en` のみです。`ja` を選択すると `locale "ja" is not registered` となります。DSH を fork して `LOCALE_IDS` と `LOCALES` ラベルを更新し再ビルドすることで利用可能になります。

本ファイルは **0.11.0** リリースノートの日本語版です。全履歴は [CHANGELOG.md](./CHANGELOG.md)（中文）を参照してください。

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
