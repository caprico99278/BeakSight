// T29a（Task 29 の設計書 3 章、5 章）: 外部到達の語の一覧の owner（`src/control/data-rules/external-delivery-words.ts`）の検査。
// - 閉じた一覧（種類、名前の語、欄の型、autocomplete の値）: 凍結、比べる形（NFKC と大文字小文字の畳み込みの後）、重なりがない。
// - 判定の表（欄の名前・type・autocomplete）。英語の語は語の単位（発見の分類の `fieldNameWordsOf` と同じ分け方）、日本語の語は部分一致。
// 例の値は匿名の欄の名前だけ。
import { describe, expect, it } from 'vitest';
import {
  EXTERNAL_DELIVERY_AUTOCOMPLETE_TOKENS,
  EXTERNAL_DELIVERY_FIELD_TYPES,
  EXTERNAL_DELIVERY_KINDS,
  EXTERNAL_DELIVERY_NAME_WORDS,
  NOTIFICATION_NEGATION_WORDS,
  NOTIFICATION_OPT_OUT_OPTION_WORDS,
  externalDeliveryKindsOf,
  externalDeliveryKindsOfName,
  isNotificationOptOutValue,
  notificationFieldNameIsNegated,
  type ExternalDeliveryKind,
} from '../../src/control/data-rules/external-delivery-words.js';
import { foldNfkcCase } from '../../src/core/text.js';
import { CANDIDATE_FIELD_TYPES, type CandidateFieldType } from '../../src/discovery/candidate-contracts.js';
import { NO_CONSTRAINTS } from './discovery-candidate-samples.js';

const fieldOf = (name: string, type: CandidateFieldType = 'text', autocomplete: string | null = null) =>
  ({ name, type, constraints: { ...NO_CONSTRAINTS, autocomplete } });

describe('external delivery word lists (T29a)', () => {
  it('keeps the kinds and the lists closed, frozen, folded and without duplicates', () => {
    expect(EXTERNAL_DELIVERY_KINDS).toEqual(['EMAIL', 'PHONE', 'NOTIFICATION', 'ADDRESS']);
    for (const table of [EXTERNAL_DELIVERY_NAME_WORDS, EXTERNAL_DELIVERY_FIELD_TYPES, EXTERNAL_DELIVERY_AUTOCOMPLETE_TOKENS]) {
      expect(Object.isFrozen(table)).toBe(true);
      expect(Object.keys(table)).toEqual([...EXTERNAL_DELIVERY_KINDS]);
      const all: readonly string[] = Object.values(table).flat();
      expect(new Set(all).size, 'no word is listed twice, even under two kinds').toBe(all.length);
      for (const words of Object.values(table)) {
        expect(Object.isFrozen(words)).toBe(true);
        for (const word of words as readonly string[]) {
          expect(word.length, word).toBeGreaterThan(0);
          expect(foldNfkcCase(word), word).toBe(word);
        }
      }
    }
    expect(Object.values(EXTERNAL_DELIVERY_FIELD_TYPES).flat().every((type) => CANDIDATE_FIELD_TYPES.includes(type))).toBe(true);
  });

  it('has the words of the design', () => {
    expect(EXTERNAL_DELIVERY_NAME_WORDS.EMAIL).toEqual(expect.arrayContaining(['mail', 'email', 'メール']));
    expect(EXTERNAL_DELIVERY_NAME_WORDS.PHONE).toEqual(expect.arrayContaining(['tel', 'phone', 'fax', 'mobile', '電話', '携帯']));
    expect(EXTERNAL_DELIVERY_NAME_WORDS.NOTIFICATION).toEqual(expect.arrayContaining(['notify', 'sms', '通知', '配信']));
    expect(EXTERNAL_DELIVERY_NAME_WORDS.ADDRESS).toEqual(expect.arrayContaining(['address', 'zip', '住所']));
    expect(EXTERNAL_DELIVERY_FIELD_TYPES).toEqual({ EMAIL: ['email'], PHONE: ['tel'], NOTIFICATION: [], ADDRESS: [] });
    expect(EXTERNAL_DELIVERY_AUTOCOMPLETE_TOKENS.EMAIL).toEqual(['email']);
    expect(EXTERNAL_DELIVERY_AUTOCOMPLETE_TOKENS.PHONE.every((token) => token.startsWith('tel'))).toBe(true);
    expect(EXTERNAL_DELIVERY_AUTOCOMPLETE_TOKENS.PHONE).toEqual(expect.arrayContaining(['tel', 'tel-national', 'tel-local', 'tel-extension']));
    expect(EXTERNAL_DELIVERY_AUTOCOMPLETE_TOKENS.ADDRESS).toEqual(expect.arrayContaining(['street-address', 'address-line1', 'address-level1',
      'postal-code']));
  });
});

