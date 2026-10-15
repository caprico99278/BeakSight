/**
 * 要求の守りの部品（`launcher/request-guard.ts`）の単体テスト（Task 23 設計書 4.4、7 章「画面のサーバ」。T23e）。
 */
import { createHash } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_STYLE_HASH_RESPONSE_HEADER,
  CSP_NONCE_BYTES,
  HTTP_STATUS,
  SESSION_TOKEN_BYTES,
  artifactSecurityHeaders,
  buildArtifactContentSecurityPolicy,
  buildContentSecurityPolicy,
  createCspNonce,
  createSessionToken,
  evaluateRequest,
  formatTokenUrl,
  guardNodeRequest,
  isTokenEqual,
  securityHeaders,
  sessionCookieName,
  type LocalUiGuardOptions,
} from '../launcher/request-guard.ts';
import { LOCAL_UI_GUARD_REJECTION_TEXT } from '../../../src/presentation/messages.js';
import { ARTIFACT_ROUTE_PREFIX, isArtifactRoutePath } from '../src/security/artifact-route.ts';
import { CSP_NONCE_REQUEST_HEADER } from '../src/security/csp-nonce.ts';

const PORT = 43_210;
const TOKEN = createSessionToken();
const OPTIONS: LocalUiGuardOptions = { port: PORT, token: TOKEN, rejectionText: LOCAL_UI_GUARD_REJECTION_TEXT };
const HOST = `127.0.0.1:${PORT}`;
const COOKIE = `${sessionCookieName(PORT)}=${TOKEN}`;
/** 要求を受けた socket の手元のアドレス（待ち受けの 127.0.0.1）。 */
const LOOPBACK_ADDRESS = '127.0.0.1';

describe('session token and nonce', () => {
  it('creates a base64url token of the named length, different each time', () => {
    const other = createSessionToken();
    expect(TOKEN).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(Buffer.from(TOKEN, 'base64url')).toHaveLength(SESSION_TOKEN_BYTES);
    expect(other).not.toBe(TOKEN);
  });

  it('creates a base64 nonce of the named length, different each time', () => {
    const nonce = createCspNonce();
    expect(Buffer.from(nonce, 'base64')).toHaveLength(CSP_NONCE_BYTES);
    expect(createCspNonce()).not.toBe(nonce);
  });

  it('compares tokens in constant time, and rejects different lengths and empty values', () => {
    expect(isTokenEqual(TOKEN, TOKEN)).toBe(true);
    expect(isTokenEqual(`${TOKEN}x`, TOKEN)).toBe(false);
    expect(isTokenEqual(TOKEN.slice(1), TOKEN)).toBe(false);
    expect(isTokenEqual('', TOKEN)).toBe(false);
    expect(isTokenEqual(createSessionToken(), TOKEN)).toBe(false);
  });

  it('prints the token URL on 127.0.0.1 only', () => {
    expect(formatTokenUrl(PORT, TOKEN)).toBe(`http://127.0.0.1:${PORT}/?token=${TOKEN}`);
  });

  it('uses a nonce request header name that a browser cannot forge through fetch metadata', () => {
    expect(CSP_NONCE_REQUEST_HEADER).toMatch(/^x-beaksight-/u);
  });
});

describe('evaluateRequest: Host', () => {
  it('rejects every Host except 127.0.0.1:<port> with 421', () => {
    for (const host of [undefined, '', `localhost:${PORT}`, '127.0.0.1', `127.0.0.1:${PORT + 1}`, `attacker.invalid:${PORT}`, 'attacker.invalid',
      `[::1]:${PORT}`, `127.0.0.1:${PORT}.attacker.invalid`, `127.0.0.1:0${PORT}`, `127.0.0.1:${PORT} `, `LOCALHOST:${PORT}`]) {
      expect(evaluateRequest(OPTIONS, { localAddress: LOOPBACK_ADDRESS, url: '/', host, cookie: COOKIE }), String(host)).toEqual({
        kind: 'reject',
        status: HTTP_STATUS.MISDIRECTED_REQUEST,
      });
    }
  });

  it('rejects a request target that is not a path (absolute form) with 400', () => {
    expect(evaluateRequest(OPTIONS, { localAddress: LOOPBACK_ADDRESS, url: `http://attacker.invalid/`, host: HOST, cookie: COOKIE })).toEqual({
      kind: 'reject',
      status: HTTP_STATUS.BAD_REQUEST,
    });
    expect(evaluateRequest(OPTIONS, { localAddress: LOOPBACK_ADDRESS, url: undefined, host: HOST, cookie: COOKIE })).toEqual({
      kind: 'reject',
      status: HTTP_STATUS.BAD_REQUEST,
    });
  });
});

