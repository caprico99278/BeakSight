/**
 * 表示用モデルと表示用の集計の唯一の owner（UI追補設計書 第4章、4.2。Task 14〜17 の設計書 6.1.3、6.1.4）。
 * - 確定した Run（`AuditRunResult`。最終の Run Status のもの。`ArtifactWriter.writeRun` の戻り値の `result`）から、
 *   HTML レポート、ChatGPT 用バンドル、CLI の要約が使う1つのモデルを、1回だけ組み立てる。モデルは深く凍結する。
 * - 判定しない。Run Status は `RunSummary.runStatus` を、ページの件数は `RunSummary` の件数を、そのまま使う。新しい Finding や
 *   severity は作らない。
 * - Finding の件数と一覧の出どころは、`AuditRunResult.findings` の1つだけ（`PageAuditResult.findings` は使わない）。
 * - Finding を severity や category で数えたり分けたりする処理（表示用の集計）は、このファイルだけで行う（GATE-UI04）。
 * - ラベルと順は、カタログ（`src/presentation/catalog.ts`）から取る。モデルには値（severity や状態の値そのもの）を入れ、
 *   日本語のラベルは入れない（ラベルは、描画する側がカタログで引く）。理由の説明だけは、`messages.ts` の説明を入れる。
 * - 状態や severity の値の文字列を、直接書かない（GATE-UI01）。
 * - Evidence の場所（`page.json` と、その中の JSON Pointer）とスクリーンショットのパスは、Run のディレクトリからの相対パスで持つ。
 *   配置は、配置の owner（`src/core/artifact-layout.ts`。設計書 6.1.8）から取る。スクリーンショットのパスは、Page Auditor がその
 *   owner の関数で組み立てて Evidence に記録したもの（`ScreenshotEvidence.relativePath`）を、そのまま使う。
 * - スクリーンショットと Finding の関係づけ（設計書 6.1.8）は、`relateScreenshotsToFindings` の1か所で行う。
 * - Interaction と Safety の事象は、Evidence の場所（`location`）を持つ。場所は、Finding の Evidence の参照と同じ対応（同じ ID が
 *   2か所にある不正な Run では、先にあるもの）から付ける。描画する側は、ID から場所を引き直さない（設計書 6.1.10）。
 * - Safety の事象の一覧（`safety.events`）は、各ページの Safety の Evidence の記録を並べるだけで、Run Status や件数の判定には使わない。
 * - モデルは、入力のオブジェクトを参照せず、写しを持つ（入力を凍結したり、変えたりしない）。
 */
import { pageArtifactRelativePath } from '../core/artifact-layout.js';
import {
  INTERACTION_STATUSES,
  SEVERITIES,
  VIEWPORT_PROFILES,
  type AuditRunResult,
  type CrawlLimitState,
  type EvidenceId,
  type EvidenceType,
  type Finding,
  type FindingCategory,
  type FindingId,
  type IncompleteReason,
  type IncompleteReasonCode,
  type InteractionStatus,
  type PageAuditResult,
  type PageAuditStatus,
  type PageId,
  type RunEnvironment,
  type RunId,
  type RunSafetySummary,
  type RunStatus,
  type Severity,
  type ViewportProfile,
} from '../core/contracts.js';
import {
  INTERACTION_NOT_VERIFIABLE_KINDS,
  SAFETY_EVENT_KINDS,
  type InteractionNotVerifiableKind,
  type InteractionReasonCode,
  type NavigationOutcomeKind,
  type SafetyEventKind,
  type SafetyEventsEvidence,
  type SafetyEvidenceScope,
  type ScreenshotCaptureType,
} from '../core/evidence-types.js';
import { deepFreeze } from '../core/immutable.js';
import {
  REPORT_CATEGORY_SECTION_CATALOG,
  REPORT_CATEGORY_SECTIONS,
  SEVERITY_CATALOG,
  SEVERITY_GROUPS,
  VIEWPORT_PROFILE_CATALOG,
  findingCategoriesInSection,
  severitiesInGroup,
  sortByDisplayOrder,
  type ReportCategorySection,
  type SeverityGroup,
} from '../presentation/catalog.js';
import { describeIncompleteReason, describeInteractionReason } from '../presentation/messages.js';
import { earlierAttemptEvidenceIds, retryRecordsOf, visibleTextOf } from './artifact-writer.js';

// ---------------------------------------------------------------------------------------------------------------
// 型
// ---------------------------------------------------------------------------------------------------------------

/**
 * 理由の表示（コード、詳細、日本語の説明）。`TCode` は理由のコードの型で、既定は未完了の理由（`IncompleteReasonCode`）。
 * `description` は、理由のコードの日本語の説明（`messages.ts` の `describeIncompleteReason`、`describeInteractionReason`）。
 * `detail` は、技術的な詳細のまま（Interaction では Evidence の `reasonDetail`）。
 */
