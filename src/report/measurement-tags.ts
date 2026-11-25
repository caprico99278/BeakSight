/**
 * BS-1（設計書 `doc/design/2026-11-19-beaksight-measurement-tag-inventory-design.md` 2.2・2.3）: 計測タグの一覧の集計（数えるのは、ここだけ。呼ぶのは表示用モデルの
 * 組み立て `src/report/view-model.ts` だけ）。HTML・CLI・ChatGPT 用バンドルは、表示用モデルの `summary.measurementTags` を描くだけで、数え直さない。
 * - 元: 各ページの最終の試行の network の Evidence の `requests`（応答の状態・失敗は、同じ `requestId` の `responses`・`failures`）と、`repeatedReads`（最初の 1 件の
 *   URL の行に、`requests` にない分の数を足す）。（種類, 識別子）は `src/core/measurement-services.ts` の `measurementTagOf` だけで決める（一覧にないものは数えない）。
 * - BeakSight が止めたかは、同じページ・ビューポートの Safety の記録（止めた要求の method と URL）と照らす。失敗の記録の `blockedByBeakSight` も、止めた印として使う。
 * - 1 行 =（種類, 識別子）。サイト全体で同じ構成が繰り返されても、ページごとに行を作らない。並びは、最初に観測した順（ページの順、Evidence の順、要求の順）。
 * - Finding は作らない（Run の事実の集計）。良し悪しや「重なり」の判定はしない。
 */
import type { AuditSendPolicyName } from '../core/audit-send-policy.js';
import { VIEWPORT_PROFILES, type EvidenceId, type PageAuditResult, type PageId, type RunStatus, type ViewportProfile } from '../core/contracts.js';
import {
  CLIENT_ERROR_HTTP_STATUS_RANGE,
  REDIRECTION_HTTP_STATUS_RANGE,
  SERVER_ERROR_HTTP_STATUS_RANGE,
  SUCCESS_HTTP_STATUS_RANGE,
  isHttpStatusInRange,
} from '../core/http-status.js';
import {
  MEASUREMENT_SERVICE_GROUPS,
  MEASUREMENT_SERVICE_GROUP_OF,
  isMeasurementServiceHostUrl,
  measurementTagOf,
  type MeasurementServiceGroup,
  type MeasurementServiceKind,
} from '../core/measurement-services.js';
import type { EvidenceLocationView } from './view-model.js';

/** 要求の結果の分け方（応答の状態の番号の範囲、範囲の外の番号、失敗、BeakSight が止めた、応答も失敗も観測していない）。 */
export const MEASUREMENT_REQUEST_RESULTS = Object.freeze([
  'STATUS_2XX', 'STATUS_3XX', 'STATUS_4XX', 'STATUS_5XX', 'OTHER_STATUS', 'REQUEST_FAILED', 'BLOCKED', 'NO_RESPONSE',
] as const);
export type MeasurementRequestResult = (typeof MEASUREMENT_REQUEST_RESULTS)[number];

/** 検出元（1 版目は、記録した要求だけ。DOM の中の記述からは検出しない）。 */
export const MEASUREMENT_TAG_SOURCES = Object.freeze(['NETWORK_REQUEST'] as const);
export type MeasurementTagSource = (typeof MEASUREMENT_TAG_SOURCES)[number];

/** 要求の種類（method・resourceType）ごとの数。 */
export interface MeasurementRequestKindView {
  readonly method: string;
  readonly resourceType: string;
  readonly count: number;
}

/** 根拠の参照（最初に観測した network の Evidence と、その page.json の場所）。 */
export interface MeasurementTagEvidenceView {
  readonly evidenceId: EvidenceId;
  readonly pageId: PageId;
  readonly viewport: ViewportProfile | null;
  readonly path: string;
  readonly pointer: string;
}

/** 一覧の 1 行（種類, 識別子）。 */
export interface MeasurementTagView {
  readonly service: MeasurementServiceKind;
  readonly group: MeasurementServiceGroup;
  readonly tagId: string;
  /** 観測したページの ID（点検の順）と数。 */
  readonly pageIds: readonly PageId[];
  readonly pageCount: number;
  /** ビューポートごとの観測の有無。 */
  readonly viewports: Readonly<Record<ViewportProfile, boolean>>;
  /** 要求の数（`repeatedReads` にだけある分を含む）と、種類ごとの数（最初に出た順）。 */
  readonly requestCount: number;
  readonly requestKinds: readonly MeasurementRequestKindView[];
  readonly results: Readonly<Record<MeasurementRequestResult, number>>;
  /** 根拠の参照（場所が分からなければ `null`）。 */
  readonly evidence: MeasurementTagEvidenceView | null;
  readonly source: MeasurementTagSource;
}