describe('evaluateRequest: local address of the socket (T23h, I1)', () => {
  it('rejects a request that arrived on any address other than 127.0.0.1 with 421, even with the right Host and cookie', () => {
    for (const localAddress of [undefined, '', '0.0.0.0', '192.168.10.20', '10.0.0.5', '::1', '::ffff:127.0.0.1', '::', '127.0.0.2']) {
      expect(evaluateRequest(OPTIONS, { localAddress, url: '/', host: HOST, cookie: COOKIE }), String(localAddress)).toEqual({
        kind: 'reject',
        status: HTTP_STATUS.MISDIRECTED_REQUEST,
      });
      expect(evaluateRequest(OPTIONS, { localAddress, url: `/?token=${TOKEN}`, host: HOST, cookie: undefined }), String(localAddress)).toEqual({
        kind: 'reject',
        status: HTTP_STATUS.MISDIRECTED_REQUEST,
      });
    }
    expect(evaluateRequest(OPTIONS, { localAddress: LOOPBACK_ADDRESS, url: '/', host: HOST, cookie: COOKIE })).toEqual({ kind: 'allow' });
  });
});

describe('evaluateRequest: token and cookie', () => {
  it('allows a request with the session cookie', () => {
    expect(evaluateRequest(OPTIONS, { localAddress: LOOPBACK_ADDRESS, url: '/', host: HOST, cookie: COOKIE })).toEqual({ kind: 'allow' });
    expect(evaluateRequest(OPTIONS, { localAddress: LOOPBACK_ADDRESS, url: '/_serverFn/x', host: HOST, cookie: `other=1; ${COOKIE}; more=2` })).toEqual({ kind: 'allow' });
  });

  it('rejects requests without a cookie or with a wrong cookie with 401', () => {
    for (const cookie of [undefined, '', `${sessionCookieName(PORT)}=wrong`, `${sessionCookieName(PORT + 1)}=${TOKEN}`, `${sessionCookieName(PORT)}=`,
      `x${sessionCookieName(PORT)}=${TOKEN}`]) {
      for (const url of ['/', '/assets/index.js', '/_serverFn/abc']) {
        expect(evaluateRequest(OPTIONS, { localAddress: LOOPBACK_ADDRESS, url, host: HOST, cookie }), `${url} ${String(cookie)}`).toEqual({
          kind: 'reject',
          status: HTTP_STATUS.UNAUTHORIZED,
        });
      }
    }
  });

  it('exchanges a correct ?token= for the cookie, and redirects with 303 to the URL without the token', () => {
    const decision = evaluateRequest(OPTIONS, { localAddress: LOOPBACK_ADDRESS, url: `/?token=${TOKEN}`, host: HOST, cookie: undefined });
    expect(decision).toEqual({
      kind: 'redirect',
      status: HTTP_STATUS.SEE_OTHER,
      location: '/',
      setCookie: `${sessionCookieName(PORT)}=${TOKEN}; HttpOnly; SameSite=Strict; Path=/`,
    });
    const withQuery = evaluateRequest(OPTIONS, { localAddress: LOOPBACK_ADDRESS, url: `/profiles?a=1&token=${TOKEN}&b=2`, host: HOST, cookie: COOKIE });
    expect(withQuery).toMatchObject({ kind: 'redirect', location: '/profiles?a=1&b=2' });
  });

  it('rejects a wrong or repeated ?token= with 401, even with a valid cookie', () => {
    for (const url of ['/?token=wrong', '/?token=', `/?token=${TOKEN}&token=${TOKEN}`, `/?token=${TOKEN}x`]) {
      expect(evaluateRequest(OPTIONS, { localAddress: LOOPBACK_ADDRESS, url, host: HOST, cookie: COOKIE }), url).toEqual({ kind: 'reject', status: HTTP_STATUS.UNAUTHORIZED });
    }
  });

  it('never redirects to another origin', () => {
    const decision = evaluateRequest(OPTIONS, { localAddress: LOOPBACK_ADDRESS, url: `//attacker.invalid/?token=${TOKEN}`, host: HOST, cookie: undefined });
    expect(decision).toEqual({ kind: 'reject', status: HTTP_STATUS.BAD_REQUEST });
  });
});

