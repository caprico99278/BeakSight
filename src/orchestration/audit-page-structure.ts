/**
 * COV-4（網羅の設計書 `doc/design/2026-11-09-beaksight-coverage-by-state-design.md` 3.1 の 2・3.2）: 見るだけの点検で読んだページの、構造の鍵と辺（巡回の待ち行列
 * `CrawlFrontier.completePage` の入力）。
 * - 設計者の判断（2026-11-10）: 構造の鍵は、監査の段がもう集めた記録から `stateStructureKeyOf` の入力を組む（要求とページの中の読み取りは増やさない）。発見の側の
 *   構造の鍵と同じ値でなくてよい。欄の名前の型と path の型は、`stateStructureKeyOf` の中の共通の部品が作る。
 *   - 使う記録: Desktop の最終の試行の DOM の Evidence（確かめ直しの段のものは除く）。見出しの段、区分（landmark）、form の欄、見える文字の状態の語。
 *   - 持たない事実（`null`。欠けとして鍵に入る）: 候補の識別（見るだけの点検の操作の候補は、区切り 3 で入れる）、開いた窓・区画。欄の無効（記録にないので偽）・
 *     選択肢（記録にないので `null`）。
 *   - DOM の記録のないページ（読めなかった）は `UNREAD_PAGE_STRUCTURE_KEY`。
 * - 辺: 各ビューポートの Link の Evidence の、巡回で移るリンク（`crawlableLinkUrlsOf`）と、同じ Origin の子の frame の文書（`frames`）。
 * - DUP（ユーザーの判断 2026-11-18）: 同じ作りの画面を見分ける作りの鍵（`auditPageTemplateKeyOf`。データを抜いた形）と中身の要約（`auditPageContentDigestOf`）も
 *   ここで作る。Page Auditor が Desktop の layout の後に読む。
 */
import type { PageAuditResult } from '../core/contracts.js';
import type { CollectedDomEvidence, DomEvidence, FormFieldEvidence, LayoutEvidence, SemanticRegionKind } from '../core/evidence-types.js';
import { createSha256Fingerprint } from '../core/ids.js';
import { foldNfkcCase } from '../core/text.js';
import { crawlableLinkUrlsOf } from '../crawl/internal-navigable-links.js';
import { normalizeUrl } from '../crawl/normalize-url.js';
import { dataFreePathOf, dataFreeQueryItemsOf } from '../discovery/fingerprint.js';
import { STATE_WORDS, stateStructureKeyOf, type StateLandmarkRole } from '../discovery/state-keys.js';
import type { InteractionCandidate } from '../safety/interaction-policy.js';
import { UNREAD_PAGE_STRUCTURE_KEY, type CrawlPageEdge, type CrawlPageOutcome } from './crawl-frontier.js';

/** 区分の種類から landmark の role（`other` は landmark でない）。 */
const LANDMARK_ROLE_OF_REGION: Readonly<Record<SemanticRegionKind, StateLandmarkRole | null>> = Object.freeze({
  header: 'banner',
  navigation: 'navigation',
  main: 'main',
  aside: 'complementary',
  footer: 'contentinfo',
  form: 'form',
  other: null,
});

/** ページの結果の、Desktop の最終の DOM の記録（確かめ直しの段のものは除く。なければ `null`）。 */
const desktopDomOf = (result: PageAuditResult): DomEvidence | null => {
  // 再試行の前の試行の記録は前に並ぶので、最後のものを使う。
  let found: DomEvidence | null = null;
  for (const record of result.evidence) {
    if (record.type === 'dom' && record.viewport === 'desktop' && record.capture?.phase !== 'recheck') {
      found = record.payload;
    }
  }
  return found;
};

/**
 * URL の path と query の名前（解析できなければ `null`）。DUP: `dataFree` なら、データを抜いた path と query の項目（`dataFreePathOf`・`dataFreeQueryItemsOf`）。
 */
const pathAndQueryNamesOf = (url: string, dataFree = false): { readonly path: string; readonly queryNames: readonly string[] } | null => {
  try {
    const parsed = new URL(url);
    return dataFree
      ? { path: dataFreePathOf(parsed.pathname), queryNames: dataFreeQueryItemsOf(parsed.searchParams) }
      : { path: parsed.pathname, queryNames: [...new Set(parsed.searchParams.keys())] };
  } catch {
    return null;
  }
};

/**
 * DOM の記録と URL から、構造の鍵を作る（ページと開いた状態の共通の組み立て）。候補の識別は、操作の候補の ID（`candidateId`）の集合を digest にして入れる
 * （設計者の判断 2026-11-10。分からなければ `null`）。`visibleFieldsOnly` が真なら、見えている入力欄だけを入れる（開いた状態は、隠れていた入力欄が見えるように
 * なったら別の構造にする。入れ子の区画を見落とさない）。
 */
