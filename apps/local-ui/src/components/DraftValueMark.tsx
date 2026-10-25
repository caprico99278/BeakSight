/**
 * 自動の下書きの案の出どころの印と根拠（手を減らす段 2 の設計書 3A 章の共通の決まり「推測で決めた項目は、項目ごとに推測の印と根拠を画面に出す」。
 * FM2b）。発見の画面の下書きの一覧、作成の画面の前もって選んだ値、シナリオの画面の推測の項目、自動ログインのセレクタの案が使う。出どころの名前と色の
 * 区分は表示カタログ（`DRAFT_VALUE_ORIGIN_CATALOG`。`draftValueOriginDisplay`）、根拠の文は `DRAFT_VALUE_TEXT.grounds` の 1 か所から読んで描くだけ。
 * 印は表示だけで、承認に結ばない。
 */
import type { DraftValueGround, DraftValueOrigin } from '../../../../src/control/approval-view.js';
import { DRAFT_VALUE_TEXT } from '../../../../src/presentation/messages.js';
import { draftValueOriginDisplay, toneClass } from '../display/labels';

/** 印（出どころのラベル）と根拠の文。 */
export function DraftValueMark({ origin, ground, testId = 'draft-value-mark' }: Readonly<{
  origin: DraftValueOrigin;
  ground: DraftValueGround;
  testId?: string;
}>) {
  const display = draftValueOriginDisplay(origin);
  return (
    <span className="field-hint" data-testid={testId} data-origin={origin} data-ground={ground}>
      <span className={toneClass(display.tone)}>{display.label}</span>
      {' '}
      {DRAFT_VALUE_TEXT.grounds[ground]}
    </span>
  );
}