describe('security headers and CSP', () => {
  it('builds the production CSP with the nonce, without unsafe-inline or unsafe-eval', () => {
    const csp = buildContentSecurityPolicy('abc');
    expect(csp.split('; ')).toEqual([
      "default-src 'self'",
      "script-src 'self' 'nonce-abc'",
      "style-src 'self'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ]);
    expect(csp).not.toMatch(/unsafe-/u);
  });

  it('puts the nonce of each request into script-src, and allows no other script source', () => {
    const csp = buildContentSecurityPolicy('xyz');
    expect(csp).toContain("script-src 'self' 'nonce-xyz'; ");
    expect(csp).not.toMatch(/unsafe-|ws:|\*/u);
  });

  it('returns every header for every response', () => {
    expect(securityHeaders('abc')).toEqual({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Content-Security-Policy': buildContentSecurityPolicy('abc'),
    });
  });
});

/** 成功の応答の状態。 */
const OK_STATUS = 200;
/** 例の `<style>` の中身の SHA-256（base64）。 */
const STYLE_HASH = createHash('sha256').update('body{color:red}', 'utf8').digest('base64');

describe('artifact responses: CSP without scripts (T24f, Task 24 design 4.5)', () => {
  it('builds the artifact CSP: sandbox without scripts, no source by default, images from self, styles only by their hash', () => {
    expect(buildArtifactContentSecurityPolicy([STYLE_HASH]).split('; ')).toEqual([
      'sandbox allow-same-origin',
      "default-src 'none'",
      "img-src 'self' data:",
      `style-src 'sha256-${STYLE_HASH}'`,
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ]);
    const csp = buildArtifactContentSecurityPolicy([STYLE_HASH]);
    expect(csp).not.toMatch(/unsafe-|allow-scripts|script-src|nonce-/u);
  });

  it('allows no style without a valid hash, and drops values that are not a SHA-256 in base64', () => {
    expect(buildArtifactContentSecurityPolicy([])).toContain("style-src 'none'");
    for (const value of ["abc'; script-src *", '', `${STYLE_HASH}x`, STYLE_HASH.slice(1), 'unsafe-inline', `${STYLE_HASH} 'unsafe-inline'`]) {
      expect(buildArtifactContentSecurityPolicy([value]), value).toContain("style-src 'none'");
      expect(buildArtifactContentSecurityPolicy([value, STYLE_HASH]), value).toContain(`style-src 'sha256-${STYLE_HASH}';`);
    }
  });

  it('keeps the other security headers for artifacts', () => {
    expect(artifactSecurityHeaders([])).toEqual({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Content-Security-Policy': buildArtifactContentSecurityPolicy([]),
    });
  });

  it('recognizes the artifact route paths (case-insensitive prefix), and nothing else', () => {
    expect(ARTIFACT_ROUTE_PREFIX).toBe('/artifacts/');
    for (const path of ['/artifacts/job-1/report.html', '/ARTIFACTS/job-1/run.json', '/artifacts/']) {
      expect(isArtifactRoutePath(path), path).toBe(true);
    }
    for (const path of ['/', '/artifacts', '/jobs/artifacts/x', '/_serverFn/abc', '/artifactsx/y']) {
      expect(isArtifactRoutePath(path), path).toBe(false);
    }
  });
});

/** 守りの部品を掛けた小さなサーバに要求を送り、応答の header を受け取る（`respond` は守りを通った後の応答）。 */
const guardedHeaders = (
  path: string,
  respond: (response: ServerResponse) => void,
): Promise<IncomingHttpHeaders> => new Promise((resolveHeaders, rejectHeaders) => {
  const server = createServer((request, response) => {
    if (guardNodeRequest({ ...OPTIONS, port: (server.address() as AddressInfo).port }, request, response)) {
      respond(response);
    }
  });
  server.listen({ host: LOOPBACK_ADDRESS, port: 0 }, () => {
    const { port } = server.address() as AddressInfo;
    const req = httpRequest({ host: LOOPBACK_ADDRESS, port, path, headers: { host: `${LOOPBACK_ADDRESS}:${port}`, cookie: `${sessionCookieName(port)}=${TOKEN}` } }, (res) => {
      res.resume();
      res.on('end', () => {
        server.close();
        resolveHeaders(res.headers);
      });
    });
    req.on('error', (error) => {
      server.close();
      rejectHeaders(error);
    });
    req.end();
  });
});

describe('guardNodeRequest: the CSP depends on the path (T24f)', () => {
  it('gives the artifact CSP to the artifact routes, with the style hash that the route passed, and never sends the internal header', async () => {
    const headers = await guardedHeaders('/artifacts/job-1/report.html', (response) => {
      response.writeHead(OK_STATUS, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "script-src 'unsafe-inline'",
        [ARTIFACT_STYLE_HASH_RESPONSE_HEADER]: STYLE_HASH,
      });
      response.end('<p>report</p>');
    });
    expect(headers['content-security-policy']).toBe(buildArtifactContentSecurityPolicy([STYLE_HASH]));
    expect(headers[ARTIFACT_STYLE_HASH_RESPONSE_HEADER]).toBeUndefined();
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['cache-control']).toBe('no-store');
  });

  it('normalizes the path like the URL parser before choosing (dot segments), and keeps the UI CSP elsewhere', async () => {
    const normalized = await guardedHeaders('/jobs/../artifacts/job-1/run.json', (response) => {
      response.end('{}');
    });
    expect(normalized['content-security-policy']).toBe(buildArtifactContentSecurityPolicy([]));
    const ui = await guardedHeaders('/artifacts/../jobs', (response) => {
      response.setHeader(ARTIFACT_STYLE_HASH_RESPONSE_HEADER, STYLE_HASH);
      response.end('ok');
    });
    expect(String(ui['content-security-policy'])).toMatch(/^default-src 'self'; script-src 'self' 'nonce-/u);
    expect(ui[ARTIFACT_STYLE_HASH_RESPONSE_HEADER]).toBeUndefined();
  });
});
