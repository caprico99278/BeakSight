import { isPositiveSafeInteger, isRecord } from '../core/guards.js';
import { INTERACTION_TIMEOUT_COUNT_PER_CANDIDATE, MIN_INTERACTION_TIMEOUT_EXCLUSIVE_MS } from '../core/limits.js';
import { canonicalizeAllowedOrigins, hasUrlCredentials, isHttpProtocol, normalizeUrl } from '../crawl/normalize-url.js';
import type { AuditConfig, ConfigValidationResult, Viewport } from './types.js';

type UnknownRecord = Record<string, unknown>;

const unknownKeys = (value: UnknownRecord, keys: readonly string[]): readonly string[] => Object.keys(value).filter((key) => !keys.includes(key));

const hasExactKeys = (value: UnknownRecord, keys: readonly string[]): boolean => unknownKeys(value, keys).length === 0 && keys.every((key) => Object.hasOwn(value, key));

const isStringArray = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');

const validateHttpUrl = (value: string): URL | undefined => {
  try {
    const url = new URL(value);
    return isHttpProtocol(url.protocol) ? url : undefined;
  } catch {
    return undefined;
  }
};

/**
 * 正の整数だけを受け付ける crawl の設定値。件数・深さと、時間（ms）。
 * 時間は、Page Auditor が期限の計算に使い、`auditInteraction` などが正の整数を要求するので、正の整数に限る
 * （Task 14〜17 の設計書 4.5.7）。`schemas/run.schema.json` の `effectiveConfig.crawl` も同じ規則にする。
 */
const crawlIntegerKeys = [
  'maxPages',
  'maxDepth',
  'maxRuntimeMs',
  'navigationTimeoutMs',
  'overallPageTimeoutMs',
  'resourceSettlingTimeoutMs',
  'interactionTimeoutMs',
] as const;

/**
 * IANA の time zone の名前の書き方（例: `Asia/Tokyo`、`UTC`、`GMT`、`Etc/GMT+9`、`America/Port-au-Prince`）。
 * `/` で区切った各部分は、大文字の英字か数字で始まり、英数字・`_`・`-`・`+` を含んでよい。
 * `asia/tokyo` のような小文字で始まる名前と、`+09:00`・`-0530` のようなオフセットの形は、この書き方に当たらない。
 */
const IANA_TIME_ZONE_NAME_PATTERN = /^[A-Z0-9][A-Za-z0-9_+-]*(?:\/[A-Z0-9][A-Za-z0-9_+-]*)*$/u;

/** `Intl.Locale` が「言語なし」（`und`）を表す言語の部分。 */
const UNDETERMINED_LANGUAGE = 'und';

/**
 * Chromium（Playwright の `timezoneId`）が受け付ける time zone か（R''2 の I-1）。
 * Node の `Intl.DateTimeFormat` は、オフセットの形（`+09:00`）や小文字で始まる名前（`asia/tokyo`）も受け付けるが、
 * Chromium は拒否する。そのため、IANA の名前の書き方であり、かつ `Intl.DateTimeFormat` が受け付けるものを受け付ける。
 * `Intl` が解決した名前との一致は求めない。`Asia/Kolkata`（→ `Asia/Calcutta`）、`Etc/UTC`・`GMT`（→ `UTC`）、
 * `US/Pacific`（→ `America/Los_Angeles`）のように、ICU が別の表記に解決する正式な名前も Chromium は受け付けるため（F13b）。
 * ただし、解決した名前と大文字・小文字だけが違う名前（`ASIA/TOKYO`、`Asia/TOKYO`）は書き方の誤りであり、
 * Chromium も `Invalid timezone ID` で拒否するので、拒否する（F13c）。
 */
const isAcceptedTimeZone = (timeZone: string): boolean => {
  if (!IANA_TIME_ZONE_NAME_PATTERN.test(timeZone)) {
    return false;
  }
  let resolvedTimeZone: string;
  try {
    resolvedTimeZone = new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone;
  } catch {
    return false;
  }
  const differsOnlyInLetterCase = resolvedTimeZone !== timeZone && resolvedTimeZone.toLowerCase() === timeZone.toLowerCase();
  return !differsOnlyInLetterCase;
};

/**
 * Chromium（Playwright の `locale`）が受け付ける locale か（R''2 の I-1）。
 * 正規の形（`Intl.getCanonicalLocales` の結果と一致する）で、言語の部分があり、それが `und` ではないものだけを受け付ける。
 * Chromium は `und`・`und-JP` を拒否する。
 */