export interface ReasonView<TCode extends string = IncompleteReasonCode> {
  readonly code: TCode;
  readonly detail: string | null;
  readonly description: string;
}

/**
 * Finding の件数。`total` は全件、`bySeverity` は severity ごと（キーは `SEVERITIES` の順）、`byGroup` はサイト品質と Safety の区分ごと
 * （区分は `SEVERITY_CATALOG` の `group`。上位の設計書 13章）。
 */
export interface SeverityCountsView {
  readonly total: number;
  readonly bySeverity: Readonly<Record<Severity, number>>;
  readonly byGroup: Readonly<Record<SeverityGroup, number>>;
}

/** ページの網羅（`RunSummary` の件数のまま。数え直さない）。 */
export interface PageCoverageView {
  readonly discovered: number;
  readonly audited: number;
  readonly partial: number;
  readonly failed: number;
  readonly skipped: number;
}

/** 上限の設定（`effectiveConfig.crawl`）と、到達したか（`RunSummary.crawlLimits`）。 */
export interface RunLimitsView {
  readonly maxPages: number;
  readonly maxDepth: number;
  readonly maxRuntimeMs: number;
  readonly reached: CrawlLimitState;
}

/** 要約（設計書 6.1.4 の節1）。 */
export interface RunSummaryView {
  readonly runId: RunId;
  /** `RunSummary.runStatus` のまま。 */
  readonly runStatus: RunStatus;
  readonly targetId: string;
  readonly toolVersion: string;
  readonly startUrl: string;
  /** 許可 Origin（URL をリンクにするかの判断に使う。設計書 6.1.6）。 */
  readonly allowedOrigins: readonly string[];
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly coverage: PageCoverageView;
  /** サイト品質（ERROR、WARN、INFO）と Safety の件数。出どころは `AuditRunResult.findings` だけ。 */
  readonly findingCounts: SeverityCountsView;
  /** 安全の不変条件の違反の件数（`RunSafetySummary.invariantViolationCount`）。 */
  readonly safetyInvariantViolationCount: number;
  readonly limits: RunLimitsView;
  /** Run の未完了の理由（`RunSummary.incompleteReasons` の順）。 */
  readonly incompleteReasons: readonly ReasonView[];
  readonly unverifiedInteractionCount: number;
  readonly unverifiedInternalLinkCount: number;
  readonly environment: RunEnvironment;
}

/** 1つの Evidence の場所（Run のディレクトリからの相対パス）。 */
export interface EvidenceLocationView {
  readonly evidenceId: EvidenceId;
  readonly type: EvidenceType;
  readonly pageId: PageId;
  readonly viewport: ViewportProfile | null;
  /** その Evidence がある `page.json` の、Run のディレクトリからの相対パス（例: `pages/PAGE-000001/page.json`）。 */
  readonly path: string;
  /** `page.json` の中の場所（JSON Pointer。例: `/evidence/3`）。 */
  readonly pointer: string;
  /** 再試行の前の試行の Evidence なら、その試行の番号。最終の試行の Evidence（と metadata）なら `null`。 */
  readonly retryAttempt: number | null;
  /** この Evidence を `evidenceRefs` に持つ Finding の ID（`AuditRunResult.findings` の順）。 */
  readonly relatedFindingIds: readonly FindingId[];
}

/** Finding の Evidence の参照（`evidenceRefs` の順）。どのページにもない ID は、`location` が `null`。 */
export interface EvidenceRefView {
  readonly evidenceId: EvidenceId;
  readonly location: EvidenceLocationView | null;
}

/**
 * スクリーンショットの Evidence（`html-components.ts` の `ScreenshotRefInput` の形を含む）。`evidenceId` がスクリーンショットの ID
 * である。`relatedFindingIds` は、このスクリーンショットに関係づく Finding の ID（`AuditRunResult.findings` の順。重複なし）。
 * 関係づけの規則は、設計書 6.1.8（`relateScreenshotsToFindings`）:
 * - 最終の試行のスクリーンショットは、それを `evidenceRefs` で直接参照する Finding と、同じページ・同じビューポートの最終の試行の
 *   Evidence を参照する Finding に関係づく。
 * - 再試行の前の試行のスクリーンショットは、直接参照する Finding にだけ関係づく。
 */
export interface ScreenshotView {
  readonly evidenceId: EvidenceId;
  readonly pageId: PageId;
  readonly viewport: ViewportProfile;
  readonly captureType: ScreenshotCaptureType;
  /** Run のディレクトリからの相対パス（`ScreenshotEvidence.relativePath`）。 */
  readonly relativePath: string;
  readonly relatedFindingIds: readonly FindingId[];
}

