import type { EffectiveAuditConfig, ViewportSizeEvidence } from '../core/evidence-types.js';

/** ビューポートの大きさ。定義は `src/core/evidence-types.ts` に1か所だけ置く。 */
export type Viewport = ViewportSizeEvidence;

/** 確定後の監査の設定。定義は `src/core/evidence-types.ts` に1か所だけ置く（run.json の `effectiveConfig` と同じ型）。 */
export type AuditConfig = EffectiveAuditConfig;

/** 対象に依存しない既定の設定の型。`target` は対象の設定ファイルだけが決める。 */
export type AuditConfigDefaults = Omit<AuditConfig, 'target'>;

export type ConfigValidationResult =
  | { readonly ok: true; readonly value: AuditConfig }
  | { readonly ok: false; readonly errors: readonly string[] };

export interface AuditConfigOverrides {
  readonly site?: Partial<AuditConfig['site']>;
  readonly crawl?: Partial<AuditConfig['crawl']>;
  readonly browser?: Partial<AuditConfig['browser']>;
  readonly viewports?: {
    readonly primaryDesktop?: Partial<Viewport>;
    readonly primaryMobile?: Partial<Viewport>;
    readonly stressWidths?: readonly number[];
  };
  readonly audit?: Partial<AuditConfig['audit']>;
  readonly output?: Partial<AuditConfig['output']>;
}
