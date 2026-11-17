// DEF-144（指示書 `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/DEF-144-brief.md`）: 発見と READ の確かめのジョブで、Safety Ledger の不変条件の
// 違反が起きたときに残す中身（`discovery.json`・`read-evidence.json` の任意の項目 `safetyViolation`、IPC の `FINISHED` の要約、ジョブの画面）の組み立ての
// 唯一の場所。形の owner は core（`src/core/contracts.ts` の `JobSafetyViolation`）。
// - 違反の一覧と数は、監査の Run の `run.json` の `safety` と同じ部品（`summarizePageSafety`）の同じ形（`PageSafetySummary`。違反 1 件は `code`・`message`・
//   結びつく要求 `request`（method・Origin・path））を使う。ここで書き写さない。
// - 足すのは、違反が起きた段（`stage`）、その画面の path（`pagePath`。query・値は持たない）、probe の押下の中なら押した候補（`press`。送信ボタンの語と識別の
//   digest）。
// - 文（`message`）は、IPC で送れる 1 行にし（制御文字と行の区切りを空白に）、文の中の絶対形の URL の query の値と path の値に見える区切りを伏せる（伏せ字の
//   owner `redactUrlSecretsInText` のサービスの Origin の伏せ方を、文の中のどの Origin にも当てる）。LZ-2: 長さでは切らない。LZ-3a: 一覧の数でも切らない（前は 16 まで）。
// 値（本文、query の値、Cookie、token）は残さない。
import {
  type JobSafetyViolation,
  type JobSafetyViolationPress,
  type JobSafetyViolationStage,
} from '../core/contracts.js';
import { removeBidiControls, replaceControlOrLineSeparators, replaceLoneSurrogates } from '../core/text.js';
import { redactValueLikePathSegments } from '../core/url-path-redaction.js';
import { asHttpSchemeUrl } from '../core/url-redaction.js';
import {
  EXTERNAL_SCHEME_NAVIGATION_VIOLATION_CODE,
  FRAME_CLASSIFICATION_FAILED_VIOLATION_CODE,
  HTTP_MAIN_FRAME_DELIVERY_FAILED_VIOLATION_CODE,
} from './passive-request-guard.js';
import { isReadMethod } from './request-policy.js';
import { absoluteUrlPattern, redactUrlSecretsInText } from './redact.js';
import { summarizePageSafety, type SafetyLedgerSnapshot } from './safety-ledger.js';

export {
  JOB_SAFETY_VIOLATION_STAGES,
  type JobSafetyViolation,
  type JobSafetyViolationPress,
  type JobSafetyViolationStage,
} from '../core/contracts.js';

/** 文の置き換えの文字（制御文字と行の区切り）。 */
const TEXT_REPLACEMENT = ' ';
/** 文の中の、絶対形の URL の Origin の部分（scheme と host と port）。 */
const ABSOLUTE_URL_ORIGIN = absoluteUrlPattern(String.raw`[^\s"'<>` + '`' + String.raw`/?#\\]+`);

/** 組み立ての入力。 */
export interface JobSafetyViolationInput {
  /** 読み込んだ画面の URL（path だけを残す）。 */
  readonly url: string;
  /** その画面の Context の Ledger の、閉じた後の snapshot。 */
  readonly snapshot: SafetyLedgerSnapshot;
  readonly stage: JobSafetyViolationStage;
  readonly press: JobSafetyViolationPress | null;
}

/** 文の中の絶対形の URL の Origin（読めないものは除く）。 */
const originsInText = (text: string): readonly string[] => [...text.matchAll(ABSOLUTE_URL_ORIGIN)].flatMap(([match]) => {
  try {
    return [new URL(asHttpSchemeUrl(match)).origin];
  } catch {
    return [];
  }
});

/** 違反の文を、1 行で、URL の値を伏せた文にする（LZ-2: 長さの上限（前は 1,024）は置かない。切り詰めない）。 */
const safeMessageOf = (message: string): string => {
  const line = replaceLoneSurrogates(removeBidiControls(replaceControlOrLineSeparators(message, TEXT_REPLACEMENT)));
  return redactUrlSecretsInText(line, { serviceOrigins: originsInText(line) });
};

/** 画面の URL の path（値に見える区切りを伏せる。読めなければ空）。URL-LEN: 長さでは切り詰めない（前は 2,048）。 */
const pagePathOf = (url: string): string => {
  try {
    return redactValueLikePathSegments(new URL(url).pathname);
  } catch {
    return '';
  }
};

/** DEF-144: probe の段で発見を続けてよい違反の種類（外部スキームへの移動と、あわせて記録される frame の判定の失敗）。 */
const PROBE_EXTERNAL_SCHEME_VIOLATION_CODES: ReadonlySet<string> = new Set([
  EXTERNAL_SCHEME_NAVIGATION_VIOLATION_CODE,
  FRAME_CLASSIFICATION_FAILED_VIOLATION_CODE,
]);

