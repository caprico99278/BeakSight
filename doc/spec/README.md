# BeakSight の仕様

BeakSight の利用者向けの仕様の索引です。
起動の手順と簡単な使い方は、[README](../../README.md) にあります。

[README に戻る](../../README.md)

| ファイル | 内容 |
| --- | --- |
| [cli.md](cli.md) | CLI のオプションの細かい決まり、headless で使うブラウザ、終了コード、実行中と結果の CLI の表示、Windows PowerShell での日本語の表示。 |
| [configuration.md](configuration.md) | 監査の対象の設定のファイル（JSON）の書き方、既定値、`config/targets/` と `local/` の使い分け、`--config` を省いたときの扱い。 |
| [resume.md](resume.md) | 途中で止まった Run を同じコマンドで続きから再開する決まり、`--new`、Ctrl+C で止める、実行時間の上限、同時に実行できる Run、再開のための保存、タスク スケジューラ。 |
| [site-unavailability.md](site-unavailability.md) | サイトが応答しないときに、読み込みを止め、段階的に確かめ直し、再開できる状態で止まる決まりと、診断の記録。 |
| [output.md](output.md) | 出力の構成（Run のディレクトリのファイル）と、HTML レポート、Run Status、Finding と Evidence、幅の走査の結果、ChatGPT 用のバンドル、パフォーマンスの値の読み方。 |
| [safety.md](safety.md) | 読み取り専用の保証の範囲と保証できない範囲、headed で実行するときの注意、Safety Ledger の読み方。 |
| [site-load.md](site-load.md) | サイトへの負荷を抑える決まり（読み込みの間隔と回数、キャッシュ、先読み、アイコン、制約）、full audit での上限の選び方、実績の確かめ方。 |
| [development.md](development.md) | 開発者向けの npm のスクリプト、ローカルでの検証の手順、アーカイブのスクリプト。 |
