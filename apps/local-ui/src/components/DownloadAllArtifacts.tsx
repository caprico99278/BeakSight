import { useState } from 'react';
import { formatInteger } from '../../../../src/presentation/format.js';
import { LOCAL_UI_AUDIT_TEXT } from '../../../../src/presentation/messages.js';
import { clickDownloadLinksInOrder } from '../display/download-all';

/** 今のリンクと同じ `href` の `a[download]` を作って押す（取りに行く処理は持たない。保存はブラウザのダウンロードの仕組み）。 */
const clickDownloadLink = (href: string): void => {
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = '';
  anchor.click();
};

/**
 * DLALL（設計書 `2026-11-24-beaksight-job-artifacts-download-all-design.md` 2 章と設計変更履歴）: 「できたファイル」の一覧の全部を、一覧の順に
 * 1 つずつ別のファイルとしてダウンロードするボタン。一覧に 2 つ以上あるときだけ出す。押した後は、始めた数の 1 行を出す。
 */
export function DownloadAllArtifacts({ hrefs }: Readonly<{ hrefs: readonly string[] }>) {
  const [startedCount, setStartedCount] = useState<number | null>(null);
  if (hrefs.length < 2) {
    return null;
  }
  const text = LOCAL_UI_AUDIT_TEXT.job;
  const onClick = (): void => {
    clickDownloadLinksInOrder(hrefs, clickDownloadLink);
    setStartedCount(hrefs.length);
  };
  return (
    <>
      <p>
        <button type="button" className="button" data-testid="job-artifacts-download-all" onClick={onClick}>
          {text.downloadAll}
        </button>
      </p>
      {startedCount === null ? null : <p className="muted" role="status">{text.downloadAllStarted(formatInteger(startedCount))}</p>}
    </>
  );
}
