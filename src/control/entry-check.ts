// 入口の確かめ（`ENTRY_CHECK`。Task 43 の設計書 3 章、4.3。T43c）の、読んだ事実と案の唯一の owner。純粋な部品（入出力を持たない。Playwright と
// 監査エンジンを import しない）。ワーカー（`src/worker/entry-check-run.ts`）、ジョブの管理（照らし合わせ）、画面（ジョブの詳細と認証の設定の案）が使う。
// - 成果物 `entry-check.json`（`schemas/entry-check.schema.json`）の形: 終わり方、移った先（許可 Origin の中ならその path（値に見える区切りは伏せる）、
//   外なら Origin だけ）、読んだ事実（ログインの画面に見えるか、3 つの欄の候補の数と一意な CSS、form の置き方と action と method）、案、Guard が
//   止めた要求の数。欄の値は持たない（読まない）。URL は書く側の伏せ字（`ArtifactWriter`）も通る。
// - 案への写し（`entryCheckProposalOf`）: ログインの画面に見え、移った先が許可 Origin の中のときだけ案を作る。
//   - ログインの開始の URL とセッションの切れの path: 移った先の Origin と path（伏せた区切りがあれば出さない）。
//   - 送り方: 3 つが同じ form の中で、action が許可 Origin の中で POST なら「フォームの送信」とその送信先。3 つとも form の外、action がない、GET なら
//     「スクリプトで送る」（送信先は人が入れる）。混ざった置き方、外部の Origin の action、伏せた区切りのある action、ほかの method は案を出さない。
//   - 自動ログインの 3 つのセレクタ: 欄ごとに、候補がちょうど 1 つで一意な CSS があるときだけ。
// - 埋めた値は保存されていない案（設計書 3 章）。利用者が確かめて保存したものだけが通る。
import type { RunStatus } from '../core/contracts.js';
import { MAX_URL_LENGTH } from '../core/limits.js';
import { deriveRunStatus } from '../core/status.js';
import { hasRedactedPathSegment, redactValueLikePathSegments } from '../core/url-path-redaction.js';
import { canonicalHttpOriginOf, isOriginInAllowedOrigins } from '../crawl/normalize-url.js';
import {
  FORM_NAVIGATION_TRANSPORT,
  LOGIN_TRANSPORTS,
  MAX_SUCCESS_SELECTOR_LENGTH,
  SCRIPT_REQUEST_TRANSPORT,
  type LoginTransport,
} from './auth/auth-setup-contracts.js';
import { isAcceptedSelector, isStandardCssSelectorShape } from './auth/auth-setup-policy.js';

/** 成果物の版（スキーマの `schemaVersion` の const と一致する）。 */
export const ENTRY_CHECK_ARTIFACT_SCHEMA_VERSION = 'entry-check-schema/1.0';

/**
 * 入口の確かめの終わり方（閉じた一覧。スキーマの enum と一致する）。
 * - `READ`: 開始の URL を読み、落ち着いた後に凍結して読んだ。
 * - `LEFT_ALLOWED_ORIGINS`: 許可 Origin の外へ移ろうとした（Guard が止めた。移ろうとした Origin だけを記録し、読まない）。
 * - `READ_FAILED`: 読み込めたが、凍結できない・読めなかった（読んでいない）。
 * - `NAVIGATION_FAILED`: 読み込みが失敗した（時間切れを含む）。
 * - `PREFLIGHT_FAILED`: Run の前の確認が失敗した（読み込んでいない）。
 * - `STOPPED`: 止める要求で、読み込む前に止まった。
 * - `SAFETY_VIOLATION`: Safety Ledger に不変条件の違反があった。
 */
export const ENTRY_CHECK_END_REASONS = Object.freeze([
  'READ',
  'LEFT_ALLOWED_ORIGINS',
  'READ_FAILED',
  'NAVIGATION_FAILED',
  'PREFLIGHT_FAILED',
  'STOPPED',
  'SAFETY_VIOLATION',
] as const);
export type EntryCheckEndReason = (typeof ENTRY_CHECK_END_REASONS)[number];

/** 読む欄（ユーザー名、パスワード、送信の要素の順）。 */
export const ENTRY_CHECK_FIELDS = Object.freeze(['username', 'password', 'submit'] as const);
export type EntryCheckField = (typeof ENTRY_CHECK_FIELDS)[number];

/**
 * 3 つの要素の form の中の置き方（ログインの form の事前の確かめと同じ分け方）。`SAME` は 3 つが同じ form の中、`NONE` は 3 つとも form の外、
 * `MIXED` はほか（一部だけが form の中、別々の form の中）。3 つのどれかの候補がちょうど 1 つでなければ、置き方は `null`。
 */
