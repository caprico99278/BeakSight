// SD-1（設計書 `doc/design/2026-11-16-beaksight-action-based-delete-guard-design.md` 2.2）: 削除に関する操作の、操作の前の判定の単体テスト。
import { describe, expect, it } from 'vitest';
import { submitterWordsOf } from '../../src/discovery/classify.js';
import {
  crawlUrlHasDestructiveWord,
  destructiveActionFactsFrom,
  destructiveActionFactsOfNames,
  isAiAction,
  isAiRequest,
  isDestructiveAction,
  linkTextHasDestructiveWord,
  urlHasDestructiveWord,
  type DestructiveActionFacts,
} from '../../src/discovery/destructive-action.js';

const BASE = 'https://example.test/items';
const facts = (overrides: Partial<DestructiveActionFacts>): DestructiveActionFacts => ({ ...destructiveActionFactsOfNames([]), baseUrl: BASE, ...overrides });
const inFrame = (names: readonly string[], frameNames: readonly string[] = ['お知らせ']): DestructiveActionFacts =>
  facts({ names, frame: { names: frameNames } });

describe('押さない操作（設計書 2.2）', () => {
  it('削除の語の名前（足した語を含む）・削除の form・削除の語の送り先・行の ×・予約のキャンセル・削除の確かめの枠の中のボタン・削除の選択肢', () => {
    const cases: readonly DestructiveActionFacts[] = [
      ...['削除', 'Delete', 'ゴミ箱を空にする', 'クリア', 'Clear all', 'Move to trash', '初期化', '申し込みを取り下げる', 'リセット'].map((name) => facts({ names: [name] })),
      facts({ names: ['実行'], methods: ['DELETE'] }),
      facts({ names: ['送る'], methods: ['post', 'delete'] }),
      facts({ names: ['実行'], htmxDelete: true }),
      facts({ names: ['詳細'], urls: ['/items/1/destroy'] }),
      facts({ names: ['詳細'], urls: ['/items?action=remove'] }),
      facts({ names: ['×'], inRow: true }),
      inFrame(['キャンセル'], ['予約の確認']),
      inFrame(['Cancel'], ['Order details']),
      facts({ names: ['OK'], frame: { names: [] }, confirmText: 'この項目を削除しますか？' }),
      facts({ names: ['キャンセル'], frame: { names: [] }, confirmText: 'この項目を削除しますか？' }),
      facts({ names: ['実行'], chosenTexts: ['一括削除'] }),
    ];
    expect(cases.map(isDestructiveAction)).toEqual(cases.map(() => true));
  });
});