const isAcceptedLocale = (locale: string): boolean => {
  try {
    if (Intl.getCanonicalLocales(locale)[0] !== locale) {
      return false;
    }
    const language: string | undefined = new Intl.Locale(locale).language;
    return language !== undefined && language.length > 0 && language !== UNDETERMINED_LANGUAGE;
  } catch {
    return false;
  }
};

/**
 * `allowedQueryParameters` は、クロールで開始URLを正規化するときと同じ値を使う。
 * 設定の値が文字列の配列でない場合（別のエラーとして報告する）は、引数をすべて除いて判定する。
 */
const validateSite = (site: UnknownRecord, allowedQueryParameters: ReadonlySet<string>, errors: string[]): void => {
  const rawStartUrl = typeof site.startUrl === 'string' ? site.startUrl : undefined;
  const startUrl = rawStartUrl === undefined ? undefined : validateHttpUrl(rawStartUrl);
  if (rawStartUrl === undefined || startUrl === undefined) {
    errors.push('site.startUrl must be an HTTP(S) URL');
  } else if (hasUrlCredentials(startUrl)) {
    errors.push('site.startUrl must not contain credentials');
  } else {
    // 実行時と同じ正規化で受け入れられない開始URL（例: 正規化した後に `MAX_URL_LENGTH` を超える）は、設定のエラーにする（R'2 の m5）。
    const normalized = normalizeUrl(rawStartUrl, rawStartUrl, allowedQueryParameters);
    if (!normalized.ok) {
      errors.push(`site.startUrl is rejected by URL normalization: ${normalized.reason}`);
    }
  }

  if (!isStringArray(site.allowedOrigins) || site.allowedOrigins.length === 0) {
    errors.push('site.allowedOrigins must be a non-empty string array');
    return;
  }
  const origins = site.allowedOrigins.map(validateHttpUrl);
  if (origins.some((origin) => origin === undefined)) {
    errors.push('site.allowedOrigins must contain only HTTP(S) URLs');
    return;
  }
  if (origins.some((origin) => origin !== undefined && hasUrlCredentials(origin))) {
    errors.push('site.allowedOrigins must not contain credentials');
    return;
  }
  if (startUrl !== undefined && !canonicalizeAllowedOrigins(site.allowedOrigins).has(startUrl.origin)) {
    errors.push('site.startUrl origin must be included in site.allowedOrigins');
  }
};

/**
 * Interaction が有効なら、ページの期限（`crawl.overallPageTimeoutMs`）が、Interaction の候補1つの予算
 * （`crawl.navigationTimeoutMs` + `INTERACTION_TIMEOUT_COUNT_PER_CANDIDATE` × `crawl.interactionTimeoutMs`）以上かを確かめる
 * （Task 14〜17 の設計書 4.5.7、R14 の m2）。満たさない設定では、Page Auditor が候補を1つも監査できず、除外される候補も記録されない。
 * 3つの時間のどれかが正の整数でない場合は、別のエラーとして報告するので、ここでは確かめない。
 */
const validateInteractionCandidateBudget = (crawl: UnknownRecord, audit: unknown, errors: string[]): void => {
  if (!isRecord(audit) || audit.interactions !== true) {
    return;
  }
  const { navigationTimeoutMs, interactionTimeoutMs, overallPageTimeoutMs } = crawl;
  if (!isPositiveSafeInteger(navigationTimeoutMs) || !isPositiveSafeInteger(interactionTimeoutMs)
    || !isPositiveSafeInteger(overallPageTimeoutMs)) {
    return;
  }
  const candidateBudgetMs = navigationTimeoutMs + INTERACTION_TIMEOUT_COUNT_PER_CANDIDATE * interactionTimeoutMs;
  if (overallPageTimeoutMs < candidateBudgetMs) {
    errors.push(
      `crawl.overallPageTimeoutMs must be at least crawl.navigationTimeoutMs + ${INTERACTION_TIMEOUT_COUNT_PER_CANDIDATE} `
        + `x crawl.interactionTimeoutMs (${candidateBudgetMs} ms) when audit.interactions is enabled`,
    );
  }
};

