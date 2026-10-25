// 要求の本文の部品の読み方の唯一の部品（CC-096 の B）。
// - CDP の本文の部品（`Network.Request.postDataEntries`。各部品の `bytes` は base64）を、部品ごとに base64 で decode して、bytes をつなぐ
//   （`decodeBase64BodyParts`）。decode は Node の `Buffer.from(…, 'base64')` のまま寛容に読む（base64 でない文字は飛ばし、`=` の後は読まない）。
//   `bytes` のない部品は、空として読む。大きさの上限は持たない（上限は、照合の owner の `write-payload-policy.ts` が見る）。
// - 本文があるか（`hasPostData`）・部品が読めるか（部品がない、`bytes` のない部品がある）の確かめは、読み口ごとに違うので、呼び出し側に残す:
//   Guard の書き込みの送信の本文（照合で通した承認の POST）、Guard の API の書き込みの照合の本文、ログインの資格情報の守りの本文の文字列
//   （`login-credential-guard.ts` の `requestBodyTextOf`。文字列にするのは、つないだ後）。
// - 照合の owner の部品ごとの読み方（base64 の形と大きさを確かめてから、部品ごとに latin1 の文字列にする）は、読み方が違うので、ここに寄せない。
// - 戻りは Gate `write-stage-boundary` の (b2) が止める。読み方は `tests/unit/request-body.test.ts` が固定する。

/** 本文の部品（CDP の `postDataEntries` の 1 つ。`bytes` は base64。file や blob の部品には `bytes` がない）。 */
export interface Base64BodyPart {
  readonly bytes?: string | undefined;
}

/** 本文の部品を、部品ごとに base64 で decode して、順につないだ bytes。部品がなければ空。 */
export function decodeBase64BodyParts(parts: readonly Base64BodyPart[]): Buffer {
  return Buffer.concat(parts.map((part) => Buffer.from(part.bytes ?? '', 'base64')));
}
