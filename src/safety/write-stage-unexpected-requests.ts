// 書き込みの段で止めた、承認した送信のほかの要求の一覧の唯一の owner（OP-M。値を入れた後に出た送信の種類を、値を残さずに記録する）。
// - Guard が書き込みの段の記録（`WriteStageMonitor`）の中に持ち、止めた要求を記録する（止める判定は変えない。記録を足すだけ）。ワーカーが
//   `action-evidence.json` の `guard.unexpectedRequests` に写す（設計者が読む成果物。画面には出さない）。
// - 1 行は、送り方（method）、送り先の区分（`WRITE_STAGE_REQUEST_DESTINATIONS`。許可の外の Origin は名前を残さない）、path の形、要求の種類、いつ出たか
//   （`WRITE_STAGE_REQUEST_TIMINGS`）、止めた理由のコード、入れた値（目印）が本文に入っていたかの真偽と本文の種類、回数。Origin・query・本文・値は持たない。
// - path の形・method の形は、型の作り手（`src/core/api-request-shape.ts` の `apiRequestShapeOf`）に任せる（値に見える区切りと目印を含む区切りを伏せる）。
// - 同じ形の行は重ねず、回数を足す（飽和）。一覧は `MAX_WRITE_STAGE_UNEXPECTED_REQUESTS` まで。上限を超えた新しい行と、型を作れなかった要求は数だけ
//   （`unlisted`）。
// - OP-N（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.7 の N1・N2）: 目印の照らし（`requestCarriesMarker`）の唯一の owner。行の
//   `markerInBody` と、Guard の判断（値を入れた後に止めた読み取りと WebSocket を、取りやめに数えるか）が、同じ照らしを使う。照らす形は、そのままの文字列、
//   `%XX` を寛容に戻した形、さらに `+` を空白に直した形（form の符号化）、JSON の入れ子の値と鍵（`\u` の符号化を戻す）で、大文字と小文字を区別しない。読めない
//   本文は、目印があるとみなす（安全の側。行の `markerInBody` は偽のまま、本文の種類で読む）。
// - 既知の限界（OP-REV3 の M-1・I-3）:
//   - 照らすのは URL と本文だけ。ヘッダと Cookie は照らさない。base64、二重の `%XX`、`\u` を文字列の中に書いた形、値を分けて送る形など、ほかの符号化も見つけない。
//     そのため、押した後（値を入れた後）の読み取りでない要求には、この照らしで送信の扱いを当てない（要求の判定の owner の `writeStageAuditSendApplies`。止める）。
//     値を入れた後の窓の中の判断（N1）では、この限界は「止めたまま、取りやめに数えない」ことにだけ効く（サーバへは届かない）。
//   - 押した後（窓を閉じた後）の読み取り（GET・HEAD）は、前からの書き込みの段の決まりで、許可 Origin の中なら通す（目印を含んでも届く。この部品は使わない）。
// - OP-N（N2）: 同じ形の一覧を、送信の扱い `PASS_EXCEPT_DELETE` で通した、サイトが自動で送る通信の記録にも使う（理由は `WRITE_STAGE_AUDIT_SEND_PASSED`）。
import {
  apiRequestShapeOf,
  MAX_API_REQUEST_BODY_BYTES,
  MAX_API_SHAPE_MARKERS,
  type ApiRequestBody,
  type ApiRequestBodyKind,
} from '../core/api-request-shape.js';
import { saturatingIncrement } from '../core/saturating-count.js';
import type { RequestResourceType } from './request-policy.js';

/** 一覧の行の上限（OP-M の指示書の「名前つきの数」）。 */
export const MAX_WRITE_STAGE_UNEXPECTED_REQUESTS = 20;

/** OP-N（N2）: 送信の扱い `PASS_EXCEPT_DELETE` で通した要求の行の理由（止めた理由ではない。通した一覧の行だけが持つ）。 */
export const WRITE_STAGE_AUDIT_SEND_PASSED = 'AUDIT_SEND_PASSED';

