import { describe, expect, it } from 'vitest';
import {
  NETWORK_LAYER_FAILURE_CODE_PREFIXES,
  NETWORK_LAYER_FAILURE_CODES,
  isNetworkLayerFailure,
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
});
