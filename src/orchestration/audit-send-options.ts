// 監査の段の送信の扱いの、factory の口（`BrowserContextFactoryOptions.auditSend`）の組み立ての唯一の場所（AS-b。設計書
// `doc/design/2026-10-19-beaksight-audit-send-policy-design.md` 2.1・2.2、5 章の AS-b の Blocker の行の (1)）。
// - Run Coordinator（CLI の監査とワーカーの監査。公開と認証つき）、発見のジョブ、READ の確かめのジョブが、Passive Context を作る factory に渡す指定を
//   ここで作る。OP-N（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.7 の N2）・OP-REV3（C-1）: 書き込みのジョブも、同じ組み立てで作った口を、書き込みの段の
//   Context だけに渡す（factory の `writeStageAuditSend`。送る前の確かめの Passive の Context には渡さない）。ログインの段の流れには口そのものは渡さない。
//   DEF-193（設計書 `2026-11-04-beaksight-login-session-design.md` 3.2）: factory が、この組み立ての危険な語を、自動ログインの段の指定の印（`automatedPassThrough`）に使う
//   （扱いが `PASS_EXCEPT_DELETE` のときだけ。一覧を複製しない）。
// - 実効の設定の扱いが `PASS_EXCEPT_DELETE` のときだけ口を作る。`READ_ONLY` と、項目のない設定（`READ_ONLY` と読む）は口を作らない（今のまま読み取りだけ）。
// - 承認したサービスの Origin は呼び出し側が渡す（認証つきならプロファイルの承認したサービスの Origin（`approvedTestOrigins`）、公開の監査なら空）。
// - 危険な語は既定の危険な語（`DEFAULT_EXCLUDED_URL_WORDS`。監査の段の除外と同じ一覧）に、URL の判定の足す語（SD-1 の `DESTRUCTIVE_ACTION_URL_EXTRA_WORDS`）を
//   足したもの。数の上限はない（L10）。SD-2（設計書 `2026-11-16-beaksight-action-based-delete-guard-design.md` 2.4）: ページの送信を止めるのには使わない。
//   使うのは、凍結の段の読み取りと token の更新から除く決まり（守り 2）と、通した WebSocket の記録の印だけ。
import type { BrowserContextFactoryOptions } from '../browser/context-factory.js';
import type { AuditConfig } from '../config/types.js';
import { AUDIT_SEND_PASS_EXCEPT_DELETE, auditSendPolicyOf } from '../core/audit-send-policy.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../core/default-excluded-url-words.js';
import { DESTRUCTIVE_ACTION_URL_EXTRA_WORDS } from '../discovery/classification-words.js';

/** factory の指定のうち、監査の段の送信の扱いの口（`PASS_EXCEPT_DELETE` のときだけ持つ）。 */
export type AuditSendFactoryOptions = Pick<BrowserContextFactoryOptions, 'auditSend'>;

/**
 * 送信の扱いの口に渡す危険な語（既定の一覧の後に、URL の判定の足す語）。SD-2: 前の通信の層だけの語（`AUDIT_SEND_EXTRA_DANGEROUS_TERMS`）は外し、SD-1 の操作の前の
 * 判定の語の一覧（`src/discovery/classification-words.ts`）から読む（値は同じ。凍結の段の読み取りから除く語を変えない）。
 */
export const AUDIT_SEND_DANGEROUS_TERMS: readonly string[] = Object.freeze([...DEFAULT_EXCLUDED_URL_WORDS, ...DESTRUCTIVE_ACTION_URL_EXTRA_WORDS]);

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