/** Finding（写し）と、その Evidence の参照（`evidenceRefs` の順）と、関係づくスクリーンショット。 */
export interface FindingView {
  readonly finding: Finding;
  readonly evidence: readonly EvidenceRefView[];
  /**
   * この Finding に関係づくスクリーンショット（設計書 6.1.8。`ScreenshotView.relatedFindingIds` と同じ関係）。重複なし。
   * 直接参照するもの（`evidenceRefs` の順）が先で、その後に、同じページ・同じビューポートのもの（`evidenceRefs` の順に、
   * それぞれ `page.json` の中の順）。
   */
  readonly screenshots: readonly ScreenshotView[];
}

/**
 * category の節（設計書 6.1.4 の節3。節の順はカタログの順）。`findings` は、severity の表示の順に並べる
 * （同じ severity は `AuditRunResult.findings` の順）。
 */
export interface FindingSectionView {
  readonly section: ReportCategorySection;
  /** 節に入る category（表示の順。`findingCategoriesInSection`）。 */
  readonly categories: readonly FindingCategory[];
  readonly findings: readonly FindingView[];
  readonly counts: SeverityCountsView;
}

/** ページのビューポートごとの状態（ビューポートの表示の順）。 */
export interface ViewportView {
  readonly viewport: ViewportProfile;
  readonly status: PageAuditStatus;
  readonly requestedUrl: string;
  readonly finalUrl: string | null;
  readonly httpStatus: number | null;
  readonly navigationOutcome: NavigationOutcomeKind | null;
  readonly incompleteReasons: readonly ReasonView[];
}

/** 再試行の前の試行の記録（`RunSummary.retries` の1件と、その試行の Evidence とスクリーンショット）。 */
export interface RetryAttemptView {
  readonly attempt: number;
  readonly navigationOutcome: NavigationOutcomeKind;
  readonly detail: string | null;
  readonly evidence: readonly EvidenceLocationView[];
  readonly screenshots: readonly ScreenshotView[];
}

/**
 * ページ（設計書 6.1.4 の節6。`AuditRunResult.pages` の順）。`screenshots` と `findings` は、最終の試行のもの。
 * 再試行の前の試行の記録は `retryAttempts` にある。`visibleTextPath` は、`visible-text.txt` を書かないページでは `null`。
 */
export interface PageView {
  readonly pageId: PageId;
  readonly pageUrl: string;
  readonly status: PageAuditStatus;
  readonly incompleteReasons: readonly ReasonView[];
  readonly viewports: readonly ViewportView[];
  readonly pageJsonPath: string;
  readonly visibleTextPath: string | null;
  readonly screenshots: readonly ScreenshotView[];
  /** `AuditRunResult.findings` を `pageId` で絞ったもの（`PageAuditResult.findings` は使わない）。 */
  readonly findings: readonly FindingView[];
  readonly findingCounts: SeverityCountsView;
  readonly retryAttempts: readonly RetryAttemptView[];
}

/** Interaction の対象の要素（操作の前の記録。なければ後の記録）。 */
export interface InteractionTargetView {
  readonly tagName: string;
  readonly role: string | null;
  readonly accessibleName: string;
}

/**
 * Interaction の候補ごとの結果（最終の試行のもの。ページの順、Evidence の順）。`reason` は、Evidence の理由のコードと詳細
 * （`reasonDetail`）に、コードの日本語の説明を添えたもの（未完了の理由と同じ形。C18o）。
 */
export interface InteractionView {
  readonly evidenceId: EvidenceId;
  readonly pageId: PageId;
  readonly pageUrl: string;
  readonly viewport: ViewportProfile | null;
  readonly candidateId: string;
  readonly target: InteractionTargetView | null;
  readonly status: InteractionStatus;
  readonly notVerifiableKind: InteractionNotVerifiableKind | null;
  readonly reason: ReasonView<InteractionReasonCode>;
  /**
   * Interaction の Evidence の場所（C16d。設計書 6.1.10）。`evidence` と同じ場所（同じ ID が2か所にある不正な Run では、先にあるもの）。
   * HTML は、これで Evidence の参照を描く（ID から引き直さない）。
   */
  readonly location: EvidenceLocationView | null;
}

/** Safety の事象の理由（記録の種類ごとの理由の閉じた一覧を合わせたもの）。 */
export type SafetyEventReason = SafetyEventsEvidence[SafetyEventKind][number]['reason'];

/**
 * Safety の事象の1件（C16d。設計書 6.1.10）。Safety の Evidence（`SafetyEventsEvidence`）の、事象の一覧の1つの記録。
 * 表示のためだけのもので、Run Status と件数の判定には使わない。
 */
