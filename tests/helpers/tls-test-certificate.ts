// DEF-099 fix: テストだけの自前の証明書（127.0.0.1 だけ。テストの外で使わない）。
// - https の fixture のサーバが使う鍵と証明書。
// - 書き込みの送り手（`src/safety/write-submission-sender.ts`）の TLS の確かめに、テストだけ足す信頼の証明書（`additionalTrustedCertificates`）。
//   製品の確かめ（OS の証明書の置き場所と Node の同梱の証明書）は切らない。
// - ブラウザ（テストの Chromium）は、テストの起動の引数 `TEST_BROWSER_IGNORE_CERTIFICATE_ERRORS_ARGS` で証明書の誤りを無視する（`ignoreHTTPSErrors`
//   と同じ意味。テストの中だけ。CLI の Chromium は `--ignore-certificate-errors-spki-list` を受けないため、両方の Chromium で同じ引数にした）。
// DEF-099-key: 鍵と証明書はリポジトリに置かず（秘密の検出ツールに当たるため）、このモジュールを読み込んだときにメモリの中で作る。
// - 鍵は EC P-256（Node の `generateKeyPairSync`）。証明書は X.509 v3 の自己署名（CN=127.0.0.1、SAN IP:127.0.0.1、basicConstraints CA:TRUE
//   critical、subjectKeyIdentifier・authorityKeyIdentifier。署名は ecdsa-with-SHA256）。有効期限は作った時点の前後（`VALIDITY_BEFORE_MS`・
//   `VALIDITY_AFTER_MS`）。
// - 証明書の DER の組み立て（ASN.1 の DER の符号化）は、このテストの補助の中に閉じる（製品は証明書を作らない。依存も足さない）。
// - 作った証明書は `X509Certificate` で読み直して確かめ、作り損ねたら投げる。
// - 1 つの process の中では 1 回だけ作って使い回す（出す定数）。process ごとに別の鍵になる。今は fork の子に証明書を渡す経路はない
//   （信頼の証明書を渡す `writeSubmissionCertificates` は、テストの process の中で `executeWriteCreateRun` に直に渡す）。
import { X509Certificate, createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { DAY_MS } from '../../src/core/time-units.js';
import { LOOPBACK_HOST } from './loopback-server.js';

/** 作った鍵と証明書（PEM）。 */
export interface LoopbackTestCertificate {
  readonly certificate: string;
  readonly key: string;
}

/** `createLoopbackTestCertificate` の指定（テストが時点を決めるため）。 */
export interface LoopbackTestCertificateOptions {
  readonly now?: Date | undefined;
}

/** 有効期限の始まりを、作った時点からさかのぼる長さ（時計のずれの余裕）。 */
const VALIDITY_BEFORE_MS = DAY_MS;
/** 有効期限の終わりを、作った時点から進める日の数（1 回のテストの実行より十分に長い）。 */
const VALIDITY_AFTER_DAYS = 30;
/** 有効期限の終わりを、作った時点から進める長さ。 */
const VALIDITY_AFTER_MS = VALIDITY_AFTER_DAYS * DAY_MS;
/** 鍵の曲線（TLS のサーバと Node・Chromium の両方で受かるもの）。 */
const KEY_CURVE = 'P-256';
/** 署名の要約の関数（ecdsa-with-SHA256）。 */
const SIGNATURE_DIGEST = 'sha256';
/** subjectKeyIdentifier の要約の関数（RFC 5280 4.2.1.2 の (1)）。 */
const KEY_IDENTIFIER_DIGEST = 'sha1';
/** 通し番号の bytes の数（RFC 5280 は 20 octets まで。正の数にするため先頭の bit を落とす）。 */
const SERIAL_NUMBER_BYTES = 16;
/** X.509 の版（v3 は 2）。 */
const X509_VERSION_3 = 2;
/** UTCTime で書ける最後の年（RFC 5280 4.1.2.5: 2050 年からは GeneralizedTime）。 */
const LAST_UTC_TIME_YEAR = 2049;
/** UTCTime の 2 桁の年の割る数。 */
const UTC_TIME_YEAR_MODULUS = 100;
/** 日時の 2 桁の数字の幅。 */
const TWO_DIGITS = 2;
/** 年の 4 桁の数字の幅。 */
const FOUR_DIGITS = 4;
/** PEM の 1 行の文字の数。 */
const PEM_LINE_LENGTH = 64;

/** ASN.1 の DER の型の番号（使う分だけ）。 */
const DER_TAG = Object.freeze({
  BOOLEAN: 0x01,
  INTEGER: 0x02,
  BIT_STRING: 0x03,
  OCTET_STRING: 0x04,
  OBJECT_IDENTIFIER: 0x06,
  UTF8_STRING: 0x0c,
  UTC_TIME: 0x17,
  GENERALIZED_TIME: 0x18,
  SEQUENCE: 0x30,
  SET: 0x31,
  /** [0] EXPLICIT（版）。 */
  CONTEXT_0_CONSTRUCTED: 0xa0,
  /** [3] EXPLICIT（拡張）。 */
  CONTEXT_3_CONSTRUCTED: 0xa3,
  /** [0] IMPLICIT（authorityKeyIdentifier の keyIdentifier）。 */
  CONTEXT_0_PRIMITIVE: 0x80,
  /** [7] IMPLICIT（GeneralName の iPAddress）。 */
  CONTEXT_7_PRIMITIVE: 0x87,
});

/** 使う OID。 */
const OID = Object.freeze({
  ECDSA_WITH_SHA256: '1.2.840.10045.4.3.2',
  COMMON_NAME: '2.5.4.3',
  SUBJECT_KEY_IDENTIFIER: '2.5.29.14',
  SUBJECT_ALT_NAME: '2.5.29.17',
  BASIC_CONSTRAINTS: '2.5.29.19',
  AUTHORITY_KEY_IDENTIFIER: '2.5.29.35',
});

/** 長さの短い形の上限（これを超えると長い形）。 */
const DER_SHORT_LENGTH_LIMIT = 0x80;
/** 1 byte の値の上限と、7 bit・8 bit の区切り。 */
const BYTE_MASK = 0xff;
const BITS_PER_BYTE = 8;
const BASE128_MASK = 0x7f;
const BASE128_BITS = 7;
const BASE128_CONTINUATION = 0x80;
/** INTEGER の先頭の bit（立っていれば負の数と読まれる）。 */
const HIGH_BIT = 0x80;
/** OID の先頭の 2 つの数をまとめる掛ける数（X.690 8.19.4）。 */
const OID_FIRST_ARC_MULTIPLIER = 40;
/** EC の非圧縮の点の先頭の byte（SEC 1 2.3.3）。 */
const UNCOMPRESSED_POINT_PREFIX = 0x04;
/** BOOLEAN の TRUE。 */
const DER_TRUE = 0xff;

const tlv = (tag: number, content: Uint8Array): Buffer => Buffer.concat([Buffer.of(tag), derLengthOf(content.length), content]);

const derLengthOf = (length: number): Buffer => {
  if (length < DER_SHORT_LENGTH_LIMIT) {
    return Buffer.of(length);
  }
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / (BYTE_MASK + 1))) {
    bytes.unshift(rest & BYTE_MASK);
  }
  return Buffer.of(DER_SHORT_LENGTH_LIMIT | bytes.length, ...bytes);
};

