/**
 * 書き込みの段の送る中身の照合（T30b。Task 30 の設計書 `2026-10-13-beaksight-task-30-approved-create-design.md` 3 章の「送る中身の照合」、
 * 10 章の 2）。純粋な関数で、Guard が CDP の `Fetch.requestPaused`（Document の Request の段階）の事実を渡して呼ぶ（呼ぶのは Guard だけ）。
 * 要求の本文（urlencoded と multipart）を読むのは、このファイルだけ（Gate `write-stage-boundary` の (b)）。
 *
 * 判定（`checkWritePayload`。上から順に調べ、最初に当たった理由を返す）:
 * - 承認の要求の形と送る欄の指定（`WritePayloadExpectation`）が正しくなければ `EXPECTATION_INVALID`（fail-closed）。
 * - (a) method が `POST`、main frame のナビゲーション、URL に query と fragment がない、Origin と path が承認の形と完全に一致する（要求の判定の
 *   owner の `isWriteEndpointUrl`。ログインの段と同じ比べ方）。
 * - (f) 文書の文字コードが分かり、UTF-8 である（Guard が送信の窓を開いた時点に isolated world で読んだ値。読めなければ `null`）。
 * - (b) `Content-Type` が `application/x-www-form-urlencoded`（引数なし）か `multipart/form-data`（`boundary` だけ）で、承認の enctype と同じ。
 * - (g) 本文がある（`hasPostData` と、bytes のある `postDataEntries`）、切れていない（bytes のない部品がない。multipart の終わりの区切りがある）、
 *   上限（`MAX_WRITE_PAYLOAD_BYTES`）を超えない（base64 を decode する前に長さで調べる）、形が正しい。
 * - (c) 欄の名前は、送る欄・承認した候補の hidden と readonly の欄・空の file の欄だけ。同じ名前は 1 回だけ。送る欄はすべてある。
 * - (d) 送る欄の値は、生成した値（改行はブラウザと同じく CR LF にした形）の UTF-8 の bytes と完全に一致する。
 * - (e) file の欄は空（multipart はファイル名も中身もない部品、urlencoded は空の値）。file の部品が file でない欄にある、file の欄が file の
 *   部品でない、も止める。
 * - (h) T30b fix round 1（T31 の調査で見つかった穴）: method の上書きの欄（`_method`。名前は Task 27 の判定 `isMethodOverrideFieldName` と同じ
 *   畳み込みで当てる）は、名前だけでなく値を照らす（秘密でない閉じた値）。承認した候補の上書き（`methodOverride`。`PUT`・`PATCH`）があれば、
 *   本文にその欄がちょうど 1 つ（file の部品でない）あり、値が同じ畳み込み（`foldNfkcCase`）で一致すること。上書きがなければ（省略と null）、
 *   本文にその欄がないこと。外れたら `METHOD_OVERRIDE_MISMATCH`。上書きの欄は、名前だけの一覧（送る欄・hidden と readonly・file）に入れられない
 *   （入れた指定は `EXPECTATION_INVALID`）。
 * - T31c（Task 31 の設計書 `2026-10-13-beaksight-task-31-approved-update-design.md` 3 章の「欄の役割」「削除にあたる変更の遮断」「同じ名前の
 *   hidden と checkbox の組」「値の照らし方」、4 章の「照合」）: UPDATE の画面のために、期待に 3 つの一覧を足した（省略と空の一覧は同じで、
 *   今の CREATE の照合と同じ結果）。保つ見える欄は、新しい仕組みを作らず、送る欄（`submittedFields`）に前の値で入れる（(c)(d) と同じ扱い）。
 *   調べる順は (h) の後に (k)・(i)・(j) で、その後に (c)(e)(d)。
 *   - (k) 送らないことを期待する欄（`absentFieldNames`。チェックしていない checkbox、選んでいない radio の組）: 本文にその名前（(c) と同じ名前の
 *     比べ方）の欄があれば `UNEXPECTED_FIELD_PRESENT`。
 *   - (i) 値を照らす hidden の欄（`checkedPassthroughFields`。状態の名前の hidden など）: 本文にその名前の欄がちょうど 1 つ、file の部品でなく、
 *     値が期待の値（改行は CR LF にした形）の UTF-8 の bytes と完全に一致する。外れたら `PASSTHROUGH_VALUE_MISMATCH`。
 *   - (j) 同じ名前の hidden と checkbox の組（`checkboxPairs`。Rails 型）: 本文のその名前の欄が、`checkedValue` が null なら `offValue` の 1 つ
 *     だけ、そうでなければ `offValue`、`checkedValue` の順の 2 つだけ（間にほかの名前の欄があってもよい）。どれも file の部品でない。値は (i) と
 *     同じ比べ方。外れたら `CHECKBOX_PAIR_MISMATCH`。組の名前だけが、(c) の「同じ名前は 1 回だけ」の例外。
 *   - 名前は、6 つの一覧（送る欄・hidden と readonly・file・(i)・(j)・(k)）を通して重ならない。method の上書きの欄は、どの一覧にも入れない。
 *     重ねた指定と形の違う指定は `EXPECTATION_INVALID`。
 * hidden・readonly の欄の値（CSRF のトークンを含む）は、形の確かめのほかに読まず、比べず、返さず、記録しない（名前だけを照らす。method の
 * 上書きの欄と、(i)・(j) の欄だけは値を照らす。その値も返さず、記録しない）。結果は閉じた一覧の語だけで、値・名前・URL を含まない。例外を投げない
 * （どの入力でも語を返す）。
 */
