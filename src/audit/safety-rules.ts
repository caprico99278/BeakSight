import type { EvidenceId } from '../core/contracts.js';
import type { SafetyEventsEvidence } from '../core/evidence-types.js';
import { listText } from '../presentation/messages.js';
import { isReadMethod } from '../safety/request-policy.js';
import type { AuditRule, FindingDraft, PageRuleInput } from './rule.js';
import { distinctSorted, evidenceOfType } from './rule-helpers.js';

const RULE_VERSION = 1;

/** 記録の上限に達した Evidence から作る Finding の文言に加える注意（Task 12・13 の設計書 5.4.1）。 */
const TRUNCATION_NOTE = 'Safety Ledger の記録が上限に達したため、実際の件数は、この件数より多い可能性があります。';

/** 1つの事象を、文言に書く事実にしたもの。 */
interface SafetyEventFact {
  /** 例として文言に書く事実（URL など）。 */
  readonly sample: string;
  /** 事象の種類をまとめて書く値（メソッド、理由）。ない場合は null。 */
  readonly kind: string | null;
}

interface SafetyRuleDefinition {
  readonly ruleId: string;
  /** 1つの Evidence から、この Rule が数える事象を取り出す。 */
  readonly facts: (payload: SafetyEventsEvidence) => readonly SafetyEventFact[];
  /** 件数、種類の一覧、例から、文言の本体を作る。 */
  readonly describe: (count: number, kinds: string, sample: string) => string;
}

/**
 * Safety Ledger の事象を、ページ・ビューポート・Rule の組ごとに1つの SAFETY の Finding にまとめる Rule。
 * - Scope（PASSIVE・INTERACTION）の違いでは分けない。件数は、記録された事象の数。
 * - 例に書く事実は、入力の順序によらないよう、コード単位の順で最初のものにする。
 * - 事象を1件以上数えた Evidence だけを参照する。そのどれかが記録の上限に達していれば、件数が不完全である注意を書く。
 * - 同一性の要素は加えない（Rule・ページ・ビューポートで決まるため）。
 */
const safetyRule = (definition: SafetyRuleDefinition): AuditRule => ({
  ruleId: definition.ruleId,
  version: RULE_VERSION,
  category: 'SAFETY',
  severity: 'SAFETY',
  evaluate(input: PageRuleInput): readonly FindingDraft[] {
    const facts: SafetyEventFact[] = [];
    const evidenceRefs: EvidenceId[] = [];
    let truncated = false;
    for (const record of evidenceOfType(input, 'safety')) {
      const recordFacts = definition.facts(record.payload);
      if (recordFacts.length === 0) {
        continue;
      }
      facts.push(...recordFacts);
      evidenceRefs.push(record.evidenceId);
      truncated ||= record.payload.recordLimits.truncated;
    }
    const sample = distinctSorted(facts.map((fact) => fact.sample))[0];
    if (sample === undefined) {
      return [];
    }
    const kinds = listText(distinctSorted(facts.flatMap((fact) => (fact.kind === null ? [] : [fact.kind]))));
    const body = definition.describe(facts.length, kinds, sample);
    return [{
      ruleId: definition.ruleId,
      ruleVersion: RULE_VERSION,
      category: 'SAFETY',
      severity: 'SAFETY',
      message: truncated ? `${body}${TRUNCATION_NOTE}` : body,
      evidenceRefs,
      identityFields: [],
    }];
  },
});

/**
 * Safety の page rule（T12d）の一覧。登録は `RULE_CATALOG`（`./rule-catalog.ts`）がまとめて行う。
 * 事象と Rule の対応は、Task 12・13 の設計書 5.4.1 に従う。Interaction の凍結中に遮断した GET・HEAD のリクエストと、
 * `blockedInteractionNavigations` は、凍結のしくみで遮断が予定された通信なので、Finding にしない。
 */
