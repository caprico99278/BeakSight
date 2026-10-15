// CC-090（T32k）: スキーマのテストの補助（テストのファイルではない）。`schemas/` の JSON Schema を読み、`$ref` の先を解決し、項目の名前と
// `$ref` を集める。成果物のスキーマのテスト（`action-run-schema`・`action-evidence-schema`・`approval-summary-schema` など）が使い、
// テストのファイルに書き写さない。
// - `$ref` の先のファイルは、`schemas/` の下のファイル自身の `$id` から導く（`$id` と path の一覧を手で書かない）。
// - 秘密を持つ項目に見える名前の語は `SECRET_PROPERTY_WORDS` の 1 か所。テストごとに足す語（承認者の名前など）は、テストの側で足す。
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

/** テストで読む JSON Schema の形（使う鍵だけを型にする）。 */
export type JsonSchema = Record<string, unknown> & {
  readonly properties?: Record<string, JsonSchema>;
  readonly $defs?: Record<string, JsonSchema>;
  readonly anyOf?: readonly JsonSchema[];
  readonly oneOf?: readonly JsonSchema[];
  readonly required?: readonly string[];
  readonly $ref?: string;
};

const SCHEMAS_ROOT = resolve(process.cwd(), 'schemas');
const SCHEMA_FILE_SUFFIX = '.schema.json';

/** `schemas/` からの path（例: `control/scenario.schema.json`）のスキーマを読む。 */
export const readSchemaFile = (path: string): JsonSchema =>
  JSON.parse(readFileSync(resolve(SCHEMAS_ROOT, path), 'utf8')) as JsonSchema;

const schemaFilesUnder = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return schemaFilesUnder(path);
    }
    return entry.isFile() && entry.name.endsWith(SCHEMA_FILE_SUFFIX) ? [relative(SCHEMAS_ROOT, path).split(sep).join('/')] : [];
  });

let schemasById: ReadonlyMap<string, JsonSchema> | undefined;

/** `schemas/` の下のスキーマを、ファイル自身の `$id` で引ける形にする（1 回だけ読む）。 */
const schemaById = (id: string): JsonSchema | undefined => {
  schemasById ??= new Map(schemaFilesUnder(SCHEMAS_ROOT).flatMap((path) => {
    const schema = readSchemaFile(path);
    return typeof schema['$id'] === 'string' ? [[schema['$id'], schema] as const] : [];
  }));
  return schemasById.get(id);
};

/** `$ref`（`<$id>#<JSON Pointer>`）の先の部分のスキーマ。先がなければ undefined。 */
export const resolveRef = (ref: string): JsonSchema | undefined => {
  const [id = '', pointer = ''] = ref.split('#');
  let node: unknown = schemaById(id);
  if (node === undefined) {
    return undefined;
  }
  for (const token of pointer.split('/').slice(1)) {
    if (typeof node !== 'object' || node === null || !Object.hasOwn(node, token)) {
      return undefined;
    }
    node = (node as Record<string, unknown>)[token];
  }
  return node as JsonSchema;
};

/** `#` で始まる同じ文書の中の `$ref` を、その文書の `$id` からの形にする。 */
export const absoluteRef = (schemaId: string, ref: string): string => (ref.startsWith('#') ? `${schemaId}${ref}` : ref);

/** スキーマの中の `$ref` の値をすべて集める。 */
export const schemaRefsOf = (node: unknown, found: string[] = []): string[] => {
  if (Array.isArray(node)) {
    node.forEach((item) => schemaRefsOf(item, found));
  } else if (typeof node === 'object' && node !== null) {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') {
        found.push(value);
      }
      schemaRefsOf(value, found);
    }
  }
  return found;
};

/** 項目の名前（properties の鍵）をすべて集める。 */
export const propertyNamesOf = (node: unknown, found: string[] = []): string[] => {
  if (Array.isArray(node)) {
    node.forEach((item) => propertyNamesOf(item, found));
  } else if (typeof node === 'object' && node !== null) {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'properties' && typeof value === 'object' && value !== null) {
        found.push(...Object.keys(value));
      }
      propertyNamesOf(value, found);
    }
  }
  return found;
};

/** 名前の語の一覧のどれかを含む項目の名前（大文字と小文字を区別しない）。 */
export const propertyNamesWithWords = (node: unknown, words: readonly string[]): string[] =>
  propertyNamesOf(node).map((name) => name.toLowerCase()).filter((name) => words.some((word) => name.includes(word)));

/** 秘密を持つ項目に見える名前の語（資格情報・Cookie・CSRF のトークン・hidden の値・認証の状態）。 */
export const SECRET_PROPERTY_WORDS: readonly string[] = Object.freeze([
  'password', 'passwd', 'credential', 'secret', 'cookie', 'token', 'csrf', 'xsrf', 'hidden', 'storage', 'session', 'auth', 'header', 'username',
]);

/** 項目 `key` の部分のスキーマ（なければ空）。 */
export const prop = (node: JsonSchema | undefined, key: string): JsonSchema => node?.properties?.[key] ?? {};

/** `anyOf`（または `oneOf`）の最初の枝（null を許す項目の、値の側）。 */
export const firstOf = (node: JsonSchema): JsonSchema => (node.anyOf ?? node.oneOf ?? [])[0] ?? {};