describe('external delivery judgement by the field name (T29a)', () => {
  it.each<readonly [string, readonly ExternalDeliveryKind[]]>([
    // メール
    ['email', ['EMAIL']],
    ['user_email', ['EMAIL']],
    ['eMail', ['EMAIL']],
    ['e-mail', ['EMAIL']],
    ['email2', ['EMAIL']],
    ['mailaddress', ['EMAIL']],
    ['ＥＭＡＩＬ', ['EMAIL']],
    ['メールアドレス', ['EMAIL']],
    ['mailAddress', ['EMAIL', 'ADDRESS']],
    ['email_address', ['EMAIL', 'ADDRESS']],
    ['gmail_flag', []],
    ['mailbox_size', []],
    // 電話
    ['tel', ['PHONE']],
    ['tel1', ['PHONE']],
    ['telNumber', ['PHONE']],
    ['TEL', ['PHONE']],
    ['phone_number', ['PHONE']],
    ['mobilePhone', ['PHONE']],
    ['fax', ['PHONE']],
    ['telephone', ['PHONE']],
    ['電話番号', ['PHONE']],
    ['携帯', ['PHONE']],
    ['hotel', []],
    ['title', []],
    ['intel_flag', []],
    // 通知
    ['notify_me', ['NOTIFICATION']],
    ['sms_opt_in', ['NOTIFICATION']],
    ['newsletter', ['NOTIFICATION']],
    ['send_notifications', ['NOTIFICATION']],
    ['subscribe', ['NOTIFICATION']],
    ['メルマガ配信', ['NOTIFICATION']],
    ['お知らせ', ['NOTIFICATION']],
    ['unsubscribe_reason', []],
    ['admin', []],
    // メールの配信（両方）
    ['mail_notify', ['EMAIL', 'NOTIFICATION']],
    ['メール配信', ['EMAIL', 'NOTIFICATION']],
    // 住所
    ['address', ['ADDRESS']],
    ['zip_code', ['ADDRESS']],
    ['postalCode', ['ADDRESS']],
    ['city', ['ADDRESS']],
    ['住所', ['ADDRESS']],
    ['郵便番号', ['ADDRESS']],
    ['capacity', []],
    // 外部に届かない欄
    ['name', []],
    ['name_kana', []],
    ['quantity', []],
    ['start_time', []],
    ['comment', []],
    ['備考', []],
    ['', []],
  ])('reads %j as %j', (name, kinds) => {
    expect(externalDeliveryKindsOfName(name)).toEqual(kinds);
    expect(externalDeliveryKindsOf(fieldOf(name))).toEqual(kinds);
  });
});

describe('joined names and promotion or consent words (T29R-fix-1: M-7, I-2)', () => {
  it.each<readonly [string, readonly ExternalDeliveryKind[]]>([
    // M-7: 区切りなしでつないだ名前
    ['mailaddr', ['EMAIL']],
    ['contactemail', ['EMAIL']],
    ['usermail', ['EMAIL']],
    ['メアド', ['EMAIL']],
    ['mobilephone', ['PHONE']],
    ['homephone', ['PHONE']],
    ['faxno', ['PHONE']],
    ['keitai', ['PHONE']],
    ['denwa', ['PHONE']],
    ['keitai_no', ['PHONE']],
    // I-2: 販促・案内・同意の語
    ['mailmagazine', ['NOTIFICATION']],
    ['mail_magazine', ['EMAIL', 'NOTIFICATION']],
    ['marketing_consent', ['NOTIFICATION']],
    ['optin', ['NOTIFICATION']],
    ['opt_in', ['NOTIFICATION']],
    ['promotion', ['NOTIFICATION']],
    ['promo_code_ok', ['NOTIFICATION']],
    ['campaign', ['NOTIFICATION']],
    ['show_ads', ['NOTIFICATION']],
    ['ご案内を受け取る', ['NOTIFICATION']],
    ['連絡を希望する', ['NOTIFICATION']],
    ['キャンペーン情報', ['NOTIFICATION']],
    ['広告の表示', ['NOTIFICATION']],
    // 当たらない名前（語の単位の比べ）
    ['admin', []],
    ['address_line', ['ADDRESS']],
    ['promoter_name', []],
    ['campaigner', []],
  ])('reads %j as %j', (name, kinds) => {
    expect(externalDeliveryKindsOfName(name)).toEqual(kinds);
  });
});

