// T31b fix round 1（Task 31 の設計書 3 章の「同じ名前の hidden と checkbox の組（Rails 型）」）: 組の判定（`src/discovery/candidate-contracts.ts`。
// 純粋）。
// - 組: 同じ名前の欄がちょうど 2 つで、hidden の欄（型が `hidden`）のすぐ後に checkbox の欄がある。checkbox の「外した値」として組で扱う。
// - 同じ名前で 3 つ以上、順が逆、間に別の欄、hidden でない、checkbox でない、名前がない、は組にしない。組は候補（1 つの form）の欄の中だけで決まる。
// - 候補の欄の一覧は DOM の順（probe の `form.elements` の順。送信ボタンなどは含めない）。
// - 送る欄としての欄（`writeFieldsOfName`）: 組の名前は checkbox だけ、ほかは同じ名前の欄のすべて。
// 例の値は、匿名の値だけを使う。
import { describe, expect, it } from 'vitest';
import { checkboxHiddenPairsOf, writeFieldsOfName, type CandidateField } from '../../src/discovery/candidate-contracts.js';
import { isSendableReadCheckParameter, isSendableWriteFieldName } from '../../src/discovery/read-check-contracts.js';
import { sampleField } from './discovery-candidate-samples.js';

const hidden = (name: string): CandidateField => sampleField(name, 'hidden', { hasValue: true });
const checkbox = (name: string): CandidateField => sampleField(name, 'checkbox');

describe('T31b fix round 1: pairs of a hidden field and a checkbox with the same name', () => {
  it('finds a hidden field right before a checkbox of the same name, with the positions in the field list', () => {
    const fields = [sampleField('name'), hidden('newsletter'), checkbox('newsletter'), hidden('active'), checkbox('active')];
    expect(checkboxHiddenPairsOf(fields)).toEqual([
      { name: 'newsletter', hiddenIndex: 1, checkboxIndex: 2 },
      { name: 'active', hiddenIndex: 3, checkboxIndex: 4 },
    ]);
    expect(Object.isFrozen(checkboxHiddenPairsOf(fields))).toBe(true);
  });

  it.each([
    ['three fields of the same name', [hidden('a'), checkbox('a'), hidden('a')]],
    ['two checkboxes after the hidden field', [hidden('a'), checkbox('a'), checkbox('a')]],
    ['the reverse order', [checkbox('a'), hidden('a')]],
    ['another field between them', [hidden('a'), sampleField('x'), checkbox('a')]],
    ['a field that is not of the hidden type (only invisible)', [sampleField('a', 'text', { hidden: true }), checkbox('a')]],
    ['a radio button instead of a checkbox', [hidden('a'), sampleField('a', 'radio')]],
    ['a select instead of a checkbox', [hidden('a'), sampleField('a', 'select-one', { options: ['0', '1'] })]],
    ['two hidden fields', [hidden('a'), hidden('a')]],
    ['no name', [hidden(''), checkbox('')]],
    ['a hidden field alone', [hidden('a')]],
    ['a checkbox alone', [checkbox('a')]],
  ])('does not make a pair of %s', (_label, fields) => {
    expect(checkboxHiddenPairsOf(fields)).toEqual([]);
  });

  it('decides the pairs only within the fields of one candidate (one form)', () => {
    expect(checkboxHiddenPairsOf([hidden('a')])).toEqual([]);
    expect(checkboxHiddenPairsOf([checkbox('a')])).toEqual([]);
  });

  it('gives the checkbox of a pair as the field to send, and every field of the same name otherwise', () => {
    const fields = [hidden('newsletter'), checkbox('newsletter'), checkbox('tags'), checkbox('tags'), checkbox('ok'), hidden('ok')];
    expect(writeFieldsOfName(fields, 'newsletter')).toEqual([fields[1]]);
    expect(writeFieldsOfName(fields, 'tags')).toEqual([fields[2], fields[3]]);
    expect(writeFieldsOfName(fields, 'ok')).toEqual([fields[4], fields[5]]);
    expect(writeFieldsOfName(fields, 'missing')).toEqual([]);
  });

  // T31d の最初（T31b fix round 1 の発見事項 1 の判断）: 書き込みの送れる欄の判定は、`isSendableField` の owner（`read-check-contracts.ts`）に置く。
  it('sends the checkbox of a pair in a write, and keeps the READ judgement of the same name (all fields must be sendable)', () => {
    const fields = [hidden('newsletter'), checkbox('newsletter'), checkbox('ok'), hidden('ok'), sampleField('note')];
    expect(isSendableWriteFieldName({ fields }, 'newsletter')).toBe(true);
    expect(isSendableWriteFieldName({ fields }, 'ok')).toBe(false);
    expect(isSendableWriteFieldName({ fields }, 'note')).toBe(true);
    expect(isSendableWriteFieldName({ fields }, 'missing')).toBe(false);
    expect(isSendableWriteFieldName({ fields: [hidden('a'), sampleField('a', 'checkbox', { readonly: true })] }, 'a')).toBe(false);
    expect(isSendableReadCheckParameter({ fields }, 'newsletter')).toBe(false);
  });
});
