import type {
  EvidenceId,
  EvidenceRecordFor,
  FindingCategory,
  Severity,
} from '../core/contracts.js';
import type {
  FormFieldEvidence,
  NetworkEvidence,
  NetworkRequestEvidence,
  NetworkResponseEvidence,
  RequestOriginFlags,
} from '../core/evidence-types.js';
import type { FindingFingerprintIdentityField } from '../core/ids.js';
import { compareCodeUnits, normalizeWhitespace } from '../core/text.js';
import { normalizeUrl } from '../crawl/normalize-url.js';
import { listText } from '../presentation/messages.js';
import type { AuditRule, FindingDraft, PageRuleInput } from './rule.js';
import {
  CLIENT_ERROR_HTTP_STATUS_RANGE,
  SERVER_ERROR_HTTP_STATUS_RANGE,
  SUCCESS_HTTP_STATUS_RANGE,
  distinctSorted,
  evidenceOfType,
  isHttpStatusInRange,
  type HttpStatusRange,
} from './rule-helpers.js';

// ---------------------------------------------------------------------------------------------------------------
// 判定に使う定数（設計書 Task 12・13 の 5.1）
// ---------------------------------------------------------------------------------------------------------------

// HTTP のステータスの範囲は、`rule-helpers.ts` の定数を使う（Cross-page rule と共有する）。`EMPTY_HTTP_RESPONSE` の対象は 2xx。
/** 本文が空とみなす、観測した本文のバイト数。 */
const EMPTY_BODY_BYTES = 0;
/** 読み込みに失敗したとみなす、`complete` な画像の `naturalWidth`。 */
const FAILED_IMAGE_NATURAL_WIDTH = 0;
/** Playwright の `Request.resourceType()` のうち、script・stylesheet・画像を表す値。 */
const SCRIPT_RESOURCE_TYPE = 'script';
const STYLESHEET_RESOURCE_TYPE = 'stylesheet';
const IMAGE_RESOURCE_TYPE = 'image';
/**
 * canonical の href の正規化に渡す、残す query のパラメータ（Rule の入力には設定がないため、空にする）。
 * query を残すかどうかは、正規化できるかどうかに影響しない（残さない方が URL は短くなる）。
 */
const CANONICAL_ALLOWED_QUERY_PARAMETERS: ReadonlySet<string> = Object.freeze(new Set<string>());

/** この版の判定。判定を変えたら、その Rule の版を上げる。 */
const INITIAL_RULE_VERSION = 1;

// ---------------------------------------------------------------------------------------------------------------
// Rule の組み立て
// ---------------------------------------------------------------------------------------------------------------

/** Rule が見つけた1件の事実（下書きのうち、Rule ごとに変わる部分）。 */
interface Detection {
  readonly message: string;
  readonly evidenceRefs: readonly EvidenceId[];
  readonly identityFields: readonly FindingFingerprintIdentityField[];
}

interface TechnicalRuleSpec {
  readonly ruleId: string;
  readonly category: FindingCategory;
  readonly severity: Severity;
  readonly detect: (input: PageRuleInput) => readonly Detection[];
}

const defineRule = (spec: TechnicalRuleSpec): AuditRule => ({
  ruleId: spec.ruleId,
  version: INITIAL_RULE_VERSION,
  category: spec.category,
  severity: spec.severity,
  evaluate: (input: PageRuleInput): readonly FindingDraft[] =>
    spec.detect(input).map((detection): FindingDraft => ({
      ruleId: spec.ruleId,
      ruleVersion: INITIAL_RULE_VERSION,
      category: spec.category,
      severity: spec.severity,
      message: detection.message,
      evidenceRefs: detection.evidenceRefs,
      identityFields: detection.identityFields,
    })),
});

/** 同じ対象（キー）の事実を1件にまとめるための入れ物。Evidence の参照と、文言に使う値を集める。 */
class DetectionGroups<TFact> {
  readonly #groups = new Map<string, { evidenceRefs: Set<EvidenceId>; facts: TFact[] }>();

