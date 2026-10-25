import { readFile } from 'node:fs/promises';
import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import { jsonPointerOf } from './json-pointer.js';

export type ArtifactSchemaName =
  | 'run'
  | 'audit'
  | 'page'
  | 'finding'
  | 'checkpoint'
  | 'checkpoint-page'
  | 'site-unavailable-diagnostic'
  | 'discovery'
  | 'read-evidence'
  | 'action-run'
  | 'action-evidence'
  | 'approval-summary'
  | 'entry-check';

/** スキーマの検証の結果（成果物と Control の契約で共通）。 */
export type SchemaValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly errors: readonly string[] };

export type ArtifactValidationResult = SchemaValidationResult;

/**
 * スキーマの誤り 1 件と、その位置（CC-086。CCX-24）。誤りの文から位置を読み取らずに済むように、検証の部品が構造で返す。
 * - `message`: `describeSchemaError` の文（同じ結果の `errors` の、同じ順の文と同じ）。
 * - `instancePath`: 誤りのある値の位置（Ajv の instancePath。JSON Pointer。文書の全体は空文字列）。
 * - `missingProperty`: なくなった項目の名前（`required` の誤りだけ。ほかは `null`）。
 */
export interface SchemaValidationIssue {
  readonly message: string;
  readonly instancePath: string;
  readonly missingProperty: string | null;
}

/**
 * 検証関数が返す、位置つきの結果（CCX-24）。`SchemaValidationResult` として扱える（`errors` は今までと同じ）。`issues` は、`errors` と
 * 同じ順で、同じ件数。
 */
export type LocatedSchemaValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly errors: readonly string[]; readonly issues: readonly SchemaValidationIssue[] };

/** 1 つのスキーマで値を検証する関数。誤りは `describeSchemaError` の形の文字列の一覧と、その位置（`issues`）で返す。 */
export type SchemaDocumentValidator = (value: unknown) => LocatedSchemaValidationResult;

/** 登録したスキーマの一覧から、`$id` で検証関数を引く部品。 */
export interface SchemaValidatorRegistry {
  /** 登録していない `$id` では `RangeError` を投げる。 */
  readonly validatorFor: (schemaId: string) => SchemaDocumentValidator;
}

const schemaIdByName: Readonly<Record<ArtifactSchemaName, string>> = {
  run: 'urn:beaksight:schema:run:1.0',
  audit: 'urn:beaksight:schema:audit:1.0',
  page: 'urn:beaksight:schema:page:1.0',
  finding: 'urn:beaksight:schema:finding:1.0',
  checkpoint: 'urn:beaksight:schema:checkpoint:1.0',
  'checkpoint-page': 'urn:beaksight:schema:checkpoint-page:1.0',
  // サイトの不調で止めたときの診断の記録（サイトの不調で止めたときの診断の記録の設計書 2.3）。
  'site-unavailable-diagnostic': 'urn:beaksight:schema:site-unavailable-diagnostic:1.0',
  // 発見のジョブの成果物 `discovery.json`（Task 27 の設計書の変更履歴「Blocker: T27d」の行の (1)。T27d）。
  discovery: 'urn:beaksight:schema:discovery:1.0',
  // READ の確かめのジョブの成果物 `read-evidence.json`（Task 27 の設計書 4.5。T27e）。
  'read-evidence': 'urn:beaksight:schema:read-evidence:1.0',
  // 書き込みのジョブの記録 `action-run.json`（Task 30 の設計書 3 章の「記録」。T30a）。公開監査の `run.json` のスキーマは変えない。
  'action-run': 'urn:beaksight:schema:action-run:1.0',
  // 書き込みの報告の証拠 `action-evidence.json` と承認の要約 `approval-summary.json`（Task 32 の設計書 4.1。T32c）。
  'action-evidence': 'urn:beaksight:schema:action-evidence:1.0',
  'approval-summary': 'urn:beaksight:schema:approval-summary:1.0',
  // 入口の確かめのジョブの成果物 `entry-check.json`（Task 43 の設計書 4.3。T43c）。
  'entry-check': 'urn:beaksight:schema:entry-check:1.0',
};

/**
 * 成果物のスキーマが参照するだけの、ほかの置き場所のスキーマ（`schemas/` からの相対パス。T27d）。検証の名前（`ArtifactSchemaName`）には
 * 入れず、`$ref` を解決するために、同じ検証器に登録するだけにする（スキーマのファイルは 1 つのまま。書き写さない）。
 * - `control/candidate.schema.json`: 発見の候補（`discovery.json` の候補）。Control の検証（`control-schema-validator.ts`）にも、同じファイルを
 *   登録している。
 * - `control/read-check-definition.schema.json`（T27e）: READ の確かめの定義の期待（`read-evidence.json` の期待ごとの結果）。Control の検証にも、
 *   同じファイルを登録している。
 * - `control/scenario.schema.json`・`control/approval-receipt.schema.json`（T32c）: 書き込みの報告（`action-evidence.json` のシナリオの種類と
 *   送信先の path、`approval-summary.json` の承認の記録・縛った事実・入力の規則の参照・上限・期限の日数・副作用の確認）。Control の検証にも、
 *   同じファイルを登録している。
 */
const REFERENCED_SCHEMA_PATHS: readonly string[] = Object.freeze([
  'control/candidate.schema.json',
  'control/read-check-definition.schema.json',
  'control/scenario.schema.json',
  'control/approval-receipt.schema.json',
]);

let validatorsPromise: Promise<Readonly<Record<ArtifactSchemaName, SchemaDocumentValidator>>> | undefined;

const isDistributionBuild = import.meta.url.includes('/dist/core/');

const schemaDirectory = isDistributionBuild ? '../schemas/' : '../../schemas/';

