export interface Viewport {
  readonly width: number;
  readonly height: number;
}

export interface AuditConfig {
  readonly site: {
    readonly startUrl: string;
    readonly allowedOrigins: readonly string[];
  };
  readonly crawl: {
    readonly maxPages: number;
    readonly maxDepth: number;
    readonly maxRuntimeMs: number;
    readonly navigationTimeoutMs: number;
    readonly overallPageTimeoutMs: number;
    readonly resourceSettlingTimeoutMs: number;
    readonly interactionTimeoutMs: number;
    readonly allowedQueryParameters: readonly string[];
  };
  readonly browser: {
    readonly headed: boolean;
    readonly locale: string;
    readonly timezone: string;
  };
  readonly viewports: {
    readonly primaryDesktop: Viewport;
    readonly primaryMobile: Viewport;
    readonly stressWidths: readonly number[];
  };
  readonly audit: {
    readonly performance: boolean;
    readonly accessibility: boolean;
    readonly interactions: boolean;
    readonly screenshots: boolean;
  };
  readonly output: {
    readonly directory: string;
  };
}

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
