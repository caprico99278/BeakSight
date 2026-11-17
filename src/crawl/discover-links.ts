import type { Page } from 'playwright';
import type { PageId } from '../core/contracts.js';
import type { LinkDiscoveryEvidence, LinkEvidence, NormalizedHttpUrlEvidence } from '../core/evidence-types.js';
import { readInParts } from '../core/read-in-parts.js';
import { normalizeWhitespace } from '../core/text.js';
import { composeInPage, type StandardReaders } from '../browser/in-page-readers.js';
import { classifyUrl, type AdmissionPolicy, type UrlAdmission } from './admission-policy.js';
import { normalizeUrl, redactUrlCredentials, type NormalizedUrlResult } from './normalize-url.js';

/*
 * COV-6: リンクの件数の上限は持たない（文書のすべての `a[href]` を記録する。`omittedLinkCount` は常に 0）。URL-LEN: URL（`rawHref`、`normalized` と
 * `admission` の `rawUrl`、`scheme`）の長さの上限（前は 2,048）は撤廃した。LZ-3b: 文（`anchorText`・`ariaLabel`・`title`）の長さの上限（前の
 * `LINK_LIMITS.maxTextLength` 1,024）も撤廃した。どの値も切り詰めない（`truncated` は前の記録の形のために残し、いつも偽）。
 */

/**
 * COV-6: ページの中の 1 回の読み取りで返すリンクの件数（自分の処理の上限 C。1 回の受け渡しの大きさを抑えるための分け方の単位で、記録の件数の
 * 上限ではない。これを超える件数は、続きの位置から読み直して全部集める）。
 */
export const LINK_COLLECTION_PART_SIZE = 2_000;

/** リンク証跡用に注入するURLポリシー（必須。暗黙の受け入れ判定は持たない）。 */
export interface LinkDiscoveryPolicy extends AdmissionPolicy {
  readonly allowedQueryParameters: ReadonlySet<string>;
}

interface ExtractedAnchor {
  readonly anchorText: string | null;
  readonly ariaLabel: string | null;
  readonly title: string | null;
  /** REV-SD の M-1: リンクの中の画像の `alt`（空でないもの。ないときは省く）。 */
  readonly imageAlts?: readonly string[];
  readonly rawHref: string;
  readonly baseUrl: string;
}

interface ExtractedAnchors {
  /** 文書の中の `a[href]` の総数。 */
  readonly totalCount: number;
  /** 続きの位置（`offset`）から `partSize` 件までのアンカー。 */
  readonly anchors: readonly ExtractedAnchor[];
}

const normalizeAnchorText = (text: string | null): string => (text === null ? '' : normalizeWhitespace(text));

const classifyRejectedNormalization = (
  normalized: Extract<NormalizedUrlResult, { readonly ok: false }>,
  baseUrl: string,
  policy: AdmissionPolicy,
): UrlAdmission => {
  try {
    const parsedUrl = new URL(normalized.rawUrl, baseUrl);
    const admission = classifyUrl(parsedUrl, policy);
    if (admission.kind === 'SPECIAL_SCHEME_RECORD_ONLY') {
      return admission;
    }
  } catch {
    // 下記の正規化された失敗値は、パーサーが返す正規の理由と生の値をそのまま保持する。
  }

  return { kind: 'REJECTED_INVALID', rawUrl: normalized.rawUrl, reason: normalized.reason };
};

/**
 * 1つのアンカーの Evidence を作る。認証情報は伏せ字にする。
 * 文字（`anchorText`・`ariaLabel`・`title`）は切り詰めない（LZ-3b）。
 * URL（`rawHref`、正規化の前後の値、`admission` の値）も切り詰めない（L14: 正規化は長さで拒まない。表 A の N23。URL-LEN: 記録も切り詰めない）。
 */
const toLinkEvidence = (anchor: ExtractedAnchor, sourcePageId: PageId, policy: LinkDiscoveryPolicy): LinkEvidence => {
  const normalized = normalizeUrl(anchor.rawHref, anchor.baseUrl, policy.allowedQueryParameters);
  const admission = normalized.ok
    ? classifyUrl(new URL(normalized.url), policy)
    : classifyRejectedNormalization(normalized, anchor.baseUrl, policy);

  return {
    sourcePageId,
    anchorText: normalizeAnchorText(anchor.anchorText),
    ariaLabel: anchor.ariaLabel,
    title: anchor.title,
    // REV-SD の M-1: 画像の `alt` のないリンクは項目を持たない（前の記録と同じ形）。
    ...(anchor.imageAlts === undefined || anchor.imageAlts.length === 0 ? {} : { imageAlts: anchor.imageAlts.map((alt) => normalizeWhitespace(alt)) }),
    rawHref: redactUrlCredentials(anchor.rawHref, anchor.baseUrl),
    normalized,
    admission,
    truncated: false,
  };
};

/** `extractAnchorsReader` の入力（集める要素のセレクタと、この回に返す部分の続きの位置と件数）。 */
interface AnchorExtractionInput {
  readonly selector: string;
  readonly offset: number;
  readonly partSize: number;
}

/**
 * ページの中で、標準のメソッドで link を集める（DEF-074。集め方と順は `discoverLinks` の説明のとおり）。部品（`R`）を `composeInPage` で
 * 組み込んで `page.evaluate` に渡すため、この関数の外にあるものを参照しない。
 */
