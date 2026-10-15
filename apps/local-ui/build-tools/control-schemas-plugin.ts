/**
 * ビルドした画面のサーバに、スキーマを置く Vite の plugin（T23f。T27d round 2 で成果物のスキーマも足した）。
 * - `src/control/control-schema-validator.ts` は、自分の場所（`import.meta.url`）から `../../schemas/control/` を読む。Vite のビルドでは、
 *   その部品は `dist/server/` の下の chunk に入るので、chunk の場所から同じ相対の位置に Control のスキーマ（`schemas/control/`）を写す
 *   （部品は変えない）。
 * - T27d round 2（Task 27 の設計書の変更履歴「Blocker: T27d」の行の (1)）: 成果物のスキーマの検証（`src/core/schema-validator.ts` の
 *   `validateArtifact`。ジョブの管理が、発見のジョブの `discovery.json` を確かめる）も、自分の場所から `../../schemas/` の
 *   `<名前>.schema.json`（と、参照する `control/candidate.schema.json`）を読む。その部品の入った chunk の場所から同じ相対の位置に、
 *   成果物のスキーマ（`schemas/` の直下の `*.schema.json`）と Control のスキーマを写す。スキーマのファイルは、リポジトリの 1 つのまま（写すだけ）。
 * - 写す先は、ビルドの出力のフォルダ（`apps/local-ui/dist/`）の中でなければ、ビルドを止める（ほかの場所に書かない）。
 * - 開発のサーバでは、部品はソースの場所（`src/control/`、`src/core/`）から読むので、何もしない。
 */
import { cpSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Plugin } from 'vite';

/** Control のスキーマを読む部品のソース（リポジトリの root から）。 */
const CONTROL_SCHEMA_VALIDATOR_MODULE = 'src/control/control-schema-validator.ts';

/** 成果物のスキーマを読む部品のソース（リポジトリの root から。T27d round 2）。 */
const ARTIFACT_SCHEMA_VALIDATOR_MODULE = 'src/core/schema-validator.ts';

/** 部品が chunk の場所から読む、スキーマのフォルダの相対の位置（どちらの部品も `../../schemas/`。Control は、その下の `control/`）。 */
const SCHEMA_DIRECTORY_FROM_MODULE = '../../schemas';

/** Control のスキーマのフォルダの名前（`schemas/` の下）。 */
const CONTROL_SCHEMA_DIRECTORY = 'control';

/** スキーマのファイルの名前の終わり。 */
const SCHEMA_FILE_SUFFIX = '.schema.json';

const isInside = (path: string, directory: string): boolean => {
  const fromDirectory = relative(directory, path);
  return fromDirectory !== '' && !fromDirectory.startsWith(`..${sep}`) && fromDirectory !== '..' && !isAbsolute(fromDirectory);
};

/** スキーマを、ビルドした画面のサーバの chunk から読める位置に写す。 */
export function controlSchemasPlugin(repositoryRoot: string, distributionDirectory: string): Plugin {
  const moduleIdOf = (path: string): string => resolve(repositoryRoot, path).replaceAll('\\', '/');
  const controlValidatorId = moduleIdOf(CONTROL_SCHEMA_VALIDATOR_MODULE);
  const artifactValidatorId = moduleIdOf(ARTIFACT_SCHEMA_VALIDATOR_MODULE);
  const sourceSchemas = resolve(repositoryRoot, 'schemas');
  return {
    name: 'beaksight-control-schemas',
    apply: 'build',
    applyToEnvironment: (environment) => environment.config.consumer === 'server',
    writeBundle(outputOptions, bundle) {
      const outputDirectory = outputOptions.dir;
      if (outputDirectory === undefined) {
        this.error('the server build has no output directory');
      }
      const chunksWith = (moduleId: string) => Object.values(bundle).filter((output) => output.type === 'chunk'
        && Object.keys(output.modules).some((id) => id.replaceAll('\\', '/') === moduleId));
      const targetOf = (fileName: string): string => {
        const target = resolve(outputDirectory, dirname(fileName), SCHEMA_DIRECTORY_FROM_MODULE);
        if (!isInside(target, resolve(distributionDirectory))) {
          this.error(`the schemas would be copied outside ${distributionDirectory}: ${target}`);
        }
        return target;
      };
      const controlChunks = chunksWith(controlValidatorId);
      if (controlChunks.length === 0) {
        this.error(`no server chunk contains ${CONTROL_SCHEMA_VALIDATOR_MODULE}`);
      }
      // Control のスキーマ: Control の検証の chunk と、成果物の検証の chunk（参照する候補のスキーマを読む）の両方の位置に写す。
      const artifactChunks = chunksWith(artifactValidatorId);
      for (const chunk of [...controlChunks, ...artifactChunks]) {
        cpSync(join(sourceSchemas, CONTROL_SCHEMA_DIRECTORY), join(targetOf(chunk.fileName), CONTROL_SCHEMA_DIRECTORY), { recursive: true });
      }
      // 成果物のスキーマ（`schemas/` の直下の `*.schema.json`）: 成果物の検証の chunk の位置に写す。
      const artifactSchemaFiles = readdirSync(sourceSchemas).filter((name) => name.endsWith(SCHEMA_FILE_SUFFIX));
      for (const chunk of artifactChunks) {
        const target = targetOf(chunk.fileName);
        for (const name of artifactSchemaFiles) {
          cpSync(join(sourceSchemas, name), join(target, name));
        }
      }
    },
  };
}