function structureKeyOfDom(
  dom: DomEvidence,
  url: string,
  facts: {
    readonly openedDialogOrRegion: boolean | null;
    readonly candidateIds: readonly string[] | null;
    readonly visibleFieldsOnly?: boolean;
    /** DUP: path と query を、データを抜いた形にする（作りの鍵）。 */
    readonly dataFree?: boolean;
  },
): string {
  const location = pathAndQueryNamesOf(url, facts.dataFree === true);
  const text = foldNfkcCase(dom.visibleText.text);
  const fields = [...dom.forms.flatMap((form) => form.fields), ...dom.unassociatedFields]
    .filter((field) => facts.visibleFieldsOnly !== true || field.visible);
  return stateStructureKeyOf({
    path: location?.path ?? null,
    queryNames: location?.queryNames ?? null,
    candidateIdentityDigests: facts.candidateIds === null ? null : [...new Set(facts.candidateIds)].map((id) => createSha256Fingerprint(id)),
    fields: fields.map((field) => ({ name: field.name, type: field.type, required: field.required, disabled: false, optionValues: null })),
    openedDialogOrRegion: facts.openedDialogOrRegion,
    headingLevels: dom.headings.map(({ level }) => level),
    landmarkRoles: dom.visibleText.regions.flatMap(({ kind }) => {
      const role = LANDMARK_ROLE_OF_REGION[kind];
      return role === null ? [] : [role];
    }),
    stateWords: STATE_WORDS.filter((word) => text.includes(foldNfkcCase(word))),
  });
}

/** 読んだページの構造の鍵（ファイルの先頭の説明。候補の識別は、Desktop の操作の記録の候補の ID。操作の記録がなければ `null`）。 */
export function auditPageStructureKeyOf(result: PageAuditResult): string {
  const dom = desktopDomOf(result);
  if (dom === null) {
    return UNREAD_PAGE_STRUCTURE_KEY;
  }
  const candidateIds = result.evidence.flatMap((record) =>
    (record.type === 'interaction' && record.viewport === 'desktop' ? [record.payload.candidateId] : []));
  return structureKeyOfDom(dom, result.pageUrl, { openedDialogOrRegion: null, candidateIds: candidateIds.length === 0 ? null : candidateIds });
}

/**
 * COV-4 の区切り 3: 操作で開いた状態の構造の鍵（ページの構造の鍵の入力に、開いた窓・区画があることと、押した候補の識別を足したもの）。同じ鍵の状態は、Run の
 * 全体で 1 回だけ監査する（見た鍵の集合は `CrawlFrontier.acceptOpenedStructure`）。
 */
export function openedStateStructureKeyOf(dom: DomEvidence, url: string, pressedCandidateIds: readonly string[]): string {
  return structureKeyOfDom(dom, url, { openedDialogOrRegion: true, candidateIds: pressedCandidateIds, visibleFieldsOnly: true });
}

/** DUP: 候補の形の入力の形の印（版つき）。 */
const CANDIDATE_SHAPE_FORMAT = 'beaksight-audit-candidate-shape/1';
/** DUP: 中身の要約の入力の形の印（版つき）。 */
const PAGE_CONTENT_DIGEST_FORMAT = 'beaksight-audit-page-content/1';

/** DUP: データを抜いた URL の path と query の項目（`dataFreePathOf`・`dataFreeQueryItemsOf`。解析できなければ `null`）。 */
const urlShapeOf = (url: string | null): unknown => {
  if (url === null) {
    return null;
  }
  try {
    const parsed = new URL(url);
    return [dataFreePathOf(parsed.pathname), dataFreeQueryItemsOf(parsed.searchParams)];
  } catch {
    return null;
  }
};

/**
 * DUP: データを抜いた候補の形（名前・文字・番号・開いた状態・制御する要素の ID は入れない）。行き先は、同じ Origin の http だけ形を入れ、特別な scheme
 * （`tel:` など）と外のサイトは種類（`hrefKind`）だけにする（REV-DUP の I-2。電話番号や外のサイトの行き先は、データで変わる）。
 */
const candidateShapeOf = (candidate: InteractionCandidate): string => JSON.stringify([
  CANDIDATE_SHAPE_FORMAT,
  candidate.tagName,
  candidate.role,
  candidate.type,
  candidate.hrefKind,
  candidate.hrefKind === 'SAME_ORIGIN_HTTP' ? urlShapeOf(candidate.href) : null,
  candidate.formAssociated,
  candidate.formMethod,
  urlShapeOf(candidate.formAction),
  candidate.download,
  candidate.destructiveAction,
  candidate.disabled,
  candidate.visible,
]);

/**
 * DUP（ユーザーの判断 2026-11-18）: 作りの鍵。Desktop の DOM と URL と Interaction の候補から、データを抜いた形で作る（構造の鍵の部品 `stateStructureKeyOf` を
 * 使う。候補の識別は、名前・文字・番号の違いでは変わらない形 `candidateShapeOf`）。同じ作りでデータだけが違う画面で同じになる。
 */