export interface SafetyEventView {
  /** 記録の種類（`SafetyEventsEvidence` の項目の名前のまま。値の一覧は core の `SAFETY_EVENT_KINDS`、ラベルは `SAFETY_EVENT_KIND_CATALOG`）。 */
  readonly kind: SafetyEventKind;
  readonly evidenceId: EvidenceId;
  readonly pageId: PageId;
  readonly viewport: ViewportProfile | null;
  /** Safety の Evidence のもとになった Safety Ledger の種類（`PASSIVE` か `INTERACTION`）。 */
  readonly scope: SafetyEvidenceScope;
  /** 再試行の前の試行の記録なら、その試行の番号。最終の試行の記録なら `null`。 */
  readonly retryAttempt: number | null;
  /** HTTP のメソッド。記録にない種類は `null`。 */
  readonly method: string | null;
  /** 記録された URL（そのまま）。記録にない種類と、URL のない記録は `null`。 */
  readonly url: string | null;
  /** Interaction の候補の ID。記録にない種類は `null`。 */
  readonly candidateId: string | null;
  readonly reason: SafetyEventReason;
  /**
   * 記録のある Safety の Evidence の場所（`evidence` と同じ場所。HTML の Evidence の参照に使う。`InteractionView.location` と同じ扱い）。
   */
  readonly location: EvidenceLocationView | null;
}

/** Safety の一覧（`RunSummary.safety` の写し）と、Safety の事象の一覧（C16d。設計書 6.1.10）。 */
export interface SafetyView extends RunSafetySummary {
  /**
   * 各ページの Safety の Evidence の事象の記録（ページの順、Evidence の順、記録の種類の順（core の `SAFETY_EVENT_KINDS` の順。
   * `SafetyEventsEvidence` の項目の順と同じ）、記録の中の順）。再試行の前の試行の記録を含む。記録の上限で記録されなかった件数は、
   * この一覧から推し量らず、`recordTruncated` などの `RunSafetySummary` の値で示す。
   */
  readonly events: readonly SafetyEventView[];
}

/** Interaction の一覧（設計書 6.1.4 の節4）と、状態ごと・区分ごとの件数。 */
export interface InteractionListView {
  readonly items: readonly InteractionView[];
  readonly byStatus: Readonly<Record<InteractionStatus, number>>;
  readonly notVerifiableByKind: Readonly<Record<InteractionNotVerifiableKind, number>>;
}

/** 表示用モデル。HTML レポート、ChatGPT 用バンドル、CLI の要約は、どれもこれを使う。 */
export interface ReportViewModel {
  readonly summary: RunSummaryView;
  /** すべての Finding（`AuditRunResult.findings` の順）。 */
  readonly findings: readonly FindingView[];
  /** 重大な指摘（`SEVERITY_CATALOG` の `criticalSection` が真の severity の Finding。category を問わない。`AuditRunResult.findings` の順）。 */
  readonly criticalFindings: readonly FindingView[];
  /** category の節（すべての節。Finding のない節も含む）。 */
  readonly categorySections: readonly FindingSectionView[];
  readonly interactions: InteractionListView;
  /** Safety の一覧（`RunSummary.safety` の写し）と、Safety の事象の一覧（`events`）。 */
  readonly safety: SafetyView;
  readonly pages: readonly PageView[];
  /** すべてのページのすべての Evidence の場所（ページの順、`page.json` の中の順）。 */
  readonly evidence: readonly EvidenceLocationView[];
}

// ---------------------------------------------------------------------------------------------------------------
// 組み立て
// ---------------------------------------------------------------------------------------------------------------

/**
 * 「重大な指摘」の節（設計書 6.1.4 の節2、6.1.8）に入れる severity。カタログの明示の属性 `criticalSection` で選ぶ（色のトーンでは
 * 選ばない）。severity の値そのものは書かない（GATE-UI01）。
 */
const CRITICAL_SEVERITIES: ReadonlySet<Severity> = new Set(
  SEVERITIES.filter((severity) => SEVERITY_CATALOG[severity].criticalSection),
);

const reasonView = ({ code, detail }: IncompleteReason): ReasonView => ({
  code,
  detail,
  description: describeIncompleteReason(code),
});

/** Interaction の理由（Evidence の `reason` と `reasonDetail`）に、コードの日本語の説明を添える（C18o）。 */
const interactionReasonView = (code: InteractionReasonCode, detail: string | null): ReasonView<InteractionReasonCode> => ({
  code,
  detail,
  description: describeInteractionReason(code),
});

/** Finding を severity ごと、区分ごとに数える（表示用の集計。このファイルだけで行う）。 */
const countFindings = (findings: readonly FindingView[]): SeverityCountsView => {
  const bySeverity = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0])) as Record<Severity, number>;
  for (const { finding } of findings) {
    bySeverity[finding.severity] += 1;
  }
  const byGroup = Object.fromEntries(
    SEVERITY_GROUPS.map((group) => [
      group,
      severitiesInGroup(group).reduce((sum, severity) => sum + bySeverity[severity], 0),
    ]),
  ) as Record<SeverityGroup, number>;
  return { total: findings.length, bySeverity, byGroup };
};