  add(key: string, evidenceRef: EvidenceId, fact: TFact): void {
    let group = this.#groups.get(key);
    if (group === undefined) {
      group = { evidenceRefs: new Set<EvidenceId>(), facts: [] };
      this.#groups.set(key, group);
    }
    group.evidenceRefs.add(evidenceRef);
    group.facts.push(fact);
  }

  /** キーのコード単位の順に、まとめた事実を Detection にする（入力の順序に依存させない）。 */
  toDetections(
    build: (key: string, facts: readonly TFact[]) => Omit<Detection, 'evidenceRefs'>,
  ): readonly Detection[] {
    return [...this.#groups.entries()]
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, group]) => ({ ...build(key, group.facts), evidenceRefs: [...group.evidenceRefs] }));
  }
}

/** メインフレームのナビゲーション（iframe の文書、サブリソース、フレームの分からないものは除く）。 */
const isMainFrameNavigation = (flags: RequestOriginFlags): boolean =>
  flags.isNavigationRequest && flags.isMainFrame === true;

const formatStatus = (response: NetworkResponseEvidence): string =>
  response.statusText.length > 0 ? `${response.status} ${response.statusText}` : String(response.status);

// ---------------------------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------------------------

/** メインフレームのナビゲーション応答のうち、ステータスが範囲にあるものを、URL ごとに1件にまとめる。 */
const detectMainFrameStatus = (
  input: PageRuleInput,
  range: HttpStatusRange,
): readonly Detection[] => {
  const groups = new DetectionGroups<string>();
  for (const record of evidenceOfType(input, 'network')) {
    for (const response of record.payload.responses) {
      if (isMainFrameNavigation(response) && isHttpStatusInRange(response.status, range)) {
        groups.add(response.url, record.evidenceId, formatStatus(response));
      }
    }
  }
  return groups.toDetections((url, statuses) => ({
    message: `ページのナビゲーションの応答が HTTP ステータス ${listText(distinctSorted(statuses))} でした（URL: ${url}）。`,
    identityFields: [{ name: 'url', value: url }],
  }));
};

const HTTP_4XX = defineRule({
  ruleId: 'HTTP_4XX',
  category: 'HTTP',
  severity: 'ERROR',
  detect: (input) => detectMainFrameStatus(input, CLIENT_ERROR_HTTP_STATUS_RANGE),
});

const HTTP_5XX = defineRule({
  ruleId: 'HTTP_5XX',
  category: 'HTTP',
  severity: 'ERROR',
  detect: (input) => detectMainFrameStatus(input, SERVER_ERROR_HTTP_STATUS_RANGE),
});

/**
 * メインフレームのナビゲーションのリダイレクトの連鎖を、連鎖の最初のリクエストごとに、最も長く観測したものにまとめる。
 * 連鎖は、リダイレクトの前のリクエスト（`redirectChainRequestIds`）と、そのリクエスト自身の、URL の並び。
 * 上限で記録しなかったリクエストは、並びに含められない。
 */
const mainFrameRedirectChains = (network: NetworkEvidence): readonly (readonly NetworkRequestEvidence[])[] => {
  const requestsById = new Map(network.requests.map((request) => [request.requestId, request]));
  const longestByRoot = new Map<string, readonly NetworkRequestEvidence[]>();
  for (const request of network.requests) {
    if (!isMainFrameNavigation(request)) {
      continue;
    }
    const chainIds = [...request.redirectChainRequestIds, request.requestId];
    const chain = chainIds
      .map((requestId) => requestsById.get(requestId))
      .filter((entry): entry is NetworkRequestEvidence => entry !== undefined);
    const root = chainIds[0] ?? request.requestId;
    const known = longestByRoot.get(root);
    if (known === undefined || chain.length > known.length) {
      longestByRoot.set(root, chain);
    }
  }
  return [...longestByRoot.values()];
};