/** 一覧の限界（2.3。表示用モデルの今の値。数え直さない）。 */
export interface MeasurementTagLimitsView {
  readonly runStatus: RunStatus;
  /** 点検が最後まで届かなかったか（読み込めなかったページ・まだ見ていないページ・Run の理由のどれかがある）。 */
  readonly incomplete: boolean;
  readonly failedPageCount: number;
  readonly uncollectedPageCount: number;
  readonly runReasonCount: number;
  readonly auditSendPolicy: AuditSendPolicyName;
  /** 計測サービスのホストへの、BeakSight が止めた要求の数（Safety の記録から）。 */
  readonly blockedRequestCount: number;
}

/** 計測タグの一覧（`summary.measurementTags`）。 */
export interface MeasurementTagsView {
  readonly tags: readonly MeasurementTagView[];
  /** 構成の要約: 分け方ごとの行の数。 */
  readonly countsByGroup: Readonly<Record<MeasurementServiceGroup, number>>;
  readonly limits: MeasurementTagLimitsView;
}

/** 組み立ての途中の 1 行。 */
interface TagDraft {
  readonly service: MeasurementServiceKind;
  readonly tagId: string;
  readonly pageIds: PageId[];
  readonly viewports: Set<ViewportProfile>;
  requestCount: number;
  readonly requestKinds: Map<string, MeasurementRequestKindView & { count: number }>;
  readonly results: Record<MeasurementRequestResult, number>;
  readonly firstEvidenceId: EvidenceId;
}

const STATUS_RESULTS: readonly (readonly [typeof SUCCESS_HTTP_STATUS_RANGE, MeasurementRequestResult])[] = [
  [SUCCESS_HTTP_STATUS_RANGE, 'STATUS_2XX'],
  [REDIRECTION_HTTP_STATUS_RANGE, 'STATUS_3XX'],
  [CLIENT_ERROR_HTTP_STATUS_RANGE, 'STATUS_4XX'],
  [SERVER_ERROR_HTTP_STATUS_RANGE, 'STATUS_5XX'],
];

const statusResultOf = (status: number): MeasurementRequestResult =>
  STATUS_RESULTS.find(([range]) => isHttpStatusInRange(status, range))?.[1] ?? 'OTHER_STATUS';

/** 止めた要求の照らし合わせの鍵（ビューポート・method・URL）。 */
const blockKeyOf = (viewport: ViewportProfile | null, method: string, url: string): string => JSON.stringify([viewport, method, url]);

const tagKeyOf = (service: MeasurementServiceKind, tagId: string): string => JSON.stringify([service, tagId]);