/** severity の表示の順に並べた新しい配列（同じ severity は入力の順）。 */
const sortBySeverity = (findings: readonly FindingView[]): readonly FindingView[] =>
  [...findings].sort((left, right) => SEVERITY_CATALOG[left.finding.severity].order - SEVERITY_CATALOG[right.finding.severity].order);

const copyFinding = (finding: Finding): Finding => ({ ...finding, evidenceRefs: [...finding.evidenceRefs] });

/** Safety の事象の記録から取り出す項目（記録にない項目は `null`）。 */
type SafetyEventFields = Pick<SafetyEventView, 'method' | 'url' | 'candidateId' | 'reason'>;

/** 記録の種類ごとの、事象の記録から項目を取り出す関数の表の型。鍵は core の `SafetyEventKind` のすべて。 */
type SafetyEventFieldReaders = {
  readonly [TKind in SafetyEventKind]: (event: SafetyEventsEvidence[TKind][number]) => SafetyEventFields;
};

/**
 * 記録の種類ごとの、事象の記録から項目を取り出す関数（設計書 6.1.10）。書き漏れと余分は、`satisfies` で型のエラーになる。
 * 記録にない項目は `null` にする。種類の並びは、この表ではなく core の `SAFETY_EVENT_KINDS` から取る。
 */
const SAFETY_EVENT_FIELDS: SafetyEventFieldReaders = Object.freeze({
  blockedRequests: ({ method, url, reason }) => ({ method, url, candidateId: null, reason }),
  blockedNavigations: ({ method, url, reason }) => ({ method, url, candidateId: null, reason }),
  blockedWebSockets: ({ url, reason }) => ({ method: null, url, candidateId: null, reason }),
  blockedExternalActions: ({ candidateId, url, reason }) => ({ method: null, url, candidateId, reason }),
  excludedInteractionCandidates: ({ candidateId, reason }) => ({ method: null, url: null, candidateId, reason }),
  blockedInteractionRequests: ({ method, url, reason }) => ({ method, url, candidateId: null, reason }),
  blockedInteractionNavigations: ({ method, url, reason }) => ({ method, url, candidateId: null, reason }),
  blockedPopups: ({ url, reason }) => ({ method: null, url, candidateId: null, reason }),
  blockedDownloads: ({ url, reason }) => ({ method: null, url, candidateId: null, reason }),
  blockedInteractionWebSockets: ({ url, reason }) => ({ method: null, url, candidateId: null, reason }),
  externalSchemeNavigations: ({ url, reason }) => ({ method: null, url, candidateId: null, reason }),
} satisfies SafetyEventFieldReaders);

/** Safety の Evidence の、1つの種類の事象の記録から取り出した項目（記録の中の順）。 */
function safetyEventFieldsOf<TKind extends SafetyEventKind>(
  payload: SafetyEventsEvidence,
  kind: TKind,
): readonly SafetyEventFields[] {
  const events: readonly SafetyEventsEvidence[TKind][number][] = payload[kind];
  return events.map((event) => SAFETY_EVENT_FIELDS[kind](event));
}

/** 場所を付ける前の Interaction の結果。 */
type InteractionDraft = Omit<InteractionView, 'location'>;
/** 場所を付ける前の Safety の事象。 */
type SafetyEventDraft = Omit<SafetyEventView, 'location'>;

/** 1つのページの Evidence を、場所の一覧と、スクリーンショットと、最終の試行の Interaction と、Safety の事象に分けたもの。 */
interface PageEvidenceIndex {
  readonly locations: readonly EvidenceLocationView[];
  readonly screenshots: readonly ScreenshotView[];
  readonly interactions: readonly InteractionDraft[];
  readonly safetyEvents: readonly SafetyEventDraft[];
}

