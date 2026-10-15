// T27R-fix-2（T27R-fix-1 の報告の発見事項 3）: 発見の probe が、送信ボタンの文言を `input` の `value` と画像の送信ボタンの `alt` から読み、分類の
// 語（`submitterWords`）に変えることを確かめる fixture のサーバ（テストの補助）。`tests/helpers/discovery-fixture.ts` とは別のファイルにする
// （並行の作業がそちらに触るため）。
// - 127.0.0.1 だけで待ち受ける。サーバに届いた要求を、すべて順に記録する（method と path）。
// - 画面（`SUBMITTER_WORDS_FIXTURE_PATHS`）:
//   - `inputValue`: `input type=submit` の `value` に語のある POST の form 2 つ（`削除する`、`Save`）、`input type=button`・`type=reset` の `value`
//     に語のある form の外と form の中のボタン（`編集`、`取消`）。
//   - `imageAlt`: 画像の送信ボタン（`input type=image`）の `alt` に語のある GET の form（`検索`）と POST の form（`削除`）。
//   - `notRead`: 対照。語を、probe が読まない属性（`data-label`、`name`、`input type=submit` の `alt`、`input type=image` の `value`）にだけ置いた
//     form（語は 0 件になる）。
// - どの画面も、アイコンに `data:` の URL を指定する（ブラウザ自身のアイコンの要求を出さないため）。画像は `data:` の URL（ネットワークを使わない）。
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

const STATUS_OK = 200;
const STATUS_NO_CONTENT = 204;
const STATUS_NOT_FOUND = 404;
/** 1 画素の透明な GIF（`data:` の URL。画像の送信ボタンの `src`）。 */
const PIXEL_GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/** fixture の画面のパス。 */
export const SUBMITTER_WORDS_FIXTURE_PATHS = Object.freeze({
  inputValue: '/input-value',
  imageAlt: '/image-alt',
  notRead: '/not-read',
} as const);

/** サーバに届いた要求。 */
export interface SubmitterWordsFixtureRequest {
  readonly method: string;
  readonly path: string;
}

export interface SubmitterWordsFixture {
  readonly origin: string;
  readonly requests: readonly SubmitterWordsFixtureRequest[];
  url(path: string): string;
  close(): Promise<void>;
}

const page = (title: string, body: string): string => '<!doctype html><html lang="ja"><head><meta charset="utf-8">'
  + `<link rel="icon" href="data:,"><title>${title}</title></head><body>${body}</body></html>`;

const BODIES: Readonly<Record<string, string>> = Object.freeze({
  [SUBMITTER_WORDS_FIXTURE_PATHS.inputValue]: page('input の value', `
    <form method="post" action="/items/remove"><input type="text" name="note"><input type="submit" value="削除する"></form>
    <form method="post" action="/items/save"><input type="text" name="title"><input type="submit" value="Save"></form>
    <form method="post" action="/items/other"><input type="text" name="memo"><input type="reset" value="取消"><input type="submit" value="確定"></form>
    <input type="button" value="編集">`),
  [SUBMITTER_WORDS_FIXTURE_PATHS.imageAlt]: page('画像の送信ボタン', `
    <form method="get" action="/items"><input type="search" name="q"><input type="image" src="${PIXEL_GIF}" alt="検索"></form>
    <form method="post" action="/items/drop"><input type="image" src="${PIXEL_GIF}" alt="削除"></form>`),
  [SUBMITTER_WORDS_FIXTURE_PATHS.notRead]: page('読まない属性', `
    <form method="post" action="/items/a"><input type="submit" value="確定" data-label="削除" alt="削除" name="delete"></form>
    <form method="post" action="/items/b"><input type="image" src="${PIXEL_GIF}" alt="確定" value="削除"></form>`),
});

/** fixture のサーバを 127.0.0.1 で起動する。 */
export async function startSubmitterWordsFixture(): Promise<SubmitterWordsFixture> {
  const requests: SubmitterWordsFixtureRequest[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = request.url ?? '/';
    requests.push({ method: request.method ?? '', path });
    request.resume();
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(STATUS_NO_CONTENT);
      response.end();
      return;
    }
    const body = BODIES[path.split('?')[0] ?? path];
    if (body === undefined) {
      response.writeHead(STATUS_NOT_FOUND, { 'content-type': 'text/html; charset=utf-8' });
      response.end(page('404', 'not found'));
      return;
    }
    response.writeHead(STATUS_OK, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(body);
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    requests,
    url: (path: string): string => `${origin}${path}`,
    close: () => new Promise<void>((resolveClose) => {
      server.closeAllConnections();
      server.close(() => resolveClose());
    }),
  };
}
