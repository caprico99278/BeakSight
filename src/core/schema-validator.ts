import { readFile } from 'node:fs/promises';
import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';

export type ArtifactSchemaName = 'run' | 'audit' | 'page' | 'finding';

export type ArtifactValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly errors: readonly string[] };

const schemaIdByName: Readonly<Record<ArtifactSchemaName, string>> = {
  run: 'urn:beaksight:schema:run:1.0',
  audit: 'urn:beaksight:schema:audit:1.0',
  page: 'urn:beaksight:schema:page:1.0',
  finding: 'urn:beaksight:schema:finding:1.0',
};

let validatorsPromise: Promise<Readonly<Record<ArtifactSchemaName, ValidateFunction>>> | undefined;

const isDistributionBuild = import.meta.url.includes('/dist/core/');

const schemaUrlFor = (schemaName: ArtifactSchemaName): URL => {
  const schemaDirectory = isDistributionBuild ? '../schemas/' : '../../schemas/';
  return new URL(`${schemaDirectory}${schemaName}.schema.json`, import.meta.url);
};

const describeError = (error: ErrorObject): string => {
  if (error.keyword === 'required') {
    const missingProperty = error.params.missingProperty;
    return `${error.instancePath || '/'} must include ${missingProperty}`;
  }

  return `${error.instancePath || '/'} ${error.message ?? error.keyword}`;
};

const loadValidators = (): Promise<Readonly<Record<ArtifactSchemaName, ValidateFunction>>> => {
  if (validatorsPromise !== undefined) {
    return validatorsPromise;
  }

  validatorsPromise = Promise.all(
    (Object.keys(schemaIdByName) as ArtifactSchemaName[]).map(async (schemaName) => ({
      schemaName,
      schema: JSON.parse(await readFile(schemaUrlFor(schemaName), 'utf8')) as object,
    })),
  ).then((schemas) => {
    const ajv = new Ajv({ allErrors: true, strict: true });
    for (const { schema } of schemas) {
      ajv.addSchema(schema);
    }

    return Object.fromEntries(
      (Object.keys(schemaIdByName) as ArtifactSchemaName[]).map((schemaName) => {
        const validator = ajv.getSchema(schemaIdByName[schemaName]);
        if (validator === undefined) {
          throw new Error(`schema validator was not registered: ${schemaName}`);
        }
        return [schemaName, validator];
      }),
    ) as Readonly<Record<ArtifactSchemaName, ValidateFunction>>;
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
  if (validate(value)) {
    return { ok: true };
  }

  return { ok: false, errors: (validate.errors ?? []).map(describeError) };
};
