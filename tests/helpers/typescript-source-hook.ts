/**
 * TypeScript のソースを直接読む子 process の、resolve のフックの本文の唯一の置き場（T44-UIFIX で 3 か所の同じ中身をまとめた）。
 * - 子 process は、Node の型の除去で `src/` などの TypeScript のソースを直接読み込む。ソースは相対の指定子を `.js` で書く（tsconfig の
 *   NodeNext）ので、解決できない相対の `.js` の指定子を、同じ名前の `.ts` に読み替える（`module.registerHooks` の resolve。登録した子 process の
 *   中だけで効く）。解決できるものは、そのまま使う（読み替えるのは、失敗したときだけ）。
 * - 使い方: 子の ES モジュールの本文の始めに、この文字列を埋め込む。フックは登録の後の解決にだけ効くので、TypeScript のソースは、その後の動的な
 *   `import()` で読み込む（同じ本文の静的な import は、フックの登録の前に解決される）。
 * - 使う側: `tests/integration/control-profile-fixtures.ts`（子 process の始めの本文）、`tests/integration/control-environment-no-sqlite.test.ts`
 *   （子 process の本文）、`tests/helpers/fake-audit-worker.ts`（偽のワーカーが書き込みのバンドルを本物の部品で組み立てる）。
 */
export const TYPESCRIPT_SOURCE_RESOLVE_HOOK = String.raw`import { registerHooks } from 'node:module';
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (/^\.{1,2}\//u.test(specifier) && specifier.endsWith('.js')) {
        return next(specifier.slice(0, -'.js'.length) + '.ts', context);
      }
      throw error;
    }
  },
});
`;
