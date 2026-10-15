// T32k（CC-090）: スキーマのテストの補助（`tests/helpers/schema-test-support.ts`）が、`$ref` の先のないものと、語に当たる項目の名前を
// 見逃さないことの対照。補助を使うテストの「先のない `$ref` がない」「秘密の項目の名前がない」の確かめは、この補助の正しさに頼る。
import { describe, expect, it } from 'vitest';
import {
  absoluteRef,
  propertyNamesOf,
  propertyNamesWithWords,
  readSchemaFile,
  resolveRef,
  schemaRefsOf,
  SECRET_PROPERTY_WORDS,
} from '../helpers/schema-test-support.js';

const RUN_SCHEMA_ID = 'urn:beaksight:schema:run:1.0';

describe('schema test support (CC-090)', () => {
  it('resolves a $ref by the $id of a schema file, also in a subdirectory, and reports a missing target as undefined', () => {
    expect(resolveRef(`${RUN_SCHEMA_ID}#/properties/runId`)).toEqual(readSchemaFile('run.schema.json').properties?.['runId']);
    expect(resolveRef('urn:beaksight:schema:control:scenario:1#/properties/kind')).toBeDefined();
    expect(resolveRef(`${RUN_SCHEMA_ID}#/properties/noSuchProperty`)).toBeUndefined();
    expect(resolveRef('urn:beaksight:schema:no-such-schema:1#/properties/runId')).toBeUndefined();
    expect(absoluteRef(RUN_SCHEMA_ID, '#/$defs/x')).toBe(`${RUN_SCHEMA_ID}#/$defs/x`);
    expect(absoluteRef(RUN_SCHEMA_ID, 'urn:other#/x')).toBe('urn:other#/x');
  });

  it('collects every $ref and every property name at any depth', () => {
    const planted = {
      properties: { a: { $ref: '#/$defs/b' }, nested: { anyOf: [{ properties: { sessionCookie: { type: 'string' } } }] } },
      $defs: { b: { items: [{ $ref: 'urn:other#/c' }] } },
    };
    expect(schemaRefsOf(planted)).toEqual(['#/$defs/b', 'urn:other#/c']);
    expect(propertyNamesOf(planted)).toEqual(['a', 'nested', 'sessionCookie']);
    expect(propertyNamesWithWords(planted, SECRET_PROPERTY_WORDS)).toEqual(['sessioncookie']);
    expect(propertyNamesWithWords(planted, ['nothing'])).toEqual([]);
  });
});