const schemaUrlFor = (schemaName: ArtifactSchemaName): URL => new URL(`${schemaDirectory}${schemaName}.schema.json`, import.meta.url);

/** スキーマの検証の誤りを、1 行の文字列にする（成果物と Control の契約で共通の形）。 */
export const describeSchemaError = (error: ErrorObject): string => {
  if (error.keyword === 'required') {
    const missingProperty = error.params.missingProperty;
    return `${error.instancePath || '/'} must include ${missingProperty}`;
  }

  return `${error.instancePath || '/'} ${error.message ?? error.keyword}`;
};

/** なくなった項目の誤り（Ajv の `required`）の keyword。 */
const REQUIRED_KEYWORD = 'required';

/** スキーマの検証の誤り 1 件と、その位置（CCX-24。文は `describeSchemaError` と同じ）。 */
const schemaValidationIssueOf = (error: ErrorObject): SchemaValidationIssue => Object.freeze({
  message: describeSchemaError(error),
  instancePath: error.instancePath,
  missingProperty: error.keyword === REQUIRED_KEYWORD ? String(error.params.missingProperty) : null,
});

/** スキーマの誤りのある項目の位置（JSON Pointer。CCX-24）。なくなった項目の誤りは、その項目の位置（`instancePath` の下）。 */
export const schemaIssuePointerOf = ({ instancePath, missingProperty }: SchemaValidationIssue): string =>
  missingProperty === null ? instancePath : `${instancePath}${jsonPointerOf([missingProperty])}`;

const toDocumentValidator = (validate: ValidateFunction): SchemaDocumentValidator => (value) => {
  if (validate(value)) {
    return { ok: true };
  }

  const issues = Object.freeze((validate.errors ?? []).map(schemaValidationIssueOf));
  return { ok: false, errors: issues.map(({ message }) => message), issues };
};

/**
 * スキーマ（JSON の値）の一覧を、成果物の検証と同じ設定（`strict: true`、`allErrors: true`）の Ajv に登録し、
 * `$id` で検証関数を引ける部品を返す。同期で作る。Ajv を扱うのはこのファイルだけ（GATE-ARCH08）。
 * - 一覧の中の `$ref` は、同じ一覧の `$id` で解決する。各スキーマは文字列の `$id` を持つ（ないと `TypeError`）。
 * - すべてのスキーマを作成の時点でコンパイルする（strict の違反は、作成の時点で投げる）。
 * - `$id` は、登録した `$id` の表（`Map`）だけで引く。Ajv の内部の表を直接引くと、`constructor` などの継承した
 *   プロパティ名で無関係な値を引く（DEF-002 と同じ種類の誤り）。
 */
export const createSchemaValidatorRegistry = (schemas: readonly object[]): SchemaValidatorRegistry => {
  const ajv = new Ajv({ allErrors: true, strict: true });
  const schemaIds: string[] = [];
  for (const schema of schemas) {
    const schemaId: unknown = (schema as { readonly $id?: unknown }).$id;
    if (typeof schemaId !== 'string') {
      throw new TypeError('a registered schema must have a string $id');
    }
    ajv.addSchema(schema);
    schemaIds.push(schemaId);
  }

  const validatorsById = new Map<string, SchemaDocumentValidator>();
  for (const schemaId of schemaIds) {
    const validate = ajv.getSchema(schemaId);
    if (validate === undefined) {
      throw new Error(`schema validator was not registered: ${schemaId}`);
    }
    validatorsById.set(schemaId, toDocumentValidator(validate));
  }

  return Object.freeze({
    validatorFor: (schemaId: string): SchemaDocumentValidator => {
      const validator = validatorsById.get(schemaId);
      if (validator === undefined) {
        throw new RangeError(`schema was not registered: ${schemaId}`);
      }
      return validator;
    },
  });
};

const loadValidators = (): Promise<Readonly<Record<ArtifactSchemaName, SchemaDocumentValidator>>> => {
  if (validatorsPromise !== undefined) {
    return validatorsPromise;
  }

  const readSchema = async (url: URL): Promise<object> => JSON.parse(await readFile(url, 'utf8')) as object;
  validatorsPromise = Promise.all([
    ...(Object.keys(schemaIdByName) as ArtifactSchemaName[]).map(async (schemaName) => readSchema(schemaUrlFor(schemaName))),
    ...REFERENCED_SCHEMA_PATHS.map(async (path) => readSchema(new URL(`${schemaDirectory}${path}`, import.meta.url))),
  ]).then((schemas) => {
    const registry = createSchemaValidatorRegistry(schemas);

    return Object.fromEntries(
      (Object.keys(schemaIdByName) as ArtifactSchemaName[]).map((schemaName) => {
        let validator: SchemaDocumentValidator;
        try {
          validator = registry.validatorFor(schemaIdByName[schemaName]);
        } catch {
          throw new Error(`schema validator was not registered: ${schemaName}`);
        }
        return [schemaName, validator];
      }),
    ) as Readonly<Record<ArtifactSchemaName, SchemaDocumentValidator>>;
  });
  return validatorsPromise;
};

export const validateArtifact = async (
  schemaName: ArtifactSchemaName,
  value: unknown,
): Promise<ArtifactValidationResult> => {
  // 検証関数の表は普通のオブジェクトなので、`constructor` などの継承したプロパティ名で引くと、`Object` などの無関係な関数が
  // 検証関数として呼ばれ、検証を素通りする。スキーマ名は、自身のプロパティかどうかで確かめる（DEF-002）。
  if (!Object.hasOwn(schemaIdByName, schemaName)) {
    throw new RangeError(`unsupported artifact schema name: ${schemaName}`);
  }
  const validate = (await loadValidators())[schemaName];
  return validate(value);
};