/** 連鎖の中で最初に再び現れた URL。切り詰めた URL は、別の URL と取り違えるおそれがあるので比べない。 */
const firstRepeatedUrl = (chain: readonly NetworkRequestEvidence[]): string | null => {
  const seen = new Set<string>();
  for (const request of chain) {
    if (request.truncated) {
      continue;
    }
    if (seen.has(request.url)) {
      return request.url;
    }
    seen.add(request.url);
  }
  return null;
};

const REDIRECT_LOOP = defineRule({
  ruleId: 'REDIRECT_LOOP',
  category: 'HTTP',
  severity: 'ERROR',
  detect: (input) => {
    const groups = new DetectionGroups<Readonly<{ firstUrl: string; length: number }>>();
    for (const record of evidenceOfType(input, 'network')) {
      for (const chain of mainFrameRedirectChains(record.payload)) {
        const repeatedUrl = firstRepeatedUrl(chain);
        const firstUrl = chain[0]?.url;
        if (repeatedUrl !== null && firstUrl !== undefined) {
          groups.add(repeatedUrl, record.evidenceId, { firstUrl, length: chain.length });
        }
      }
    }
    return groups.toDetections((repeatedUrl, facts) => ({
      message: `ページのナビゲーションのリダイレクトの連鎖に、同じ URL が再び現れました（URL: ${repeatedUrl}、`
        + `連鎖の最初の URL: ${listText(distinctSorted(facts.map((fact) => fact.firstUrl)))}、`
        + `観測した連鎖のリクエスト数: ${listText(distinctSorted(facts.map((fact) => String(fact.length))))}）。`,
      identityFields: [{ name: 'url', value: repeatedUrl }],
    }));
  },
});

const EMPTY_HTTP_RESPONSE = defineRule({
  ruleId: 'EMPTY_HTTP_RESPONSE',
  category: 'HTTP',
  severity: 'ERROR',
  detect: (input) => {
    const groups = new DetectionGroups<string>();
    for (const record of evidenceOfType(input, 'network')) {
      for (const response of record.payload.responses) {
        if (
          isMainFrameNavigation(response)
          && isHttpStatusInRange(response.status, SUCCESS_HTTP_STATUS_RANGE)
          && response.transferSize.status === 'OBSERVED'
          && response.transferSize.bodyBytes === EMPTY_BODY_BYTES
        ) {
          groups.add(response.url, record.evidenceId, formatStatus(response));
        }
      }
    }
    return groups.toDetections((url, statuses) => ({
      message: `ページのナビゲーションの応答が HTTP ステータス ${listText(distinctSorted(statuses))} で、`
        + `本文の大きさが ${EMPTY_BODY_BYTES} バイトと観測されました（URL: ${url}）。`,
      identityFields: [{ name: 'url', value: url }],
    }));
  },
});

// ---------------------------------------------------------------------------------------------------------------
// LINK
// ---------------------------------------------------------------------------------------------------------------

/**
 * 受け入れなかったリンクを、内部とみなすか。ページの URL を基準に解析でき、Origin がページと異なるものは、外部とみなす。
 * 解析できないもの（Origin が分からないもの）は、外部と確かめられないので、内部とみなす。
 */
const isRejectedLinkInternal = (rawUrl: string, pageUrl: string): boolean => {
  try {
    return new URL(rawUrl, pageUrl).origin === new URL(pageUrl).origin;
  } catch {
    return true;
  }
};

const INVALID_INTERNAL_URL = defineRule({
  ruleId: 'INVALID_INTERNAL_URL',
  category: 'LINK',
  severity: 'WARN',
  detect: (input) => {
    const groups = new DetectionGroups<string>();
    for (const record of evidenceOfType(input, 'link')) {
      for (const link of record.payload.links) {
        const { admission } = link;
        if (admission.kind === 'REJECTED_INVALID' && isRejectedLinkInternal(admission.rawUrl, input.pageUrl)) {
          groups.add(admission.rawUrl, record.evidenceId, admission.reason);
        }
      }
    }
    return groups.toDetections((rawUrl, reasons) => ({
      message: `リンクの href を正規化できないため、内部リンクとして扱えません（href: ${rawUrl}、理由: ${listText(distinctSorted(reasons))}）。`,
      identityFields: [{ name: 'href', value: rawUrl }],
    }));
  },
});

