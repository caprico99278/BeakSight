// T31R-fix-1 の I-1（Task 31 の設計書 11 章の T31R の行、3 章の「削除にあたる変更の遮断」）: 危険な語・削除の語に当たる名前の欄の判定
// （`src/discovery/classify.ts` の `fieldNameHasRemovalWord`）。UPDATE では、状態の欄と同じく、この欄を変えずに保つだけにする。
// - 判定は、危険な語（`DISCOVERY_DESTRUCTIVE_WORDS`）と、欄の名前のためだけに足した削除の語（`DISCOVERY_REMOVAL_FIELD_WORDS`。閉じた一覧）の
//   どちらかに当たるか。比べ方は欄の名前の語の比べ（`fieldNameHasListedWord`。英語の語は語の単位の並び、日本語の語は部分一致）。
// - 削除の語は、危険な語の一覧には足さない（危険な語は、ボタンの文言・送信先の path に部分一致で当てる分類の一覧で、候補のスキーマの
//   `submitterWords` の enum でもあるため。`lock` のような短い語を部分一致で当てると `block`・`clock` にも当たる）。
// - 足した語ごとの、当たる名前と当たらない名前の表（誤って当たる名前がないかの確かめ）。
// 例の名前は匿名の名前だけ。
import { describe, expect, it } from 'vitest';
import {
  DISCOVERY_DESTRUCTIVE_WORDS,
  DISCOVERY_REMOVAL_FIELD_WORDS,
  DISCOVERY_STATE_FIELD_WORDS,
} from '../../src/discovery/classification-words.js';
import { fieldNameHasDestructiveWord, fieldNameHasRemovalWord } from '../../src/discovery/classify.js';
import { foldNfkcCase } from '../../src/core/text.js';

/** 独立レビュー（T31R）が挙げた名前（どれも当たる）。 */
const REVIEW_EXAMPLES = Object.freeze([
  '_destroy', 'delete_flag', 'delete_at', 'remove_photo', 'removeTag', 'purge', 'is_removed', 'trashed', 'withdrawn', 'void', 'unsubscribed', 'locked',
  'banned',
  // T31R2-fix-1 の M-1（再レビューが挙げた名前）。
  'is_unpublished', 'unlisted', 'expired_at', 'is_frozen', 'muted', 'dropped', 'kill_switch', 'opt_out', 'optOut', '凍結フラグ', 'ロック状態',
]);

/** 足した語ごとの、当たる名前と当たらない名前。 */
const ADDED_WORD_TABLE: readonly (readonly [word: string, hits: readonly string[], misses: readonly string[]])[] = [
  ['removed', ['is_removed', 'removed', 'removedAt'], ['removal_note', 'unremoved']],
  ['purged', ['purged', 'is_purged'], ['purger']],
  ['trash', ['trash', 'move_to_trash', 'inTrash'], ['trashcan_color']],
  ['trashed', ['trashed', 'is_trashed', 'trashedAt'], ['untrashed']],
  ['withdrawn', ['withdrawn', 'is_withdrawn'], ['withdrawal_amount']],
  ['void', ['void', 'is_void', 'voidFlag'], ['avoid_spam', 'voice', 'devoid']],
  ['voided', ['voided', 'voided_at'], ['avoided']],
  ['unsubscribed', ['unsubscribed', 'is_unsubscribed'], ['subscribed']],
  ['locked', ['locked', 'is_locked', 'lockedAt'], ['unlocked', 'clock']],
  ['banned', ['banned', 'is_banned'], ['banner_text', 'bandwidth']],
  ['blocked', ['blocked', 'is_blocked'], ['unblocked', 'blockquote']],
  ['destroyed', ['destroyed', 'is_destroyed'], ['indestructible']],
  ['erased', ['erased'], ['eraser']],
  ['discarded', ['discarded'], ['discardable']],
  ['terminated', ['terminated', 'is_terminated'], ['terminal_id']],
  ['revoked', ['revoked', 'revokedAt'], ['revocable']],
  ['deactivated', ['deactivated', 'is_deactivated'], ['activated']],
  ['wiped', ['wiped'], ['wiper']],
  // T31R2-fix-1 の M-1: 足した語。基の形（`lock`・`block`・`ban`・`drop`）は `lock_version`・`block_size` も保つだけにする（止める側）。
  ['unpublished', ['unpublished', 'is_unpublished'], ['published_at']],
  ['unpublish', ['unpublish', 'unpublish_at'], ['publisher']],
  ['unlisted', ['unlisted', 'is_unlisted'], ['listed_at']],
  ['delisted', ['delisted'], ['listed']],
  ['expired', ['expired', 'expired_at', 'isExpired'], ['expires_at', 'expiry_date']],
  ['retired', ['retired', 'is_retired'], ['retirement_age']],
  ['obsolete', ['obsolete', 'is_obsolete'], ['obsoletes_note']],
  ['frozen', ['frozen', 'is_frozen'], ['unfrozen']],
  ['freeze', ['freeze', 'freeze_flag'], ['freezer']],
  ['muted', ['muted', 'is_muted'], ['mute_ratio']],
  ['drop', ['drop', 'drop_flag'], ['dropdown_value', 'droplet']],
  ['dropped', ['dropped', 'is_dropped'], ['droppedness']],
  ['kill', ['kill', 'kill_switch'], ['skill', 'killer']],
  ['ban', ['ban', 'ban_flag'], ['banner_text', 'bank_name']],
  ['lock', ['lock', 'lock_version', 'isLock'], ['clock_in', 'unlock_code']],
  ['block', ['block', 'block_size'], ['blockquote', 'unblock_reason']],
  ['unregistered', ['unregistered', 'is_unregistered'], ['registered_at']],
  ['deregistered', ['deregistered'], ['registered']],
  ['opt_out', ['opt_out', 'optOut', 'opt-out', 'email_opt_out'], ['opt_in', 'output', 'option_out_of_stock']],
  ['凍結', ['凍結', '凍結フラグ'], ['冷凍']],
  ['ロック', ['ロック', 'ロック状態', 'ブロック'], ['ロッカー番号']],
  ['廃棄', ['廃棄', '廃棄日'], ['廃材']],
  ['非掲載', ['非掲載', '非掲載フラグ'], ['掲載日']],
  ['掲載終了', ['掲載終了', '掲載終了日'], ['掲載開始日']],
  ['ブロック', ['ブロック', 'ブロック中'], ['ブロッコリー']],
];