const sequence = (...parts: readonly Uint8Array[]): Buffer => tlv(DER_TAG.SEQUENCE, Buffer.concat(parts));
const set = (...parts: readonly Uint8Array[]): Buffer => tlv(DER_TAG.SET, Buffer.concat(parts));
const octetString = (content: Uint8Array): Buffer => tlv(DER_TAG.OCTET_STRING, content);
/** 未使用の bit が 0 の BIT STRING。 */
const bitString = (content: Uint8Array): Buffer => tlv(DER_TAG.BIT_STRING, Buffer.concat([Buffer.of(0), content]));
const derTrue = (): Buffer => tlv(DER_TAG.BOOLEAN, Buffer.of(DER_TRUE));

/** 符号なしの数の bytes から、正の INTEGER（余分な先頭の 0 を落とし、先頭の bit が立っていれば 0 を足す）。 */
const unsignedInteger = (bytes: Uint8Array): Buffer => {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) {
    start += 1;
  }
  const trimmed = Buffer.from(bytes.subarray(start));
  return tlv(DER_TAG.INTEGER, ((trimmed[0] ?? 0) & HIGH_BIT) === 0 ? trimmed : Buffer.concat([Buffer.of(0), trimmed]));
};

const smallInteger = (value: number): Buffer => unsignedInteger(Buffer.of(value));