const UNSUPPORTED_URL_SCHEME = defineRule({
  ruleId: 'UNSUPPORTED_URL_SCHEME',
  category: 'LINK',
  severity: 'INFO',
  detect: (input) => {
    const groups = new DetectionGroups<string>();
    for (const record of evidenceOfType(input, 'link')) {
      for (const link of record.payload.links) {
        const { admission } = link;
        if (admission.kind === 'SPECIAL_SCHEME_RECORD_ONLY') {
          groups.add(admission.rawUrl, record.evidenceId, admission.scheme);
        }
      }
    }
    return groups.toDetections((rawUrl, schemes) => ({
      message: `http・https 以外の scheme（${listText(distinctSorted(schemes))}）のリンクがあります（href: ${rawUrl}、`
        + `${schemes.length} 件）。事実の記録で、リンク先は開いていません。`,
      identityFields: [{ name: 'href', value: rawUrl }],
    }));
  },
});

// ---------------------------------------------------------------------------------------------------------------
// RESOURCE
// ---------------------------------------------------------------------------------------------------------------

/** メインフレームのナビゲーション以外の応答（サブリソースと iframe の文書）のうち、ステータスが範囲にあるもの。 */
const detectResourceStatus = (
  input: PageRuleInput,
  range: HttpStatusRange,
): readonly Detection[] => {
  const groups = new DetectionGroups<Readonly<{ status: string; resourceType: string | null }>>();
  for (const record of evidenceOfType(input, 'network')) {
    const resourceTypes = new Map(
      record.payload.requests.map((request) => [request.requestId, request.resourceType]),
    );
    for (const response of record.payload.responses) {
      if (!isMainFrameNavigation(response) && isHttpStatusInRange(response.status, range)) {
        groups.add(response.url, record.evidenceId, {
          status: formatStatus(response),
          resourceType: resourceTypes.get(response.requestId) ?? null,
        });
      }
    }
  }
  return groups.toDetections((url, facts) => {
    const resourceTypes = facts.flatMap((fact) => (fact.resourceType === null ? [] : [fact.resourceType]));
    const typeText = resourceTypes.length === 0 ? '' : `、種類: ${listText(distinctSorted(resourceTypes))}`;
    return {
      message: `資源の応答が HTTP ステータス ${listText(distinctSorted(facts.map((fact) => fact.status)))} でした（URL: ${url}${typeText}）。`,
      identityFields: [{ name: 'url', value: url }],
    };
  });
};

const RESOURCE_4XX = defineRule({
  ruleId: 'RESOURCE_4XX',
  category: 'RESOURCE',
  severity: 'ERROR',
  detect: (input) => detectResourceStatus(input, CLIENT_ERROR_HTTP_STATUS_RANGE),
});

const RESOURCE_5XX = defineRule({
  ruleId: 'RESOURCE_5XX',
  category: 'RESOURCE',
  severity: 'ERROR',
  detect: (input) => detectResourceStatus(input, SERVER_ERROR_HTTP_STATUS_RANGE),
});

/** 読み込みの失敗（requestfailed）のうち、指定した種類の資源のものを、URL ごとに1件にまとめる。 */
const detectLoadFailures = (input: PageRuleInput, resourceType: string, label: string): readonly Detection[] => {
  const groups = new DetectionGroups<string>();
  for (const record of evidenceOfType(input, 'network')) {
    for (const failure of record.payload.failures) {
      if (failure.resourceType === resourceType) {
        groups.add(failure.url, record.evidenceId, failure.errorText);
      }
    }
  }
  return groups.toDetections((url, errorTexts) => ({
    message: `${label} の読み込みに失敗しました（URL: ${url}、エラー: ${listText(distinctSorted(errorTexts))}）。`,
    identityFields: [{ name: 'url', value: url }],
  }));
};