function extractAnchorsReader(R: StandardReaders, { selector, offset, partSize }: AnchorExtractionInput): ExtractedAnchors {
  // DOM clobbering（DEF-073・DEF-074）: 名前つきの img・form など（`<img name="baseURI">`、`<img name="querySelectorAll">`）は、`document` の
  // 同じ名前のプロパティとメソッドを、form の中の名前つきの入力の欄は form のそれを隠すので、`document` と要素（form になりうる）は、
  // 標準の prototype の getter とメソッドで読む（getter は部品の `standardProperty`・`optionalStandardGetter`。`src/browser/in-page-readers.ts`。CC-068）。
  // a 要素は、名前つきの子でプロパティが隠れないので、そのまま読む。
  const baseUrl = R.standardProperty<string>(Node.prototype, 'baseURI', document);
  // 文書と open な shadow root（入れ子を含む。文書の順）を根にして、根ごとに CSS で集める（部品の `optionalOpenRoots`・`queryAllInRoots`。CC-099）。
  // 根の順は、文書、要素の文書の順の shadow root（その中の入れ子の shadow root を先に）なので、今までの集め方（文書の一致の後に、要素ごとの
  // shadow root を同じ集め方でたどる）と同じ順になる。ページの JS が `shadowRoot` の getter を消したときは、今までどおり shadow root を飛ばして
  // 文書の link を集める（例外にしない。細工したページで発見を止めない）。
  const elements = R.queryAllInRoots(R.optionalOpenRoots(), selector) as Element[];
  return {
    totalCount: elements.length,
    anchors: elements.slice(offset, offset + partSize).map((element) => {
      const anchor = element as HTMLAnchorElement;
      return {
        anchorText: anchor.textContent,
        ariaLabel: anchor.getAttribute('aria-label'),
        title: anchor.getAttribute('title'),
        imageAlts: Array.from(anchor.querySelectorAll('img[alt]'), (image) => image.getAttribute('alt') ?? '').filter((alt) => alt.trim() !== ''),
        rawHref: anchor.getAttribute('href') ?? '',
        baseUrl,
      };
    }),
  };
}
const extractAnchorsInPage = composeInPage(extractAnchorsReader);

/**
 * 本番で使用する唯一のアンカー抽出処理（link の Evidence の payload を返す）。証跡を返すのみであり、
 * INTERNAL_NAVIGABLEの許可を巡回候補にするかどうかは呼び出し側が判断する。
 * COV-6: 文書のすべてのリンクを、文書の順に記録する。ページの中の読み取りは `LINK_COLLECTION_PART_SIZE` 件ずつに分け、続きの位置から読み直す
 * （`readInParts`。読み取りが返す件数が 0 になるか、続きの位置が総数に届いたら終わる）。分けた回数を `collectedInParts` に、`omittedLinkCount` は 0 を残す。
 * DOM の Evidence には、ここで得た結果をそのまま渡す（Link は1回だけ抽出する。ARCH03）。
 * Link を抽出する入口は、この関数だけにする（実装タスク指示 4.2「No Parallel Entry Points」）。
 */
export const discoverLinks = async (
  page: Page,
  sourcePageId: PageId,
  policy: LinkDiscoveryPolicy,
): Promise<LinkDiscoveryEvidence> => {
  if (typeof policy !== 'object' || policy === null) {
    throw new TypeError('discoverLinks requires an explicit link discovery policy');
  }
  // ページの中で、標準のメソッドで link を集める（DEF-074）。Playwright の `locator(...).evaluateAll` は、ページの `document.querySelectorAll`
  // と要素の `matches` を使うので、名前つきの要素（`<img name="querySelectorAll">` など）に隠されると失敗する。集め方と順は、Playwright の
  // CSS のセレクタの集め方（open な shadow root を貫く）と同じにする: 文書の中の一致を文書の順に並べ、その後に、文書の中のすべての要素の
  // open な shadow root を、要素の文書の順に、同じ集め方で（入れ子を含めて）たどる。
  const parts = await readInParts(0, async (offset: number) => {
    const extracted = await page.evaluate(extractAnchorsInPage, { selector: 'a[href]', offset, partSize: LINK_COLLECTION_PART_SIZE });
    const next = offset + extracted.anchors.length;
    return { part: extracted.anchors, next: extracted.anchors.length === 0 || next >= extracted.totalCount ? null : next };
  });

  return {
    links: parts.flat().map((anchor) => toLinkEvidence(anchor, sourcePageId, policy)),
    omittedLinkCount: 0,
    collectedInParts: parts.length,
    frames: internalFrameUrlsOf(page, policy),
  };
};

/**
 * COV-4（網羅の設計書 3.3 の iframe の行）: 許可 Origin の中の子の frame の文書の URL（正規化し、受け入れの判定が `INTERNAL_NAVIGABLE` のもの。frame の木の順。
 * 重なりなし）。Playwright の frame の木から読む（ページの中で読まない。要求は送らない）。
 */
const internalFrameUrlsOf = (page: Page, policy: LinkDiscoveryPolicy): NormalizedHttpUrlEvidence[] => {
  const main = page.mainFrame();
  const urls = new Set<NormalizedHttpUrlEvidence>();
  for (const frame of page.frames()) {
    if (frame === main) {
      continue;
    }
    const normalized = normalizeUrl(frame.url(), frame.url(), policy.allowedQueryParameters);
    if (normalized.ok && classifyUrl(new URL(normalized.url), policy).kind === 'INTERNAL_NAVIGABLE') {
      urls.add(normalized.url);
    }
  }
  return [...urls];
};
