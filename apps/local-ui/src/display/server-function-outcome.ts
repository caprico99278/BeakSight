/**
 * Server Function の呼び出しの結果の読み方（DEF-146。FM-3 の表示の設定の `outcomeOf` と、ジョブの画面の止める要求・「ログインを終えた」を 1 つにまとめた）。
 * - 結果は、受け付けた（`ok: true`）・閉じた一覧の理由で拒まれた（`ok: false` と一覧の理由）・要求が届かなかった、の 3 つに読む。
 * - Server Function の呼び出しは、通信の誤りと入力の検証の誤り（400）で例外を投げる。入力の検証の誤りのとき、例外を投げずに結果の形でない値で終わる
 *   こともある（FM-3 の教訓）。どちらも「要求が届かなかった」（`REQUEST_FAILED`）にし、何も出さずに消さない。
 * - 読み方は例外を投げない（`settleServerFunction` は失敗しない Promise を返す）。
 */

/** 結果の読み方（受け付けた・拒まれた・要求が届かなかった）。 */
export type ServerFunctionOutcome<Accepted, Reason extends string> =
  | { readonly kind: 'ACCEPTED'; readonly result: Accepted }
  | { readonly kind: 'REJECTED'; readonly reason: Reason }
  | { readonly kind: 'REQUEST_FAILED' };

/** 要求が届かなかった（例外、結果の形でない値）。 */
const REQUEST_FAILED = Object.freeze({ kind: 'REQUEST_FAILED' } as const);

/** 閉じた一覧（理由ごとの説明のカタログ。鍵が一覧）の理由かの判定を作る。 */
export const closedListReason = <Reason extends string>(catalog: Readonly<Record<Reason, unknown>>) =>
  (value: unknown): value is Reason => typeof value === 'string' && Object.hasOwn(catalog, value);

/** 受け付けた結果に、呼び出し側が要る項目があるか（既定は、`ok: true` だけで受け付ける）。 */
const ANY_ACCEPTED = (): boolean => true;

/**
 * 結果の値を読む。`ok: true` で、呼び出し側の確かめ（`isAccepted`）に通れば受け付けた。`ok: false` で、理由が閉じた一覧の理由なら拒まれた。ほかは
 * 要求が届かなかった。
 */
export const serverFunctionOutcomeOf = <Accepted, Reason extends string>(
  result: unknown,
  isReason: (value: unknown) => value is Reason,
  isAccepted: (value: Readonly<Record<string, unknown>>) => boolean = ANY_ACCEPTED,
): ServerFunctionOutcome<Accepted, Reason> => {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    return REQUEST_FAILED;
  }
  const value = result as Readonly<Record<string, unknown>>;
  if (value['ok'] === true && isAccepted(value)) {
    return { kind: 'ACCEPTED', result: result as Accepted };
  }
  if (value['ok'] === false && isReason(value['reason'])) {
    return { kind: 'REJECTED', reason: value['reason'] };
  }
  return REQUEST_FAILED;
};

/** Server Function の呼び出しを待って、結果を読む（呼び出しが例外で終わったら、要求が届かなかった。失敗しない Promise）。 */
export const settleServerFunction = <Accepted, Reason extends string>(
  call: Promise<unknown>,
  isReason: (value: unknown) => value is Reason,
  isAccepted?: (value: Readonly<Record<string, unknown>>) => boolean,
): Promise<ServerFunctionOutcome<Accepted, Reason>> =>
  call.then(
    (result) => serverFunctionOutcomeOf<Accepted, Reason>(result, isReason, isAccepted),
    () => REQUEST_FAILED,
  );