const SCRIPT_LOAD_FAILED = defineRule({
  ruleId: 'SCRIPT_LOAD_FAILED',
  category: 'RESOURCE',
  severity: 'ERROR',
  detect: (input) => detectLoadFailures(input, SCRIPT_RESOURCE_TYPE, 'script'),
});

const STYLESHEET_LOAD_FAILED = defineRule({
  ruleId: 'STYLESHEET_LOAD_FAILED',
  category: 'RESOURCE',
  severity: 'ERROR',
  detect: (input) => detectLoadFailures(input, STYLESHEET_RESOURCE_TYPE, 'stylesheet'),
});

const IMAGE_LOAD_FAILED = defineRule({
  ruleId: 'IMAGE_LOAD_FAILED',
  category: 'RESOURCE',
  severity: 'ERROR',
  detect: (input) => {
    const groups = new DetectionGroups<string>();
    for (const record of evidenceOfType(input, 'network')) {
      for (const failure of record.payload.failures) {
        if (failure.resourceType === IMAGE_RESOURCE_TYPE) {
          groups.add(failure.url, record.evidenceId, `読み込みの失敗: ${failure.errorText}`);
        }
      }
    }
    for (const record of evidenceOfType(input, 'dom')) {
      for (const image of record.payload.images) {
        if (image.resolvedUrl !== null && image.complete && image.naturalWidth === FAILED_IMAGE_NATURAL_WIDTH) {
          groups.add(
            image.resolvedUrl,
            record.evidenceId,
            `complete: true、naturalWidth: ${image.naturalWidth}、naturalHeight: ${image.naturalHeight}`,
          );
        }
      }
    }
    return groups.toDetections((url, facts) => ({
      message: `画像の読み込みに失敗しました（URL: ${url}、観測: ${listText(distinctSorted(facts))}）。`,
      identityFields: [{ name: 'url', value: url }],
    }));
  },
});

// ---------------------------------------------------------------------------------------------------------------
// JAVASCRIPT
// ---------------------------------------------------------------------------------------------------------------

/**
 * 捕捉されない例外（pageerror）を、同じ message・source・stack のものを1つにまとめる。
 * pageerror の Evidence は source を別に持たず、stack が source（URL と行・列）を含むので、name・message・stack で比べる。
 */
const PAGE_ERROR = defineRule({
  ruleId: 'PAGE_ERROR',
  category: 'JAVASCRIPT',
  severity: 'ERROR',
  detect: (input) => {
    const groups = new DetectionGroups<Readonly<{ name: string; message: string; stack: string }>>();
    for (const record of evidenceOfType(input, 'console')) {
      for (const pageError of record.payload.pageErrors) {
        const fact = { name: pageError.name, message: pageError.message, stack: pageError.stack ?? '' };
        groups.add(JSON.stringify([fact.name, fact.message, fact.stack]), record.evidenceId, fact);
      }
    }
    return groups.toDetections((_key, facts) => {
      const [fact] = facts;
      const name = fact?.name ?? '';
      const message = fact?.message ?? '';
      const stack = fact?.stack ?? '';
      const title = name.length > 0 ? `${name}: ${message}` : message;
      return {
        message: `捕捉されない例外が発生しました（${title}、発生回数: ${facts.length}）。`,
        identityFields: [
          { name: 'errorName', value: name },
          { name: 'errorMessage', value: message },
          { name: 'stack', value: stack },
        ],
      };
    });
  },
});

// ---------------------------------------------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------------------------------------------

const isBlank = (value: string): boolean => normalizeWhitespace(value).length === 0;

/** DOM の Evidence ごとに、条件に当たれば1件の事実を作る。 */
const detectPerDom = (
  input: PageRuleInput,
  judge: (dom: EvidenceRecordFor<'dom'>['payload']) => string | null,
): readonly Detection[] =>
  evidenceOfType(input, 'dom').flatMap((record): Detection[] => {
    const message = judge(record.payload);
    return message === null ? [] : [{ message, evidenceRefs: [record.evidenceId], identityFields: [] }];
  });

