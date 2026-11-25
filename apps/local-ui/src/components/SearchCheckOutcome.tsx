import type { SearchCheckErrorItem, SearchCheckOutcome } from '../../../../src/control/discovery-view.js';
import { formatInteger } from '../../../../src/presentation/format.js';
import { SEARCH_CHECK_RESULT_TEXT } from '../../../../src/presentation/messages.js';

/** RCA-8: 1 つの誤りの試し方の文（文言はカタログ）。 */
const triedTextOf = (tried: SearchCheckErrorItem['tried']): string => {
  const text = SEARCH_CHECK_RESULT_TEXT;
  if (tried.by === 'EXPLORATION') {
    return text.discovery[tried.trigger];
  }
  const { how } = tried;
  switch (how.kind) {
    case 'BASELINE':
      return text.how.BASELINE;
    case 'TEXT':
      return how.text === 'EMPTY' ? text.how.TEXT_EMPTY : how.text === 'HALF_WIDTH' ? text.how.TEXT_HALF_WIDTH : text.how.TEXT_FULL_WIDTH;
    case 'OPTION':
      return text.how.OPTION(formatInteger(how.optionIndex + 1));
    case 'CHECK':
      return text.how.CHECK;
  }
};

/**
 * RCA-8（検索の確かめの設計書 2.4）: 検索の確かめの結果の行（ためした数と問題があった数）。REV-RCA の M-2: 操作さがしでサイトが誤りを返した操作は、別の 1 行・
 * 別の数（ためした数と問題の数に混ぜない）。見るだけの確かめでためしていなければ、操作さがしの行だけ。
 */
export const searchCheckSummaryTextsOf = (outcome: SearchCheckOutcome): readonly string[] => [
  ...(outcome.tried === 0 && outcome.errors.length === 0 && outcome.explorationErrors.length > 0
    ? []
    : [SEARCH_CHECK_RESULT_TEXT.summary(formatInteger(outcome.tried), outcome.errors.length, formatInteger(outcome.errors.length))]),
  ...(outcome.explorationErrors.length === 0 ? [] : [SEARCH_CHECK_RESULT_TEXT.exploration(formatInteger(outcome.explorationErrors.length))]),
];

/** 誤りの一覧（見出しと、画面の名前・どう試したか・起きたことの行）。 */
function ErrorList({ heading, items, testId }: Readonly<{ heading: string; items: readonly SearchCheckErrorItem[]; testId: string }>) {
  const text = SEARCH_CHECK_RESULT_TEXT;
  return items.length === 0 ? null : (
    <>
      <p className="panel-subheading">{heading}</p>
      <ul data-testid={testId}>
        {items.map((item, index) => (
          <li key={index}>{text.item(item.screenName ?? text.unnamedScreen, triedTextOf(item.tried), text.happened[item.happened])}</li>
        ))}
      </ul>
    </>
  );
}

/**
 * RCA-8: 見るだけの確かめの作業の画面の要点（行と、問題があった検索の一覧と、操作さがしでサイトが誤りを返した操作の一覧。画面の名前・どう試したか・起きたことだけ。
 * 欄の名前・URL・値は出さない）。
 */
export function SearchCheckOutcomePanel({ outcome }: Readonly<{ outcome: SearchCheckOutcome }>) {
  const text = SEARCH_CHECK_RESULT_TEXT;
  return (
    <div data-testid="search-check-outcome" data-errors={outcome.errors.length}>
      {searchCheckSummaryTextsOf(outcome).map((line) => <p key={line}>{line}</p>)}
      <ErrorList heading={text.heading} items={outcome.errors} testId="search-check-errors" />
      <ErrorList heading={text.explorationHeading} items={outcome.explorationErrors} testId="search-check-exploration-errors" />
    </div>
  );
}