import { isRecord } from '../core/guards.js';
import { foldNfkcCase, hasLoneSurrogate } from '../core/text.js';
import { isMethodOverrideFieldName, type FormEnctype, type MethodOverride } from '../discovery/candidate-contracts.js';
import { SUBMISSION_POST_METHOD, isWriteEndpointUrl } from './request-policy.js';

/** 書き込みの段で送ってよい enctype（`FormEnctype` の一部。`text/plain` は値の区切りが曖昧なので送らない）。 */
export const WRITE_FORM_ENCTYPES = Object.freeze([
  'application/x-www-form-urlencoded',
  'multipart/form-data',
] as const satisfies readonly FormEnctype[]);
export type WriteFormEnctype = (typeof WRITE_FORM_ENCTYPES)[number];

const URLENCODED: WriteFormEnctype = WRITE_FORM_ENCTYPES[0];
const MULTIPART: WriteFormEnctype = WRITE_FORM_ENCTYPES[1];

/**
 * 書き込みの段で承認できる method の上書き（T30b fix round 1。`MethodOverride` の一部。DELETE の上書きは書き込みで送らない）。
 */
export const WRITE_METHOD_OVERRIDES = Object.freeze(['PUT', 'PATCH'] as const satisfies readonly MethodOverride[]);
export type WriteMethodOverride = (typeof WRITE_METHOD_OVERRIDES)[number];

/** 本文の大きさの上限（bytes）。承認の form の hidden の欄（画面の状態の値など）の大きさに余裕を見た値。超えたら読まずに止める。 */
export const MAX_WRITE_PAYLOAD_BYTES = 1_048_576;

/** 送る中身の照合の結果（閉じた一覧）。`ALLOW` のほかは止めた理由。 */
export const WRITE_PAYLOAD_DECISIONS = Object.freeze([
  'ALLOW',
  'EXPECTATION_INVALID',
  'NOT_POST',
  'NOT_MAIN_FRAME_NAVIGATION',
  'QUERY_OR_FRAGMENT_PRESENT',
  'ENDPOINT_MISMATCH',
  'DOCUMENT_CHARSET_UNKNOWN',
  'DOCUMENT_CHARSET_NOT_UTF8',
  'ENCTYPE_NOT_ALLOWED',
  'ENCTYPE_MISMATCH',
  'BODY_UNAVAILABLE',
  'BODY_INCOMPLETE',
  'BODY_TOO_LARGE',
  'BODY_MALFORMED',
  'UNKNOWN_FIELD',
  'DUPLICATE_FIELD',
  'SUBMITTED_FIELD_MISSING',
  'VALUE_MISMATCH',
  'FILE_NOT_EMPTY',
  'METHOD_OVERRIDE_MISMATCH',
  // T31c: UPDATE の画面の照合（(k)・(i)・(j)）。
  'UNEXPECTED_FIELD_PRESENT',
  'PASSTHROUGH_VALUE_MISMATCH',
  'CHECKBOX_PAIR_MISMATCH',
] as const);
export type WritePayloadDecision = (typeof WRITE_PAYLOAD_DECISIONS)[number];
/** 止めた理由（`ALLOW` を除く）。 */
export type WritePayloadBlockReason = Exclude<WritePayloadDecision, 'ALLOW'>;
/** 止めた理由の閉じた一覧（記録の数の鍵に使う）。 */
export const WRITE_PAYLOAD_BLOCK_REASONS = Object.freeze(
  WRITE_PAYLOAD_DECISIONS.filter((decision): decision is WritePayloadBlockReason => decision !== 'ALLOW'),
);

/** 承認の要求の形（method は `POST` だけ）。Origin と path は要求の判定の送信先と同じ意味。 */
export interface WriteRequestShape {
  readonly origin: string;
  readonly path: string;
  readonly enctype: WriteFormEnctype;
}