const MISSING_TITLE = defineRule({
  ruleId: 'MISSING_TITLE',
  category: 'DOM',
  severity: 'WARN',
  detect: (input) => detectPerDom(input, (dom) => (dom.title === null ? '<title> 要素がありません。' : null)),
});

const EMPTY_TITLE = defineRule({
  ruleId: 'EMPTY_TITLE',
  category: 'DOM',
  severity: 'WARN',
  detect: (input) => detectPerDom(input, (dom) => (
    dom.title !== null && isBlank(dom.title) ? '<title> 要素の内容が、空か空白だけです。' : null
  )),
});

const MISSING_HTML_LANG = defineRule({
  ruleId: 'MISSING_HTML_LANG',
  category: 'DOM',
  severity: 'WARN',
  detect: (input) => detectPerDom(input, (dom) => {
    if (dom.lang === null) {
      return '<html> 要素に lang 属性がありません。';
    }
    return isBlank(dom.lang) ? '<html> 要素の lang 属性が、空か空白だけです。' : null;
  }),
});

/** 可視テキストが空で、しかも走査が上限に達していない場合だけ判定する（上限に達していれば、空とは言えない）。 */
const EMPTY_VISIBLE_CONTENT = defineRule({
  ruleId: 'EMPTY_VISIBLE_CONTENT',
  category: 'DOM',
  severity: 'ERROR',
  detect: (input) => detectPerDom(input, (dom) => (
    !dom.visibleText.nodeLimitReached && isBlank(dom.visibleText.text)
      ? 'ページの body に、可視のテキストがありません（テキストの走査は、ノード数の上限に達する前に終わっています）。'
      : null
  )),
});

const DUPLICATE_ELEMENT_ID = defineRule({
  ruleId: 'DUPLICATE_ELEMENT_ID',
  category: 'DOM',
  severity: 'WARN',
  detect: (input) => {
    const groups = new DetectionGroups<number>();
    for (const record of evidenceOfType(input, 'dom')) {
      for (const duplicate of record.payload.duplicateIds) {
        groups.add(duplicate.id, record.evidenceId, duplicate.count);
      }
    }
    return groups.toDetections((id, counts) => ({
      message: `同じ id「${id}」を持つ要素が ${Math.max(...counts)} 個あります。`,
      identityFields: [{ name: 'elementId', value: id }],
    }));
  },
});

/**
 * canonical の href を、URL の正規化（`normalizeUrl`）にかけて、正規化できなければ判定する。相対URLは、ページの URL を基準にする。
 * 長さの上限で切り詰めた canonical は、元の URL と異なり、正規化できるかどうかが分からないので判定しない。
 */
const INVALID_CANONICAL_URL = defineRule({
  ruleId: 'INVALID_CANONICAL_URL',
  category: 'DOM',
  severity: 'WARN',
  detect: (input) => {
    const groups = new DetectionGroups<string>();
    for (const record of evidenceOfType(input, 'dom')) {
      const { canonicalUrl, truncation } = record.payload;
      if (canonicalUrl === null || truncation.documentFields.canonicalUrl) {
        continue;
      }
      const normalized = normalizeUrl(canonicalUrl, input.pageUrl, CANONICAL_ALLOWED_QUERY_PARAMETERS);
      if (!normalized.ok) {
        groups.add(normalized.rawUrl, record.evidenceId, normalized.reason);
      }
    }
    return groups.toDetections((rawUrl, reasons) => ({
      message: `canonical の href を正規化できません（href: ${rawUrl}、理由: ${listText(distinctSorted(reasons))}）。`,
      identityFields: [{ name: 'canonicalUrl', value: rawUrl }],
    }));
  },
});

// ---------------------------------------------------------------------------------------------------------------
// FORM
// ---------------------------------------------------------------------------------------------------------------

