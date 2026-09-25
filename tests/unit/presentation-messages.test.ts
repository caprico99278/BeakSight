import { describe, expect, it } from 'vitest';
import { INCOMPLETE_REASON_CODES } from '../../src/core/contracts.js';
import { INTERACTION_REASON_CODES } from '../../src/core/evidence-types.js';
import {
  CLI_TEXT,
  HTML_REPORT_TEXT,
  INCOMPLETE_REASON_DESCRIPTIONS,
  INTERACTION_REASON_DESCRIPTIONS,
  NOT_OBSERVED_TEXT,
  RUN_SUMMARY_TEXT,
  describeIncompleteReason,
  describeInteractionReason,
  listText,
  truncatedListText,
} from '../../src/presentation/messages.js';

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
    });
    expect(Object.isFrozen(RUN_SUMMARY_TEXT)).toBe(true);
    expect(Object.isFrozen(RUN_SUMMARY_TEXT.coverage)).toBe(true);
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