const validateViewport = (value: unknown, name: string, errors: string[]): value is Viewport => {
  if (!isRecord(value) || !hasExactKeys(value, ['width', 'height'])) {
    errors.push(`${name} must be an object with width and height`);
    return false;
  }
  if (!isPositiveSafeInteger(value.width) || !isPositiveSafeInteger(value.height)) {
    errors.push(`${name} width and height must be positive integers`);
    return false;
  }
  return true;
};

export const validateConfig = (input: unknown): ConfigValidationResult => {
  const errors: string[] = [];
  const sectionKeys = ['target', 'site', 'crawl', 'browser', 'viewports', 'audit', 'output'];
  if (!isRecord(input)) {
    return { ok: false, errors: ['configuration must be an object with only supported sections'] };
  }
  const unsupportedSectionKeys = unknownKeys(input, sectionKeys);
  if (unsupportedSectionKeys.length > 0) {
    return { ok: false, errors: unsupportedSectionKeys.map((key) => `unknown configuration key: ${key}`) };
  }
  const missingSectionKeys = sectionKeys.filter((key) => !Object.hasOwn(input, key));
  if (missingSectionKeys.length > 0) {
    return { ok: false, errors: missingSectionKeys.map((key) => `missing configuration section: ${key}`) };
  }

  const { target, site, crawl, browser, viewports, audit, output } = input;
  if (!isRecord(target) || !hasExactKeys(target, ['id'])) {
    errors.push('target must be an object with only id');
  } else if (typeof target.id !== 'string' || target.id.length === 0) {
    errors.push('target.id must be a non-empty string');
  }

  if (!isRecord(site) || !hasExactKeys(site, ['startUrl', 'allowedOrigins'])) {
    errors.push('site must be an object with startUrl and allowedOrigins');
  } else {
    const allowedQueryParameters = isRecord(crawl) && isStringArray(crawl.allowedQueryParameters)
      ? new Set(crawl.allowedQueryParameters)
      : new Set<string>();
    validateSite(site, allowedQueryParameters, errors);
  }

  const crawlKeys = [...crawlIntegerKeys, 'allowedQueryParameters'];
  if (!isRecord(crawl) || !hasExactKeys(crawl, crawlKeys)) {
    errors.push('crawl must be an object with only supported settings');
  } else {
    for (const key of crawlIntegerKeys) {
      if (!isPositiveSafeInteger(crawl[key])) {
        errors.push(`crawl.${key} must be a positive integer`);
      }
    }
    if (isPositiveSafeInteger(crawl.interactionTimeoutMs) && crawl.interactionTimeoutMs <= MIN_INTERACTION_TIMEOUT_EXCLUSIVE_MS) {
      errors.push(
        `crawl.interactionTimeoutMs must be greater than ${MIN_INTERACTION_TIMEOUT_EXCLUSIVE_MS} ms `
          + '(the pre-freeze stability check and the post-condition persistence check)',
      );
    }
    validateInteractionCandidateBudget(crawl, audit, errors);
    if (!isStringArray(crawl.allowedQueryParameters)) {
      errors.push('crawl.allowedQueryParameters must be a string array');
    }
  }

  if (!isRecord(browser) || !hasExactKeys(browser, ['headed', 'locale', 'timezone'])) {
    errors.push('browser must be an object with headed, locale, and timezone');
  } else if (typeof browser.headed !== 'boolean' || typeof browser.locale !== 'string' || typeof browser.timezone !== 'string') {
    errors.push('browser settings have invalid types');
  } else {
    // ブラウザの Context に渡す前に、Chromium が受け付ける値かを確かめる（R'2 の m5、R''2 の I-1）。
    if (!isAcceptedLocale(browser.locale)) {
      errors.push('browser.locale must be a canonical BCP 47 locale with a language (not "und")');
    }
    if (!isAcceptedTimeZone(browser.timezone)) {
      errors.push(
        'browser.timezone must be an IANA time zone name whose parts start with an uppercase letter or digit (not an offset), spelled with its canonical letter case',
      );
    }
  }

  if (!isRecord(viewports) || !hasExactKeys(viewports, ['primaryDesktop', 'primaryMobile', 'stressWidths'])) {
    errors.push('viewports must be an object with only supported settings');
  } else {
    validateViewport(viewports.primaryDesktop, 'viewports.primaryDesktop', errors);
    validateViewport(viewports.primaryMobile, 'viewports.primaryMobile', errors);
    if (!Array.isArray(viewports.stressWidths) || !viewports.stressWidths.every(isPositiveSafeInteger)) {
      errors.push('viewports.stressWidths must be an array of positive integers');
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