/** 計測タグの一覧を、ページを 1 つずつ足して数える（`earlier` は、そのページの再試行の前の試行の Evidence の ID）。 */
export function createMeasurementTagCollector(): {
  readonly addPage: (page: PageAuditResult, earlier: ReadonlySet<EvidenceId>) => void;
  readonly result: (
    locationOf: (evidenceId: EvidenceId) => EvidenceLocationView | null,
    limits: Omit<MeasurementTagLimitsView, 'blockedRequestCount'>,
  ) => MeasurementTagsView;
} {
  const drafts = new Map<string, TagDraft>();
  let blockedRequestCount = 0;

  const draftOf = (service: MeasurementServiceKind, tagId: string, evidenceId: EvidenceId): TagDraft => {
    const key = tagKeyOf(service, tagId);
    const known = drafts.get(key);
    if (known !== undefined) {
      return known;
    }
    const draft: TagDraft = {
      service,
      tagId,
      pageIds: [],
      viewports: new Set(),
      requestCount: 0,
      requestKinds: new Map(),
      results: Object.fromEntries(MEASUREMENT_REQUEST_RESULTS.map((result) => [result, 0])) as Record<MeasurementRequestResult, number>,
      firstEvidenceId: evidenceId,
    };
    drafts.set(key, draft);
    return draft;
  };

  const add = (
    url: string,
    observed: { readonly pageId: PageId; readonly viewport: ViewportProfile | null; readonly evidenceId: EvidenceId },
    kind: { readonly method: string; readonly resourceType: string },
    result: MeasurementRequestResult,
    count: number,
  ): void => {
    const match = measurementTagOf(url);
    if (match === null || count <= 0) {
      return;
    }
    const draft = draftOf(match.service, match.tagId, observed.evidenceId);
    if (!draft.pageIds.includes(observed.pageId)) {
      draft.pageIds.push(observed.pageId);
    }
    if (observed.viewport !== null) {
      draft.viewports.add(observed.viewport);
    }
    draft.requestCount += count;
    const kindKey = JSON.stringify([kind.method, kind.resourceType]);
    const knownKind = draft.requestKinds.get(kindKey) ?? { method: kind.method, resourceType: kind.resourceType, count: 0 };
    knownKind.count += count;
    draft.requestKinds.set(kindKey, knownKind);
    draft.results[result] += count;
  };

  return {
    addPage: (page, earlier) => {
      const records = page.evidence.filter((record) => !earlier.has(record.evidenceId));
      const blocked = new Set<string>();
      for (const record of records) {
        if (record.type !== 'safety') {
          continue;
        }
        for (const event of [...record.payload.blockedRequests, ...record.payload.blockedInteractionRequests]) {
          blocked.add(blockKeyOf(record.viewport, event.method, event.url));
          blockedRequestCount += isMeasurementServiceHostUrl(event.url) ? 1 : 0;
        }
      }
      for (const record of records) {
        if (record.type !== 'network') {
          continue;
        }
        const { payload, viewport } = record;
        const observed = { pageId: page.pageId, viewport, evidenceId: record.evidenceId };
        const responses = new Map(payload.responses.map((value) => [value.requestId, value]));
        const failures = new Map(payload.failures.map((value) => [value.requestId, value]));
        const listed = new Set<string>();
        for (const request of payload.requests) {
          listed.add(request.requestId);
          const responded = responses.get(request.requestId);
          const failure = failures.get(request.requestId);
          const result: MeasurementRequestResult = responded !== undefined
            ? statusResultOf(responded.status)
            : failure === undefined
              ? 'NO_RESPONSE'
              : failure.blockedByBeakSight || blocked.has(blockKeyOf(viewport, request.method, request.url)) ? 'BLOCKED' : 'REQUEST_FAILED';
          add(request.url, observed, request, result, 1);
        }
        for (const repeated of payload.repeatedReads ?? []) {
          // 最初の 1 件が `requests` にあれば、残りの分だけを足す。
          add(repeated.first.url, observed, repeated, statusResultOf(repeated.status), listed.has(repeated.firstRequestId) ? repeated.count - 1 : repeated.count);
        }
      }
    },
    result: (locationOf, limits) => {
      const tags = [...drafts.values()].map((draft): MeasurementTagView => {
        const location = locationOf(draft.firstEvidenceId);
        return {
          service: draft.service,
          group: MEASUREMENT_SERVICE_GROUP_OF[draft.service],
          tagId: draft.tagId,
          pageIds: [...draft.pageIds],
          pageCount: draft.pageIds.length,
          viewports: Object.fromEntries(VIEWPORT_PROFILES.map((viewport) => [viewport, draft.viewports.has(viewport)])) as Record<ViewportProfile, boolean>,
          requestCount: draft.requestCount,
          requestKinds: [...draft.requestKinds.values()].map(({ method, resourceType, count }) => ({ method, resourceType, count })),
          results: { ...draft.results },
          evidence: location === null
            ? null
            : { evidenceId: location.evidenceId, pageId: location.pageId, viewport: location.viewport, path: location.path, pointer: location.pointer },
          source: 'NETWORK_REQUEST',
        };
      });
      const countsByGroup = Object.fromEntries(MEASUREMENT_SERVICE_GROUPS.map((group) => [group, tags.filter((tag) => tag.group === group).length])) as Record<
        MeasurementServiceGroup,
        number
      >;
      return { tags, countsByGroup, limits: { ...limits, blockedRequestCount } };
    },
  };
}