/** ページの Evidence を1回だけたどり、場所、スクリーンショット、Interaction、Safety の事象を作る。 */
function indexPageEvidence(
  result: AuditRunResult,
  page: PageAuditResult,
  relatedFindingIds: (evidenceId: EvidenceId) => readonly FindingId[],
  screenshotFindingIds: (evidenceId: EvidenceId) => readonly FindingId[],
): PageEvidenceIndex {
  const retryAttemptOf = new Map<EvidenceId, number>();
  for (const retry of retryRecordsOf(result.run, page)) {
    for (const evidenceId of retry.evidenceIds) {
      retryAttemptOf.set(evidenceId, retry.attempt);
    }
  }
  const path = pageArtifactRelativePath(page.pageId, 'page');
  const locations: EvidenceLocationView[] = [];
  const screenshots: ScreenshotView[] = [];
  const interactions: InteractionDraft[] = [];
  const safetyEvents: SafetyEventDraft[] = [];
  page.evidence.forEach((record, index) => {
    const retryAttempt = retryAttemptOf.get(record.evidenceId) ?? null;
    locations.push({
      evidenceId: record.evidenceId,
      type: record.type,
      pageId: record.pageId,
      viewport: record.viewport,
      path,
      pointer: `/evidence/${index}`,
      retryAttempt,
      relatedFindingIds: [...relatedFindingIds(record.evidenceId)],
    });
    if (record.type === 'screenshot') {
      screenshots.push({
        evidenceId: record.evidenceId,
        pageId: record.payload.pageId,
        viewport: record.payload.viewport,
        captureType: record.payload.captureType,
        relativePath: record.payload.relativePath,
        relatedFindingIds: [...screenshotFindingIds(record.evidenceId)],
      });
    } else if (record.type === 'interaction' && retryAttempt === null) {
      const { payload } = record;
      const target = payload.evidence.before ?? payload.evidence.after;
      interactions.push({
        evidenceId: record.evidenceId,
        pageId: record.pageId,
        pageUrl: page.pageUrl,
        viewport: record.viewport,
        candidateId: payload.candidateId,
        target: target === null ? null : { tagName: target.tagName, role: target.role, accessibleName: target.accessibleName },
        status: payload.status,
        notVerifiableKind: payload.notVerifiableKind,
        reason: interactionReasonView(payload.reason, payload.reasonDetail),
      });
    } else if (record.type === 'safety') {
      // 再試行の前の試行の記録も含める（`retryAttempt` で区別する。設計書 6.1.10）。
      const { payload } = record;
      for (const kind of SAFETY_EVENT_KINDS) {
        for (const fields of safetyEventFieldsOf(payload, kind)) {
          safetyEvents.push({
            kind,
            evidenceId: record.evidenceId,
            pageId: record.pageId,
            viewport: record.viewport,
            scope: payload.scope,
            retryAttempt,
            ...fields,
          });
        }
      }
    }
  });
  return { locations, screenshots, interactions, safetyEvents };
}

/** スクリーンショットと Finding の関係（`relateScreenshotsToFindings` の結果）。 */
interface ScreenshotRelations {
  /** `AuditRunResult.findings` と同じ並びの、各 Finding に関係づくスクリーンショットの Evidence の ID（`FindingView.screenshots` の順）。 */
  readonly screenshotIdsOfFinding: readonly (readonly EvidenceId[])[];
  /** スクリーンショットの Evidence の ID から、関係づく Finding の ID（`AuditRunResult.findings` の順。重複なし）。 */
  readonly findingIdsOfScreenshot: ReadonlyMap<EvidenceId, readonly FindingId[]>;
}

/** 関係づけに使う、1つの Evidence の事実。 */
interface EvidenceRelationFacts {
  /** その Evidence がある `page.json` のページ。 */
  readonly pageId: PageId;
  readonly viewport: ViewportProfile | null;
  /** 最終の試行の Evidence か（`retries[].evidenceIds` にないか）。 */
  readonly finalAttempt: boolean;
  readonly screenshot: boolean;
}

/**
 * スクリーンショットと Finding を関係づける（設計書 6.1.8。関係づけは、ここだけで行う）。
 * - 最終の試行のスクリーンショットは、それを `evidenceRefs` で直接参照する Finding と、同じページ（その Evidence がある
 *   `page.json` のページ）・同じビューポートの最終の試行の Evidence を参照する Finding に関係づける。Cross-page の Finding も同じ。
 * - 再試行の前の試行のスクリーンショットは、直接参照する Finding にだけ関係づける。再試行の前の試行の Evidence の参照からは、
 *   どのスクリーンショットにも広げない。
 * - 同じ ID の Evidence が2か所にある（不正な Run）場合は、先にあるものを使う（Evidence の場所と同じ扱い）。
 */
