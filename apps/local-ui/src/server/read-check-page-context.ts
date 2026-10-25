/**
 * 画面の path の READ の確かめの定義の、保存の確かめの文脈と、選べる画面の path（T37d。FM2b で `read-check-functions.ts` から移した。READ の確かめの
 * 画面のサーバと、シナリオの下書きをボタン 1 回で作る画面のサーバ（`scenario-autodraft-functions.ts`）が共用する。書き写さない）。サーバだけで使う
 * （ブラウザ側のコードは import しない）。
 * - `readCheckPageContextOf`: ターゲット設定の開始の URL と許可 Origin、プロファイルの承認したテストの Origin、保存した認証の設定の読まないパス・読む範囲・
 *   セッションの切れの path（ワーカーの実行の前の判定と同じ出どころ）。ターゲット設定を読めなければ null（保存の検証が拒む）。
 * - `readCheckPagePathsOf`: 直近の発見の結果の、読めた画面のうち、開始の URL と同じ Origin のもの（文書の順で重なりなし。読めなければ空）。
 */
import type { ReadCheckPageContext } from '../../../../src/control/read-check-policy.js';
import { sessionLostPathPrefixOf } from '../../../../src/control/auth/auth-setup-policy.js';
import type { DiscoveryDocument } from '../../../../src/control/discovery-view.js';
import type { ProfileStartReading } from './start-check-inputs';

/** 開始の URL の Origin（読めなければ null）。 */
const originOfUrl = (url: string | undefined): string | null => {
  if (url === undefined) {
    return null;
  }
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

/** 画面の path の定義を確かめる文脈（ターゲット設定を読めなければ null）。 */
export const readCheckPageContextOf = (reading: ProfileStartReading): ReadCheckPageContext | null => {
  const site = reading.context?.targetConfig.site;
  if (site === undefined) {
    return null;
  }
  const setup = reading.storedSetup?.setup ?? null;
  return {
    startUrl: site.startUrl,
    allowedOrigins: site.allowedOrigins,
    approvedTestOrigins: reading.stored.profile.approvedTestOrigins,
    excludedPathPrefixes: setup?.excludedPaths ?? [],
    auditPathPrefixes: setup?.auditPathPrefixes ?? [],
    sessionLostPathPrefix: setup === null ? null : sessionLostPathPrefixOf(setup),
  };
};

/** 画面を読む定義で選べる画面の path（直近の発見の結果の、読めた画面のうち、開始の URL と同じ Origin のもの。文書の順で重なりなし）。 */
export const readCheckPagePathsOf = (document: DiscoveryDocument | null, reading: ProfileStartReading): readonly string[] => {
  const startOrigin = originOfUrl(reading.context?.targetConfig.site.startUrl);
  if (document === null || startOrigin === null) {
    return [];
  }
  const paths = new Set<string>();
  for (const page of document.pages) {
    const location = page.state === 'READ' ? page.record.location : null;
    if (location !== null && location.origin === startOrigin) {
      paths.add(location.path);
    }
  }
  return [...paths];
};