/**
 * 送り先の区分（閉じた一覧）: テスト環境の Origin（許可 Origin）、承認したサービスの Origin（承認した API の Origin を含む）、許可の外。
 * 許可の外の Origin は、名前を残さず区分だけにする。
 */
export const WRITE_STAGE_REQUEST_DESTINATIONS = Object.freeze(['TEST_ORIGIN', 'APPROVED_SERVICE_ORIGIN', 'OUTSIDE_ALLOWED_ORIGINS'] as const);
export type WriteStageRequestDestination = (typeof WRITE_STAGE_REQUEST_DESTINATIONS)[number];

/** いつ出たか（閉じた一覧）: 値を入れる前（送信の窓を開く前）、入れた後（窓の観察の段）、押した後（窓の送信の段と、窓を閉じた後）。 */
export const WRITE_STAGE_REQUEST_TIMINGS = Object.freeze(['BEFORE_FILL', 'AFTER_FILL', 'AFTER_PRESS'] as const);
export type WriteStageRequestTiming = (typeof WRITE_STAGE_REQUEST_TIMINGS)[number];

/** 一覧の 1 行（値・Origin・query・本文を持たない）。 */
export interface WriteStageUnexpectedRequest {
  readonly method: string;
  readonly destination: WriteStageRequestDestination;
  /** path の形（`/` で始まる。値に見える区切りと目印を含む区切りは伏せてある。長すぎる path は全体を伏せる）。 */
  readonly pathShape: string;
  readonly resourceType: string;
  readonly timing: WriteStageRequestTiming;
  /** 止めた理由のコード（Guard の判定の理由か、送信の段の理由か、送る中身の照合の理由）。通した一覧では `WRITE_STAGE_AUDIT_SEND_PASSED`。 */
  readonly reason: string;
  /** 入れた値（目印）のどれかが、本文に入っていたか（OP-N: JSON の入れ子の値と form の符号化も照らす。読めない本文は偽）。 */
  readonly markerInBody: boolean;
  /** 本文の種類（`markerInBody` を読むため。読めない本文は、目印を照らしていない）。 */
  readonly bodyKind: ApiRequestBodyKind;
  /** 止めた回数（1 以上。飽和）。 */
  readonly count: number;
}

/** 一覧の写し（凍結）。 */
export interface WriteStageUnexpectedRequests {
  readonly requests: readonly WriteStageUnexpectedRequest[];
  /** 一覧に入れなかった、止めた要求の数（上限を超えた新しい行と、型を作れなかった要求。飽和）。 */
  readonly unlisted: number;
}

/** Guard が渡す、止めた要求の事実（区分と時点は Guard が決める。本文は、行を作るときにだけ読む）。 */
export interface WriteStageUnexpectedRequestFacts {
  readonly method: string;
  readonly url: string;
  readonly resourceType: RequestResourceType;
  readonly destination: WriteStageRequestDestination;
  readonly timing: WriteStageRequestTiming;
  readonly reason: string;
  readonly body: () => ApiRequestBody;
}

/** form の符号化の空白。 */
const FORM_SPACE = '+';
/** `%XX` の続き（1 つ以上）。捕まえる組で `split` すると、奇数番目が続きになる。 */
const PERCENT_RUN = /((?:%[0-9A-Fa-f]{2})+)/u;
const SPLIT_RUN_PERIOD = 2;
const PERCENT_SIGN = '%';

/** `%XX` の続きを寛容に戻した形（各 `%XX` を 1 バイトにし、UTF-8 として読む。戻せないバイトは置き換え文字）。 */
const lenientPercentDecoded = (text: string): string => text
  .split(PERCENT_RUN)
  .map((part, index) => (index % SPLIT_RUN_PERIOD === 1 ? Buffer.from(part.split(PERCENT_SIGN).join(''), 'hex').toString('utf8') : part))
  .join('');

