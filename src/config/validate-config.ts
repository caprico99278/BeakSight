import type { AuditConfig, ConfigValidationResult, Viewport } from './types.js';

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord => typeof value === 'object' && value !== null && !Array.isArray(value);

const unknownKeys = (value: UnknownRecord, keys: readonly string[]): readonly string[] => Object.keys(value).filter((key) => !keys.includes(key));

const hasExactKeys = (value: UnknownRecord, keys: readonly string[]): boolean => unknownKeys(value, keys).length === 0 && keys.every((key) => Object.hasOwn(value, key));

const isPositiveFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

const isStringArray = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');

const validateHttpUrl = (value: string): URL | undefined => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
};

const validateViewport = (value: unknown, name: string, errors: string[]): value is Viewport => {
  if (!isRecord(value) || !hasExactKeys(value, ['width', 'height'])) {
    errors.push(`${name} must be an object with width and height`);
    return false;
  }
  if (!isPositiveFiniteNumber(value.width) || !isPositiveFiniteNumber(value.height)) {
    errors.push(`${name} width and height must be positive finite numbers`);
    return false;
  }
  return true;
};

export const validateConfig = (input: unknown): ConfigValidationResult => {
  const errors: string[] = [];
  const sectionKeys = ['site', 'crawl', 'browser', 'viewports', 'audit', 'output'];
  if (!isRecord(input)) {
    return { ok: false, errors: ['configuration must be an object with only supported sections'] };
  }
  const unsupportedSectionKeys = unknownKeys(input, sectionKeys);
  if (unsupportedSectionKeys.length > 0) {
    return { ok: false, errors: unsupportedSectionKeys.map((key) => `unknown configuration key: ${key}`) };
  }
  if (!hasExactKeys(input, sectionKeys)) {
    return { ok: false, errors: ['configuration must be an object with only supported sections'] };
  }

  const { site, crawl, browser, viewports, audit, output } = input;
  if (!isRecord(site) || !hasExactKeys(site, ['startUrl', 'allowedOrigins'])) {
    errors.push('site must be an object with startUrl and allowedOrigins');
  } else {
    const startUrl = typeof site.startUrl === 'string' ? validateHttpUrl(site.startUrl) : undefined;
    if (startUrl === undefined) {
      errors.push('site.startUrl must be an HTTP(S) URL');
    }
    if (!isStringArray(site.allowedOrigins) || site.allowedOrigins.length === 0) {
      errors.push('site.allowedOrigins must be a non-empty string array');
    } else {
      const origins = site.allowedOrigins.map(validateHttpUrl);
      if (origins.some((origin) => origin === undefined)) {
        errors.push('site.allowedOrigins must contain only HTTP(S) URLs');
      } else if (startUrl !== undefined && !origins.some((origin) => origin?.origin === startUrl.origin)) {
        errors.push('site.startUrl origin must be included in site.allowedOrigins');
      }
    }
  }

  const crawlKeys = [
    'maxPages',
    'maxDepth',
    'maxRuntimeMs',
    'navigationTimeoutMs',
    'overallPageTimeoutMs',
    'resourceSettlingTimeoutMs',
    'interactionTimeoutMs',
    'allowedQueryParameters',
  ];
  if (!isRecord(crawl) || !hasExactKeys(crawl, crawlKeys)) {
    errors.push('crawl must be an object with only supported settings');
  } else {
    for (const key of crawlKeys.slice(0, 7)) {
      if (!isPositiveFiniteNumber(crawl[key])) {
        errors.push(`crawl.${key} must be a positive finite number`);
      }
    }
    if (!isStringArray(crawl.allowedQueryParameters)) {
      errors.push('crawl.allowedQueryParameters must be a string array');
    }
  }

  if (!isRecord(browser) || !hasExactKeys(browser, ['headed', 'locale', 'timezone'])) {
    errors.push('browser must be an object with headed, locale, and timezone');
  } else if (typeof browser.headed !== 'boolean' || typeof browser.locale !== 'string' || typeof browser.timezone !== 'string') {
    errors.push('browser settings have invalid types');
  }

  if (!isRecord(viewports) || !hasExactKeys(viewports, ['primaryDesktop', 'primaryMobile', 'stressWidths'])) {
    errors.push('viewports must be an object with only supported settings');
  } else {
    validateViewport(viewports.primaryDesktop, 'viewports.primaryDesktop', errors);
    validateViewport(viewports.primaryMobile, 'viewports.primaryMobile', errors);
    if (!Array.isArray(viewports.stressWidths) || !viewports.stressWidths.every(isPositiveFiniteNumber)) {
      errors.push('viewports.stressWidths must be an array of positive finite numbers');
    }
  }

  if (!isRecord(audit) || !hasExactKeys(audit, ['performance', 'accessibility', 'interactions', 'screenshots'])) {
    errors.push('audit must be an object with only supported settings');
  } else if (Object.values(audit).some((value) => typeof value !== 'boolean')) {
    errors.push('audit settings must be booleans');
  }

  if (!isRecord(output) || !hasExactKeys(output, ['directory']) || typeof output.directory !== 'string' || output.directory.length === 0) {
    errors.push('output.directory must be a non-empty string');
  }

  return errors.length === 0
    ? { ok: true, value: input as unknown as AuditConfig }
    : { ok: false, errors };
};
