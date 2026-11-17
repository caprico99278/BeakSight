/**
 * DN-1（設計書 `doc/design/2026-11-16-beaksight-profile-display-name-design.md` 2 章）: サイトの画面に出す名前の決め方の、ただ 1 か所。
 * - 画面に出す名前（管理データの表示の設定の名前）があればそれを、なければ（前の版の管理データ・まだ変えていないサイト）今どおり見分けの印
 *   （プロファイルの ID）を出す。作るときの名前は印なので、作った直後は印がそのまま名前になる。
 * - 名前の組は、根の route の loader（`siteNamesFn`）が画面を開くたびに読む（保存の後の `router.invalidate()` でも読み直す）。画面は
 *   `useSiteNameOf` を通して名前を出す。URL・記録のファイル・報告は、今どおり印を使う（この部品を通さない）。
 */
import { useLoaderData } from '@tanstack/react-router';

/** 画面に出す名前のあるサイトの、ID と名前の組。 */
export type SiteNames = Readonly<Record<string, string>>;

/** サイトの画面に出す名前（名前がなければ、見分けの印）。 */
export const siteNameOf = (names: SiteNames, profileId: string): string =>
  (Object.hasOwn(names, profileId) ? names[profileId] : undefined) ?? profileId;

/** 画面の部品が、サイトの名前を出すための関数を得る（根の route の loader が読んだ名前の組を使う）。 */
export const useSiteNameOf = (): ((profileId: string) => string) => {
  const names = useLoaderData({ from: '__root__' });
  return (profileId) => siteNameOf(names, profileId);
};
