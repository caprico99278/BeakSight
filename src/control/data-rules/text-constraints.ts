// 欄の文字の制約（pattern・minlength・maxlength）の確かめ（Task 29 の設計書 3 章、4.2。T29c）。純粋な関数。
// - 長さは UTF-16 のコード単位で数える（HTML の minlength・maxlength と同じ）。数字だけでない属性の値は、ブラウザと同じく制約にしない。
// - pattern は、閉じた単純な文法（`simple-pattern.ts`）で解釈できるときだけ、値の全体に当てる。ページが書いた pattern を正規表現にしない
//   （T29c fix round 1。ReDoS）。解釈できない pattern は、どの値も合わないとみなす（止める側に寄せる。`PATTERN_UNSUPPORTED`）。
// - 確かめは長さ、pattern の順。理由は、長さが合わなければ `LENGTH`、長さは合うが pattern が合わなければ `PATTERN`。
import type { CandidateFieldConstraints } from '../../discovery/candidate-contracts.js';
import type { NeedsRuleInputDetail } from './rule-contracts.js';
import { matchesSimplePattern, simplePatternOf } from './simple-pattern.js';

/** 制約に合わない理由。 */
export type TextConstraintIssue = 'LENGTH' | 'PATTERN';

/** 値を確かめる関数（合えば null）。 */
export type TextConstraintCheck = (value: string) => TextConstraintIssue | null;

/** 長さの属性の値の形（0 以上の整数）。 */
const LENGTH_ATTRIBUTE_PATTERN = /^[0-9]+$/u;

const lengthOf = (text: string | null): number | null => (text !== null && LENGTH_ATTRIBUTE_PATTERN.test(text) ? Number(text) : null);

/** 欄の制約から、値を確かめる関数を作る（pattern は 1 回だけ解釈する）。 */
export const textConstraintCheckOf = (
  constraints: Pick<CandidateFieldConstraints, 'pattern' | 'minlength' | 'maxlength'>,
): TextConstraintCheck => {
  const minimum = lengthOf(constraints.minlength);
  const maximum = lengthOf(constraints.maxlength);
  const pattern = simplePatternOf(constraints);
  return (value) => {
    if ((minimum !== null && value.length < minimum) || (maximum !== null && value.length > maximum)) {
      return 'LENGTH';
    }
    if (pattern === null || (pattern !== undefined && !matchesSimplePattern(pattern, value))) {
      return 'PATTERN';
    }
    return null;
  };
};

/** 値の一覧のどれも合わないときの理由（1 つでも合えば null）。長さが合う値があれば `PATTERN_UNSUPPORTED`、なければ `LENGTH_UNSATISFIABLE`。 */
export const unsatisfiedDetailOf = (
  values: readonly string[],
  check: TextConstraintCheck,
): Extract<NeedsRuleInputDetail, 'PATTERN_UNSUPPORTED' | 'LENGTH_UNSATISFIABLE'> | null => {
  const issues = values.map(check);
  if (issues.some((issue) => issue === null)) {
    return null;
  }
  return issues.includes('PATTERN') ? 'PATTERN_UNSUPPORTED' : 'LENGTH_UNSATISFIABLE';
};
