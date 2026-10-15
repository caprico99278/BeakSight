// DEF-099-key: テストだけの自前の証明書（`tests/helpers/tls-test-certificate.ts`）は、リポジトリに置かず、テストの起動のときにメモリの中で作る。
// - 作った証明書が `X509Certificate` で読め、CN と SAN が 127.0.0.1、鍵と対になり（`checkPrivateKey`）、自分の鍵で署名され、有効期限の中で、PEM の形。
// - 1 つの process の中では 1 回だけ作って使い回す（出す定数は同じ値）。作り直すたびに鍵は変わる（リポジトリの固定の鍵ではない）。
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LOOPBACK_HOST } from '../helpers/loopback-server.js';
import {
  LOOPBACK_TEST_CERTIFICATE,
  LOOPBACK_TEST_KEY,
  TEST_BROWSER_IGNORE_CERTIFICATE_ERRORS_ARGS,
  createLoopbackTestCertificate,
} from '../helpers/tls-test-certificate.js';

/** PEM の形（1 行 64 文字までの base64）。秘密の検出ツールに当たらないよう、見出しの語は組み立てる。 */
const pemPatternOf = (label: string): RegExp =>
  new RegExp(`^-----BEGIN ${label}-----\n(?:[A-Za-z0-9+/=]{1,64}\n)+-----END ${label}-----\n$`, 'u');
const CERTIFICATE_PEM = pemPatternOf('CERTIFICATE');
const PRIVATE_KEY_PEM = pemPatternOf(['PRIVATE', 'KEY'].join(' '));

describe('DEF-099-key: the loopback test certificate is made in memory', () => {
  it('exports a PEM certificate and a PEM private key', () => {
    expect(LOOPBACK_TEST_CERTIFICATE).toMatch(CERTIFICATE_PEM);
    expect(LOOPBACK_TEST_KEY).toMatch(PRIVATE_KEY_PEM);
    expect(TEST_BROWSER_IGNORE_CERTIFICATE_ERRORS_ARGS).toEqual(['--ignore-certificate-errors']);
  });

  it('reads back as a self-signed X.509 v3 certificate for 127.0.0.1 that pairs with the key and is valid now', () => {
    const certificate = new X509Certificate(LOOPBACK_TEST_CERTIFICATE);
    const key = createPrivateKey(LOOPBACK_TEST_KEY);
    expect(certificate.subject).toBe(`CN=${LOOPBACK_HOST}`);
    expect(certificate.issuer).toBe(`CN=${LOOPBACK_HOST}`);
    expect(certificate.subjectAltName).toBe(`IP Address:${LOOPBACK_HOST}`);
    expect(certificate.checkIP(LOOPBACK_HOST)).toBe(LOOPBACK_HOST);
    expect(certificate.checkPrivateKey(key)).toBe(true);
    expect(certificate.verify(certificate.publicKey)).toBe(true);
    expect(certificate.ca).toBe(true);
    const now = Date.now();
    expect(certificate.validFromDate.getTime()).toBeLessThanOrEqual(now);
    expect(certificate.validToDate.getTime()).toBeGreaterThan(now);
  });

  it('makes a new key each time it is asked, and keeps one pair for the process', () => {
    const first = createLoopbackTestCertificate();
    const second = createLoopbackTestCertificate();
    expect(first.key).not.toBe(second.key);
    expect(first.certificate).not.toBe(second.certificate);
    expect(new X509Certificate(first.certificate).checkPrivateKey(createPrivateKey(second.key))).toBe(false);
    expect(new X509Certificate(first.certificate).checkPrivateKey(createPrivateKey(first.key))).toBe(true);
    expect(LOOPBACK_TEST_CERTIFICATE).not.toBe(first.certificate);
  });

  it('keeps the validity around the given time', () => {
    // UTCTime（2 桁の年）は 2049 年まで。有効期限の終わりが 2050 年に入る時点で、GeneralizedTime の形も読めることを確かめる。
    const at = new Date(Date.UTC(2049, 11, 31, 0, 0, 0));
    const made = new X509Certificate(createLoopbackTestCertificate({ now: at }).certificate);
    expect(made.validFromDate.getTime()).toBeLessThanOrEqual(at.getTime());
    expect(made.validToDate.getTime()).toBeGreaterThan(at.getTime());
  });
});