// AIW（2026-11-20 のユーザーの判断）: 名前に「AI」の語があるボタンは押さない（サイトの AI の生成を起こさない）。「生成」などの広い語は止めない。
describe('AI の操作', () => {
  it('名前に AI の語（語の境界つき・全角・人工知能）があるボタンだけを AI の操作とする', () => {
    const ai = ['AI で作り直す', 'AIで本文を編集', 'ＡＩに相談', '人工知能に聞く'].map((name) => facts({ names: [name] }));
    const plain = ['作成', 'QR コードを生成', 'レポートを生成', 'メールを送る', '詳細', 'MAIL', 'DETAIL'].map((name) => facts({ names: [name] }));
    expect(ai.map(isAiAction)).toEqual(ai.map(() => true));
    expect(plain.map(isAiAction)).toEqual(plain.map(() => false));
  });

  it('キラキラの印（✨・sparkle・magic・wand のアイコン）と、AI の枠の中の生成・作成・実行のボタンも AI の操作とする（枠の中の保存や、枠の外の生成は押す）', () => {
    const ai = [
      facts({ names: ['✨ 下書き'] }),
      facts({ names: ['下書き'], iconTokens: ['lucide lucide-sparkles'] }),
      facts({ names: [''], iconTokens: ['icon-magic-wand'] }),
      facts({ names: ['下書きを生成'], regionTexts: ['記事の下書きを自動作成する'] }),
      facts({ names: ['実行'], regionTexts: ['AI アシスタント'] }),
    ];
    const plain = [
      facts({ names: ['保存'], regionTexts: ['記事の下書きを自動作成する'] }),
      facts({ names: ['閉じる'], regionTexts: ['AI アシスタント'] }),
      facts({ names: ['QR コードを生成'] }),
      facts({ names: ['パスワードを生成'], regionTexts: ['アカウントの設定'] }),
      facts({ names: ['メール'], iconTokens: ['icon-mail'] }),
    ];
    expect(ai.map(isAiAction)).toEqual(ai.map(() => true));
    expect(plain.map(isAiAction)).toEqual(plain.map(() => false));
  });

  it('押下で出た AI の送信（path の区切りの AI の語・流し続ける答え）を見分け、静的なファイルと画面の移動は数えない', () => {
    const ai = [
      { url: 'https://api.example.test/functions/v1/assist-text', resourceType: 'fetch' },
      { url: 'https://api.example.test/v1/generate-summary', resourceType: 'fetch' },
      { url: 'https://api.example.test/chat/ai-reply', resourceType: 'xhr' },
      { url: 'https://example.test/stream', resourceType: 'fetch', contentType: 'text/event-stream; charset=utf-8' },
    ];
    const plain = [
      { url: 'https://example.test/static/js/generateChart.js', resourceType: 'script' },
      { url: 'https://example.test/ai/help', resourceType: 'document' },
      { url: 'https://example.test/api/mail', resourceType: 'fetch' },
      { url: 'https://example.test/api/details', resourceType: 'fetch' },
    ];
    expect(ai.map(isAiRequest)).toEqual(ai.map(() => true));
    expect(plain.map(isAiRequest)).toEqual(plain.map(() => false));
  });
});

describe('押す操作（止めすぎない）', () => {
  it('枠を閉じるキャンセル・閉じる・行の外の ×・ふつうのボタンと移動', () => {
    const cases: readonly DestructiveActionFacts[] = [
      inFrame(['キャンセル']),
      inFrame(['Cancel'], []),
      inFrame(['閉じる']),
      facts({ names: ['×'] }),
      inFrame(['×']),
      facts({ names: ['詳細を見る'], urls: ['/items/1', '#top', ''] }),
      facts({ names: ['保存'], methods: ['post'], chosenTexts: ['東京'] }),
    ];
    expect(cases.map(isDestructiveAction)).toEqual(cases.map(() => false));
  });

  it('枠の外の「キャンセル」と、行の中の「キャンセル」は削除に関する操作', () => {
    expect(isDestructiveAction(facts({ names: ['キャンセル'] }))).toBe(true);
    expect(isDestructiveAction(facts({ names: ['キャンセル'], inRow: true, frame: null }))).toBe(true);
  });
});

describe('語の一覧の分け方（設計者の判断 2026-11-16）', () => {
  it('足した語は操作の前の判定だけが使い、候補の submitterWords（識別の digest）は変えない', () => {
    expect(isDestructiveAction(facts({ names: ['ゴミ箱を空にする'] }))).toBe(true);
    expect(submitterWordsOf('ゴミ箱を空にする')).toEqual([]);
    expect(submitterWordsOf('Sign out')).toEqual(['sign-out', 'signout']);
  });

  it('巡回の URL には、既定の除外の語と区切りが `_` のログアウトの語だけを当てる', () => {
    expect(['/items/1/delete', '/a?op=cancel', '/sign_out', '/log_out'].map(crawlUrlHasDestructiveWord)).toEqual([true, true, true, true]);
    expect(['/blog/archive/2024', '/password/reset-guide', '/nuclear', '/trash/empty', `/${encodeURIComponent('削除')}`].map(crawlUrlHasDestructiveWord))
      .toEqual([false, false, false, false, false]);
  });
});