export const ENTRY_CHECK_FORM_PLACEMENTS = Object.freeze(['SAME', 'NONE', 'MIXED'] as const);
export type EntryCheckFormPlacement = (typeof ENTRY_CHECK_FORM_PLACEMENTS)[number];

/** form の method（ブラウザの `method` のプロパティの値を大文字にしたもの）。 */
export const ENTRY_CHECK_FORM_METHODS = Object.freeze(['GET', 'POST', 'DIALOG'] as const);
export type EntryCheckFormMethod = (typeof ENTRY_CHECK_FORM_METHODS)[number];

/** 案の送り方（認証の設定の送り方の一覧そのもの。スキーマの enum との対応のため、この名前でも公開する）。 */
export const ENTRY_CHECK_LOGIN_TRANSPORTS = LOGIN_TRANSPORTS;

/** 場所（Origin と、許可 Origin の中なら値に見える区切りを伏せた path。外なら path は `null`）。 */
export interface EntryCheckLocation {
  readonly origin: string;
  readonly path: string | null;
  readonly inAllowedOrigins: boolean;
}

/** 1 つの欄の事実（見える候補の数と、候補がちょうど 1 つのときの一意な CSS）。 */
export interface EntryCheckFieldFacts {
  readonly candidates: number;
  readonly selector: string | null;
}

/** form の事実（action は action の属性があるときだけ。method は form があるときだけ）。 */
export interface EntryCheckFormFacts {
  readonly placement: EntryCheckFormPlacement | null;
  readonly action: EntryCheckLocation | null;
  readonly method: EntryCheckFormMethod | null;
}

/** 読んだ事実（欄の値は持たない）。 */
export interface EntryCheckFacts {
  /** 見える `input[type=password]` がある。 */
  readonly loginPage: boolean;
  readonly fields: Readonly<Record<EntryCheckField, EntryCheckFieldFacts>>;
  readonly form: EntryCheckFormFacts;
}

/** 認証の設定の案（保存されていない値）。 */
export interface EntryCheckProposal {
  readonly loginStartUrl: string | null;
  readonly sessionLostPathPrefix: string | null;
  readonly loginTransport: LoginTransport | null;
  /** 「フォームの送信」のときだけ、その送信先。 */
  readonly loginPostEndpoint: { readonly origin: string; readonly path: string } | null;
  readonly selectors: Readonly<Record<EntryCheckField, string | null>>;
}

/** 成果物 `entry-check.json`。 */
export interface EntryCheckDocument {
  readonly schemaVersion: typeof ENTRY_CHECK_ARTIFACT_SCHEMA_VERSION;
  readonly jobId: string;
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly runStatus: RunStatus;
  readonly endReason: EntryCheckEndReason;
  /** 移った先（読み込めなかったときは `null`）。 */
  readonly landing: EntryCheckLocation | null;
  /** 読んだ事実（`READ` のときだけ）。 */
  readonly facts: EntryCheckFacts | null;
  /** 案（ログインの画面に見え、移った先が許可 Origin の中のときだけ）。 */
  readonly proposal: EntryCheckProposal | null;
  /** Guard が止めた、ページ自身の要求の数。 */
  readonly blockedRequests: number;
  /**
   * DEF-129: Guard が通した（サーバへ送った）main frame の文書の要求の数（BeakSight 自身の読み込み、リダイレクトの続き、ページが始めた読み込みを含む）。
   * 今の書き手は必ず書く。ページが始めた読み込みが上限を超えたら、その画面は読まない（`READ_FAILED`）。
   */
  readonly documentRequests?: number;
  /** T37R2-fix: Guard が通した子の frame の文書の要求の数（別の数）。今の書き手は必ず書く。子の frame の読み込みの上限も、上の `READ_FAILED` と同じ。 */
  readonly childFrameDocumentRequests?: number;
  /** DEF-130-fix: Guard が通した文書でない要求の数（別の数）。今の書き手は必ず書く。上限で止めたら、その画面は読まない（`READ_FAILED`）。 */
  readonly subresourceRequests?: number;
}

/** IPC の `FINISHED` の件数の要約（URL・セレクタ・値を持たない）。 */
export interface EntryCheckSummary {
  readonly endReason: EntryCheckEndReason;
  /** ログインの画面に見えたか（読んでいなければ `null`）。 */
  readonly loginPage: boolean | null;
  /** 案のセレクタの数（0〜3）。 */
  readonly proposedSelectors: number;
}

/**
 * 終わり方の Run Status。終わり方を Run Status の入力に写して、唯一の判定 `deriveRunStatus`（`src/core/status.ts`）に任せる（判定を書き写さない）:
 * 違反 → `safetyInvariantViolations`、PREFLIGHT の失敗 → `preflightFailed`、止めた → 終わっていない（`executionComplete` が偽）、読み込みの失敗 →
 * `failedRequiredWork`、凍結できない・読めない → `incompleteCollectorCount`。結果: 違反は `ABORTED_BY_SAFETY`、PREFLIGHT の失敗は `FAILED`、読んだ・外へ
 * 移ったは `COMPLETE`、ほかは `PARTIAL`。
 */
