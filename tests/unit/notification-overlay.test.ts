// 通知の枠の見分け方（設計書 `doc/design/2026-11-06-beaksight-notification-overlay-design.md` 3.1）と、描く面の判定（3.5。DEF-204）の純粋な部品の単体テスト。
import { describe, expect, it } from 'vitest';
import { isPassThroughContainer, isTransparentColor, paintsOwnSurfaceOf, type OwnSurfaceFacts } from '../../src/core/own-surface.js';
import { foldNfkcCase } from '../../src/core/text.js';
import {
  DISCOVERY_DESTRUCTIVE_WORDS,
  NOTIFICATION_CLOSE_DESTRUCTIVE_OBJECT_PAIRS,
  NOTIFICATION_CLOSE_DESTRUCTIVE_OBJECT_WORDS,
  NOTIFICATION_CLOSE_OBJECT_WORDS,
  NOTIFICATION_CLOSE_SYMBOLS,
  NOTIFICATION_CLOSE_WORDS,
} from '../../src/discovery/classification-words.js';
import { destructiveActionFactsOfNames, type DestructiveActionFacts } from '../../src/discovery/destructive-action.js';
import {
  NOTIFICATION_OVERLAY_LIMITS,
  classifyNotificationFrames,
  isNotificationCloseName,
  notificationFrameDigestOf,
  type NotificationButtonRead,
  type NotificationCandidateRead,
  type NotificationFramesRead,
  type NotificationRect,
} from '../../src/interaction/notification-overlay.js';

/** 何も描かない要素の事実。 */
const EMPTY_SURFACE: OwnSurfaceFacts = Object.freeze({
  backgroundColor: 'rgba(0, 0, 0, 0)',
  backgroundImage: 'none',
  borderWidths: ['0px', '0px', '0px', '0px'],
  borderStyles: ['none', 'none', 'none', 'none'],
  borderColors: ['rgb(0, 0, 0)', 'rgb(0, 0, 0)', 'rgb(0, 0, 0)', 'rgb(0, 0, 0)'],
  outlineWidth: '0px',
  outlineStyle: 'none',
  outlineColor: 'rgb(0, 0, 0)',
  boxShadow: 'none',
  backdropFilter: 'none',
  hasOwnText: false,
  hasPseudoContent: false,
  replacedContent: false,
});
const PAINTED_SURFACE: OwnSurfaceFacts = Object.freeze({ ...EMPTY_SURFACE, backgroundColor: 'rgb(255, 255, 255)' });

describe('描く面の判定（DEF-204）', () => {
  it('透明な色は transparent と、不透明度の成分が 0 の色だけ', () => {
    expect(['transparent', 'rgba(0, 0, 0, 0)', 'rgb(0 0 0 / 0)', 'hsla(0, 0%, 0%, 0)'].map(isTransparentColor)).toEqual([true, true, true, true]);
    expect(['rgb(0, 0, 0)', 'rgba(0, 0, 0, 0.4)', 'rgb(0 0 0 / 0.5)', 'color-mix(in srgb, red, blue)', ''].map(isTransparentColor))
      .toEqual([false, false, false, false, false]);
  });

  it('背景・背景の画像・枠線・輪郭・影・背後のぼかし・文字・疑似要素・画像のどれかがあれば、描く面がある', () => {
    expect(paintsOwnSurfaceOf(EMPTY_SURFACE)).toBe(false);
    const painted: Partial<OwnSurfaceFacts>[] = [
      { backgroundColor: 'rgb(255, 255, 255)' },
      { backgroundImage: 'url("x.png")' },
      { borderWidths: ['0px', '1px', '0px', '0px'], borderStyles: ['none', 'solid', 'none', 'none'] },
      { outlineWidth: '2px', outlineStyle: 'solid' },
      { boxShadow: 'rgb(0, 0, 0) 0px 2px 4px 0px' },
      { backdropFilter: 'blur(4px)' },
      { hasOwnText: true },
      { hasPseudoContent: true },
      { replacedContent: true },
    ];
    expect(painted.map((overrides) => paintsOwnSurfaceOf({ ...EMPTY_SURFACE, ...overrides }))).toEqual(painted.map(() => true));
    // 幅のある線でも、線の種類がないか色が透明なら、描かない。
    expect(paintsOwnSurfaceOf({ ...EMPTY_SURFACE, borderWidths: ['3px', '3px', '3px', '3px'] })).toBe(false);
    expect(paintsOwnSurfaceOf({
      ...EMPTY_SURFACE,
      borderWidths: ['3px', '3px', '3px', '3px'],
      borderStyles: ['solid', 'solid', 'solid', 'solid'],
      borderColors: ['transparent', 'transparent', 'transparent', 'transparent'],
    })).toBe(false);
  });

  it('入れ物とみなすのは、描く面がなく pointer-events: none のときだけ（記録のない前の Evidence は数える）', () => {
    expect(isPassThroughContainer({ paintsOwnSurface: false, pointerEvents: 'none' })).toBe(true);
    expect(isPassThroughContainer({ paintsOwnSurface: false, pointerEvents: 'auto' })).toBe(false);
    expect(isPassThroughContainer({ paintsOwnSurface: true, pointerEvents: 'none' })).toBe(false);
    expect(isPassThroughContainer({})).toBe(false);
  });
});

