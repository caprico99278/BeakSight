import { describe, expect, it } from 'vitest';
import { classifyPassiveRequest, isReadMethod } from '../../src/safety/request-policy.js';

const allowedOrigins = new Set(['HTTPS://EXAMPLE.TEST:443/path']);

describe('isReadMethod', () => {
  it.each(['GET', 'get', 'GeT', 'HEAD', 'head', 'HeAd'])(
    'allows the case-insensitive read method %s',
    (method) => {
      expect(isReadMethod(method)).toBe(true);
    },
  );

  it.each(['OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE', 'CONNECT', '', 'UNKNOWN'])(
    'blocks the non-read method %s',
    (method) => {
      expect(isReadMethod(method)).toBe(false);
    },
  );
});

describe('classifyPassiveRequest', () => {
  it('blocks a non-read method before considering navigation authority', () => {
    expect(classifyPassiveRequest({
      kind: 'HTTP',
      method: 'post',
      url: 'https://external.test/submit',
      isNavigationRequest: true,
      isMainFrame: true,
    }, allowedOrigins)).toEqual({
      action: 'BLOCK',
      category: 'REQUEST',
      reason: 'NON_READ_METHOD',
    });
  });

  it('allows GET and HEAD requests to a canonicalized allowed origin', () => {
    for (const method of ['GET', 'HEAD']) {
      expect(classifyPassiveRequest({
        kind: 'HTTP',
        method,
        url: 'https://example.test/catalog',
        isNavigationRequest: true,
        isMainFrame: true,
      }, allowedOrigins)).toEqual({ action: 'ALLOW', delivery: 'INSPECT_REDIRECTS' });
    }
  });

  it('blocks external main-frame navigation while allowing an external subresource', () => {
    const externalMainFrame = {
      kind: 'HTTP' as const,
      method: 'GET',
      url: 'https://external.test/catalog',
      isNavigationRequest: true,
      isMainFrame: true,
    };

    expect(classifyPassiveRequest(externalMainFrame, allowedOrigins)).toEqual({
      action: 'BLOCK',
      category: 'NAVIGATION',
      reason: 'EXTERNAL_MAIN_FRAME_NAVIGATION',
    });
    expect(classifyPassiveRequest({ ...externalMainFrame, isMainFrame: false }, allowedOrigins)).toEqual({
      action: 'ALLOW',
      delivery: 'DIRECT',
    });
    expect(classifyPassiveRequest({
      ...externalMainFrame,
      isNavigationRequest: false,
      isMainFrame: true,
    }, allowedOrigins)).toEqual({ action: 'ALLOW', delivery: 'DIRECT' });
  });

  it('blocks every passive WebSocket before server connection', () => {
    expect(classifyPassiveRequest({
      kind: 'WEBSOCKET',
      url: 'wss://example.test/socket',
    }, allowedOrigins)).toEqual({
      action: 'BLOCK',
      category: 'WEBSOCKET',
      reason: 'PASSIVE_WEBSOCKET',
    });
  });

  it('does not grant authority from invalid or non-HTTP allowed-origin entries', () => {
    const invalidOrigins = new Set(['not a URL', 'mailto:help@example.test']);

    expect(classifyPassiveRequest({
      kind: 'HTTP',
      method: 'GET',
      url: 'https://example.test/catalog',
      isNavigationRequest: true,
      isMainFrame: true,
    }, invalidOrigins)).toMatchObject({ action: 'BLOCK', category: 'NAVIGATION' });
  });
});