/** 普通の欄の名前（どの語にも当たらない。誤って当たらないことの確かめ）。 */
const ORDINARY_NAMES = Object.freeze([
  'name', 'email', 'note', 'phone', 'invoice_number', 'banner_text', 'voice_memo', 'clock_in', 'avoid_spam',
  'withdrawal_amount', 'removal_note', 'unlocked_at', 'blockquote', 'trashcan_color', 'code_name', 'title',
]);

describe('T31R-fix-1 I-1: the removal words of the field names', () => {
  it.each(REVIEW_EXAMPLES)('marks %s (the examples of the review) as a field that can only be kept', (name) => {
    expect(fieldNameHasRemovalWord(name)).toBe(true);
  });

  it.each(ADDED_WORD_TABLE.map(([word, hits, misses]) => [word, hits, misses] as const))(
    'matches the added word %s word by word, not inside another word',
    (_word, hits, misses) => {
      expect(hits.filter((name) => !fieldNameHasRemovalWord(name))).toEqual([]);
      expect(misses.filter((name) => fieldNameHasRemovalWord(name))).toEqual([]);
    },
  );

  it('does not mark the ordinary field names', () => {
    expect(ORDINARY_NAMES.filter((name) => fieldNameHasRemovalWord(name))).toEqual([]);
  });

  it('includes every name with a dangerous word (one shared judgement), and the added words are only for field names', () => {
    for (const name of ['delete_flag', 'remove_photo', '_destroy', 'cancel_reason', '削除フラグ']) {
      expect(fieldNameHasDestructiveWord(name), name).toBe(true);
      expect(fieldNameHasRemovalWord(name), name).toBe(true);
    }
    // 足した語は、危険な語の一覧（分類と候補のスキーマの enum）を変えない。
    expect(DISCOVERY_REMOVAL_FIELD_WORDS.filter((word) => (DISCOVERY_DESTRUCTIVE_WORDS as readonly string[]).includes(word))).toEqual([]);
  });

  it('keeps the closed list frozen, folded, without duplicates and apart from the state field words', () => {
    expect(Object.isFrozen(DISCOVERY_REMOVAL_FIELD_WORDS)).toBe(true);
    expect(DISCOVERY_REMOVAL_FIELD_WORDS.map((word) => foldNfkcCase(word))).toEqual([...DISCOVERY_REMOVAL_FIELD_WORDS]);
    expect(new Set(DISCOVERY_REMOVAL_FIELD_WORDS).size).toBe(DISCOVERY_REMOVAL_FIELD_WORDS.length);
    // 状態の欄の語（`deleted`・`archived`・`suspended` など）は、状態の欄の判定が保つだけにする（重ねて持たない）。
    expect(DISCOVERY_REMOVAL_FIELD_WORDS.filter((word) => (DISCOVERY_STATE_FIELD_WORDS as readonly string[]).includes(word))).toEqual([]);
    expect(ADDED_WORD_TABLE.map(([word]) => word)).toEqual([...DISCOVERY_REMOVAL_FIELD_WORDS]);
  });
});
