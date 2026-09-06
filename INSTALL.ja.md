# インストールガイド（dsh-prime-memory）

本プラグインは **DSH 公式 bundle 合成パッケージ**として配布されます。インストール後、`cordis.patch.yml` の `dsh.bundle` 層がプラグイン行を自動マウントするため、profile 設定を手修正する必要はありません。

## 環境要件

- Node.js ≥ 22.16（DSH 0.1.1-rc.2 以上）
- DeepSeek Harness（以下 DSH）が導入済みで、`--profile web` が利用可能

## インストール

2 通りの呼び出し方式から選べます（`npx` 接頭辞は以下のどの `dsh` コマンドも置き換え可能）：

```bash
# 方法1：npx で公式 CLI を直接実行（dsh の事前導入不要。バージョン固定可、例: dsh-prime-memory@0.8.4）
npx -y @deepseek-ai/dsh plugin --profile web add dsh-prime-memory

# 方法2：dsh CLI 導入済みの場合（dsh は pnpm フォワーダ。未導入なら先に npm i -g pnpm）
dsh plugin --profile web add dsh-prime-memory

# その他のソース：GitHub リポジトリ / ローカルパス（開発・デバッグ用。link: はリポジトリを指し、npm run build + dsh 再起動で反映）
dsh plugin --profile web add https://github.com/drscrewdriver/dsh-prime-memory
dsh plugin --profile web add /path/to/dsh-prime-memory
```

### Agent にインストールさせる（推奨）

現在の Agent がターミナルコマンドを実行できるなら、以下の文をそのまま送ってください：

```text
DeepSeek Harness の web プロファイルに dsh-prime-memory プラグインをインストールしてください。

他のプロファイルは変更せず、以下の2コマンドのみを実行してください:
dsh plugin --profile web add dsh-prime-memory
dsh --profile web --dump-config

出力に dsh-prime-memory が表示されたらインストール結果を教えてください。
稼働中の DSH を勝手に閉じたり再起動しないでください。インストール後、DSH Web Host の手動再起動を促してください。
```

## アップグレード

```bash
# 最新版へ
dsh plugin --profile web update dsh-prime-memory

# 特定バージョンへ
dsh plugin --profile web update dsh-prime-memory@0.8.11
```

アップグレードはプラグインコードと `dist/` 成果物のみを置換し、データディレクトリ `~/.dsh/memory/` には影響しません。

## 検証

DSH Web Host を再起動後、以下を確認：

1. **データディレクトリが現れる**＝プラグイン適用成功：`~/.dsh/memory/` 配下に `conversations/` `records/` `scenes/` と `memory.db` が現れる；
2. **設定に「記憶」ページ**、入力バーにモードピルが現れる＝クライアント側準備完了；
3. 個人情報を含むメッセージを送り、蒸留完了後、別のターンで関連を尋ねると、コンテキストに「コンテキスト注入 · memory」行が見えるはず。

任意のスモークテスト（開発・障害対応用）：

```bash
npm run build
npx tsc src/smoke.ts --outDir dist-smoke --module nodenext --moduleResolution nodenext --target es2022 --strict --skipLibCheck --esModuleInterop
node dist-smoke/smoke.js
```

## 移行 / ダウングレード

- **旧版（0.5.0 以前は `dsh-memory-plugin`）からの移行**：旧データディレクトリは新パッケージと互換性がありません。バックアップ後 `~/.dsh/memory/` を削除し、新プラグインの初回実行で再構築してください。履歴はそのまま升格不可で、再蒸留が必要です。
- **旧版へのロールバック**：`dsh plugin --profile web remove dsh-prime-memory` 後、旧版ドキュメントで再インストール。データディレクトリは残りますが、旧版は新レイアウトを読めないため、併せて削除を推奨。

## アンインストール

```bash
dsh plugin --profile web remove dsh-prime-memory
```

データは `~/.dsh/memory/` に残ります。不要ならディレクトリごと手動削除してください。

## トラブルシューティング

| 現象 | 考えられる原因 | 対処 |
| --- | --- | --- |
| インストール後「記憶」ページがない | DSH 未再起動 / bundle 未マウント | DSH Web Host を再起動。`dsh --profile web --dump-config` で `dsh-prime-memory` を確認 |
| 起動時 `duplicate loader entry id` | patch が `insert:` と bundle 同 id を重複追加 | 手動の `insert:` を削除（本パッケージは bundle 層を同梱） |
| 「コンテキスト注入 · memory」行がない | 蒸留未実行 / 想起オフ | モードが off でなく `recall.enabled=true` を確認。`memory.log` の `L1 段完了` を確認 |
| ローカル埋め込みダウンロードが止まる | ミラー直結が不可 | `embedding.proxy` でプロキシを設定、または `embedding.mirror` を公式 `huggingface.co` へ |
| リモート埋め込み 401 エラー | apiKey 誤り / 免キー服務に key 不要 | `embedding.apiKey` を確認。自己ホスト免キー服務は apiKey を空に |

詳細は [README.ja.md](./README.ja.md) と [CHANGELOG.ja.md](./CHANGELOG.ja.md) を参照。