function relateScreenshotsToFindings(result: AuditRunResult): ScreenshotRelations {
  const facts = new Map<EvidenceId, EvidenceRelationFacts>();
  // 最終の試行のスクリーンショット（ページごと、ビューポートごと。`page.json` の中の順）。
  const finalScreenshotsByPage = new Map<PageId, Map<ViewportProfile, EvidenceId[]>>();
  for (const page of result.pages) {
    const earlier = earlierAttemptEvidenceIds(result.run, page);
    for (const record of page.evidence) {
      if (facts.has(record.evidenceId)) {
        continue;
      }
      const fact: EvidenceRelationFacts = {
        pageId: page.pageId,
        viewport: record.viewport,
        finalAttempt: !earlier.has(record.evidenceId),
        screenshot: record.type === 'screenshot',
      };
      facts.set(record.evidenceId, fact);
      if (fact.screenshot && fact.finalAttempt && fact.viewport !== null) {
        const byViewport = finalScreenshotsByPage.get(fact.pageId) ?? new Map<ViewportProfile, EvidenceId[]>();
        const ids = byViewport.get(fact.viewport) ?? [];
        ids.push(record.evidenceId);
        byViewport.set(fact.viewport, ids);
        finalScreenshotsByPage.set(fact.pageId, byViewport);
      }
    }
  }

  const screenshotIdsOfFinding = result.findings.map((finding) => {
    const related = new Set<EvidenceId>();
    // 直接の参照（`evidenceRefs` の順）。
    for (const evidenceId of finding.evidenceRefs) {
      if (facts.get(evidenceId)?.screenshot === true) {
        related.add(evidenceId);
      }
    }
    // 同じページ・同じビューポートの、最終の試行の Evidence の参照。
    for (const evidenceId of finding.evidenceRefs) {
      const fact = facts.get(evidenceId);
      if (fact === undefined || !fact.finalAttempt || fact.viewport === null) {
        continue;
      }
      for (const screenshotId of finalScreenshotsByPage.get(fact.pageId)?.get(fact.viewport) ?? []) {
        related.add(screenshotId);
      }
    }
    return [...related];
  });

  const findingIdsOfScreenshot = new Map<EvidenceId, FindingId[]>();
  result.findings.forEach((finding, index) => {
    for (const screenshotId of screenshotIdsOfFinding[index] ?? []) {
      const ids = findingIdsOfScreenshot.get(screenshotId) ?? [];
      if (!ids.includes(finding.findingId)) {
        ids.push(finding.findingId);
      }
      findingIdsOfScreenshot.set(screenshotId, ids);
    }
  });
  return { screenshotIdsOfFinding, findingIdsOfScreenshot };
}

/**
 * 確定した Run から、表示用モデルを組み立てる（設計書 6.1.3）。入力は、最終の Run Status のもの（`ArtifactWriter.writeRun` の
 * 戻り値の `result`）でなければならない。モデルは深く凍結する。入力は変えない。
 */
