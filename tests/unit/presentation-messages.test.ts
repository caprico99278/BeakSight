import { describe, expect, it } from 'vitest';
import { formatCount } from '../../src/presentation/format.js';
import { INCOMPLETE_REASON_CODES } from '../../src/core/contracts.js';
import { INTERACTION_REASON_CODES } from '../../src/core/evidence-types.js';
import {
  CLI_TEXT,
  FORMAT_UNIT_TEXT,
  HTML_REPORT_TEXT,
  INCOMPLETE_REASON_DESCRIPTIONS,
  INCOMPLETE_REASON_NEXT_STEPS,
  INTERACTION_REASON_DESCRIPTIONS,
  LOCAL_UI_AUTO_DRAFT_TEXT,
  LOCAL_UI_SAFETY_VIOLATION_TEXT,
  NOT_OBSERVED_TEXT,
  PAGE_COVERAGE_ITEMS,
  PRECHECK_FAILURE_DETAIL_DESCRIPTIONS,
  RUN_SUMMARY_TEXT,
  activeRunInOutputDirectoryText,
  checkpointStoreFailedText,
  countWithDetailsText,
  countWithPeakPerMinuteText,
  countWithRecentAndPeakPerMinuteText,
  describeIncompleteReason,
  describeInteractionReason,
  differentConfigRunText,
  differentVersionRunText,
  finalizingRunText,
  finishedCheckpointCleanupFailedText,
  listText,
  nextStepOfIncompleteReason,
  ordinalText,
  progressItemsText,
  resumingRunText,
  retryAttemptText,
  runLockHeldText,
  runLockTakenOverText,
  siteUnavailableRecheckText,
  siteUnavailableSlowdownText,
  siteUnavailableStopText,
  truncatedListText,
  unreadableCheckpointText,
  versionDifferenceText,
} from '../../src/presentation/messages.js';
import * as messagesModule from '../../src/presentation/messages.js';
import * as catalogModule from '../../src/presentation/catalog.js';

const JAPANESE_CHARACTER = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;

describe('incomplete reason descriptions', () => {
  it('has exactly one Japanese description for every incomplete reason code', () => {
    expect(Object.keys(INCOMPLETE_REASON_DESCRIPTIONS).sort()).toEqual([...INCOMPLETE_REASON_CODES].sort());
    for (const code of INCOMPLETE_REASON_CODES) {
      const description = describeIncompleteReason(code);
      expect(description, code).toMatch(JAPANESE_CHARACTER);
      expect(description, code).not.toContain(code);
    }
  });

  it('gives different codes different descriptions', () => {
    const descriptions = INCOMPLETE_REASON_CODES.map((code) => describeIncompleteReason(code));
    expect(new Set(descriptions).size).toBe(INCOMPLETE_REASON_CODES.length);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(INCOMPLETE_REASON_DESCRIPTIONS)).toBe(true);
  });

  // T44c（Task 44 の設計書 P1-4）: 内側のスクロールの領域を走査しきれなかった理由と、次にできること。
  it('explains INNER_SCROLL_CONTAINER_NOT_TRAVERSED with its next step (T44c)', () => {
    expect(describeIncompleteReason('INNER_SCROLL_CONTAINER_NOT_TRAVERSED')).toContain('読み込みの後に動く別のスクロールの枠');
    expect(describeIncompleteReason('INNER_SCROLL_CONTAINER_NOT_TRAVERSED')).toContain('全部は確かめていません');
    expect(nextStepOfIncompleteReason('INNER_SCROLL_CONTAINER_NOT_TRAVERSED')).toContain('手で確かめてください');
    expect(Object.isFrozen(INCOMPLETE_REASON_NEXT_STEPS)).toBe(true);
  });

  // T44h の判断 (1)（Task 44 の設計書の履歴の「T44h の測りとユーザーの判断」の行）: 未完了の理由のすべてのコード（ページの理由と、Run の閉じた一覧の外の理由を
  // 含む）に、次にできることがある。CLI でも作る HTML レポートの文なので、画面の操作の名前（「監査の負荷」「前回の続きから再開する」など）は書かない。
  it('gives a next step to every incomplete reason code, without the screen operations (T44h (1))', () => {
    expect(Object.keys(INCOMPLETE_REASON_NEXT_STEPS).sort()).toEqual([...INCOMPLETE_REASON_CODES].sort());
    for (const code of INCOMPLETE_REASON_CODES) {
      const nextStep = nextStepOfIncompleteReason(code);
      expect(nextStep, code).toMatch(JAPANESE_CHARACTER);
      expect(nextStep, code).not.toContain(code);
      expect(nextStep, code).not.toBe(describeIncompleteReason(code));
      for (const screenOnly of ['監査の負荷', '前回の続きから再開する', '新しく始める', 'この画面']) {
        expect(nextStep, code).not.toContain(screenOnly);
      }
    }
    expect(nextStepOfIncompleteReason('UNHANDLED_FAILURE')).toContain('もう一度');
    expect(nextStepOfIncompleteReason('MAX_PAGES_REACHED')).toContain('crawl.maxPages');
  });

  // T44R2 の I-7: DOM の準備の理由は、落ち着きの待ち（`resourceSettlingTimeoutMs` の期限）が PARTIAL のときに付くので、効く設定を案内する。
  it('points DOM_READINESS_FAILED to crawl.resourceSettlingTimeoutMs, the setting that bounds the settling wait (T44R2 I-7)', () => {
    expect(nextStepOfIncompleteReason('DOM_READINESS_FAILED')).toContain('crawl.resourceSettlingTimeoutMs');
    expect(nextStepOfIncompleteReason('DOM_READINESS_FAILED')).not.toContain('crawl.navigationTimeoutMs');
  });

  // T44R2 の M-11: 不具合と見られる理由の、知らせる宛先は「BeakSight の開発者」（BeakSight はローカルの道具で、窓口の仕組みはない）。
  it('names the developers of BeakSight as the recipient of the defect reports (T44R2 M-11)', () => {
    for (const code of ['UNHANDLED_FAILURE', 'REQUIRED_ARTIFACT_INVALID', 'RULE_EVALUATION_FAILED', 'INVALID_BROWSER_DATA'] as const) {
      expect(nextStepOfIncompleteReason(code), code).toContain('BeakSight の開発者に知らせてください');
    }
  });

  // SU1（サイトが応答しないときに Run を止める設計書 3.4）: サイトの不調で、その後の監査を始めなかった理由の説明。
  it('describes SITE_UNAVAILABLE as not starting the later audits because the site does not respond (SU1)', () => {
    expect(describeIncompleteReason('SITE_UNAVAILABLE')).toBe('サイトが応答しないため、それより後の点検を始めませんでした。');
  });
});

