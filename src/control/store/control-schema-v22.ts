// 管理データの版 22 の文（DN-1。設計書 `2026-11-16-beaksight-profile-display-name-design.md` 2 章。サイトの画面に出す名前）。凍結。
// - 版 22: プロファイルの表示の設定（`profile_display_settings`）に、画面に出す名前の列（`display_name`）を足す。NULL は名前なし（画面は今どおり
//   プロファイルの ID を出す）。前の版の行は NULL のまま読める。長さ（1〜80 文字。前後の空白を除いた値を書く）の決まりの owner は
//   `profile-store.ts` の `saveProfileDisplayName`（上限は `src/core/limits.ts` の `MAX_PROFILE_DISPLAY_NAME_LENGTH`）。この CHECK は、公開した時点の
//   値の写し（改行・制御文字の確かめは保存の部品が持つ）。
// - 走らせるのは版の管理（`migrations.ts` の `runControlMigrations`）だけ（トランザクションの中で、`user_version` と一緒に）。

/** 版 22 の文（作れる順）。 */
const CONTROL_SCHEMA_V22_STATEMENTS: readonly string[] = Object.freeze([
  `ALTER TABLE profile_display_settings ADD COLUMN display_name TEXT
    CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 80)`,
]);

/** 版 22（版と文。凍結）。 */
export const CONTROL_SCHEMA_V22: { readonly version: number; readonly statements: readonly string[] } = Object.freeze({
  version: 22,
  statements: CONTROL_SCHEMA_V22_STATEMENTS,
});