export function auditPageTemplateKeyOf(dom: DomEvidence, url: string, candidates: readonly InteractionCandidate[]): string {
  return structureKeyOfDom(dom, url, { openedDialogOrRegion: null, candidateIds: candidates.map(candidateShapeOf), dataFree: true });
}

/**
 * DUP: 中身の要約。表示の中身（題名・見える文字・見出し・画像・欄と、見えている欄の値の digest・送信のボタン）と、layout のあらまし（文書の大きさ・指摘の
 * 対象）の digest。リンクの行き先（href）は入れない（戻り先の query だけが違う画面を同じにする）。layout がなければ `null`（比べられない）。欄の値の digest は、
 * 集めた DOM の Evidence だけが持つ（記録には残さない。`CollectedDomEvidence`）。
 */
export function auditPageContentDigestOf(dom: CollectedDomEvidence, layout: LayoutEvidence | null): string | null {
  if (layout === null) {
    return null;
  }
  const fieldOf = (field: FormFieldEvidence): unknown => [field.type, field.name, field.required, field.visible, field.labels];
  const { document } = layout;
  return createSha256Fingerprint(JSON.stringify([
    PAGE_CONTENT_DIGEST_FORMAT,
    dom.title,
    dom.visibleText.text,
    dom.visibleText.ariaHiddenText,
    dom.headings.map(({ level, text }) => [level, text]),
    dom.images.map((image) => [image.resolvedUrl ?? image.src, image.alt, image.naturalWidth, image.naturalHeight]),
    dom.forms.map((form) => [form.method, form.fields.map(fieldOf), form.submitControls.map(({ type, name, value, text }) => [type, name, value, text])]),
    dom.unassociatedFields.map(fieldOf),
    dom.fieldValuesDigest ?? null,
    [
      document.documentElementScrollWidth, document.documentElementScrollHeight, document.bodyScrollWidth, document.bodyScrollHeight,
      document.horizontalOverflowPx,
    ],
    layout.boxesOutsideViewport.map(({ selector }) => selector),
    layout.zeroSizeInteractive.map(({ selector }) => selector),
    layout.clippedText.map(({ selector, text }) => [selector, text]),
    layout.fixedHeadingOverlaps,
    layout.elementOverlaps,
  ]));
}

/** COV-4 の区切り 3: 操作の後の URL が、ページの URL と比べて path が違えば SPA の経路、query だけが違えば query の変化（同じなら辺にしない）。 */
const interactionEdgeOf = (pageUrl: string, postInteractionUrl: string): CrawlPageEdge | null => {
  const normalized = normalizeUrl(postInteractionUrl, pageUrl, NO_SELECTED_QUERY_NAMES);
  if (!normalized.ok || normalized.url === pageUrl) {
    return null;
  }
  // 受け入れ（許可 Origin の中か）は、巡回の待ち行列に渡す前に、受け入れの判定の唯一の入口（`classifyUrl`）で行う（Run Coordinator）。
  try {
    return { kind: new URL(pageUrl).pathname === new URL(normalized.url).pathname ? 'QUERY_CHANGE' : 'SPA_ROUTE', url: normalized.url };
  } catch {
    return null;
  }
};

/** 残す query の名前を選ばない正規化（L14: 追跡と秘密に見える名前のほかは全部残す）。 */
const NO_SELECTED_QUERY_NAMES: ReadonlySet<string> = new Set();

/**
 * 読んだページの事実（構造の鍵と辺。辺は、記録の順に、各ビューポートのリンクの記録のリンクと frame、操作の記録の操作の後の URL。重なりは待ち行列が除く）。
 * L5 の N5: Mobile のビューポートのリンクの記録も辺にする（Mobile にだけある導線を見落とさない）。COV-4 の区切り 3: 操作で文書が替わらずに URL が変わったら、
 * SPA の経路か query の変化の辺にする。
 */
export function auditPageOutcomeOf(result: PageAuditResult): CrawlPageOutcome {
  const edges: CrawlPageEdge[] = [];
  for (const record of result.evidence) {
    if (record.type === 'link') {
      // SD-1（設計書 2026-11-16 2.3）: 削除の語のリンク（文字か URL）へは移らない（`crawlableLinkUrlsOf`）。
      edges.push(...crawlableLinkUrlsOf(record.payload.links).map((url): CrawlPageEdge => ({ kind: 'LINK', url })));
      edges.push(...(record.payload.frames ?? []).map((url): CrawlPageEdge => ({ kind: 'FRAME', url })));
    } else if (record.type === 'interaction' && record.payload.postInteractionUrl !== undefined) {
      const edge = interactionEdgeOf(result.pageUrl, record.payload.postInteractionUrl);
      if (edge !== null) {
        edges.push(edge);
      }
    }
  }
  return { structureKey: auditPageStructureKeyOf(result), edges };
}