describe('閉じる語（3.1 の 3）', () => {
  it('語の一覧は、比べる形（畳み込んだ形）で書き、サイトの文言を持たない一般の語だけ', () => {
    for (const word of [...NOTIFICATION_CLOSE_WORDS, ...NOTIFICATION_CLOSE_SYMBOLS]) {
      expect(foldNfkcCase(word)).toBe(word);
    }
    expect(NOTIFICATION_CLOSE_WORDS).toEqual(['閉じる', 'とじる', 'close', 'dismiss']);
    expect(NOTIFICATION_CLOSE_SYMBOLS).toEqual(['×', '✕', '✖']);
  });

  it('閉じる語（英語は語の境界、日本語は部分一致）と、記号だけの名前に当たる', () => {
    const hits = ['×', ' ✕ ', '✖', '閉じる', 'お知らせを閉じる', 'Close', 'close dialog', 'closeNotice', 'Dismiss', 'ＣＬＯＳＥ'];
    expect(hits.filter((name) => !isNotificationCloseName(name))).toEqual([]);
    const misses = ['', '  ', 'closet', 'enclosed', 'Help', 'OK', '2×3', 'x', 'Open the closet'];
    expect(misses.filter((name) => isNotificationCloseName(name))).toEqual([]);
  });

  it('NO-2: 日本語の語は名前の終わりにあるときだけ当て、英語のハイフンでつないだ複合の語には当てない', () => {
    expect(['お知らせを閉じる', '通知を閉じる。', 'メッセージを とじる', 'Close the notice'].filter((name) => !isNotificationCloseName(name)))
      .toEqual([]);
    expect(['お知らせを最小化', '閉じたタブを開く', '閉じる前に保存', 'Close-up photo', 'a close-knit team', 'close-button-less Close']
      .filter((name) => isNotificationCloseName(name))).toEqual([]);
  });

  it('fix round 2（SREV-1106 の I-1・I-2）: 閉じる語だけか、目的語が汎用の一覧か枠の名前のときだけ当てる', () => {
    expect(['Close account', 'アカウントを閉じる', 'Close ticket', 'ログオフして閉じる', 'Log out & close', 'Delete and close', '削除して閉じる', '退会して閉じる']
      .filter((name) => isNotificationCloseName(name))).toEqual([]);
    expect(['ご案内を閉じる', 'ダイアログを閉じる', 'Close the dialog', 'Close notifications', 'Dismiss banner', 'closeNotice']
      .filter((name) => !isNotificationCloseName(name))).toEqual([]);
    // 目的語が枠そのものの名前と一致するときは当てる（大文字小文字と空白の違いは同じにする）。
    expect(isNotificationCloseName('週末の予定を閉じる', ['週末の予定'])).toBe(true);
    expect(isNotificationCloseName('週末の予定を閉じる', ['別の名前'])).toBe(false);
    expect(isNotificationCloseName('Close  Weekly Tips', ['weekly tips'])).toBe(true);
    expect(NOTIFICATION_CLOSE_OBJECT_WORDS.every((word) => foldNfkcCase(word) === word)).toBe(true);
  });
});

const rect = (left: number, top: number, width: number, height: number): NotificationRect => ({ left, top, width, height });