// C18o（Task 19 の前の整理の設計書 5.1.2 の「表示」）: Interaction の理由のコードの、日本語の説明。
// lifecycle の理由のコードは表示しないので、説明を持たない（C18p で消した。RC18 の M8）。
describe('interaction reason descriptions', () => {
  it('has exactly one Japanese description for every interaction reason code', () => {
    expect(INTERACTION_REASON_CODES.length).toBe(69);
    expect(Object.keys(INTERACTION_REASON_DESCRIPTIONS).sort()).toEqual([...INTERACTION_REASON_CODES].sort());
    for (const code of INTERACTION_REASON_CODES) {
      const description = describeInteractionReason(code);
      expect(description, code).toMatch(JAPANESE_CHARACTER);
      expect(description, code).not.toContain(code);
    }
  });

  it('gives different codes different descriptions', () => {
    const descriptions = INTERACTION_REASON_CODES.map((code) => describeInteractionReason(code));
    expect(new Set(descriptions).size).toBe(INTERACTION_REASON_CODES.length);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(INTERACTION_REASON_DESCRIPTIONS)).toBe(true);
  });
});

describe('not observed text', () => {
  it('is the Japanese word for "not observed"', () => {
    expect(NOT_OBSERVED_TEXT).toBe('未観測');
  });
});

/** 入れ子の文言の表の、文字列の値をすべて取り出す。 */
const leafTexts = (value: unknown): readonly string[] =>
  typeof value === 'string' ? [value] : typeof value === 'object' && value !== null ? Object.values(value).flatMap(leafTexts) : [];

