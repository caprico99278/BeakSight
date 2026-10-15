// T31a（Task 31 の設計書 3 章の「削除にあたる変更の遮断」、5 章）: 状態の欄の名前の語（`DISCOVERY_STATE_FIELD_WORDS`）を足した後の、
// 欄の名前の比べ（`src/discovery/classify.ts` の `fieldNameHasStateWord`）の表。
// - 足した語ごとに、当たる名前と当たらない名前（短い語は語の単位で比べる。`model` は `del` に、`showroom` は `show` に当たらない）。
// - `display`・`show`・`表示` は、名前・順・ラベルの語（`DISCOVERY_STATE_FIELD_LABEL_WORDS`）が続く形では当てない（閉じた例外の一覧）。
// - 今まで当たっていた名前は、今も当たる（狭めない）。
// 例の名前は匿名の名前だけ。
import { describe, expect, it } from 'vitest';
import {
  DISCOVERY_STATE_FIELD_LABEL_WORDS,
  DISCOVERY_STATE_FIELD_LABELED_WORDS,
  DISCOVERY_STATE_FIELD_WORDS,
} from '../../src/discovery/classification-words.js';
import { classifyCandidate, fieldNameHasStateWord } from '../../src/discovery/classify.js';
import { SAMPLE_ALLOWED_ORIGINS, sampleField, sampleForm } from './discovery-candidate-samples.js';

/** 足した語ごとの、当たる名前と当たらない名前（設計書 3 章の例を含む）。 */
const ADDED_WORD_TABLE: readonly (readonly [word: string, hits: readonly string[], misses: readonly string[]])[] = [
  ['hidden', ['is_hidden', 'hidden_flag', 'isHidden', 'hidden'], ['unhidden', 'forbidden']],
  ['hide', ['hide', 'hide_flag', 'isHide'], ['hideout', 'chide']],
  // T31a fix round 1: `show` も、名前・順・ラベルの語が続く所では当てない。
  ['show', ['show_flag', 'show', 'isShow', 'show_on_top', 'shows'], ['showroom', 'showcase', 'shower', 'show_order', 'showName', 'show_name', 'showTitle']],
  ['shown', ['shown', 'is_shown'], ['shownote']],
  ['display', ['display', 'display_flag', 'displayStatus', 'display_kbn', 'displays'],
    ['display_name', 'displayName', 'display_order', 'displayTitle', 'display_label', 'display_names', 'displayer']],
  ['displayed', ['displayed', 'is_displayed'], ['displayedness']],
  ['flag', ['hidden_flag', 'delete_flag', 'flag', 'deleteFlag', 'flags'], ['flagship', 'flagstone']],
  ['flg', ['del_flg', 'delFlg', 'flg', 'DEL_FLG', 'flg1'], ['flgx', 'aflg']],
  ['del', ['del_flg', 'del', 'is_del', 'delFlag', 'del2'], ['model', 'delivery', 'delta', 'idle']],
  ['delflg', ['delflg', 'DELFLG', 'item_delflg'], ['delflgx']],
  ['delflag', ['delflag', 'DELFLAG'], ['delflagx']],
  ['deleteflg', ['deleteflg'], ['deleteflgx']],
  ['deleteflag', ['deleteflag', 'DELETEFLAG'], ['deleteflagx']],
  ['closed', ['closed', 'is_closed', 'closedAt', 'closed_at'], ['closet', 'enclosed']],
  ['cancel', ['cancel_flag', 'cancel', 'isCancel'], ['cancellation_reason', 'cancelable']],
  ['cancelled', ['cancelled', 'is_cancelled'], ['uncancelled']],
  ['canceled', ['canceled', 'isCanceled'], ['uncanceled']],
  ['suspend', ['suspend', 'suspend_flag'], ['suspender']],
  ['suspended', ['suspended', 'is_suspended'], ['unsuspended']],
  ['stop', ['stop', 'stop_flag', 'isStop'], ['stopwatch', 'nonstop', 'stopover']],
  ['stopped', ['stopped', 'is_stopped'], ['unstopped']],
  ['表示', ['表示', '表示フラグ', '表示区分', 'display_表示', '表示 フラグ'], ['表示名', '表示順', '表示名称', '表示 名', '表示_name', '表示順序', '表示names']],
  ['非表示', ['非表示', '非表示フラグ', 'is_非表示'], ['表示名']],
  ['ステータス', ['ステータス', '会員ステータス', 'ｽﾃｰﾀｽ'], ['ステータ', 'ステップ']],
  ['停止', ['停止', '停止フラグ', '利用停止'], ['停車']],
  ['取消', ['取消', '取消区分'], ['取引']],
  ['取り消', ['取り消し', '取り消しフラグ'], ['取り込み']],
  ['キャンセル', ['キャンセル', 'ｷｬﾝｾﾙ', 'キャンセル区分'], ['キャンプ']],
  ['休止', ['休止', '休止中'], ['休日']],
  ['中止', ['中止', '中止フラグ'], ['中心']],
  ['非公開', ['非公開', '非公開フラグ'], ['非常']],
  ['退会', ['退会', '退会日'], ['入会']],
];