const candidate = (overrides: Partial<NotificationCandidateRead> & Pick<NotificationCandidateRead, 'surface' | 'element'>): NotificationCandidateRead => ({
  shape: 'div[]',
  position: 'fixed',
  dialog: false,
  popover: false,
  inExcludedLandmark: false,
  landmarks: [],
  parent: -1,
  ...overrides,
});

const button = (overrides: Partial<NotificationButtonRead> & Pick<NotificationButtonRead, 'candidate' | 'chain' | 'element'>): NotificationButtonRead => ({
  text: '×',
  ariaLabel: '',
  title: '',
  disabled: false,
  rect: rect(0, 0, 24, 24),
  ...overrides,
});

const VIEWPORT = Object.freeze({ width: 1000, height: 500 });

describe('通知の枠の見分け（3.1 の 2〜4）', () => {
  it('入れ子では閉じるボタンを持ついちばん内側を枠にし、描く面は外から見て最初の描く面のある要素で計る', () => {
    const read: NotificationFramesRead = {
      viewport: VIEWPORT,
      surfaces: [
        { rect: rect(0, 0, 1000, 500), surface: EMPTY_SURFACE }, // 0: 全面の透明な入れ物
        { rect: rect(700, 300, 250, 150), surface: PAINTED_SURFACE }, // 1: 中の小さな枠（固定でない）
        { rect: rect(0, 0, 1000, 500), surface: EMPTY_SURFACE }, // 2: 外の固定の入れ物
        { rect: rect(100, 100, 200, 100), surface: PAINTED_SURFACE }, // 3: 中の固定の枠
      ],
      candidates: [
        candidate({ surface: 0, element: 0 }),
        candidate({ surface: 2, element: 1 }),
        candidate({ surface: 3, element: 2, parent: 1, shape: 'div[dialog]', dialog: true }),
      ],
      buttons: [
        button({ candidate: 0, chain: [0, 1], element: 3 }),
        button({ candidate: 2, chain: [3], element: 4, text: '', ariaLabel: 'Close' }),
      ],
      truncated: false,
    };
    const result = classifyNotificationFrames(read);
    expect(result.frames.map(({ candidate: index, status, closeButton }) => [index, status, closeButton])).toEqual([
      [0, 'DISMISSIBLE', 0],
      [2, 'DISMISSIBLE', 1],
    ]);
    expect(result.frames[0]?.surfaceAreaRatio).toBeCloseTo((250 * 150) / (1000 * 500), 6);
    expect(result.excluded).toEqual([{ candidate: 1, reason: 'CONTAINS_FRAME' }]);
  });

  it('閉じるボタンがない・押せない・閾値を超える枠と、ヘッダの中の枠を分ける', () => {
    const read: NotificationFramesRead = {
      viewport: VIEWPORT,
      surfaces: [
        { rect: rect(0, 0, 200, 50), surface: PAINTED_SURFACE },
        { rect: rect(0, 0, 300, 100), surface: PAINTED_SURFACE },
        { rect: rect(0, 0, 1000, 500), surface: PAINTED_SURFACE },
        { rect: rect(0, 0, 1000, 60), surface: PAINTED_SURFACE },
        { rect: rect(0, 0, 1000, 500), surface: EMPTY_SURFACE },
      ],
      candidates: [
        candidate({ surface: 0, element: 0 }),
        candidate({ surface: 1, element: 1 }),
        candidate({ surface: 2, element: 2 }),
        candidate({ surface: 3, element: 3, shape: 'header[]', inExcludedLandmark: true }),
        candidate({ surface: 4, element: 4 }),
      ],
      buttons: [
        button({ candidate: 0, chain: [0], element: 5, text: 'Help' }),
        button({ candidate: 1, chain: [1], element: 6, text: '閉じる', disabled: true }),
        button({ candidate: 2, chain: [2], element: 7, title: 'close' }),
        button({ candidate: 3, chain: [3], element: 8 }),
      ],
      truncated: true,
    };
    const result = classifyNotificationFrames(read);
    expect(result.frames.map(({ candidate: index, status, closeButton, surfaceAreaRatio }) => [index, status, closeButton, surfaceAreaRatio])).toEqual([
      [0, 'NO_CLOSE_BUTTON', null, (200 * 50) / (1000 * 500)],
      [1, 'CLOSE_BUTTON_DISABLED', null, (300 * 100) / (1000 * 500)],
      [2, 'TOO_LARGE', 2, 1],
      [4, 'NO_CLOSE_BUTTON', null, null],
    ]);
    expect(result.excluded).toEqual([{ candidate: 3, reason: 'IN_LAYOUT_LANDMARK' }]);
    expect(result.truncated).toBe(true);
    expect(NOTIFICATION_OVERLAY_LIMITS.maxViewportAreaRatio).toBe(0.6);
  });

  it('NO-2: form の送信ボタンと、名前に危険な語がある押せる要素は、閉じるボタンにしない', () => {
    const read: NotificationFramesRead = {
      viewport: VIEWPORT,
      surfaces: [{ rect: rect(0, 0, 200, 100), surface: PAINTED_SURFACE }, { rect: rect(0, 200, 200, 100), surface: PAINTED_SURFACE }],
      candidates: [candidate({ surface: 0, element: 0 }), candidate({ surface: 1, element: 1 })],
      buttons: [
        button({ candidate: 0, chain: [0], element: 2, text: '閉じる', formSubmitter: true }),
        button({ candidate: 1, chain: [1], element: 3, text: 'Close and delete' }),
      ],
      truncated: false,
    };
    expect(classifyNotificationFrames(read).frames.map(({ status }) => status)).toEqual(['NO_CLOSE_BUTTON', 'NO_CLOSE_BUTTON']);
  });

  it('SD-1（設計書 2026-11-16 2.2）: 行の ×・予約のキャンセル・削除の確かめの枠は押さず、枠を閉じるキャンセル・行の外の × は押す', () => {
    const cases: readonly (readonly [Partial<DestructiveActionFacts>, Partial<NotificationButtonRead>, boolean])[] = [
      [{ names: ['×'], inRow: true }, { text: '×' }, false],
      [{ names: ['キャンセル'], frame: { names: ['予約の確認'] } }, { text: 'キャンセル' }, false],
      [{ names: ['閉じる'], frame: { names: [] }, confirmText: 'この項目を削除しますか？' }, { text: '閉じる' }, false],
      [{ names: ['ゴミ箱を空にする'] }, { text: '', ariaLabel: 'ゴミ箱を空にする' }, false],
      [{ names: ['キャンセル'], frame: { names: ['お知らせ'] } }, { text: 'キャンセル' }, true],
      [{ names: ['×'] }, { text: '×' }, true],
      [{ names: ['閉じる'], frame: { names: ['お知らせ'] } }, { text: '閉じる' }, true],
    ];
    const read: NotificationFramesRead = {
      viewport: VIEWPORT,
      surfaces: cases.map((_, index) => ({ rect: rect(0, index * 60, 200, 50), surface: PAINTED_SURFACE })),
      candidates: cases.map((_, index) => candidate({ surface: index, element: index })),
      buttons: cases.map(([destructive, overrides], index) => button({
        candidate: index, chain: [index], element: cases.length + index, ...overrides,
        destructive: { ...destructiveActionFactsOfNames([]), ...destructive },
      })),
      truncated: false,
    };
    expect(classifyNotificationFrames(read).frames.map(({ status }) => status === 'DISMISSIBLE')).toEqual(cases.map(([, , pressed]) => pressed));
  });

  it('fix round 2（SREV-1106 の I-3〜I-5・M-3）: 移りうる要素（リンクの移動・外部スキーム・download・target・資格情報つきの URL）は閉じるボタンにしない', () => {
    const anchor = (href: string | null, extra: Partial<NonNullable<NotificationButtonRead['link']>> = {}): NotificationButtonRead['link'] => ({
      isAnchor: true, href, download: false, target: '', formAction: null, ...extra,
    });
    const links: NotificationButtonRead['link'][] = [
      anchor('/next'), anchor('mailto:someone@example.invalid'), anchor('tel:0000'), anchor('beaksight-test-app://close'),
      anchor('#', { download: true }), anchor('#', { target: '_blank' }), anchor('http://user:pass@127.0.0.1/next'),
      { isAnchor: false, href: null, download: false, target: '', formAction: 'mailto:someone@example.invalid' },
    ];
    const keeps: NotificationButtonRead['link'][] = [anchor(null), anchor(''), anchor('#'), anchor('#close'), anchor('#', { target: '_self' })];
    const statusOf = (link: NotificationButtonRead['link']): string | undefined => classifyNotificationFrames({
      viewport: VIEWPORT,
      surfaces: [{ rect: rect(0, 0, 200, 100), surface: PAINTED_SURFACE }],
      candidates: [candidate({ surface: 0, element: 0 })],
      buttons: [button({ candidate: 0, chain: [0], element: 1, text: '閉じる', ...(link === undefined ? {} : { link }) })],
      truncated: false,
      baseUrl: 'http://127.0.0.1/page',
    }).frames[0]?.status;
    expect(links.map(statusOf)).toEqual(links.map(() => 'NO_CLOSE_BUTTON'));
    expect(keeps.map(statusOf)).toEqual(keeps.map(() => 'DISMISSIBLE'));
  });

  it('fix round 2（SREV-1106 の I-2）: 危険な語に、ログオフ・サインアウト・sign off がある', () => {
    expect(DISCOVERY_DESTRUCTIVE_WORDS).toEqual(expect.arrayContaining(['signoff', 'sign-off', 'ログオフ', 'サインアウト']));
    const statusOf = (text: string): string | undefined => classifyNotificationFrames({
      viewport: VIEWPORT,
      surfaces: [{ rect: rect(0, 0, 200, 100), surface: PAINTED_SURFACE }],
      candidates: [candidate({ surface: 0, element: 0 })],
      buttons: [button({ candidate: 0, chain: [0], element: 1, text: '×', title: text })],
      truncated: false,
    }).frames[0]?.status;
    expect(['Sign off', 'サインアウト', 'ログオフ'].map(statusOf)).toEqual(['NO_CLOSE_BUTTON', 'NO_CLOSE_BUTTON', 'NO_CLOSE_BUTTON']);
  });

  it('fix round 3（SREV-1106 の再レビューの R-I1）: 枠の名前の目的語は、見える文字のないボタンで、壊す操作の目的語でないときだけ当てる', () => {
    const statusOf = (names: readonly string[], text: string, ariaLabel: string): string | undefined => classifyNotificationFrames({
      viewport: VIEWPORT,
      surfaces: [{ rect: rect(0, 0, 200, 100), surface: PAINTED_SURFACE }],
      candidates: [candidate({ surface: 0, element: 0, names })],
      buttons: [button({ candidate: 0, chain: [0], element: 1, text, ariaLabel })],
      truncated: false,
    }).frames[0]?.status;
    // 見える文字のない（アイコンか閉じる記号だけの）ボタンで、枠の名前と同じ目的語なら当てる。
    expect(statusOf(['お役立ち情報'], '', 'お役立ち情報を閉じる')).toBe('DISMISSIBLE');
    expect(statusOf(['Weekly tips'], '×', 'Close weekly tips')).toBe('DISMISSIBLE');
    // 見える文字のあるボタンは、枠の名前を目的語に使わない（汎用の目的語だけ）。
    expect(statusOf(['お役立ち情報'], 'お役立ち情報を閉じる', '')).toBe('NO_CLOSE_BUTTON');
    expect(statusOf(['お役立ち情報'], 'お知らせを閉じる', '')).toBe('DISMISSIBLE');
    // 壊す操作の目的語は、枠の名前と同じでも当てない。
    expect(statusOf(['アカウント'], '', 'アカウントを閉じる')).toBe('NO_CLOSE_BUTTON');
    expect(statusOf(['account'], '', 'Close account')).toBe('NO_CLOSE_BUTTON');
    expect(statusOf(['Premium plan'], '×', 'Close premium plan')).toBe('NO_CLOSE_BUTTON');
    expect(NOTIFICATION_CLOSE_DESTRUCTIVE_OBJECT_WORDS.every((word) => foldNfkcCase(word) === word)).toBe(true);
  });

  it('fix round 4（SREV-1106 の 3 回目の N-I2）: 壊す操作の目的語は日本語と英語の対で持ち、平らな一覧は対の語だけからなる', () => {
    expect(NOTIFICATION_CLOSE_DESTRUCTIVE_OBJECT_PAIRS.length).toBeGreaterThan(0);
    for (const [japanese, english] of NOTIFICATION_CLOSE_DESTRUCTIVE_OBJECT_PAIRS) {
      expect(japanese.length > 0 && !/^[\x20-\x7e]+$/u.test(japanese), japanese).toBe(true);
      expect(/^[a-z]+$/u.test(english), english).toBe(true);
    }
    expect([...new Set(NOTIFICATION_CLOSE_DESTRUCTIVE_OBJECT_WORDS)].sort())
      .toEqual([...new Set(NOTIFICATION_CLOSE_DESTRUCTIVE_OBJECT_PAIRS.flat())].sort());
    for (const word of ['プラン', 'ワークスペース', 'workspace', 'プロジェクト', 'project', '案件', 'case', 'ルーム', 'room', 'チャンネル', 'channel']) {
      expect(NOTIFICATION_CLOSE_DESTRUCTIVE_OBJECT_WORDS, word).toContain(word);
    }
    const statusOf = (names: readonly string[], text: string, ariaLabel: string, title = ''): string | undefined => classifyNotificationFrames({
      viewport: VIEWPORT,
      surfaces: [{ rect: rect(0, 0, 200, 100), surface: PAINTED_SURFACE }],
      candidates: [candidate({ surface: 0, element: 0, names })],
      buttons: [button({ candidate: 0, chain: [0], element: 1, text, ariaLabel, title })],
      truncated: false,
    }).frames[0]?.status;
    expect(statusOf(['プラン'], '×', 'プランを閉じる')).toBe('NO_CLOSE_BUTTON');
    expect(statusOf(['Workspace'], '', '', 'Close workspace')).toBe('NO_CLOSE_BUTTON');
    expect(statusOf(['お役立ち情報'], '', 'お役立ち情報を閉じる')).toBe('DISMISSIBLE');
  });

  it('面積の割合が閾値ちょうどなら閉じる対象にし、わずかに超えると外す', () => {
    const at = (width: number): string | undefined => classifyNotificationFrames({
      viewport: VIEWPORT,
      surfaces: [{ rect: rect(0, 0, width, 500), surface: PAINTED_SURFACE }],
      candidates: [candidate({ surface: 0, element: 0 })],
      buttons: [button({ candidate: 0, chain: [0], element: 1 })],
      truncated: false,
    }).frames[0]?.status;
    expect(at(600)).toBe('DISMISSIBLE');
    expect(at(601)).toBe('TOO_LARGE');
  });
});

