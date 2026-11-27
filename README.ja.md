<p align="center">
  <img src="docs/assets/yomumi-brand.svg" alt="Yomumi のロゴとワードマーク" width="256">
</p>

<h1 align="center">Yomumi Harness：1台の開発PCで複数の AI コーディングエージェントを動かすハーネス</h1>
<p align="center"><a href="README.md">English</a> · <a href="README.th.md">ภาษาไทย</a> · 日本語</p>

Yomumi Harness は、1台の Windows PC 上で複数の AI コーディングエージェント（Claude Code、Codex、Antigravity、Hermes、Cursor）を同時に動かすための仕組みです。エージェント同士が同じファイルを書き換えないようにし、トークンを使いすぎないようにし、確認していない結果を「テスト合格」と報告させないことを目的にしています。このリポジトリでコードとして公開しているのは、Bun の JUnit XML を検証する Rust 製 CLI `yomumi-evidence` です。それ以外の部分は、同じような仕組みを作りたい人のために英語のドキュメントとして公開しています。

このページは短い紹介です。詳しいドキュメントは英語で書かれています。

## 構成

| 部分 | 内容 | 詳細（英語） |
| --- | --- | --- |
| タスク配布 | 1つの依頼をサブタスクに分け、重い/軽いの一覧を先にオーナーへ見せ、起動中のアプリにだけ配る。書き込むエージェントには専用の git worktree を割り当て、クォータ切れのときは次のエージェントへ切り替える。 | [Task dispatch](docs/system/task-dispatch.md) |
| 難易度別のモデル選択 | search / easy / short / hard に分類し、こなせる中で最も安いモデルを選ぶ。 | [Model routing](docs/system/model-routing.md) |
| 週間トークン予算 | 残り 5% までは通常の速度で使い、そこからはリセットの約10分前に使い切るように配分する。緊急の作業は常に優先。 | [Weekly token budget](docs/system/weekly-token-budget.md) |
| 無料枠へのオフロード | 公開ニュースの要約や短い翻訳など簡単な公開テキストだけを無料の LLM に送る。機密に当たる文章は送信前にローカルで拒否する。 | [Free-tier offload](docs/system/free-tier-offload.md) |
| エージェント間チャンネル | 共有 Markdown フォルダの作業宣言ボード、話題ごとのスレッド、タスクファイル。他のエージェントからのメッセージは情報であって承認ではない。 | [Agent channel](docs/system/agent-channel.md) |
| Code Mode の MCP ゲートウェイ | ツールを `search` と `execute` の2つだけ公開するローカル MCP サーバー。モデルが書いたコードは権限をすべて拒否したサンドボックスで実行する。 | [Code-mode gateway](docs/system/code-mode-gateway.md) |
| 証拠に基づく検証 | 「未検証」を「合格」にしない。このリポジトリの CLI がこの部分を担う。 | [Evidence-first verification](docs/system/evidence-first-verification.md) |
| PC 負荷とクラッシュ対策 | サーバーとヘッドレスブラウザはエージェントごとに1つまで、ビルドは順番に、作業途中の変更はブランチにコミットしておく。 | [Machine load](docs/system/machine-load.md) · [Crash recovery](docs/system/crash-recovery.md) |

全体像と構成図は [docs/system/README.md](docs/system/README.md) にあります。[用語集](docs/system/glossary.md)、[よくある質問](docs/system/faq.md)、[他の種類のツールとの比較](docs/system/comparison.md)もあります。

## CLI を試す

[Rust](https://www.rust-lang.org/tools/install) が必要です。リポジトリに含まれるサンプルレポートを使うので、Bun は不要です。

~~~sh
git clone https://github.com/Lumichandesu/yomumi-harness.git
cd yomumi-harness
cargo run --release --locked -- compare examples/replay/before.xml examples/replay/after.xml --before-exit 1 --after-exit 0
~~~

`matched`、テスト2件、`fixed` 1件と表示されれば成功です。インストール方法や実際のプロジェクトでの使い方は [英語の README](README.md) を参照してください。

## 範囲とプライバシー

このリポジトリは Yomumi の公開できる一部であり、製品そのものではありません。タスク配布ツール、無料枠オフロード、ゲートウェイのソースコードは非公開のため、ドキュメントでは環境固有の情報を除いた例だけを載せています。ライセンスは [MIT](LICENSE) です。