// C17a: HTML レポートと CLI の両方で使う、Run の要約の文言。表示される文字は、移す前と同じ。
describe('Run summary text', () => {
  it('holds the summary labels shared by the HTML report and the CLI, with the same text as before', () => {
    expect(RUN_SUMMARY_TEXT).toEqual({
      runStatus: 'Run の状態',
      target: '対象',
      startUrl: '開始の URL',
      coverageHeading: 'ページの網羅',
      coverage: {
        discovered: '発見したページ',
        audited: '監査したページ',
        partial: '一部未完了のページ',
        failed: '失敗したページ',
        skipped: 'スキップしたページ',
      },
      reasonsHeading: '未完了の理由',
      // L6（サイトへの負荷の制御の設計書 4.5）: 要約の小節の見出しと、CLI の1行にも出る項目の名前。
      loadHeading: 'サイトへの負荷',
      allowedOriginRequests: '許可 Origin への要求',
      // CCX-29（CC-039）: HTML の要約と実行の環境の項目と、CLI の版の違いの知らせの項目の名前。
      toolVersion: 'BeakSight の版',
      playwrightVersion: 'Playwright',
    });
    expect(Object.isFrozen(RUN_SUMMARY_TEXT)).toBe(true);
    expect(Object.isFrozen(RUN_SUMMARY_TEXT.coverage)).toBe(true);
  });

  // T44R2 の M-8: 網羅の項目の並び（HTML レポート・CLI・ChatGPT 用のバンドルの README）は、ここの 1 か所（`PAGE_COVERAGE_ITEMS`）。
  it('holds the order of the coverage items in one place, covering every coverage label (T44R2 M-8)', () => {
    expect(PAGE_COVERAGE_ITEMS).toEqual(['discovered', 'audited', 'partial', 'failed', 'skipped']);
    expect([...PAGE_COVERAGE_ITEMS].sort()).toEqual(Object.keys(RUN_SUMMARY_TEXT.coverage).sort());
    expect(Object.isFrozen(PAGE_COVERAGE_ITEMS)).toBe(true);
  });

  it('is the only name of those labels: the HTML report summary and the CLI text do not keep their own copies', () => {
    const htmlSummaryKeys = Object.keys(HTML_REPORT_TEXT.summary);
    for (const key of Object.keys(RUN_SUMMARY_TEXT)) {
      expect(htmlSummaryKeys, key).not.toContain(key);
    }
    const cliTexts = leafTexts(CLI_TEXT);
    for (const text of leafTexts(RUN_SUMMARY_TEXT)) {
      expect(cliTexts, text).not.toContain(text);
    }
  });
});

// L6（サイトへの負荷の制御の設計書 3.1 の7、4.5）: サイトへの負荷の記録の文言。HTML レポートだけで使う項目の名前は
// `HTML_REPORT_TEXT.summary`、CLI だけで使う短い名前は `CLI_TEXT.run`、両方で使うものは `RUN_SUMMARY_TEXT` に置く。
describe('site load text', () => {
  // PL-R（plain UI の設計書 14 章、5 章）: 報告だけの文言を、画面と同じやさしい言葉にした（項目と並びは変えない）。
  it('names every item of the site load subsection of the HTML report in Japanese', () => {
    expect(HTML_REPORT_TEXT.summary.loadNote).toBe(
      'BeakSight が点検したサイトに送った要求の記録です。ページの読み込みは、いちばん短い間隔より長く空けて行いました。',
    );
    expect(HTML_REPORT_TEXT.summary.load).toEqual({
      minNavigationInterval: 'ページの読み込みの、いちばん短い間隔',
      maxInteractionsPerPage: '1 ページで押して確かめる操作の上限',
      navigationCount: 'ページの読み込みの回数（始められなかったものを含む）',
      pacingWait: '間隔を空けるために待った時間の合計',
      otherOriginRequests: '点検してよいサイトの外への要求',
      servedFromCache: '点検の回の全体で、取っておいた写しから返した要求',
      withheldOtherOrigins: '送らなかった、点検してよいサイトの外への要求',
    });
    expect(Object.isFrozen(HTML_REPORT_TEXT.summary.load)).toBe(true);
  });

  it('has the short CLI name of the navigation count', () => {
    expect(CLI_TEXT.run.navigationCount).toBe('ページの読み込み');
  });

  it('adds the peak per minute to a request count', () => {
    expect(countWithPeakPerMinuteText('3,400件', '210件')).toBe('3,400件（1分あたり最大 210件）');
    expect(countWithPeakPerMinuteText('0件', '0件')).toBe('0件（1分あたり最大 0件）');
  });

  it('does not repeat the shared names in the HTML-only or CLI-only names', () => {
    const shared = leafTexts(RUN_SUMMARY_TEXT);
    for (const text of [...leafTexts(HTML_REPORT_TEXT.summary), ...leafTexts(CLI_TEXT)]) {
      expect(shared, text).not.toContain(text);
    }
  });
});