/** action 属性がないか空の form。form は送信しない。form の位置（文書の中の順番）で区別する。 */
const FORM_WITHOUT_ACTION = defineRule({
  ruleId: 'FORM_WITHOUT_ACTION',
  category: 'FORM',
  severity: 'INFO',
  detect: (input) => {
    const groups = new DetectionGroups<string>();
    for (const record of evidenceOfType(input, 'dom')) {
      record.payload.forms.forEach((form, formIndex) => {
        if (isBlank(form.action)) {
          groups.add(String(formIndex), record.evidenceId, form.method);
        }
      });
    }
    return groups.toDetections((formIndex, methods) => ({
      message: `action 属性がないか空の form があります（文書の中で ${Number(formIndex) + 1} 番目の form、`
        + `method: ${listText(distinctSorted(methods))}）。事実の記録で、form は送信していません。`,
      identityFields: [{ name: 'formIndex', value: formIndex }],
    }));
  },
});

/** 可視で required の入力欄のうち、label・aria-label・aria-labelledby・title のどれもないもの。 */
const isUnlabeledRequiredControl = (field: FormFieldEvidence): boolean =>
  field.visible
  && field.required
  && field.labels.length === 0
  && !field.hasAriaLabel
  && !field.hasAriaLabelledby
  && !field.hasTitle;

const UNLABELED_REQUIRED_CONTROL = defineRule({
  ruleId: 'UNLABELED_REQUIRED_CONTROL',
  category: 'FORM',
  severity: 'WARN',
  detect: (input) => {
    const groups = new DetectionGroups<Readonly<{ location: string; type: string; name: string }>>();
    const addFields = (
      evidenceRef: EvidenceId,
      fields: readonly FormFieldEvidence[],
      location: string,
      describeLocation: string,
    ): void => {
      fields.forEach((field, fieldIndex) => {
        if (isUnlabeledRequiredControl(field)) {
          groups.add(
            JSON.stringify([location, fieldIndex, field.type, field.name]),
            evidenceRef,
            { location: `${describeLocation}の ${fieldIndex + 1} 番目の入力欄`, type: field.type, name: field.name },
          );
        }
      });
    };
    for (const record of evidenceOfType(input, 'dom')) {
      record.payload.forms.forEach((form, formIndex) => {
        addFields(record.evidenceId, form.fields, `form:${formIndex}`, `文書の中で ${formIndex + 1} 番目の form `);
      });
      addFields(record.evidenceId, record.payload.unassociatedFields, 'unassociated', 'form に属さない入力欄');
    }
    return groups.toDetections((key, facts) => {
      const [fact] = facts;
      return {
        message: `必須の入力欄に、label・aria-label・aria-labelledby・title のどれもありません`
          + `（${fact?.location ?? ''}、type: ${fact?.type ?? ''}、name: ${fact?.name ?? ''}）。`,
        identityFields: [{ name: 'field', value: key }],
      };
    });
  },
});

/** HTTP・LINK・RESOURCE・JAVASCRIPT・DOM・FORM の page rule（T12b）の一覧。登録は `RULE_CATALOG`（`./rule-catalog.ts`）がまとめて行う。 */
export const TECHNICAL_RULES: readonly AuditRule[] = Object.freeze([
  HTTP_4XX,
  HTTP_5XX,
  REDIRECT_LOOP,
  EMPTY_HTTP_RESPONSE,
  INVALID_INTERNAL_URL,
  UNSUPPORTED_URL_SCHEME,
  RESOURCE_4XX,
  RESOURCE_5XX,
  SCRIPT_LOAD_FAILED,
  STYLESHEET_LOAD_FAILED,
  IMAGE_LOAD_FAILED,
  PAGE_ERROR,
  MISSING_TITLE,
  EMPTY_TITLE,
  MISSING_HTML_LANG,
  EMPTY_VISIBLE_CONTENT,
  DUPLICATE_ELEMENT_ID,
  INVALID_CANONICAL_URL,
  FORM_WITHOUT_ACTION,
  UNLABELED_REQUIRED_CONTROL,
]);
