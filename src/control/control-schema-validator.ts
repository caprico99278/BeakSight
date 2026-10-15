// Control（管理の契約）のスキーマの検証の部品（Task 22 の設計書 6。2026-10-09 の T22a の Blocker の改訂）。
// 成果物のスキーマの検証（`validateArtifact`）とは、スキーマの置き場所（`schemas/control/`）とスキーマの名前の一覧を分ける
// （ロードマップ 4.2 の `schemas/control/` の分離）。スキーマの検証器の作成と誤りの文の形は、`src/core/schema-validator.ts` の
// `createSchemaValidatorRegistry` の 1 か所に任せる（GATE-ARCH08。このファイルは検証器を直接扱わない）。
// 判定の部品（`profile-policy.ts`）から同期で呼べるように、スキーマは初回の呼び出しで同期に読み、以後は使い回す。
import { readFileSync } from 'node:fs';
import {
  createSchemaValidatorRegistry,
  type LocatedSchemaValidationResult,
  type SchemaDocumentValidator,
} from '../core/schema-validator.js';

/** Control のスキーマの名前の閉じた一覧。 */
export const CONTROL_SCHEMA_NAMES = Object.freeze([
  'profile',
  // ローカルの管理画面の Server Function の入力（Task 23 の設計書 4.4。T23f）。
  'ui-profile-key',
  'ui-profile-create',
  'ui-profile-update',
  'ui-profile-retire',
  'ui-target-config',
  // 画面のサーバと監査のワーカーの IPC のメッセージ（Task 24 の設計書 4.3。T24d）。値の一覧と検証の関数は `worker-protocol.ts`。
  'worker-message',
  // ローカルの管理画面の監査のジョブの Server Function の入力（Task 24 の設計書 4.8。T24f）。
  'ui-audit-job-start',
  'ui-audit-job-stop',
  'ui-audit-job-key',
  // 認証の設定（Task 25 の設計書 4.1。T25a）。契約は `src/control/auth/auth-setup-contracts.ts`、検証は `auth-setup-policy.ts`。
  'auth-setup',
  // 認証の設定の版 2（Task 26 の設計書 4.3。T26b）。検証と保存は版 2 だけ。版 1（`auth-setup`）は管理データの版 1 の文書を読むために残す。
  'auth-setup-v2',
  // ローカルの管理画面の認証の設定の保存の Server Function の入力（Task 25 の設計書 4.5。T25e）。
  'ui-auth-setup-save',
  // 資格情報のファイル（Task 26 の設計書 4.1。T26a）。読み書きは `src/control/credentials/credential-store.ts`。
  'credential-file',
  // ローカルの管理画面の資格情報の登録・変更・入れ直しと、ログインの検証の開始の Server Function の入力（Task 26 の設計書 4.2、4.6。T26e）。
  'ui-credential-register',
  'ui-credential-change',
  'ui-credential-replace',
  'ui-login-check-start',
  // 発見の候補（成果物 `discovery.json` の候補の形。Task 27 の設計書 4.1。T27a）。契約は `src/discovery/candidate-contracts.ts`。
  'candidate',
  // READ の確かめの定義の中身（Task 27 の設計書 4.5。T27c）。契約は `src/discovery/read-check-contracts.ts`、検証は `read-check-policy.ts`。
  'read-check-definition',
  // ローカルの管理画面の、操作の候補の発見と READ の確かめの Server Function の入力（Task 27 の設計書 4.7。T27f）。
  'ui-discovery-start',
  'ui-read-check-start',
  'ui-read-check-create',
  'ui-read-check-update',
  'ui-read-check-cancel',
  // シナリオの版と、承認・撤回の記録（Task 28 の設計書 4.1。T28a）。契約は `src/control/approval/scenario-contracts.ts`。
  'scenario',
  'approval-receipt',
  // ローカルの管理画面の、シナリオの Server Function の入力（Task 28 の設計書 4.6。T28e）。
  'ui-scenario-key',
  'ui-scenario-form',
  'ui-scenario-create',
  'ui-scenario-update',
  'ui-scenario-approve',
  'ui-scenario-revoke',
  // 入力の規則の集まりの版（Task 29 の設計書 4.1。T29a）。契約は `src/control/data-rules/rule-contracts.ts`。
  'data-rule',
  // ローカルの管理画面の、入力の規則の保存の Server Function の入力（Task 29 の設計書 4.4。T29e）。
  'ui-data-rule-save',
  // ローカルの管理画面の、書き込みの開始の Server Function の入力（Task 30 の設計書 3 章、10 章。T30g fix round 1）。
  'ui-write-start',
  // ローカルの管理画面の、更新の書き込みの開始の Server Function の入力（Task 31 の設計書 3 章、10 章。T31h-2）。
  'ui-write-update-start',
] as const);
export type ControlSchemaName = (typeof CONTROL_SCHEMA_NAMES)[number];

/** Control の契約の検証の結果（誤りの文と、その位置。CCX-24）。 */
export type ControlValidationResult = LocatedSchemaValidationResult;