// R6（中断した Run の再開の設計書 4.8 の「表示」）: 実行の記録（`run.json` の `executions`）の文言。HTML レポートだけで使う名前は
// `HTML_REPORT_TEXT.summary`、CLI だけで使う短い名前は `CLI_TEXT.run` に置く。終わり方のラベルと説明は、表示カタログが持つ。
describe('run execution text', () => {
  it('names the executions subsection of the HTML report, its counts and its table columns in Japanese', () => {
    const { summary } = HTML_REPORT_TEXT;
    // PL-R（plain UI の設計書 14 章、5 章）: 報告だけの文言を、画面と同じやさしい言葉にした（項目と並びは変えない）。
    expect(summary.executionsHeading).toBe('起動の記録');
    expect(summary.executionsNote).toBe(
      'BeakSight を起動した回ごとの、始めと終わりの日時と、終わり方です。途中で止まった点検の回を、続きから点検した起動を、再開として数えます。',
    );
    expect(summary.executions).toEqual({ count: '起動の回数', resumeCount: '再開の回数' });
    expect(Object.isFrozen(summary.executions)).toBe(true);
    expect(summary.executionColumns).toEqual(['何回目の起動', '開始の日時', '終了の日時', '終わり方']);
    // 開始と終了の日時の列は、Run の開始と終了の日時の項目と、同じ名前で示す。
    expect(summary.executionColumns[1]).toBe(summary.startedAt);
    expect(summary.executionColumns[2]).toBe(summary.finishedAt);
    expect(Object.isFrozen(summary.executionColumns)).toBe(true);
  });

  it('has the short CLI names of the execution line', () => {
    expect(CLI_TEXT.run.executions).toBe('実行');
    expect(CLI_TEXT.run.resumes).toBe('再開');
  });

  it('writes an ordinal number, shared by the attempts before a retry and the executions', () => {
    expect(ordinalText(1)).toBe('1回目');
    expect(ordinalText(12)).toBe('12回目');
    expect(retryAttemptText(2)).toBe(ordinalText(2));
  });
});

// L7（サイトへの負荷の制御の設計書 4.8）: 実行中の進み具合の行の文言と、書式（`format.ts`）が付ける単位。
describe('run progress text', () => {
  it('has the Japanese names of the items of the progress line that only the CLI shows', () => {
    expect(CLI_TEXT.progress).toEqual({
      heading: '進み具合',
      pagesFinished: '監査を終えたページ',
      maxPages: '上限',
      otherOriginRequests: '許可 Origin の外',
      elapsed: '経過',
    });
    expect(Object.isFrozen(CLI_TEXT.progress)).toBe(true);
  });

  // PL-4 で経過時間の日の単位（「1日 10回まで」）を足した（PL-TD の 4b で期待を追いつかせた）。OP-3 で、ふだんの画面の日時の月と日を足した。
  it('has the units of times, days, hours, minutes and seconds for the formats', () => {
    expect(FORMAT_UNIT_TEXT).toEqual({ seconds: '秒', count: '件', times: '回', days: '日', hours: '時間', minutes: '分', monthOfYear: '月', dayOfMonth: '日' });
    expect(Object.isFrozen(FORMAT_UNIT_TEXT)).toBe(true);
  });

  it('adds details to a count in parentheses, with the list separator', () => {
    expect(countWithDetailsText('12件', ['発見したページ 85件', '上限 50件'])).toBe('12件（発見したページ 85件、上限 50件）');
    expect(countWithDetailsText('0件', ['上限 1件'])).toBe('0件（上限 1件）');
  });

  it('adds the count of the latest minute and the peak per minute to a request count', () => {
    expect(countWithRecentAndPeakPerMinuteText('1,930件', '38件', '61件')).toBe('1,930件（直近1分 38件、1分あたり最大 61件）');
  });

  it('keeps the request count with the peak per minute as it was', () => {
    expect(countWithPeakPerMinuteText('3,400件', '210件')).toBe('3,400件（1分あたり最大 210件）');
  });

  it('joins the items of the progress line with the middle dot', () => {
    expect(progressItemsText(['a', 'b', 'c'])).toBe('a・b・c');
    expect(progressItemsText(['a'])).toBe('a');
  });
});