export const entryCheckRunStatusOf = (endReason: EntryCheckEndReason): RunStatus => deriveRunStatus({
  preflightFailed: endReason === 'PREFLIGHT_FAILED',
  safetyInvariantViolations: endReason === 'SAFETY_VIOLATION' ? 1 : 0,
  safetyLedgerTruncated: false,
  incompleteReasons: [],
  unhandledFailures: 0,
  crawlLimitReached: false,
  requiredArtifactsValid: true,
  executionComplete: endReason !== 'STOPPED',
  skippedRequiredWork: 0,
  blockedRequiredWork: 0,
  timedOutRequiredWork: 0,
  notObservedRequiredWork: 0,
  notVerifiedRequiredWork: 0,
  failedRequiredWork: endReason === 'NAVIGATION_FAILED' ? 1 : 0,
  incompleteCollectorCount: endReason === 'READ_FAILED' ? 1 : 0,
});

/**
 * URL の場所（http(s) の URL でなければ `null`）。許可 Origin の中なら、query と fragment を除き、値に見える区切りを伏せた path（上限の長さを
 * 超えたら `null`）。外なら Origin だけ。
 */
export const entryCheckLocationOf = (url: string, allowedOrigins: readonly string[]): EntryCheckLocation | null => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const origin = canonicalHttpOriginOf(parsed.origin);
  if (origin === undefined) {
    return null;
  }
  const inAllowedOrigins = isOriginInAllowedOrigins(allowedOrigins, origin);
  const path = inAllowedOrigins ? redactValueLikePathSegments(parsed.pathname) : null;
  return { origin, path: path !== null && path.length <= MAX_URL_LENGTH ? path : null, inAllowedOrigins };
};

/** 案のセレクタとして受けるか（認証の設定の検証と同じ形: 空白だけでない、制御文字なし、標準の CSS、上限の長さまで）。 */
export const isAcceptedEntrySelector = (selector: string): boolean =>
  selector.length <= MAX_SUCCESS_SELECTOR_LENGTH && isAcceptedSelector(selector) && isStandardCssSelectorShape(selector);

/** 使える path（許可 Origin の中で、伏せた区切りがない）。 */
const usablePathOf = (location: EntryCheckLocation): string | null =>
  location.inAllowedOrigins && location.path !== null && !hasRedactedPathSegment(location.path) ? location.path : null;

/** 送り方と送信先の案（ファイルの先頭の「送り方」）。 */
const transportOf = (form: EntryCheckFormFacts): Pick<EntryCheckProposal, 'loginTransport' | 'loginPostEndpoint'> => {
  type Transport = Pick<EntryCheckProposal, 'loginTransport' | 'loginPostEndpoint'>;
  const none: Transport = { loginTransport: null, loginPostEndpoint: null };
  const script: Transport = { loginTransport: SCRIPT_REQUEST_TRANSPORT, loginPostEndpoint: null };
  if (form.placement === 'NONE') {
    return script;
  }
  if (form.placement !== 'SAME') {
    return none;
  }
  if (form.action === null || form.method === 'GET') {
    return script;
  }
  const actionPath = usablePathOf(form.action);
  return form.method === 'POST' && actionPath !== null
    ? { loginTransport: FORM_NAVIGATION_TRANSPORT, loginPostEndpoint: { origin: form.action.origin, path: actionPath } }
    : none;
};

/** 読んだ事実から、認証の設定の案を作る（ファイルの先頭の「案への写し」）。案を作らないときは `null`。 */
export const entryCheckProposalOf = (landing: EntryCheckLocation, facts: EntryCheckFacts): EntryCheckProposal | null => {
  if (!facts.loginPage || !landing.inAllowedOrigins) {
    return null;
  }
  const path = usablePathOf(landing);
  return {
    loginStartUrl: path === null ? null : `${landing.origin}${path}`,
    sessionLostPathPrefix: path,
    ...transportOf(facts.form),
    selectors: {
      username: facts.fields.username.selector,
      password: facts.fields.password.selector,
      submit: facts.fields.submit.selector,
    },
  };
};

/** 成果物の件数の要約（IPC の `FINISHED` に載せ、ジョブの管理が照らす）。 */
export const entryCheckSummaryOf = (document: Pick<EntryCheckDocument, 'endReason' | 'facts' | 'proposal'>): EntryCheckSummary => ({
  endReason: document.endReason,
  loginPage: document.facts?.loginPage ?? null,
  proposedSelectors: document.proposal === null
    ? 0
    : ENTRY_CHECK_FIELDS.filter((field) => document.proposal?.selectors[field] !== null).length,
});