/** 設計書 3 章の例（当たる名前）。 */
const DESIGN_HITS: readonly string[] = [
  'is_hidden', 'hidden_flag', 'show_flag', 'display', 'display_flag', 'del_flg', 'delete_flag', 'closed', 'is_closed', 'cancel_flag', 'status_cd',
  '表示', '非表示', '表示フラグ', 'ステータス', '公開状態', '停止', '取消',
];

/** 設計書 3 章の例（当たらない名前）。 */
const DESIGN_MISSES: readonly string[] = [
  'display_name', 'displayName', '表示名', '表示順', 'model', 'delivery', 'showroom', 'flagship', 'closet', 'stopwatch',
];

/** T31a の前から当たっていた名前（狭めない）。 */
const EARLIER_HITS: readonly string[] = [
  'active', 'is_active', 'isActive', 'STATUS', 'statusCode', 'deleted_at', 'isDeleted', 'enabled', 'archived', 'published', 'state',
  'user[status]', '状態', '公開設定', '有効', 'visibility', 'disabled', 'inactive', '無効', '削除フラグ', '公開', 'is_visible',
  'ＳＴＡＴＵＳ', 'status-code', 'item.status',
];

/** T31a の前から当たらなかった名前のうち、今も当たらない名前。 */
const EARLIER_MISSES: readonly string[] = ['estate', 'name', 'stated_reason', 'activity', 'q', '', 'title', 'price', 'quantity', 'email', 'tel'];

describe('T31a: the added state field words, word by word', () => {
  it.each(ADDED_WORD_TABLE.map(([word, hits, misses]) => [word, hits, misses] as const))(
    '%s: hits and misses',
    (word, hits, misses) => {
      expect(DISCOVERY_STATE_FIELD_WORDS, word).toContain(word);
      for (const name of hits) {
        expect(fieldNameHasStateWord(name), name).toBe(true);
      }
      for (const name of misses) {
        expect(fieldNameHasStateWord(name), name).toBe(false);
      }
    },
  );

  it('reads the examples of the design (3: blocking deleting changes)', () => {
    for (const name of DESIGN_HITS) {
      expect(fieldNameHasStateWord(name), name).toBe(true);
    }
    for (const name of DESIGN_MISSES) {
      expect(fieldNameHasStateWord(name), name).toBe(false);
    }
  });

  it('keeps every name that hit before T31a, and the misses that are still not state fields', () => {
    for (const name of EARLIER_HITS) {
      expect(fieldNameHasStateWord(name), name).toBe(true);
    }
    for (const name of EARLIER_MISSES) {
      expect(fieldNameHasStateWord(name), name).toBe(false);
    }
  });

  it('does not let a following name, order or label word hide another state word of the name', () => {
    for (const name of ['display_name_flag', 'show_order_flag', 'display_order_status', '表示名_状態', '表示順と非表示', 'display_name_display', '表示名と表示']) {
      expect(fieldNameHasStateWord(name), name).toBe(true);
    }
  });

  it('marks the candidates with the added words (the mark of the discovery index)', () => {
    const marked = (name: string): boolean =>
      classifyCandidate(sampleForm({ fields: [sampleField(name)] }), { allowedOrigins: SAMPLE_ALLOWED_ORIGINS }).hasStateField;
    expect(marked('del_flg')).toBe(true);
    expect(marked('表示フラグ')).toBe(true);
    expect(marked('display_name')).toBe(false);
    expect(marked('model')).toBe(false);
  });

  it('keeps the closed lists frozen, folded and without duplicates', () => {
    for (const words of [DISCOVERY_STATE_FIELD_WORDS, DISCOVERY_STATE_FIELD_LABEL_WORDS, DISCOVERY_STATE_FIELD_LABELED_WORDS]) {
      expect(Object.isFrozen(words)).toBe(true);
      expect(new Set(words).size).toBe(words.length);
      for (const word of words) {
        expect(word.length, word).toBeGreaterThan(0);
        expect(word.normalize('NFKC').toUpperCase().toLowerCase(), word).toBe(word);
      }
    }
    expect([...DISCOVERY_STATE_FIELD_LABELED_WORDS]).toEqual(['display', 'show', '表示']);
    expect([...DISCOVERY_STATE_FIELD_LABEL_WORDS]).toEqual(['name', 'order', 'label', 'title', '名', '順', '名称']);
    // 例外の語は、状態の欄の語の一覧の語。
    for (const word of DISCOVERY_STATE_FIELD_LABELED_WORDS) {
      expect(DISCOVERY_STATE_FIELD_WORDS).toContain(word);
    }
  });
});
