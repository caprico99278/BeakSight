// 監査の段の送信の扱いの、factory の口（`BrowserContextFactoryOptions.auditSend`）の組み立ての唯一の場所（AS-b。設計書
// `doc/design/2026-10-19-beaksight-audit-send-policy-design.md` 2.1・2.2、5 章の AS-b の Blocker の行の (1)）。
// - Run Coordinator（CLI の監査とワーカーの監査。公開と認証つき）、発見のジョブ、READ の確かめのジョブが、Passive Context を作る factory に渡す指定を
//   ここで作る。書き込みの段とログインの段の流れは使わない（口を渡さない）。
// - 実効の設定の扱いが `PASS_EXCEPT_DELETE` のときだけ口を作る。`READ_ONLY` と、項目のない設定（`READ_ONLY` と読む）は口を作らない（今のまま読み取りだけ）。
// - 承認したサービスの Origin は呼び出し側が渡す（認証つきならプロファイルの承認したサービスの Origin（`approvedTestOrigins`）、公開の監査なら空）。
// - 危険な語は既定の危険な語（`DEFAULT_EXCLUDED_URL_WORDS`。監査の段の除外と同じ一覧）に、送信の扱いだけの語（`AUDIT_SEND_EXTRA_DANGEROUS_TERMS`）を
//   足したもの。上限は Guard の既定（`AUDIT_SEND_MAX_PASSED_PER_CONTEXT`）。
import type { BrowserContextFactoryOptions } from '../browser/context-factory.js';
import type { AuditConfig } from '../config/types.js';
import { AUDIT_SEND_PASS_EXCEPT_DELETE, auditSendPolicyOf } from '../core/audit-send-policy.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../core/default-excluded-url-words.js';

/** factory の指定のうち、監査の段の送信の扱いの口（`PASS_EXCEPT_DELETE` のときだけ持つ）。 */
export type AuditSendFactoryOptions = Pick<BrowserContextFactoryOptions, 'auditSend'>;

/**
 * AS-c fix round 1（M-1。設計書 5 章の「AS-c fix round 1 の Blocker」の行）: 送信の扱いの口にだけ足す危険な語（下線の綴りのログアウト）。既定の一覧
 * `DEFAULT_EXCLUDED_URL_WORDS` は、checkpoint の digest・認証の設定の検証・READ の path の検証に結ばれているので変えない（監査の段の除外に足すかは Task 44 の
 * 候補）。この口は保存にも digest にも結ばれない。
 */
export const AUDIT_SEND_EXTRA_DANGEROUS_TERMS = Object.freeze(['sign_out', 'log_out'] as const);

/** 送信の扱いの口に渡す危険な語（既定の一覧の後に、送信の扱いだけの語）。 */
const AUDIT_SEND_DANGEROUS_TERMS: readonly string[] = Object.freeze([...DEFAULT_EXCLUDED_URL_WORDS, ...AUDIT_SEND_EXTRA_DANGEROUS_TERMS]);

/** 口を作らないときの値（今のまま読み取りだけ）。 */
const NO_AUDIT_SEND: AuditSendFactoryOptions = Object.freeze({});

/**
 * 実効の設定の扱いから、factory の口を作る。`PASS_EXCEPT_DELETE` のときだけ `{ auditSend }`（承認したサービスの Origin は写しを凍結する）、ほかは `{}`。
 */
export function auditSendOptionsOf(config: AuditConfig, approvedServiceOrigins: readonly string[]): AuditSendFactoryOptions {
  if (auditSendPolicyOf(config) !== AUDIT_SEND_PASS_EXCEPT_DELETE) {
    return NO_AUDIT_SEND;
  }
  return Object.freeze({
    auditSend: Object.freeze({
      policy: AUDIT_SEND_PASS_EXCEPT_DELETE,
      approvedServiceOrigins: Object.freeze([...approvedServiceOrigins]),
      dangerousTerms: AUDIT_SEND_DANGEROUS_TERMS,
    }),
  });
}