const base128 = (value: number): number[] => {
  const bytes = [value & BASE128_MASK];
  for (let rest = Math.floor(value / (BASE128_MASK + 1)); rest > 0; rest = Math.floor(rest / (BASE128_MASK + 1))) {
    bytes.unshift((rest & BASE128_MASK) | BASE128_CONTINUATION);
  }
  return bytes;
};

const objectIdentifier = (dotted: string): Buffer => {
  const [first = 0, second = 0, ...rest] = dotted.split('.').map(Number);
  return tlv(DER_TAG.OBJECT_IDENTIFIER, Buffer.from([first * OID_FIRST_ARC_MULTIPLIER + second, ...rest].flatMap(base128)));
};

const paddedOf = (value: number, width: number): string => String(value).padStart(width, '0');

/** RFC 5280 4.1.2.5 の時刻（秒まで、Z）。2049 年までは UTCTime、それより後は GeneralizedTime。 */
const derTime = (at: Date): Buffer => {
  const year = at.getUTCFullYear();
  const rest = [at.getUTCMonth() + 1, at.getUTCDate(), at.getUTCHours(), at.getUTCMinutes(), at.getUTCSeconds()]
    .map((value) => paddedOf(value, TWO_DIGITS)).join('');
  return year <= LAST_UTC_TIME_YEAR
    ? tlv(DER_TAG.UTC_TIME, Buffer.from(`${paddedOf(year % UTC_TIME_YEAR_MODULUS, TWO_DIGITS)}${rest}Z`, 'ascii'))
    : tlv(DER_TAG.GENERALIZED_TIME, Buffer.from(`${paddedOf(year, FOUR_DIGITS)}${rest}Z`, 'ascii'));
};

/** IPv4 の文字列（a.b.c.d）の 4 bytes。 */
const ipv4BytesOf = (address: string): Buffer => Buffer.from(address.split('.').map(Number));

const extension = (oid: string, value: Uint8Array, critical: boolean): Buffer =>
  sequence(objectIdentifier(oid), ...(critical ? [derTrue()] : []), octetString(value));

/** CN だけの Name。 */
const commonNameOf = (name: string): Buffer =>
  sequence(set(sequence(objectIdentifier(OID.COMMON_NAME), tlv(DER_TAG.UTF8_STRING, Buffer.from(name, 'utf8')))));