export function buildReportViewModel(result: AuditRunResult): ReportViewModel {
  const { run } = result;

  // Evidence の ID から、それを参照する Finding の ID（`AuditRunResult.findings` の順）。
  const findingIdsByEvidence = new Map<EvidenceId, FindingId[]>();
  for (const finding of result.findings) {
    for (const evidenceId of new Set(finding.evidenceRefs)) {
      const ids = findingIdsByEvidence.get(evidenceId) ?? [];
      ids.push(finding.findingId);
      findingIdsByEvidence.set(evidenceId, ids);
    }
  }
  const relatedFindingIds = (evidenceId: EvidenceId): readonly FindingId[] => findingIdsByEvidence.get(evidenceId) ?? [];
  const relations = relateScreenshotsToFindings(result);
  const screenshotFindingIds = (evidenceId: EvidenceId): readonly FindingId[] =>
    relations.findingIdsOfScreenshot.get(evidenceId) ?? [];

  const pageIndexes = result.pages.map((page) => ({
    page,
    index: indexPageEvidence(result, page, relatedFindingIds, screenshotFindingIds),
  }));
  // 同じ ID が2か所にある（不正な Run）場合は、先にあるものを使う。
  const locationById = new Map<EvidenceId, EvidenceLocationView>();
  const screenshotById = new Map<EvidenceId, ScreenshotView>();
  for (const { index } of pageIndexes) {
    for (const location of index.locations) {
      if (!locationById.has(location.evidenceId)) {
        locationById.set(location.evidenceId, location);
      }
    }
    for (const screenshot of index.screenshots) {
      if (!screenshotById.has(screenshot.evidenceId)) {
        screenshotById.set(screenshot.evidenceId, screenshot);
      }
    }
  }

  const findings: readonly FindingView[] = result.findings.map((finding, index) => ({
    finding: copyFinding(finding),
    evidence: finding.evidenceRefs.map((evidenceId) => ({ evidenceId, location: locationById.get(evidenceId) ?? null })),
    screenshots: (relations.screenshotIdsOfFinding[index] ?? []).flatMap((evidenceId) => {
      const screenshot = screenshotById.get(evidenceId);
      return screenshot === undefined ? [] : [screenshot];
    }),
  }));

  const categorySections: readonly FindingSectionView[] = sortByDisplayOrder(
    REPORT_CATEGORY_SECTIONS,
    REPORT_CATEGORY_SECTION_CATALOG,
  ).map((section) => {
    const categories = findingCategoriesInSection(section);
    const sectionFindings = sortBySeverity(findings.filter(({ finding }) => categories.includes(finding.category)));
    return { section, categories: [...categories], findings: sectionFindings, counts: countFindings(sectionFindings) };
  });

  const viewportOrder = sortByDisplayOrder(VIEWPORT_PROFILES, VIEWPORT_PROFILE_CATALOG);
  const pages: readonly PageView[] = pageIndexes.map(({ page, index }) => {
    const pageFindings = findings.filter(({ finding }) => finding.pageId === page.pageId);
    const earlier = earlierAttemptEvidenceIds(run, page);
    return {
      pageId: page.pageId,
      pageUrl: page.pageUrl,
      status: page.status,
      incompleteReasons: page.incompleteReasons.map(reasonView),
      viewports: viewportOrder.map((viewport) => {
        const state = page.viewports[viewport];
        return {
          viewport,
          status: state.status,
          requestedUrl: state.requestedUrl,
          finalUrl: state.finalUrl,
          httpStatus: state.httpStatus,
          navigationOutcome: state.navigationOutcome,
          incompleteReasons: state.incompleteReasons.map(reasonView),
        };
      }),
      pageJsonPath: pageArtifactRelativePath(page.pageId, 'page'),
      visibleTextPath: visibleTextOf(run, page) === null ? null : pageArtifactRelativePath(page.pageId, 'visibleText'),
      screenshots: index.screenshots.filter((screenshot) => !earlier.has(screenshot.evidenceId)),
      findings: pageFindings,
      findingCounts: countFindings(pageFindings),
      retryAttempts: retryRecordsOf(run, page).map((retry) => {
        const ids = new Set(retry.evidenceIds);
        return {
          attempt: retry.attempt,
          navigationOutcome: retry.navigationOutcome,
          detail: retry.detail,
          evidence: index.locations.filter((location) => ids.has(location.evidenceId)),
          screenshots: index.screenshots.filter((screenshot) => ids.has(screenshot.evidenceId)),
        };
      }),
    };
  });

  // Interaction と Safety の事象に、Evidence の場所を付ける（Finding の Evidence の参照と同じ `locationById`。HTML は ID から引き直さない）。
  const withLocation = <TDraft extends { readonly evidenceId: EvidenceId }>(
    draft: TDraft,
  ): TDraft & { readonly location: EvidenceLocationView | null } => ({
    ...draft,
    location: locationById.get(draft.evidenceId) ?? null,
  });
  const interactionItems: readonly InteractionView[] = pageIndexes.flatMap(({ index }) => index.interactions.map(withLocation));
  const safetyEvents: readonly SafetyEventView[] = pageIndexes.flatMap(({ index }) => index.safetyEvents.map(withLocation));
  const byStatus = Object.fromEntries(INTERACTION_STATUSES.map((status) => [status, 0])) as Record<InteractionStatus, number>;
  const notVerifiableByKind = Object.fromEntries(INTERACTION_NOT_VERIFIABLE_KINDS.map((kind) => [kind, 0])) as Record<
    InteractionNotVerifiableKind,
    number
  >;
  for (const item of interactionItems) {
    byStatus[item.status] += 1;
    if (item.notVerifiableKind !== null) {
      notVerifiableByKind[item.notVerifiableKind] += 1;
    }
  }

  const crawl = run.effectiveConfig.crawl;
  const model: ReportViewModel = {
    summary: {
      runId: run.runId,
      runStatus: run.runStatus,
      targetId: run.target.id,
      toolVersion: run.toolVersion,
      startUrl: run.startUrl,
      allowedOrigins: [...run.allowedOrigins],
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      coverage: {
        discovered: run.discoveredPageCount,
        audited: run.auditedPageCount,
        partial: run.partialPageCount,
        failed: run.failedPageCount,
        skipped: run.skippedPageCount,
      },
      findingCounts: countFindings(findings),
      safetyInvariantViolationCount: run.safety.invariantViolationCount,
      limits: {
        maxPages: crawl.maxPages,
        maxDepth: crawl.maxDepth,
        maxRuntimeMs: crawl.maxRuntimeMs,
        reached: { ...run.crawlLimits },
      },
      incompleteReasons: run.incompleteReasons.map(reasonView),
      unverifiedInteractionCount: run.unverifiedInteractionCount,
      unverifiedInternalLinkCount: run.unverifiedInternalLinkCount,
      environment: structuredClone(run.environment),
    },
    findings,
    criticalFindings: findings.filter(({ finding }) => CRITICAL_SEVERITIES.has(finding.severity)),
    categorySections,
    interactions: { items: interactionItems, byStatus, notVerifiableByKind },
    safety: { ...structuredClone(run.safety), events: safetyEvents },
    pages,
    evidence: pageIndexes.flatMap(({ index }) => index.locations),
  };
  return deepFreeze(model);
}