/** 送る欄と、生成した値。 */
export interface WriteSubmittedField {
  readonly name: string;
  readonly value: string;
}

/**
 * 同じ名前の hidden と checkbox の組（T31c。Rails 型）。`offValue` は hidden の値（checkbox の「外した値」）、`checkedValue` は checkbox の値で、
 * null はチェックしていない（本文に hidden の 1 つだけが出る）。
 */
export interface WriteCheckboxPair {
  readonly name: string;
  readonly offValue: string;
  readonly checkedValue: string | null;
}

/**
 * 承認の要求の形と、送ってよい欄（平らなデータ）。
 * - `submittedFields`: 送る欄と生成した値（1 つ以上）。
 * - `passthroughFieldNames`: 承認した候補の hidden・readonly の欄の名前（値は読まない。本文になくてもよい）。
 * - `emptyFileFieldNames`: 承認した候補の file の欄の名前（空のときだけ送ってよい。本文になくてもよい）。
 * - `methodOverride`（T30b fix round 1）: 承認した候補の method の上書き（`PUT`・`PATCH`）。値を照らす欄（`_method`）の期待。省略と null は、
 *   上書きがない（本文に `_method` があれば止める）。
 * - `checkedPassthroughFields`（T31c）: 値を照らす hidden の欄と期待の値（状態の名前の hidden など。値はワーカーが更新の前に読んだ値）。
 * - `checkboxPairs`（T31c）: 同じ名前の hidden と checkbox の組。
 * - `absentFieldNames`（T31c）: 本文に出ないことを期待する欄の名前（チェックしていない checkbox、選んでいない radio の組）。
 * T31c の 3 つは省略してよい（省略と空の一覧は同じ）。保つ見える欄は `submittedFields` に前の値で入れる。
 * 名前はすべての一覧を通して重ならない。名前の一覧に、method の上書きの欄の名前は入れない。
 */
export interface WritePayloadExpectation {
  readonly request: WriteRequestShape;
  readonly submittedFields: readonly WriteSubmittedField[];
  readonly passthroughFieldNames: readonly string[];
  readonly emptyFileFieldNames: readonly string[];
  readonly methodOverride?: WriteMethodOverride | null | undefined;
  readonly checkedPassthroughFields?: readonly WriteSubmittedField[] | undefined;
  readonly checkboxPairs?: readonly WriteCheckboxPair[] | undefined;
  readonly absentFieldNames?: readonly string[] | undefined;
}

/**
 * CDP の要求の事実（Guard が `Fetch.requestPaused` から作る）と、文書の文字コード。
 * - `contentType`: 要求のヘッダの `Content-Type`（なければ `null`）。
 * - `postDataEntries`: CDP の `postDataEntries`（各部品の `bytes` は base64。file や blob の部品は `bytes` を持たない）。なければ `null`。
 * - `documentCharset`: 送った文書の `document.characterSet`（Guard が読めなければ `null`）。
 */
export interface WriteRequestFacts {
  readonly method: string;
  readonly url: string;
  readonly isMainFrameNavigation: boolean;
  readonly contentType: string | null;
  readonly hasPostData: boolean;
  readonly postDataEntries: readonly { readonly bytes?: string | undefined }[] | null;
  readonly documentCharset: string | null;
}