describe('URL とリンクの文字（要素の送り先と巡回の移動）', () => {
  it('要素の送り先は、path と query の削除の語に当たり、percent-encode を外した形でも当たる', () => {
    expect(['/items/1/delete', '/a?op=cancel', '/sign_out', `/${encodeURIComponent('削除')}`, 'https://example.test/trash/empty']
      .map((url) => urlHasDestructiveWord(url, BASE))).toEqual([true, true, true, true, true]);
    expect(['/about', '/items/1', 'https://example.test/news?page=2'].map((url) => urlHasDestructiveWord(url, BASE))).toEqual([false, false, false]);
  });

  it('リンクの見える文字・aria-label・title のどれかが削除の語に当たる', () => {
    expect(linkTextHasDestructiveWord({ anchorText: '詳細', ariaLabel: null, title: null })).toBe(false);
    expect(linkTextHasDestructiveWord({ anchorText: '削除', ariaLabel: null, title: null })).toBe(true);
    expect(linkTextHasDestructiveWord({ anchorText: '', ariaLabel: 'Log out', title: null })).toBe(true);
    expect(linkTextHasDestructiveWord({ anchorText: '', ariaLabel: null, title: 'Sign out' })).toBe(true);
  });
});

// REV-SD（設計者の判断 2026-11-16）の I-2・I-3・I-5・M-1・M-2。
describe('REV-SD: 抜けと止めすぎの直し', () => {
  const link = (anchorText: string, imageAlts?: readonly string[]) => ({ anchorText, ariaLabel: null, title: null, ...(imageAlts === undefined ? {} : { imageAlts }) });

  it('I-5: 英語の語は語の境界で比べる（ボタン・URL）', () => {
    expect(['ＤＥＬＥＴＥ', 'REMOVE', 'Remove item', 'Batch delete'].map((name) => isDestructiveAction(facts({ names: [name] })))).toEqual([true, true, true, true]);
    expect(['Presets', 'Nuclear', 'Cancellation policy'].map((name) => isDestructiveAction(facts({ names: [name] })))).toEqual([false, false, false]);
    expect(['/c/presets', '/c/topics-nuclear'].map(crawlUrlHasDestructiveWord)).toEqual([false, false]);
    expect(isDestructiveAction(facts({ names: ['詳細'], urls: ['/presets/1'] }))).toBe(false);
  });

  it('I-3: 操作の判定だけの語を足し、Hide と「止め」は足さない', () => {
    const added = ['非表示にする', '申請を撤回', '連携を解除', 'グループから退出', 'Unfollow', 'Unlink', 'Disconnect', 'Close account', 'Deactivate', 'Unsubscribe'];
    expect(added.map((name) => isDestructiveAction(facts({ names: [name] })))).toEqual(added.map(() => true));
    expect(['Hide details', '配信を止める'].map((name) => isDestructiveAction(facts({ names: [name] })))).toEqual([false, false]);
  });

  it('I-2: 枠を閉じる「キャンセル」は、枠の本文の目的語と削除の語も見る（閉じる・× は本文を見ない）', () => {
    expect(isDestructiveAction(facts({ names: ['キャンセル'], frame: { names: [], text: 'ご予約: 明日 10:00' } }))).toBe(true);
    expect(isDestructiveAction(facts({ names: ['キャンセル'], frame: { names: ['お知らせ'], text: 'ご注文を受け付けました。' } }))).toBe(true);
    expect(isDestructiveAction(facts({ names: ['キャンセル'], frame: { names: ['お知らせ'], text: '一般の文です。' } }))).toBe(false);
    expect(isDestructiveAction(facts({ names: ['閉じる'], frame: { names: [], text: 'ご予約: 明日 10:00' } }))).toBe(false);
  });

  it('M-2: リンクの文字には狭い一覧と日本語の動きの語だけを当て、名詞と「済」「一覧」などの続く語には当てない。M-1: 画像の alt も見る', () => {
    const kept = ['アーカイブ', 'Archives', 'キャンセル一覧', 'ゴミ箱', '削除済みの項目', '停止中のユーザー', 'Presets', 'Nuclear power', 'Batch jobs', 'キャンセルポリシー',
      '取り消し履歴', '会社の案内'];
    expect(kept.map((text) => linkTextHasDestructiveWord(link(text)))).toEqual(kept.map(() => false));
    const skipped = ['削除', 'ＤＥＬＥＴＥ', 'ログアウト', '解約する', '予約を取り消す', 'Cancel'];
    expect(skipped.map((text) => linkTextHasDestructiveWord(link(text)))).toEqual(skipped.map(() => true));
    expect(linkTextHasDestructiveWord(link('', ['削除']))).toBe(true);
  });
});