describe('the opt-out side of a notification choice (T29c)', () => {
  it('keeps the opt-out words frozen and folded', () => {
    expect(Object.isFrozen(NOTIFICATION_OPT_OUT_OPTION_WORDS)).toBe(true);
    for (const word of NOTIFICATION_OPT_OUT_OPTION_WORDS) {
      expect(foldNfkcCase(word), word).toBe(word);
    }
  });

  it('reads a negated notification field name with the negation words (T29c fix round 1)', () => {
    expect(Object.isFrozen(NOTIFICATION_NEGATION_WORDS)).toBe(true);
    for (const word of NOTIFICATION_NEGATION_WORDS) {
      expect(foldNfkcCase(word), word).toBe(word);
    }
    for (const name of ['no_newsletter', 'noMail', 'sms_opt_out', 'notify_not', 'メール配信不要', 'お知らせを受け取らない', 'dm_stop']) {
      expect(notificationFieldNameIsNegated(name), name).toBe(true);
    }
    for (const name of ['newsletter', 'notify', 'notice', 'note', 'メール配信', 'sms_opt_in', 'mail_ok']) {
      expect(notificationFieldNameIsNegated(name), name).toBe(false);
    }
  });

  it.each<readonly [string, boolean]>([
    ['no', true],
    [' NO ', true],
    ['0', true],
    ['false', true],
    ['off', true],
    ['不要', true],
    ['希望しない', true],
    ['受け取らない', true],
    ['メールを配信しない', true],
    ['yes', false],
    ['1', false],
    ['on', false],
    ['none_of', false],
    ['希望する', false],
    ['nothing', false],
  ])('reads the option %j as the opt-out side: %s', (value, expected) => {
    expect(isNotificationOptOutValue(value)).toBe(expected);
  });
});

describe('external delivery judgement by the type and autocomplete (T29a)', () => {
  it.each<readonly [string, ReturnType<typeof fieldOf>, readonly ExternalDeliveryKind[]]>([
    ['the email type', fieldOf('contact', 'email'), ['EMAIL']],
    ['the tel type', fieldOf('contact', 'tel'), ['PHONE']],
    ['the text type', fieldOf('contact', 'text'), []],
    ['autocomplete email', fieldOf('contact', 'text', 'email'), ['EMAIL']],
    ['autocomplete with a contact type', fieldOf('contact', 'text', 'work email'), ['EMAIL']],
    ['autocomplete tel-national with a section', fieldOf('contact', 'text', 'section-a shipping tel-national'), ['PHONE']],
    ['autocomplete in upper case', fieldOf('contact', 'text', 'TEL'), ['PHONE']],
    ['autocomplete tel-extension', fieldOf('x', 'text', 'tel-extension'), ['PHONE']],
    ['autocomplete postal-code', fieldOf('x', 'text', 'billing postal-code'), ['ADDRESS']],
    ['autocomplete street-address', fieldOf('x', 'textarea', 'street-address'), ['ADDRESS']],
    ['autocomplete address-level2', fieldOf('x', 'text', 'address-level2'), ['ADDRESS']],
    ['autocomplete on', fieldOf('x', 'text', 'on'), []],
    ['autocomplete off', fieldOf('x', 'text', 'off'), []],
    ['autocomplete username', fieldOf('x', 'text', 'username'), []],
    ['autocomplete with a partial token', fieldOf('x', 'text', 'telephone-ish'), []],
    ['the type, the name and autocomplete together', fieldOf('notify_phone', 'tel', 'email'), ['EMAIL', 'PHONE', 'NOTIFICATION']],
  ])('reads %s', (_label, field, kinds) => {
    expect(externalDeliveryKindsOf(field)).toEqual(kinds);
  });

  it('returns frozen lists and does not change the input', () => {
    const field = fieldOf('email', 'email', 'email');
    const before = JSON.stringify(field);
    const kinds = externalDeliveryKindsOf(field);
    expect(Object.isFrozen(kinds)).toBe(true);
    expect(Object.isFrozen(externalDeliveryKindsOfName('tel'))).toBe(true);
    expect(JSON.stringify(field)).toBe(before);
  });
});