/** 文書の文字コードの、UTF-8 の名前（`document.characterSet` の値。大文字と小文字を区別しない）。 */
const UTF8_CHARSET = 'utf-8';
/** base64 の 4 文字が表す bytes の数。 */
const BASE64_BYTES_PER_QUAD = 3;
const BASE64_CHARACTERS_PER_QUAD = 4;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/u;
/** multipart の区切りの文字列の長さの上限（RFC 2046）と、使える文字。 */
const MAX_BOUNDARY_LENGTH = 70;
const BOUNDARY_PATTERN = /^[0-9A-Za-z'()+_,\-./:=? ]*[0-9A-Za-z'()+_,\-./:=?]$/u;
const CRLF = '\r\n';
const HEADER_SEPARATOR = ': ';
/** multipart の部品の見出しの名前（小文字）。 */
const CONTENT_DISPOSITION_HEADER = 'content-disposition';
const CONTENT_TYPE_HEADER = 'content-type';
/** multipart の部品の `Content-Disposition` の形（ブラウザの書き方。名前とファイル名の `"`・CR・LF は percent-encode される）。 */
const FORM_DATA_DISPOSITION = /^form-data; name="([^"]*)"(?:; filename="([^"]*)")?$/u;
/** multipart の名前で、ブラウザが percent-encode する文字（HTML の multipart/form-data の符号化）。 */
const MULTIPART_NAME_ESCAPES: ReadonlyMap<string, string> = new Map([['"', '%22'], ['\r', '%0D'], ['\n', '%0A']]);
/** urlencoded の percent-encode の 1 つ（`%` と 16 進の 2 文字）。 */
const PERCENT_ESCAPE = /^%[0-9A-Fa-f]{2}/u;
const HEX_RADIX = 16;
const URLENCODED_PLUS = 0x2b;
const URLENCODED_SPACE = 0x20;
const URLENCODED_PERCENT = 0x25;
const PERCENT_ESCAPE_LENGTH = 3;
const MAX_ASCII = 0x7f;

/** 1 つの欄（本文の中の名前と、値の bytes。latin1 の文字列で bytes を表す）。 */
interface BodyField {
  /** 名前の bytes（urlencoded は decode した後、multipart はヘッダに書かれたまま）。 */
  readonly rawName: string;
  /** file の部品か（multipart の `filename` あり）。 */
  readonly isFilePart: boolean;
  /** file の部品のファイル名の bytes（file の部品でなければ空）。 */
  readonly filename: string;
  /** 値の bytes を返す（hidden・readonly の欄では呼ばない）。 */
  readonly valueBytes: () => string | null;
}

type ParsedBody =
  | { readonly ok: true; readonly fields: readonly BodyField[] }
  | { readonly ok: false; readonly reason: WritePayloadBlockReason };

/** 文字列を UTF-8 の bytes にして、latin1 の文字列で表す（bytes の比べに使う）。 */
const utf8Bytes = (text: string): string => Buffer.from(text, 'utf8').toString('latin1');

/** 改行を、ブラウザが送る形（CR LF）にする（HTML の form の送信の、名前と値の改行の正規化）。 */
const normalizeLineBreaks = (text: string): string => text.split(CRLF).map((piece) => piece.split('\r').join('\n'))
  .join('\n').split('\n').join(CRLF);

const isNonEmptyWellFormedString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && !hasLoneSurrogate(value);

const isWellFormedString = (value: unknown): value is string => typeof value === 'string' && !hasLoneSurrogate(value);

/** 省略してよい一覧（T31c）。省略は空の一覧、配列でなければ `null`（形の違う指定）。 */
const optionalList = (value: unknown): readonly unknown[] | null => (value === undefined ? [] : Array.isArray(value) ? value : null);

/** 名前と値の項目（送る欄と、値を照らす hidden の欄）の形。 */
const isNameValueField = (field: unknown): boolean => isRecord(field)
  && isNonEmptyWellFormedString(field['name']) && isWellFormedString(field['value']);

/** 組の項目の形（T31c）。 */
const isCheckboxPair = (pair: unknown): boolean => isRecord(pair)
  && isNonEmptyWellFormedString(pair['name']) && isWellFormedString(pair['offValue'])
  && (pair['checkedValue'] === null || isWellFormedString(pair['checkedValue']));

/** 指定が正しいか（形、enctype、名前の重なり、値の形）。 */
function isValidExpectation(expectation: WritePayloadExpectation): boolean {
  const { request, submittedFields, passthroughFieldNames, emptyFileFieldNames, methodOverride } = expectation;
  if (!isRecord(request)) {
    return false;
  }
  if (methodOverride !== undefined && methodOverride !== null && !(WRITE_METHOD_OVERRIDES as readonly unknown[]).includes(methodOverride)) {
    return false;
  }
  const { origin, path, enctype } = request;
  if (
    typeof origin !== 'string' || typeof path !== 'string'
    || !(WRITE_FORM_ENCTYPES as readonly unknown[]).includes(enctype)
    || !Array.isArray(submittedFields) || submittedFields.length === 0
    || !Array.isArray(passthroughFieldNames) || !Array.isArray(emptyFileFieldNames)
  ) {
    return false;
  }
  const checkedPassthroughFields = optionalList(expectation.checkedPassthroughFields);
  const checkboxPairs = optionalList(expectation.checkboxPairs);
  const absentFieldNames = optionalList(expectation.absentFieldNames);
  if (checkedPassthroughFields === null || checkboxPairs === null || absentFieldNames === null) {
    return false;
  }
  const fieldsValid = [...(submittedFields as readonly unknown[]), ...checkedPassthroughFields].every(isNameValueField)
    && checkboxPairs.every(isCheckboxPair);
  if (!fieldsValid) {
    return false;
  }
  // 名前は、すべての一覧を通して、空でない正しい文字列で、重ならない（hidden・readonly・file・送らない欄の一覧の項目の形も、ここで確かめる）。
  const names: readonly unknown[] = [
    ...submittedFields.map((field) => field.name),
    ...passthroughFieldNames,
    ...emptyFileFieldNames,
    ...(checkedPassthroughFields as readonly WriteSubmittedField[]).map((field) => field.name),
    ...(checkboxPairs as readonly WriteCheckboxPair[]).map((pair) => pair.name),
    ...absentFieldNames,
  ];
  return names.every(isNonEmptyWellFormedString) && new Set(names).size === names.length
    // method の上書きの欄は、値を照らす（名前だけの一覧に入れない）。
    && !names.some((name) => isMethodOverrideFieldName(name as string));
}

/** (a) 要求の形。合っていれば `null`。 */
function requestShapeProblem(request: WriteRequestShape, facts: WriteRequestFacts): WritePayloadBlockReason | null {
  if (facts.method !== SUBMISSION_POST_METHOD) {
    return 'NOT_POST';
  }
  if (facts.isMainFrameNavigation !== true) {
    return 'NOT_MAIN_FRAME_NAVIGATION';
  }
  if (typeof facts.url !== 'string') {
    return 'ENDPOINT_MISMATCH';
  }
  if (facts.url.includes('?') || facts.url.includes('#')) {
    return 'QUERY_OR_FRAGMENT_PRESENT';
  }
  return isWriteEndpointUrl(facts.url, { origin: request.origin, path: request.path }) ? null : 'ENDPOINT_MISMATCH';
}

/** (f) 文書の文字コード。UTF-8 なら `null`。 */
function charsetProblem(charset: unknown): WritePayloadBlockReason | null {
  if (typeof charset !== 'string' || charset.length === 0) {
    return 'DOCUMENT_CHARSET_UNKNOWN';
  }
  return charset.toLowerCase() === UTF8_CHARSET ? null : 'DOCUMENT_CHARSET_NOT_UTF8';
}

/** `Content-Type` の解釈（MIME の本体と引数）。形が合わなければ `null`。 */
function parsedContentType(contentType: unknown): { readonly essence: string; readonly parameters: ReadonlyMap<string, string> } | null {
  if (typeof contentType !== 'string') {
    return null;
  }
  const [essence = '', ...rawParameters] = contentType.split(';');
  const parameters = new Map<string, string>();
  for (const rawParameter of rawParameters) {
    const separator = rawParameter.indexOf('=');
    if (separator < 0) {
      return null;
    }
    const name = rawParameter.slice(0, separator).trim().toLowerCase();
    let value = rawParameter.slice(separator + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    if (name.length === 0 || parameters.has(name)) {
      return null;
    }
    parameters.set(name, value);
  }
  return { essence: essence.trim().toLowerCase(), parameters };
}

/** (b) enctype と、multipart の区切り。合っていれば `{ enctype, boundary }`。 */
function enctypeOf(contentType: unknown):
  | { readonly ok: true; readonly enctype: WriteFormEnctype; readonly boundary: string | null }
  | { readonly ok: false } {
  const parsed = parsedContentType(contentType);
  if (parsed === null) {
    return { ok: false };
  }
  if (parsed.essence === URLENCODED && parsed.parameters.size === 0) {
    return { ok: true, enctype: URLENCODED, boundary: null };
  }
  const boundary = parsed.parameters.get('boundary');
  if (
    parsed.essence === MULTIPART
    && parsed.parameters.size === 1
    && boundary !== undefined
    && boundary.length <= MAX_BOUNDARY_LENGTH
    && BOUNDARY_PATTERN.test(boundary)
  ) {
    return { ok: true, enctype: MULTIPART, boundary };
  }
  return { ok: false };
}

/** (g) 本文の bytes（latin1 の文字列）。取れない・切れている・上限を超える・base64 でない、は理由を返す。 */
function bodyBytesOf(facts: WriteRequestFacts): { readonly ok: true; readonly bytes: string } | { readonly ok: false; readonly reason: WritePayloadBlockReason } {
  const entries: unknown = facts.postDataEntries;
  if (facts.hasPostData !== true || !Array.isArray(entries) || entries.length === 0) {
    return { ok: false, reason: 'BODY_UNAVAILABLE' };
  }
  let estimatedBytes = 0;
  for (const entry of entries as readonly unknown[]) {
    const bytes = isRecord(entry) ? entry['bytes'] : undefined;
    if (bytes === undefined) {
      return { ok: false, reason: 'BODY_INCOMPLETE' };
    }
    if (typeof bytes !== 'string') {
      return { ok: false, reason: 'BODY_MALFORMED' };
    }
    estimatedBytes += Math.ceil(bytes.length / BASE64_CHARACTERS_PER_QUAD) * BASE64_BYTES_PER_QUAD;
    if (estimatedBytes > MAX_WRITE_PAYLOAD_BYTES + BASE64_BYTES_PER_QUAD) {
      return { ok: false, reason: 'BODY_TOO_LARGE' };
    }
  }
  const pieces: string[] = [];
  for (const entry of entries as readonly { readonly bytes: string }[]) {
    if (entry.bytes.length % BASE64_CHARACTERS_PER_QUAD !== 0 || !BASE64_PATTERN.test(entry.bytes)) {
      return { ok: false, reason: 'BODY_MALFORMED' };
    }
    pieces.push(Buffer.from(entry.bytes, 'base64').toString('latin1'));
  }
  const bytes = pieces.join('');
  return bytes.length > MAX_WRITE_PAYLOAD_BYTES ? { ok: false, reason: 'BODY_TOO_LARGE' } : { ok: true, bytes };
}

/** urlencoded の 1 つの名前か値の bytes を decode する（`+` は空白、`%XX` は 1 byte）。形が崩れていれば `null`。 */
function decodeUrlencoded(encoded: string): string | null {
  let decoded = '';
  for (let index = 0; index < encoded.length;) {
    const code = encoded.charCodeAt(index);
    if (code > MAX_ASCII) {
      return null;
    }
    if (code === URLENCODED_PLUS) {
      decoded += String.fromCharCode(URLENCODED_SPACE);
      index += 1;
    } else if (code === URLENCODED_PERCENT) {
      if (!PERCENT_ESCAPE.test(encoded.slice(index, index + PERCENT_ESCAPE_LENGTH))) {
        return null;
      }
      decoded += String.fromCharCode(Number.parseInt(encoded.slice(index + 1, index + PERCENT_ESCAPE_LENGTH), HEX_RADIX));
      index += PERCENT_ESCAPE_LENGTH;
    } else {
      decoded += encoded[index];
      index += 1;
    }
  }
  return decoded;
}

/** urlencoded の本文を、欄に分ける（値は、求められたときだけ decode する）。 */
function parseUrlencoded(bytes: string): ParsedBody {
  const fields: BodyField[] = [];
  for (const pair of bytes.split('&')) {
    const separator = pair.indexOf('=');
    if (separator < 0) {
      return { ok: false, reason: 'BODY_MALFORMED' };
    }
    const rawName = decodeUrlencoded(pair.slice(0, separator));
    const encodedValue = pair.slice(separator + 1);
    // 値は、形だけを確かめる（hidden・readonly の値も、形の確かめのほかには読まない）。
    if (rawName === null || rawName.length === 0 || decodeUrlencoded(encodedValue) === null) {
      return { ok: false, reason: 'BODY_MALFORMED' };
    }
    fields.push({ rawName, isFilePart: false, filename: '', valueBytes: () => decodeUrlencoded(encodedValue) });
  }
  return { ok: true, fields };
}

/** multipart の 1 つの部品の見出しを読む。形が合わなければ `null`。 */
function partHeaderOf(header: string): { readonly rawName: string; readonly filename: string | null } | null {
  let disposition: string | null = null;
  let contentTypeSeen = false;
  for (const line of header.split(CRLF)) {
    const separator = line.indexOf(HEADER_SEPARATOR);
    if (separator <= 0) {
      return null;
    }
    const name = line.slice(0, separator).toLowerCase();
    const value = line.slice(separator + HEADER_SEPARATOR.length);
    if (name === CONTENT_DISPOSITION_HEADER && disposition === null) {
      disposition = value;
    } else if (name === CONTENT_TYPE_HEADER && !contentTypeSeen) {
      contentTypeSeen = true;
    } else {
      return null;
    }
  }
  const matched = disposition === null ? null : FORM_DATA_DISPOSITION.exec(disposition);
  if (matched === null) {
    return null;
  }
  const filename = matched[2] ?? null;
  // 文字の部品は Content-Type を持たない（ブラウザの書き方）。持つのは file の部品だけ。
  if (contentTypeSeen && filename === null) {
    return null;
  }
  return { rawName: matched[1] ?? '', filename };
}

/** multipart の本文を、部品に分ける。終わりの区切りがなければ `BODY_INCOMPLETE`、形が崩れていれば `BODY_MALFORMED`。 */
function parseMultipart(bytes: string, boundary: string): ParsedBody {
  const delimiter = `--${boundary}`;
  const firstLine = `${delimiter}${CRLF}`;
  if (!bytes.startsWith(firstLine)) {
    return { ok: false, reason: 'BODY_MALFORMED' };
  }
  const separator = `${CRLF}${delimiter}`;
  const fields: BodyField[] = [];
  let position = firstLine.length;
  for (;;) {
    const headerEnd = bytes.indexOf(`${CRLF}${CRLF}`, position);
    if (headerEnd < 0) {
      return { ok: false, reason: 'BODY_INCOMPLETE' };
    }
    const header = partHeaderOf(bytes.slice(position, headerEnd));
    if (header === null || header.rawName.length === 0) {
      return { ok: false, reason: 'BODY_MALFORMED' };
    }
    const contentStart = headerEnd + CRLF.length * 2;
    const contentEnd = bytes.indexOf(separator, contentStart);
    if (contentEnd < 0) {
      return { ok: false, reason: 'BODY_INCOMPLETE' };
    }
    const content = bytes.slice(contentStart, contentEnd);
    fields.push({
      rawName: header.rawName,
      isFilePart: header.filename !== null,
      filename: header.filename ?? '',
      valueBytes: () => content,
    });
    const after = contentEnd + separator.length;
    if (bytes.startsWith(CRLF, after)) {
      position = after + CRLF.length;
      continue;
    }
    if (bytes.startsWith('--', after)) {
      const tail = bytes.slice(after + '--'.length);
      return tail === '' || tail === CRLF ? { ok: true, fields } : { ok: false, reason: 'BODY_MALFORMED' };
    }
    return after >= bytes.length ? { ok: false, reason: 'BODY_INCOMPLETE' } : { ok: false, reason: 'BODY_MALFORMED' };
  }
}

/** 欄の名前の、本文の中の形（urlencoded は UTF-8 の bytes、multipart は `"`・CR・LF を percent-encode した UTF-8 の bytes）。 */
function bodyNameOf(name: string, enctype: WriteFormEnctype): string {
  const normalized = normalizeLineBreaks(name);
  if (enctype === URLENCODED) {
    return utf8Bytes(normalized);
  }
  return utf8Bytes([...normalized].map((character) => MULTIPART_NAME_ESCAPES.get(character) ?? character).join(''));
}

/** 名前か値の bytes を、UTF-8 として読む（正しくない並びは U+FFFD になり、比べで外れる）。 */
const utf8Text = (bytes: string): string => Buffer.from(bytes, 'latin1').toString('utf8');

/**
 * (h) method の上書きの欄の確かめ（T30b fix round 1）。本文の欄のうち、名前が畳み込みで `_method` に当たる欄を取り出し、承認した上書きと照らす。
 * 合えば、その欄を除いた本文の欄を返す。外れたら `METHOD_OVERRIDE_MISMATCH`。
 */
function withoutMethodOverride(
  expectation: WritePayloadExpectation,
  fields: readonly BodyField[],
): { readonly ok: true; readonly fields: readonly BodyField[] } | { readonly ok: false } {
  const overrides = fields.filter((field) => isMethodOverrideFieldName(utf8Text(field.rawName)));
  const others = fields.filter((field) => !overrides.includes(field));
  const expected = expectation.methodOverride ?? null;
  if (expected === null) {
    return overrides.length === 0 ? { ok: true, fields: others } : { ok: false };
  }
  const [override, ...extra] = overrides;
  if (override === undefined || extra.length > 0 || override.isFilePart) {
    return { ok: false };
  }
  const value = override.valueBytes();
  return value !== null && foldNfkcCase(utf8Text(value)) === foldNfkcCase(expected) ? { ok: true, fields: others } : { ok: false };
}

/** 本文の欄の値が、期待の値（改行は CR LF にした形）の UTF-8 の bytes と完全に一致する、file でない部品か（T31c の (i)・(j)）。 */
const hasExpectedValue = (field: BodyField, value: string): boolean =>
  !field.isFilePart && field.valueBytes() === utf8Bytes(normalizeLineBreaks(value));

/**
 * (k)・(i)・(j)（T31c）の確かめ。値を照らす hidden の欄と組の欄を、合えば本文の欄から除いて返す（(c)(e)(d) は残りの欄で調べる）。
 */
function withoutUpdateFields(
  expectation: WritePayloadExpectation,
  enctype: WriteFormEnctype,
  fields: readonly BodyField[],
): { readonly ok: true; readonly fields: readonly BodyField[] } | { readonly ok: false; readonly reason: WritePayloadBlockReason } {
  const named = (name: string): readonly BodyField[] => {
    const bodyName = bodyNameOf(name, enctype);
    return fields.filter((field) => field.rawName === bodyName);
  };
  const absent = new Set((expectation.absentFieldNames ?? []).map((name) => bodyNameOf(name, enctype)));
  if (fields.some((field) => absent.has(field.rawName))) {
    return { ok: false, reason: 'UNEXPECTED_FIELD_PRESENT' };
  }
  const checked = new Set<BodyField>();
  for (const { name, value } of expectation.checkedPassthroughFields ?? []) {
    const [field, ...extra] = named(name);
    if (field === undefined || extra.length > 0 || !hasExpectedValue(field, value)) {
      return { ok: false, reason: 'PASSTHROUGH_VALUE_MISMATCH' };
    }
    checked.add(field);
  }
  for (const { name, offValue, checkedValue } of expectation.checkboxPairs ?? []) {
    const pairFields = named(name);
    const values = checkedValue === null ? [offValue] : [offValue, checkedValue];
    if (pairFields.length !== values.length || !pairFields.every((field, index) => hasExpectedValue(field, values[index] ?? ''))) {
      return { ok: false, reason: 'CHECKBOX_PAIR_MISMATCH' };
    }
    pairFields.forEach((field) => checked.add(field));
  }
  return { ok: true, fields: fields.filter((field) => !checked.has(field)) };
}

/** (c)(d)(e)(h)(i)(j)(k) 欄の名前・重複・送る欄の値・file の欄・method の上書きの欄・値を照らす hidden の欄・組・送らない欄。 */
function fieldsProblem(expectation: WritePayloadExpectation, enctype: WriteFormEnctype, bodyFields: readonly BodyField[]): WritePayloadBlockReason | null {
  const overrideChecked = withoutMethodOverride(expectation, bodyFields);
  if (!overrideChecked.ok) {
    return 'METHOD_OVERRIDE_MISMATCH';
  }
  const updateChecked = withoutUpdateFields(expectation, enctype, overrideChecked.fields);
  if (!updateChecked.ok) {
    return updateChecked.reason;
  }
  const { fields } = updateChecked;
  const submitted = new Map(expectation.submittedFields.map((field) => [bodyNameOf(field.name, enctype), field.value] as const));
  const passthrough = new Set(expectation.passthroughFieldNames.map((name) => bodyNameOf(name, enctype)));
  const files = new Set(expectation.emptyFileFieldNames.map((name) => bodyNameOf(name, enctype)));
  const seen = new Set<string>();
  for (const field of fields) {
    if (!submitted.has(field.rawName) && !passthrough.has(field.rawName) && !files.has(field.rawName)) {
      return 'UNKNOWN_FIELD';
    }
    if (seen.has(field.rawName)) {
      return 'DUPLICATE_FIELD';
    }
    seen.add(field.rawName);
  }
  for (const field of fields) {
    if (files.has(field.rawName)) {
      const empty = enctype === MULTIPART
        ? field.isFilePart && field.filename === '' && field.valueBytes() === ''
        : field.valueBytes() === '';
      if (!empty) {
        return 'FILE_NOT_EMPTY';
      }
    } else if (field.isFilePart) {
      return 'FILE_NOT_EMPTY';
    }
  }
  for (const [name, value] of submitted) {
    const field = fields.find((candidate) => candidate.rawName === name);
    if (field === undefined) {
      return 'SUBMITTED_FIELD_MISSING';
    }
    if (field.valueBytes() !== utf8Bytes(normalizeLineBreaks(value))) {
      return 'VALUE_MISMATCH';
    }
  }
  return null;
}

/**
 * 書き込みの段の送る中身の照合（ファイルの先頭の説明の順）。`ALLOW` か、止めた理由の語を返す。例外を投げない。
 */
export function checkWritePayload(expectation: WritePayloadExpectation, facts: WriteRequestFacts): WritePayloadDecision {
  try {
    if (!isValidExpectation(expectation)) {
      return 'EXPECTATION_INVALID';
    }
    const shape = requestShapeProblem(expectation.request, facts);
    if (shape !== null) {
      return shape;
    }
    const charset = charsetProblem(facts.documentCharset);
    if (charset !== null) {
      return charset;
    }
    const enctype = enctypeOf(facts.contentType);
    if (!enctype.ok) {
      return 'ENCTYPE_NOT_ALLOWED';
    }
    if (enctype.enctype !== expectation.request.enctype) {
      return 'ENCTYPE_MISMATCH';
    }
    const body = bodyBytesOf(facts);
    if (!body.ok) {
      return body.reason;
    }
    const parsed = enctype.boundary === null ? parseUrlencoded(body.bytes) : parseMultipart(body.bytes, enctype.boundary);
    if (!parsed.ok) {
      return parsed.reason;
    }
    return fieldsProblem(expectation, enctype.enctype, parsed.fields) ?? 'ALLOW';
  } catch {
    // 想定しない形の入力（getter が投げるなど）。値を文に入れずに止める。
    return 'EXPECTATION_INVALID';
  }
}