// REV-SD2（設計者の判断 2026-11-16）の I-2・M-5・M-6・M-7。
describe('REV-SD2: ログオフの語・足す語・名詞の続く語・URL の名詞', () => {
  const link = (anchorText: string) => ({ anchorText, ariaLabel: null, title: null });

  it('I-2: ログオフ・サインオフのリンクの文字と URL へ移らない', () => {
    expect(['ログオフ', 'サインオフ', 'Log off', 'Sign off'].map((text) => linkTextHasDestructiveWord(link(text)))).toEqual([true, true, true, true]);
    expect(['/a/logoff', '/a/Account/LogOff', '/a/signoff', '/a/log-off', '/a/sign_off'].map(crawlUrlHasDestructiveWord)).toEqual([true, true, true, true, true]);
  });

  it('M-5: ボタンの語に足し、「外す」「Leave」「抜ける」は足さない', () => {
    const added = ['履歴を消す', 'グループを脱退', 'Unregister', 'Uninstall', 'Opt out', 'Log off', 'Logoff', 'Sign off', 'サインオフ', 'ログオフ'];
    expect(added.map((name) => isDestructiveAction(facts({ names: [name] })))).toEqual(added.map(() => true));
    expect(['外す', 'Leave', '抜ける'].map((name) => isDestructiveAction(facts({ names: [name] })))).toEqual([false, false, false]);
  });

  it('M-6: リンクの文字で「の」「について」「方法」「できない」「依頼」が続く語には当てない（ボタンには当てる）', () => {
    const kept = ['削除の手順の説明', '退会について', '解約の方法', 'ログアウトできない場合', '削除依頼について'];
    expect(kept.map((text) => linkTextHasDestructiveWord(link(text)))).toEqual(kept.map(() => false));
    expect(isDestructiveAction(facts({ names: ['退会について'] }))).toBe(true);
    expect(linkTextHasDestructiveWord(link('項目の削除'))).toBe(true);
  });

  it('M-7: 巡回の URL に cancellation・deletion・removal を当て、ボタンとリンクの文字には当てない', () => {
    expect(['/orders/1/cancellation', '/account/deletion', '/items/removal'].map(crawlUrlHasDestructiveWord)).toEqual([true, true, true]);
    // REV-EV12 の M-3: 名詞の直後が案内の語（policy・guide・faq・help など）なら当てない。
    expect(['/help/cancellation-policy', '/deletion/faq', '/docs/removal_guide', '/cancellation/about'].map(crawlUrlHasDestructiveWord))
      .toEqual([false, false, false, false]);
    expect(['/items/1/deletion', '/reservations/9/cancellation', '/cancellation/9'].map(crawlUrlHasDestructiveWord)).toEqual([true, true, true]);
    expect(isDestructiveAction(facts({ names: ['Cancellation policy'] }))).toBe(false);
    expect(linkTextHasDestructiveWord(link('Cancellation policy'))).toBe(false);
  });
});

describe('ページから受け取った値の形', () => {
  it('形が違えば null、合えば同じ値の事実', () => {
    const value = facts({ names: ['a'], frame: { names: ['b'], text: 'c' } });
    expect(destructiveActionFactsFrom(JSON.parse(JSON.stringify(value)))).toEqual(value);
    expect(destructiveActionFactsFrom({ ...value, inRow: 'no' })).toBeNull();
    expect(destructiveActionFactsFrom({ ...value, frame: { names: 'x' } })).toBeNull();
    expect(destructiveActionFactsFrom(null)).toBeNull();
  });
});