// R5a（中断した Run の再開の設計書 4.7、4.7.1）: 再開の流れの文言。値（Run の ID、違う項目、版、パス、ページの数の書式）は、呼び出し側が
// 渡す（ここでは作らない）。
describe('resume text of the CLI', () => {
  const RUN_ID = 'RUN-20261001000000';

  it('has the label of the exit code 4 of a Run that cannot start, and the warning when the end of the checkpoint cannot be written', () => {
    expect(CLI_TEXT.runUnavailableHeading).toBe('Run を始められない');
    // 最後の状態は書けて、ロックを外す処理だけが失敗した場合は、次の起動で最後の処理をやり直さないので、「ことがあります」にする
    // （R5a の報告の発見事項5）。
    expect(CLI_TEXT.resume.finishFailed).toBe(
      '再開のための保存の終わりを、最後まで書けませんでした。次に同じコマンドを実行すると、最後の処理をもう一度行うことがあります。',
    );
    expect(Object.isFrozen(CLI_TEXT.resume)).toBe(true);
  });

  it('tells that another Run is running in the same output directory', () => {
    expect(activeRunInOutputDirectoryText(RUN_ID)).toBe(
      '同じ出力先で、別の Run（RUN-20261001000000）が実行中です。その Run が終わってから実行してください。',
    );
  });

  it('tells that a checkpoint cannot be read, and that a run with another configuration is not resumed', () => {
    expect(unreadableCheckpointText(RUN_ID)).toBe('途中の Run（RUN-20261001000000）の再開のための保存を読めないため、再開の対象にしません。');
    expect(differentConfigRunText(RUN_ID, 'crawl.maxPages、output.directory')).toBe(
      '設定が違うため、途中の Run（RUN-20261001000000）は再開しません（違う項目: crawl.maxPages、output.directory）。新しい Run を始めます。',
    );
  });

  it('tells that a run of another version cannot be resumed, with the saved and the current version of each item', () => {
    expect(versionDifferenceText('BeakSight の版', '0.1.0', '0.2.0')).toBe('BeakSight の版: 保存 0.1.0 → 今 0.2.0');
    expect(differentVersionRunText(RUN_ID, 'BeakSight の版: 保存 0.1.0 → 今 0.2.0')).toBe(
      '途中の Run（RUN-20261001000000）は、版が違うため再開できません（BeakSight の版: 保存 0.1.0 → 今 0.2.0）。最初から始めるには --new を付けてください。',
    );
  });

  it('tells that the run is resumed with the number of the finished pages, or that only the final processing is done', () => {
    expect(resumingRunText(RUN_ID, '監査を終えたページ 3件')).toBe(
      '途中の Run（RUN-20261001000000。監査を終えたページ 3件）を、続きから再開します。最初から始めるには --new を付けてください。',
    );
    expect(finalizingRunText(RUN_ID)).toBe(
      '途中の Run（RUN-20261001000000）は、安全の不変条件の違反を検出した後のため、新しいページを監査せずに、最後の処理だけを行います。',
    );
  });

  it('tells why the session of the resume could not start', () => {
    expect(runLockHeldText(RUN_ID)).toBe('別のプロセスが、この Run（RUN-20261001000000）を実行しています。');
    expect(runLockTakenOverText(RUN_ID)).toBe('別のプロセスが、同時にこの Run（RUN-20261001000000）の再開を始めました。');
    expect(checkpointStoreFailedText(RUN_ID)).toBe('再開のための保存を読み書きできませんでした（RUN-20261001000000）。');
  });

  it('warns that a part of the checkpoint of a finished Run could not be removed', () => {
    expect(finishedCheckpointCleanupFailedText('C:\\out\\RUN-1\\checkpoint\\pages')).toBe(
      '終わった Run の再開のための保存の一部を消せませんでした（C:\\out\\RUN-1\\checkpoint\\pages）。手で消しても問題ありません。',
    );
  });
});