export const SAFETY_RULES: readonly AuditRule[] = Object.freeze([
  safetyRule({
    ruleId: 'SAFETY_NON_READ_REQUEST_BLOCKED',
    facts: (payload) => [...payload.blockedRequests, ...payload.blockedInteractionRequests]
      .filter((event) => !isReadMethod(event.method))
      .map((event) => ({ sample: `${event.method} ${event.url}`, kind: event.method })),
    describe: (count, kinds, sample) =>
      `読み取り以外のメソッド（${kinds}）のリクエストを ${count} 件遮断しました（例: ${sample}）。`,
  }),
  safetyRule({
    ruleId: 'SAFETY_EXTERNAL_NAVIGATION_BLOCKED',
    facts: (payload) => payload.blockedNavigations.map((event) => ({ sample: event.url, kind: null })),
    describe: (count, _kinds, sample) =>
      `許可Originの外へのメインフレームのナビゲーションを ${count} 件遮断しました（例: ${sample}）。`,
  }),
  safetyRule({
    ruleId: 'SAFETY_EXTERNAL_ACTION_BLOCKED',
    facts: (payload) => payload.blockedExternalActions.map((event) => ({
      sample: `候補 ${event.candidateId}、URL: ${event.url ?? 'なし'}`,
      kind: event.reason,
    })),
    describe: (count, kinds, sample) =>
      `外部への作用がある Interaction の候補を ${count} 件実行しませんでした（理由: ${kinds}、例: ${sample}）。`,
  }),
  safetyRule({
    ruleId: 'SAFETY_DOWNLOAD_BLOCKED',
    facts: (payload) => payload.blockedDownloads.map((event) => ({
      sample: `${event.url}、ファイル名: ${event.suggestedFilename}`,
      kind: event.reason,
    })),
    describe: (count, kinds, sample) =>
      `ダウンロードを ${count} 件遮断しました（理由: ${kinds}、例: ${sample}）。`,
  }),
  safetyRule({
    ruleId: 'SAFETY_POPUP_BLOCKED',
    facts: (payload) => payload.blockedPopups.map((event) => ({ sample: event.url, kind: null })),
    describe: (count, _kinds, sample) => `popup を ${count} 件遮断しました（例: ${sample}）。`,
  }),
  safetyRule({
    ruleId: 'SAFETY_WEBSOCKET_BLOCKED',
    facts: (payload) => [...payload.blockedWebSockets, ...payload.blockedInteractionWebSockets]
      .map((event) => ({ sample: event.url, kind: event.reason })),
    describe: (count, kinds, sample) =>
      `WebSocket の接続を ${count} 件遮断しました（理由: ${kinds}、例: ${sample}）。`,
  }),
  safetyRule({
    ruleId: 'SAFETY_INTERACTION_CANDIDATE_EXCLUDED',
    facts: (payload) => payload.excludedInteractionCandidates.map((event) => ({
      sample: `候補 ${event.candidateId}`,
      kind: event.reason,
    })),
    describe: (count, kinds, sample) =>
      `安全のため、Interaction の候補を ${count} 件、機械的に除外しました（理由: ${kinds}、例: ${sample}）。`,
  }),
  // C18a（DEF-012。Task 19 の前の整理の設計書 4.2）: `blockedExternalActions` と同じ考え方で、記録した試みを1つの Finding にまとめる。
  // 数えるのは、ページによる移動の試み（止められない経路）だけである。Guard が止めたサーバのリダイレクトは、下の Rule が数える。
  safetyRule({
    ruleId: 'SAFETY_EXTERNAL_SCHEME_NAVIGATION_ATTEMPTED',
    facts: (payload) => payload.externalSchemeNavigations
      .filter((event) => event.reason === 'EXTERNAL_SCHEME_NAVIGATION')
      .map((event) => ({ sample: event.url, kind: event.scheme })),
    describe: (count, kinds, sample) =>
      `ページによる外部スキーム（${kinds}）への移動の試みを ${count} 件記録しました（例: ${sample}）。`,
  }),
  // C18g（RC18a の指摘1。設計書 4.2、4.2.1）: 外部スキームへのサーバのリダイレクトを、Guard がたどる前に止めた事象。止めた事象なので、
  // ページによる移動の試みと区別して、1つの Finding にまとめる。
  safetyRule({
    ruleId: 'SAFETY_EXTERNAL_SCHEME_REDIRECT_BLOCKED',
    facts: (payload) => payload.externalSchemeNavigations
      .filter((event) => event.reason === 'EXTERNAL_SCHEME_REDIRECT_BLOCKED')
      .map((event) => ({ sample: event.url, kind: event.scheme })),
    describe: (count, kinds, sample) =>
      `外部スキーム（${kinds}）へのサーバのリダイレクトを ${count} 件、たどる前に止めました（例: ${sample}）。`,
  }),
]);