/** 公開鍵の bytes（SubjectPublicKeyInfo の BIT STRING の中身。P-256 の非圧縮の点）から、鍵の識別子。 */
const keyIdentifierOf = (publicKey: KeyObject): Buffer => {
  const jwk = publicKey.export({ format: 'jwk' });
  if (typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
    throw new Error('the loopback test key has no EC point');
  }
  const uncompressedPoint = Buffer.concat([Buffer.of(UNCOMPRESSED_POINT_PREFIX), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  return createHash(KEY_IDENTIFIER_DIGEST).update(uncompressedPoint).digest();
};

const pemOf = (label: string, der: Buffer): string => {
  const base64 = der.toString('base64');
  const lines: string[] = [];
  for (let start = 0; start < base64.length; start += PEM_LINE_LENGTH) {
    lines.push(base64.slice(start, start + PEM_LINE_LENGTH));
  }
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
};

/** 作った証明書を読み直して確かめる（作り損ねたら投げる）。 */
const assertMadeCertificate = (pem: string, privateKey: KeyObject, at: Date): void => {
  const certificate = new X509Certificate(pem);
  const problems = [
    certificate.subject === `CN=${LOOPBACK_HOST}` ? null : `subject ${certificate.subject}`,
    certificate.issuer === `CN=${LOOPBACK_HOST}` ? null : `issuer ${certificate.issuer}`,
    certificate.subjectAltName === `IP Address:${LOOPBACK_HOST}` ? null : `subjectAltName ${String(certificate.subjectAltName)}`,
    certificate.checkPrivateKey(privateKey) ? null : 'the key does not pair',
    certificate.verify(certificate.publicKey) ? null : 'the signature does not verify',
    certificate.validFromDate.getTime() <= at.getTime() && at.getTime() < certificate.validToDate.getTime() ? null : 'not valid at the time',
  ].filter((problem): problem is string => problem !== null);
  if (problems.length > 0) {
    throw new Error(`the loopback test certificate was not made right: ${problems.join(', ')}`);
  }
};

/** テストだけの自前の鍵と自己署名の証明書を、メモリの中で作る（呼ぶたびに新しい鍵）。 */
export const createLoopbackTestCertificate = (options: LoopbackTestCertificateOptions = {}): LoopbackTestCertificate => {
  const at = options.now ?? new Date();
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: KEY_CURVE });
  const keyIdentifier = keyIdentifierOf(publicKey);
  const serialNumber = randomBytes(SERIAL_NUMBER_BYTES);
  serialNumber[0] = (serialNumber[0] ?? 0) & ~HIGH_BIT & BYTE_MASK;
  const signatureAlgorithm = sequence(objectIdentifier(OID.ECDSA_WITH_SHA256));
  const name = commonNameOf(LOOPBACK_HOST);
  const extensions = sequence(
    extension(OID.SUBJECT_KEY_IDENTIFIER, octetString(keyIdentifier), false),
    extension(OID.AUTHORITY_KEY_IDENTIFIER, sequence(tlv(DER_TAG.CONTEXT_0_PRIMITIVE, keyIdentifier)), false),
    extension(OID.SUBJECT_ALT_NAME, sequence(tlv(DER_TAG.CONTEXT_7_PRIMITIVE, ipv4BytesOf(LOOPBACK_HOST))), false),
    extension(OID.BASIC_CONSTRAINTS, sequence(derTrue()), true),
  );
  const toBeSigned = sequence(
    tlv(DER_TAG.CONTEXT_0_CONSTRUCTED, smallInteger(X509_VERSION_3)),
    unsignedInteger(serialNumber),
    signatureAlgorithm,
    name,
    sequence(derTime(new Date(at.getTime() - VALIDITY_BEFORE_MS)), derTime(new Date(at.getTime() + VALIDITY_AFTER_MS))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    tlv(DER_TAG.CONTEXT_3_CONSTRUCTED, extensions),
  );
  const signature = sign(SIGNATURE_DIGEST, toBeSigned, privateKey);
  const certificate = pemOf('CERTIFICATE', sequence(toBeSigned, signatureAlgorithm, bitString(signature)));
  assertMadeCertificate(certificate, privateKey, at);
  return { certificate, key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
};

const madeForThisProcess = createLoopbackTestCertificate();

/** テストだけの自前の証明書（PEM。この process の中で 1 回だけ作る）。 */
export const LOOPBACK_TEST_CERTIFICATE = madeForThisProcess.certificate;
/** テストだけの自前の証明書の鍵（PEM。この process の中で 1 回だけ作る）。 */
export const LOOPBACK_TEST_KEY = madeForThisProcess.key;
/** テストの Chromium の、証明書の誤りを無視する起動の引数（テストの中だけ）。 */
export const TEST_BROWSER_IGNORE_CERTIFICATE_ERRORS_ARGS = Object.freeze(['--ignore-certificate-errors']);