/** JSON の値の中の文字列と数（鍵を含む）をすべて集める（値を外に出さない）。 */
const nestedJsonTextsOf = (value: unknown, texts: string[]): void => {
  if (typeof value === 'string' || typeof value === 'number') {
    texts.push(String(value));
  } else if (Array.isArray(value)) {
    for (const item of value) nestedJsonTextsOf(item, texts);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      texts.push(key);
      nestedJsonTextsOf(item, texts);
    }
  }
};

/** 文字列のどれかが、目印のどれかを含むか（そのまま、`%XX` を戻した形、`+` を空白にした形。目印は小文字にしてある）。 */
const textsCarryMarker = (texts: readonly string[], loweredMarkers: readonly string[]): boolean => {
  if (loweredMarkers.length === 0) return false;
  const expanded = texts.flatMap((text) => {
    const decoded = lenientPercentDecoded(text);
    return [text, decoded, decoded.split(FORM_SPACE).join(' ')];
  }).map((text) => text.toLowerCase());
  return loweredMarkers.some((marker) => expanded.some((text) => text.includes(marker)));
};

/** 本文の目印の有無（`UNKNOWN` は、読めない・大きすぎて入れ子を照らせない本文）。 */
type BodyMarkerPresence = 'ABSENT' | 'PRESENT' | 'UNKNOWN';

const bodyMarkerPresenceOf = (body: ApiRequestBody, loweredMarkers: readonly string[]): BodyMarkerPresence => {
  if (body.kind === 'NONE' || loweredMarkers.length === 0) return 'ABSENT';
  if (body.kind !== 'TEXT' || typeof body.text !== 'string') return 'UNKNOWN';
  const texts = [body.text];
  // 入れ子の値は、型の作り手と同じ大きさの上限の中だけ照らす（超えた本文は、そのままの形で見つからなければ分からないとする）。
  const parseable = body.text.length <= MAX_API_REQUEST_BODY_BYTES;
  if (parseable) {
    try {
      nestedJsonTextsOf(JSON.parse(body.text) as unknown, texts);
    } catch {
      // JSON でない本文は、そのままの形と、form の符号化を戻した形で照らす。
    }
  }
  if (textsCarryMarker(texts, loweredMarkers)) return 'PRESENT';
  return parseable ? 'ABSENT' : 'UNKNOWN';
};

/** 空でない目印を、小文字にした写し。 */
const loweredMarkersOf = (markers: readonly string[]): readonly string[] =>
  markers.filter((marker) => typeof marker === 'string' && marker.length > 0).map((marker) => marker.toLowerCase());

/** 照らす要求（URL と、本文の読み方）。 */
export interface MarkerCheckedRequest {
  readonly url: string;
  readonly body: () => ApiRequestBody;
}

/**
 * OP-N: 要求の URL か本文に、目印（入れた値）のどれかが入っているか（ファイルの先頭の照らし方）。読めない本文は、入っているとみなす（安全の側）。本文を読む
 * 関数が投げたら、入っているとみなす。目印が空なら偽。
 */
export function requestCarriesMarker(markers: readonly string[], request: MarkerCheckedRequest): boolean {
  return requestCarriesLoweredMarker(loweredMarkersOf(markers), request);
}

/** `requestCarriesMarker` の中身（目印は小文字にしてある）。 */
function requestCarriesLoweredMarker(lowered: readonly string[], request: MarkerCheckedRequest): boolean {
  if (lowered.length === 0) return false;
  if (typeof request.url !== 'string' || textsCarryMarker([request.url], lowered)) return true;
  let body: ApiRequestBody;
  try {
    body = request.body();
  } catch {
    return true;
  }
  return bodyMarkerPresenceOf(body, lowered) !== 'ABSENT';
}

interface MutableEntry {
  readonly row: Omit<WriteStageUnexpectedRequest, 'count'>;
  count: number;
}