// SU4（サイトが応答しないときに Run を止める設計書 3.4）: サイトの不調で止めた Run の、CLI の結果の1行の文言。詳細（技術的な詳細）は、
// 括弧の中にそのまま示す。詳細がなければ、括弧を出さない。
describe('site unavailability stop text of the CLI', () => {
  it('tells that the audit stopped because the site does not respond, with the detail as it is, and how to resume', () => {
    expect(siteUnavailableStopText('desktop:passive:TIMEOUT')).toBe(
      'サイトが応答しないため、監査を止めました（desktop:passive:TIMEOUT）。サイトが戻ってから、同じコマンドで続きから再開してください。',
    );
    expect(siteUnavailableStopText('site-metadata:FAILED:net::ERR_CONNECTION_RESET')).toBe(
      'サイトが応答しないため、監査を止めました（site-metadata:FAILED:net::ERR_CONNECTION_RESET）。サイトが戻ってから、同じコマンドで続きから再開してください。',
    );
  });

  it('leaves out the parentheses when there is no detail', () => {
    expect(siteUnavailableStopText(null)).toBe(
      'サイトが応答しないため、監査を止めました。サイトが戻ってから、同じコマンドで続きから再開してください。',
    );
  });
});

// SU5、SU6（サイトが応答しないときに Run を止める設計書 3.5.4、3.6.2）: サイトの不調でページを捨てた後、待ってから同じページを確かめ直す
// ことを知らせる1行の文言。待つ時間の文言（`formatDuration` の結果。例: `60秒`）、何回目か、最大の回数、ページの URL は、呼び出し側が渡す。
describe('site unavailability recheck text of the CLI', () => {
  it('tells that the same page is checked again after the wait, with the wait, the attempt of the maximum, and the URL as they are given', () => {
    expect(siteUnavailableRecheckText('http://127.0.0.1:4173/a.html', '60秒', 1, 4)).toBe(
      'サイトが応答しないため、60秒待ってから同じページを確かめ直します（1/4 回目。http://127.0.0.1:4173/a.html）。',
    );
    expect(siteUnavailableRecheckText('http://127.0.0.1:4173/b.html?page=2', '120秒', 2, 4)).toBe(
      'サイトが応答しないため、120秒待ってから同じページを確かめ直します（2/4 回目。http://127.0.0.1:4173/b.html?page=2）。',
    );
  });
});

// SU6（設計書 3.6.2）: 確かめ直しで応答が戻った後、ページの読み込みの間隔を延ばして続けることを知らせる1行の文言。新しい間隔の文言
// （`formatDuration` の結果。例: `10秒`）は、呼び出し側が渡す。
describe('site unavailability slowdown text of the CLI', () => {
  it('tells that the site responded again and the navigation interval is extended to the given interval', () => {
    expect(siteUnavailableSlowdownText('10秒')).toBe('確かめ直しで応答が戻ったので、ページの読み込みの間隔を 10秒 に延ばして続けます。');
    expect(siteUnavailableSlowdownText('40秒')).toBe('確かめ直しで応答が戻ったので、ページの読み込みの間隔を 40秒 に延ばして続けます。');
  });
});

// R5b（中断した Run の再開の設計書 4.7 の「シグナル」、4.7.1）: シグナルを受けたときの文言と、終了コード 5 の行のラベル。
describe('interrupt text of the CLI', () => {
  it('tells on the first signal that the Run stops after the current page, and how to stop at once', () => {
    expect(CLI_TEXT.interrupt.stopRequested).toBe(
      '中断を受け付けました。今のページの監査を終えてから止めます。すぐに止めるには、もう一度押してください。',
    );
  });

  it('tells on the second signal that the Run stops at once, what is kept, and how to resume', () => {
    expect(CLI_TEXT.interrupt.exitingNow).toBe(
      'すぐに止めます。再開のための保存は、最後に監査を終えたページまで残っています。同じコマンドを実行すると、続きから再開します。',
    );
    expect(Object.isFrozen(CLI_TEXT.interrupt)).toBe(true);
  });

  it('has the label of the exit code 5 (interrupted)', () => {
    expect(CLI_TEXT.interruptedHeading).toBe('中断');
  });
});

// C17a、CC-016: 文言の中の一覧の書式（Rule の Finding の文言と CLI の両方で使う）。表示される文字は、移す前と同じ。
describe('list text', () => {
  it('joins the items with the Japanese list separator', () => {
    expect(listText([])).toBe('');
    expect(listText(['a'])).toBe('a');
    expect(listText(['エラー 3件', '警告 2件', '情報 0件'])).toBe('エラー 3件、警告 2件、情報 0件');
    expect(listText(['desktop: 404', 'mobile: 500'])).toBe('desktop: 404、mobile: 500');
  });

  it('lists at most the given number of items and adds the number of the rest, as the cross-page rules did', () => {
    const urls = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7'];
    expect(truncatedListText(urls, 5)).toBe('u1、u2、u3、u4、u5、ほか 2 件');
    expect(truncatedListText(urls.slice(0, 6), 5)).toBe('u1、u2、u3、u4、u5、ほか 1 件');
    expect(truncatedListText(urls.slice(0, 5), 5)).toBe('u1、u2、u3、u4、u5');
    expect(truncatedListText(['u1', 'u2'], 5)).toBe('u1、u2');
    expect(truncatedListText([], 5)).toBe('');
  });

  it('does not change the input', () => {
    const urls = ['u1', 'u2', 'u3'];
    truncatedListText(urls, 1);
    expect(urls).toEqual(['u1', 'u2', 'u3']);
  });
});