describe('枠の識別の digest', () => {
  const facts = {
    shape: 'div[dialog]', position: 'fixed', dialog: true, popover: false, landmarks: ['main[]'], closeButtonNames: ['×', '', ''],
  };

  it('同じ形と閉じるボタンの名前なら同じで、形か名前が違えば違う。空白と大文字小文字の違いは同じにする', () => {
    const digest = notificationFrameDigestOf(facts);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(notificationFrameDigestOf({ ...facts, closeButtonNames: [' × ', '', ''] })).toBe(digest);
    expect(notificationFrameDigestOf({ ...facts, shape: 'section[dialog]' })).not.toBe(digest);
    expect(notificationFrameDigestOf({ ...facts, landmarks: [] })).not.toBe(digest);
    expect(notificationFrameDigestOf({ ...facts, closeButtonNames: ['閉じる', '', ''] })).not.toBe(digest);
    expect(notificationFrameDigestOf({ ...facts, closeButtonNames: null })).not.toBe(digest);
    expect(notificationFrameDigestOf({ ...facts, closeButtonNames: ['Close', '', ''] }))
      .toBe(notificationFrameDigestOf({ ...facts, closeButtonNames: ['close', '', ''] }));
  });

  // DEF-260: 判定には切らない全部の名前を使うが、digest は前と同じ 64 文字で切った名前から作る（digest を変えない）。
  it('DEF-260: 閉じるボタンの名前は、64 文字で切った形で digest に入れる', () => {
    const head = 'x'.repeat(64);
    expect(notificationFrameDigestOf({ ...facts, closeButtonNames: [`${head} delete`, '', ''] }))
      .toBe(notificationFrameDigestOf({ ...facts, closeButtonNames: [head, '', ''] }));
  });

  it('識別の事実は、画面の path と値を持たない（形・目印・閉じるボタンの名前だけ）', () => {
    expect(Object.keys(facts).sort()).toEqual(['closeButtonNames', 'dialog', 'landmarks', 'popover', 'position', 'shape']);
  });
});