/** 型の作り手に渡す、画面の path（filter の値は残さないので、比べる ID のない path）。 */
const NO_PAGE_PATH = '/';
/** 型の作り手に渡す、Origin の区分（使わない。区分は Guard が決めた `destination`）。 */
const UNUSED_ORIGIN_SHAPE = Object.freeze({ kind: 'OTHER' as const });

/**
 * 書き込みの段で止めた、承認した送信のほかの要求の一覧（1 つの書き込みの段に 1 つ。Guard だけが `record` で書く）。目印（入れた値）は、この部品の中だけで
 * 持ち、行には真偽だけを残す。OP-N: 通した要求の一覧にも、同じ部品を使う（Guard が別の部品を持つ）。
 */
export class WriteStageUnexpectedRequestList {
  readonly #markers: readonly string[];
  /** OP-N: 照らしに使う、すべての目印（小文字。型の作り手の上限で切らない。空の値は比べない）。 */
  readonly #loweredMarkers: readonly string[];
  readonly #entries = new Map<string, MutableEntry>();
  #unlisted = 0;

  constructor(markers: readonly string[]) {
    const kept = markers.filter((marker) => typeof marker === 'string' && marker.length > 0);
    this.#loweredMarkers = Object.freeze(loweredMarkersOf(kept));
    // 型の作り手の目印の上限まで（空の値は比べない）。
    this.#markers = Object.freeze(kept.slice(0, MAX_API_SHAPE_MARKERS));
  }

  /** OP-N: 要求の URL か本文に、この段の目印のどれかが入っているか（`requestCarriesMarker` と同じ照らし。読めない本文は入っているとみなす）。 */
  carriesMarker(request: MarkerCheckedRequest): boolean {
    return requestCarriesLoweredMarker(this.#loweredMarkers, request);
  }

  /** 止めた要求を 1 つ記録する（型を作れなければ数だけ）。 */
  record(facts: WriteStageUnexpectedRequestFacts): void {
    let row: Omit<WriteStageUnexpectedRequest, 'count'>;
    try {
      const body = facts.body();
      const shape = apiRequestShapeOf({
        method: facts.method,
        resourceType: facts.resourceType,
        url: facts.url,
        origin: UNUSED_ORIGIN_SHAPE,
        headers: undefined,
        body,
      }, { pagePath: NO_PAGE_PATH, markers: this.#markers });
      row = Object.freeze({
        method: shape.method,
        destination: facts.destination,
        pathShape: shape.pathShape,
        resourceType: shape.resourceType,
        timing: facts.timing,
        reason: facts.reason,
        // OP-N: JSON の最上位の値のほか、入れ子の値と form の符号化も照らす（読めない本文は偽。本文の種類で読む）。
        markerInBody: shape.body.markerKeys.length > 0 || bodyMarkerPresenceOf(body, this.#loweredMarkers) === 'PRESENT',
        bodyKind: shape.body.kind,
      });
    } catch {
      this.#unlisted = saturatingIncrement(this.#unlisted);
      return;
    }
    const key = JSON.stringify([row.method, row.destination, row.pathShape, row.resourceType, row.timing, row.reason, row.markerInBody, row.bodyKind]);
    const entry = this.#entries.get(key);
    if (entry !== undefined) {
      entry.count = saturatingIncrement(entry.count);
      return;
    }
    if (this.#entries.size >= MAX_WRITE_STAGE_UNEXPECTED_REQUESTS) {
      this.#unlisted = saturatingIncrement(this.#unlisted);
      return;
    }
    this.#entries.set(key, { row, count: 1 });
  }

  /** 一覧の写し（記録した順。凍結）。 */
  snapshot(): WriteStageUnexpectedRequests {
    return Object.freeze({
      requests: Object.freeze([...this.#entries.values()].map(({ row, count }) => Object.freeze({ ...row, count }))),
      unlisted: this.#unlisted,
    });
  }
}