// MI-F3（MI-F4 の報告の片付け）: 件数の書式（`formatCount`。単位「件」を含む）を受ける文言の後ろに、もう一度「件」を書かない（「3件 件」と出さない）。
// 期待は固定の文字で書く（同じ関数で期待を作ると、書式の誤りを捕まえないため）。
describe('MI-F3: texts that take a count formatted with formatCount do not add the unit again', () => {
  it('shows the number of the safety violations not listed once with its unit', () => {
    expect(LOCAL_UI_SAFETY_VIOLATION_TEXT.omittedText(formatCount(3))).toBe('一覧に載せなかった違反が 3件あります。');
  });
});

// PL-F（安全のレビュー PL-REV の Minor 3 と、PL-D2 の文言の持ち越し）。期待は固定の文字で書く。
describe('PL-F: the plain texts after the safety review', () => {
  it('tells that nothing was written because the list of the site could not be read, and to start again after a while', () => {
    const { description, action } = PRECHECK_FAILURE_DETAIL_DESCRIPTIONS.VERIFICATION_READ_UNAVAILABLE;
    expect(`${description}${action}`).toBe('サイトの一覧を読めなかったので、書き込みませんでした。少し待ってから、もう一度始めてください。');
  });

  // OP-3（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D6・D7'）: 「書き込みにも使う」の確認のダイアログは、なくしたので、文言も消した。
  it('has no texts for the dialog of the write mode switch any more', () => {
    expect(Object.keys(messagesModule)).not.toContain('LOCAL_UI_WRITE_MODE_SWITCH_TEXT');
  });

  it('has only one line for the automatic drafts when nothing was made', () => {
    expect(Object.keys(LOCAL_UI_AUTO_DRAFT_TEXT)).toContain('noneCreated');
    expect(Object.keys(LOCAL_UI_AUTO_DRAFT_TEXT)).not.toContain('noCreates');
  });
});

// OP-3（設計書 `doc/design/2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D11・D12）: 画面・報告・CLI が使う文言のカタログに、「書き換え」と「SMS」の語を
// 置かない（「更新」と「メールや電話への知らせ」にそろえる）。関数の文言は、仮の値を入れて作った文で確かめる。
describe('OP-3: the words of the catalogs', () => {
  const SAMPLE_ARGUMENT = '〇';
  /** 値の中の、すべての文（関数は、引数の数だけ仮の値を入れて呼ぶ）。 */
  const textsOf = (value: unknown, path: string): readonly (readonly [string, string])[] => {
    if (typeof value === 'string') {
      return [[path, value]];
    }
    if (typeof value === 'function') {
      // 文字でない引数を取る部品（一覧の書式など）は、文言のカタログではないので読まない。
      try {
        const made: unknown = value(...Array.from({ length: value.length }, () => SAMPLE_ARGUMENT));
        return textsOf(made, `${path}()`);
      } catch {
        return [];
      }
    }
    if (value !== null && typeof value === 'object') {
      return Object.entries(value).flatMap(([key, child]) => textsOf(child, `${path}.${key}`));
    }
    return [];
  };
  const texts = [...Object.entries(messagesModule), ...Object.entries(catalogModule)].flatMap(([name, value]) => textsOf(value, name));

  it('reads the texts of every catalog (the check itself)', () => {
    expect(texts.length).toBeGreaterThan(1000);
    expect(texts.some(([, text]) => text.includes('更新'))).toBe(true);
  });

  it('says 更新 for an update write and never 書き換え', () => {
    expect(texts.filter(([, text]) => text.includes('書き換')).map(([path]) => path)).toEqual([]);
  });

  it('says メールや電話への知らせ and never SMS', () => {
    expect(texts.filter(([, text]) => text.includes('SMS')).map(([path]) => path)).toEqual([]);
  });
});
