import { describe, expect, it } from 'vitest';
import {
  NETWORK_LAYER_FAILURE_CODE_PREFIXES,
  NETWORK_LAYER_FAILURE_CODES,
  RESPONSE_RECEIVED_FAILURE_CODES,
  isNetworkLayerFailure,
  isResponseReceivedFailure,
} from '../../src/safety/network-layer-failure.js';

describe('ネットワークの層の失敗の閉じた一覧（DEF-004）', () => {
  it('一覧は、設計者が決めたコードと接頭辞だけを持つ', () => {
    expect(NETWORK_LAYER_FAILURE_CODES).toEqual([
      'net::ERR_CONNECTION_REFUSED',
      'net::ERR_CONNECTION_RESET',
      'net::ERR_CONNECTION_CLOSED',
      'net::ERR_CONNECTION_ABORTED',
      'net::ERR_CONNECTION_FAILED',
      'net::ERR_CONNECTION_TIMED_OUT',
      'net::ERR_TIMED_OUT',
      'net::ERR_EMPTY_RESPONSE',
      // DEF-029: 本文の途中で、サーバか経路が接続を切った失敗
      'net::ERR_CONTENT_LENGTH_MISMATCH',
      'net::ERR_INCOMPLETE_CHUNKED_ENCODING',
      'net::ERR_NETWORK_CHANGED',
      'net::ERR_INTERNET_DISCONNECTED',
      'net::ERR_NAME_NOT_RESOLVED',
      'net::ERR_NAME_RESOLUTION_FAILED',
      'net::ERR_ADDRESS_UNREACHABLE',
      'net::ERR_ADDRESS_INVALID',
    ]);
    expect(NETWORK_LAYER_FAILURE_CODE_PREFIXES).toEqual(['net::ERR_SSL_', 'net::ERR_CERT_']);
  });

  it.each(NETWORK_LAYER_FAILURE_CODES)('一覧のコード %s を、ネットワークの層の失敗と判定する', (code) => {
    expect(isNetworkLayerFailure(code)).toBe(true);
  });

  it.each([
    'net::ERR_CONTENT_LENGTH_MISMATCH',
    'net::ERR_INCOMPLETE_CHUNKED_ENCODING',
  ])('DEF-029: 本文の途中の切断 %s を、ネットワークの層の失敗と判定する', (code) => {
    expect(isNetworkLayerFailure(code)).toBe(true);
  });

  it.each([
    'net::ERR_SSL_PROTOCOL_ERROR',
    'net::ERR_SSL_VERSION_OR_CIPHER_MISMATCH',
    'net::ERR_CERT_AUTHORITY_INVALID',
    'net::ERR_CERT_DATE_INVALID',
  ])('TLS の接頭辞に合うコード %s を、ネットワークの層の失敗と判定する', (code) => {
    expect(isNetworkLayerFailure(code)).toBe(true);
  });

  it.each([
    // 一覧に入れないと決めたもの
    'net::ERR_ABORTED',
    'net::ERR_FAILED',
    'net::ERR_BLOCKED_BY_CLIENT',
    'net::ERR_BLOCKED_BY_RESPONSE',
    'net::ERR_UNSAFE_REDIRECT',
    'net::ERR_UNSAFE_PORT',
    'net::ERR_INVALID_RESPONSE',
    'net::ERR_INVALID_REDIRECT',
    // そのほか一覧にないもの
    'net::ERR_HTTP2_PROTOCOL_ERROR',
    'net::ERR_BAD_SSL_CLIENT_AUTH_CERT',
    'main-frame request failed without an error reason',
    '',
    // 完全一致でないもの
    'ERR_CONNECTION_REFUSED',
    'net::ERR_CONNECTION_REFUSED ',
    ' net::ERR_CONNECTION_REFUSED',
    'net::err_connection_refused',
    'net::ERR_CONNECTION_REFUSED at http://127.0.0.1:9/',
    // 接頭辞だけ、または接頭辞の後ろにコードとして不正な文字があるもの
    'net::ERR_SSL_',
    'net::ERR_CERT_',
    'net::ERR_SSL_PROTOCOL_ERROR; net::ERR_ABORTED',
    'net::ERR_CERT_invalid',
  ])('一覧にない理由 %j は、ネットワークの層の失敗と判定しない', (errorText) => {
    expect(isNetworkLayerFailure(errorText)).toBe(false);
  });

  it.each(RESPONSE_RECEIVED_FAILURE_CODES)('応答を受けた後の失敗 %s は、ネットワークの層の失敗と判定しない（2つの一覧は重ならない）', (code) => {
    expect(isNetworkLayerFailure(code)).toBe(false);
  });
});

describe('応答を受けた後の失敗の閉じた一覧（DEF-029）', () => {
  it('一覧は、設計者が決めたコードだけを持ち、凍結している', () => {
    expect(RESPONSE_RECEIVED_FAILURE_CODES).toEqual([
      'net::ERR_HTTP_RESPONSE_CODE_FAILURE',
      'net::ERR_INVALID_AUTH_CREDENTIALS',
    ]);
    expect(Object.isFrozen(RESPONSE_RECEIVED_FAILURE_CODES)).toBe(true);
  });

  it.each(RESPONSE_RECEIVED_FAILURE_CODES)('一覧のコード %s を、応答を受けた後の失敗と判定する', (code) => {
    expect(isResponseReceivedFailure(code)).toBe(true);
  });

  it.each([
    // Guard の中断、ダウンロードへの切り替わり、外部スキームへの 3xx など、理由が違うもの
    'net::ERR_ABORTED',
    'net::ERR_FAILED',
    'net::ERR_BLOCKED_BY_CLIENT',
    'net::ERR_BLOCKED_BY_RESPONSE',
    'net::ERR_INVALID_RESPONSE',
    // ネットワークの層の失敗（別の一覧）
    'net::ERR_CONNECTION_REFUSED',
    'net::ERR_EMPTY_RESPONSE',
    'net::ERR_CONTENT_LENGTH_MISMATCH',
    'net::ERR_INCOMPLETE_CHUNKED_ENCODING',
    // そのほか一覧にないもの
    'main-frame request failed without an error reason',
    '',
    // 完全一致でないもの（前後に文字がある、大文字小文字が違う、接頭辞がない）
    ' net::ERR_HTTP_RESPONSE_CODE_FAILURE',
    'net::ERR_HTTP_RESPONSE_CODE_FAILURE ',
    'net::ERR_HTTP_RESPONSE_CODE_FAILURE at http://127.0.0.1:9/',
    'net::ERR_HTTP_RESPONSE_CODE_FAILURE; net::ERR_ABORTED',
    'net::err_http_response_code_failure',
    'NET::ERR_INVALID_AUTH_CREDENTIALS',
    'ERR_HTTP_RESPONSE_CODE_FAILURE',
    'net::ERR_INVALID_AUTH_CREDENTIALS_',
    'net::ERR_HTTP_RESPONSE_CODE',
  ])('一覧にない理由 %j は、応答を受けた後の失敗と判定しない', (errorText) => {
    expect(isResponseReceivedFailure(errorText)).toBe(false);
  });
});