/**
 * DEF-144・DEF-145: probe の段の違反で、発見を止めずに続けてよい形。
 * - `EXTERNAL_SCHEME`: 押下で外部スキームへ移ろうとした（DEF-144。その候補は `EXTERNAL_SCHEME`）。
 * - `READ_NAVIGATION_CANCELED`: 押下で始まった読み取り（GET・HEAD）の main frame の移動が、届いたか分からないまま失敗した（DEF-145。多くはページの JS が
 *   次の移動で取り消した `net::ERR_ABORTED`。その候補は `PAGE_CHANGED`）。
 */
export type ProbeViolationContinuation = 'EXTERNAL_SCHEME' | 'READ_NAVIGATION_CANCELED';

/** 違反 1 件が、probe の段で続けてよい種類か（外部スキームへの移動、frame の判定の失敗、要求が GET・HEAD と分かる main frame の配送の失敗）。 */
const isContinuableProbeViolation = ({ code, request }: JobSafetyViolation['invariantViolations'][number]): boolean =>
  PROBE_EXTERNAL_SCHEME_VIOLATION_CODES.has(code)
  || (code === HTTP_MAIN_FRAME_DELIVERY_FAILED_VIOLATION_CODE && request !== undefined && isReadMethod(request.method));

/**
 * DEF-144（設計書 `2026-10-20-beaksight-probe-external-scheme-design.md` 2.2）・DEF-145（設計書 `2026-10-21-beaksight-probe-navigation-and-dialog-design.md`
 * 2.1）: 発見を止めずに続けてよい違反なら、その形（ほかは `null`。今どおり止める）。最初に見た段が probe の押下の中（`SUBMISSION_PROBE`）で、記録が欠けて
 * おらず（数と一覧が同じ、上限で不完全でない）、どの違反も続けてよい種類で、外部スキームへの移動か、読み取りの main frame の配送の失敗を含むものだけ。
 * 配送の失敗は、失敗した要求の method が分からないもの・GET・HEAD でないものは続けない。
 */
export function probeViolationContinuationOf(violation: JobSafetyViolation): ProbeViolationContinuation | null {
  const codes = violation.invariantViolations.map(({ code }) => code);
  if (
    violation.stage !== 'SUBMISSION_PROBE'
    || violation.recordTruncated
    || violation.invariantViolationCount !== codes.length
    || !violation.invariantViolations.every(isContinuableProbeViolation)
  ) {
    return null;
  }
  if (codes.includes(EXTERNAL_SCHEME_NAVIGATION_VIOLATION_CODE)) {
    return 'EXTERNAL_SCHEME';
  }
  return codes.includes(HTTP_MAIN_FRAME_DELIVERY_FAILED_VIOLATION_CODE) ? 'READ_NAVIGATION_CANCELED' : null;
}

/**
 * SAFE-2 の 4（違反の区分の (3)。設計者の判断）: probe の押下の後に、発見をどう続けるかを、違反でなく Safety の記録から決める（`probeViolationContinuationOf` の
 * 後継。外部スキームの移動・frame の判定の失敗・読み取りの main frame の移動の失敗は、違反でなくなったので、発見は止まらない。押した候補の結果を決めるために使う）。
 * 凍結の後（時点 `INTERACTION`）の記録だけを見る（凍結の前の読み込みの記録と、Guard が止めたサーバのリダイレクトは使わない）。
 * - ページによる外部スキームの移動（`externalSchemeNavigations` の `EXTERNAL_SCHEME_NAVIGATION`）か、frame の判定の失敗（`window.open` の外部スキームなど）: `EXTERNAL_SCHEME`。
 * - 読み取り（GET・HEAD）の main frame の移動の失敗（DEF-145。届いたか分からない）: `READ_NAVIGATION_CANCELED`。
 * - どれもない: `null`。
 */
export function probeRecordContinuationOf(snapshot: SafetyLedgerSnapshot): ProbeViolationContinuation | null {
  const afterFreeze = <Event extends { readonly phase: string }>(events: readonly Event[] | undefined): readonly Event[] =>
    (events ?? []).filter(({ phase }) => phase === 'INTERACTION');
  if (
    afterFreeze(snapshot.externalSchemeNavigations).some(({ reason }) => reason === 'EXTERNAL_SCHEME_NAVIGATION')
    || afterFreeze(snapshot.frameClassificationFailures?.events).length > 0
  ) {
    return 'EXTERNAL_SCHEME';
  }
  return afterFreeze(snapshot.readNavigationFailures?.events).some(({ method }) => isReadMethod(method)) ? 'READ_NAVIGATION_CANCELED' : null;
}

/** 違反の中身を組み立てる（違反の一覧と数は `summarizePageSafety`。純粋。結果は凍結する）。 */
export function jobSafetyViolationOf(input: JobSafetyViolationInput): JobSafetyViolation {
  const summary = summarizePageSafety([input.snapshot]);
  return Object.freeze({
    pagePath: pagePathOf(input.url),
    stage: input.stage,
    press: input.press === null
      ? null
      : Object.freeze({ submitterWords: Object.freeze([...input.press.submitterWords]), identityDigest: input.press.identityDigest }),
    invariantViolationCount: summary.invariantViolationCount,
    invariantViolations: Object.freeze(summary.invariantViolations.map((violation) => Object.freeze({
      ...violation,
      message: safeMessageOf(violation.message),
    }))),
    recordTruncated: summary.recordTruncated,
  });
}
