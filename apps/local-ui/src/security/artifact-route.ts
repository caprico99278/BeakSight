/**
 * 成果物の Server Routes の URL の決まり（Task 24 の設計書 4.5。T24f）。
 * - 成果物は `/artifacts/<jobId>/<Run のディレクトリからの相対パス>` で配る（`src/routes/artifacts/$jobId/$.tsx`。GET だけ）。
 * - 要求の守りの部品（`launcher/request-guard.ts`）は、この接頭辞の要求に、画面の CSP の代わりに、script を動かさない成果物の CSP を掛ける。
 *   守りの部品は Node の型の除去で動くので、このファイルは消せる型の書き方だけを使い、ほかのモジュールを import しない。
 * - 画面の部品（ジョブの詳細のリンク）も、ここの `artifactRoutePath` で URL を作る（接頭辞を 1 か所にする）。
 */

/**
 * 成果物の route が、`report.html` の `<head>` の `<style>` の中身の SHA-256（base64）を、要求の守りの部品に渡す、応答の内部の header の名前。
 * 守りの部品が読んで CSP に入れ、ブラウザへは送らない（どの path の応答からも消す）。値が複数なら `,` で区切る。
 */
export const ARTIFACT_STYLE_HASH_RESPONSE_HEADER = 'x-beaksight-artifact-style-sha256';

/** 成果物の Server Routes の URL の接頭辞。 */
export const ARTIFACT_ROUTE_PREFIX = '/artifacts/';

/**
 * 成果物の Server Routes の URL のパスか（接頭辞は大文字と小文字を区別しない。画面の Router の照合が区別しないので、成果物の CSP を
 * 掛け漏らさない側に倒す）。パスは、URL の構文で正規化した後のもの（`new URL(…).pathname`）を渡す。
 */
export const isArtifactRoutePath = (pathname: string): boolean => pathname.toLowerCase().startsWith(ARTIFACT_ROUTE_PREFIX);

/** ジョブの成果物の URL のパス（区切りごとにパーセント符号化する）。`relativePath` は Run のディレクトリからの相対パス（区切りは `/`）。 */
export const artifactRoutePath = (jobId: string, relativePath: string): string =>
  `${ARTIFACT_ROUTE_PREFIX}${encodeURIComponent(jobId)}/${relativePath.split('/').map((segment) => encodeURIComponent(segment)).join('/')}`;