const schemaIdByName: Readonly<Record<ControlSchemaName, string>> = Object.freeze({
  profile: 'urn:beaksight:schema:control:profile:1',
  'ui-profile-key': 'urn:beaksight:schema:control:ui-profile-key:1',
  'ui-profile-create': 'urn:beaksight:schema:control:ui-profile-create:1',
  'ui-profile-update': 'urn:beaksight:schema:control:ui-profile-update:1',
  'ui-profile-retire': 'urn:beaksight:schema:control:ui-profile-retire:1',
  'ui-target-config': 'urn:beaksight:schema:control:ui-target-config:1',
  'worker-message': 'urn:beaksight:schema:control:worker-message:1',
  'ui-audit-job-start': 'urn:beaksight:schema:control:ui-audit-job-start:1',
  'ui-audit-job-stop': 'urn:beaksight:schema:control:ui-audit-job-stop:1',
  'ui-audit-job-key': 'urn:beaksight:schema:control:ui-audit-job-key:1',
  'auth-setup': 'urn:beaksight:schema:control:auth-setup:1',
  'auth-setup-v2': 'urn:beaksight:schema:control:auth-setup:2',
  'ui-auth-setup-save': 'urn:beaksight:schema:control:ui-auth-setup-save:1',
  'credential-file': 'urn:beaksight:schema:control:credential-file:1',
  'ui-credential-register': 'urn:beaksight:schema:control:ui-credential-register:1',
  'ui-credential-change': 'urn:beaksight:schema:control:ui-credential-change:1',
  'ui-credential-replace': 'urn:beaksight:schema:control:ui-credential-replace:1',
  'ui-login-check-start': 'urn:beaksight:schema:control:ui-login-check-start:1',
  candidate: 'urn:beaksight:schema:control:candidate:1',
  'read-check-definition': 'urn:beaksight:schema:control:read-check-definition:1',
  'ui-discovery-start': 'urn:beaksight:schema:control:ui-discovery-start:1',
  'ui-read-check-start': 'urn:beaksight:schema:control:ui-read-check-start:1',
  'ui-read-check-create': 'urn:beaksight:schema:control:ui-read-check-create:1',
  'ui-read-check-update': 'urn:beaksight:schema:control:ui-read-check-update:1',
  'ui-read-check-cancel': 'urn:beaksight:schema:control:ui-read-check-cancel:1',
  scenario: 'urn:beaksight:schema:control:scenario:1',
  'approval-receipt': 'urn:beaksight:schema:control:approval-receipt:1',
  'ui-scenario-key': 'urn:beaksight:schema:control:ui-scenario-key:1',
  'ui-scenario-form': 'urn:beaksight:schema:control:ui-scenario-form:1',
  'ui-scenario-create': 'urn:beaksight:schema:control:ui-scenario-create:1',
  'ui-scenario-update': 'urn:beaksight:schema:control:ui-scenario-update:1',
  'ui-scenario-approve': 'urn:beaksight:schema:control:ui-scenario-approve:1',
  'ui-scenario-revoke': 'urn:beaksight:schema:control:ui-scenario-revoke:1',
  'data-rule': 'urn:beaksight:schema:control:data-rule:1',
  'ui-data-rule-save': 'urn:beaksight:schema:control:ui-data-rule-save:1',
  'ui-write-start': 'urn:beaksight:schema:control:ui-write-start:1',
  'ui-write-update-start': 'urn:beaksight:schema:control:ui-write-update-start:1',
});

let validators: Readonly<Record<ControlSchemaName, SchemaDocumentValidator>> | undefined;

const isDistributionBuild = import.meta.url.includes('/dist/control/');

const schemaUrlFor = (schemaName: ControlSchemaName): URL => {
  const schemaDirectory = isDistributionBuild ? '../schemas/control/' : '../../schemas/control/';
  return new URL(`${schemaDirectory}${schemaName}.schema.json`, import.meta.url);
};

/**
 * Control のスキーマが参照するだけの、成果物のスキーマ（`schemas/` の中のファイルの名前。T32d）。検証の名前（`ControlSchemaName`）には入れず、
 * `$ref` を解決するために同じ検証器に登録するだけにする（スキーマのファイルは 1 つのまま。書き写さない。`schema-validator.ts` の
 * `REFERENCED_SCHEMA_PATHS` と同じ考え方）。
 * - `approval-summary.schema.json`: IPC の `START` の書き込みの指定の承認の要約（`write.approvalFacts`）の形（`$defs/facts`）。
 * - `action-run.schema.json`・`run.schema.json`: `approval-summary` が参照する ID の形（成果物のスキーマの中の参照を解決するため）。
 */
const REFERENCED_ARTIFACT_SCHEMA_FILES: readonly string[] = Object.freeze(['run.schema.json', 'action-run.schema.json', 'approval-summary.schema.json']);

const artifactSchemaUrlFor = (fileName: string): URL =>
  new URL(`${isDistributionBuild ? '../schemas/' : '../../schemas/'}${fileName}`, import.meta.url);

const loadValidators = (): Readonly<Record<ControlSchemaName, SchemaDocumentValidator>> => {
  if (validators !== undefined) {
    return validators;
  }

  const registry = createSchemaValidatorRegistry([
    ...CONTROL_SCHEMA_NAMES.map((schemaName) => JSON.parse(readFileSync(schemaUrlFor(schemaName), 'utf8')) as object),
    ...REFERENCED_ARTIFACT_SCHEMA_FILES.map((fileName) => JSON.parse(readFileSync(artifactSchemaUrlFor(fileName), 'utf8')) as object),
  ]);
  validators = Object.freeze(
    Object.fromEntries(
      CONTROL_SCHEMA_NAMES.map((schemaName) => [schemaName, registry.validatorFor(schemaIdByName[schemaName])]),
    ) as Record<ControlSchemaName, SchemaDocumentValidator>,
  );
  return validators;
};

export const validateControlDocument = (schemaName: ControlSchemaName, value: unknown): ControlValidationResult => {
  // 継承したプロパティ名（`constructor` など）や、ほかの一覧の名前で引くと、無関係な関数で検証を素通りする。
  // スキーマの名前は、自身のプロパティかどうかで確かめる（`validateArtifact` の DEF-002 と同じ扱い）。
  if (!Object.hasOwn(schemaIdByName, schemaName)) {
    throw new RangeError(`unsupported control schema name: ${String(schemaName)}`);
  }
  return loadValidators()[schemaName](value);
};
