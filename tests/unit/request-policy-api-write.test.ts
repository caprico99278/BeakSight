// T39a（Task 39 の設計書 3.2、3.3）: 書き込みの段の、承認した API の要求を照合にかけるかの判定の口（`src/safety/request-policy.ts`）。
// - `isApiWriteCheckTarget`: 承認した API の Origin への `POST`・`PATCH` だけが照合の対象（ほかの method、ほかの Origin は対象でない）。
// - `isApiWriteEndpointUrl`: Origin と path が承認の型と完全に一致するか（query は照合の部品が照らす。認証情報を含む URL は当たらない）。
import { describe, expect, it } from 'vitest';
import { isApiWriteCheckTarget, isApiWriteEndpointUrl } from '../../src/safety/request-policy.js';

const API_ORIGIN = 'https://api.example.test';
const ENDPOINT = Object.freeze({ origin: API_ORIGIN, path: '/rest/v1/members' });

describe('T39a: the request policy entry of the API write check', () => {
  it.each<[string, string, string, boolean]>([
    ['POST to the approved API origin', 'POST', `${API_ORIGIN}/rest/v1/members?select=*`, true],
    ['PATCH to the approved API origin', 'PATCH', `${API_ORIGIN}/rest/v1/members?id=eq.1`, true],
    ['a lower case method', 'post', `${API_ORIGIN}/x`, true],
    ['PUT', 'PUT', `${API_ORIGIN}/rest/v1/members`, false],
    ['DELETE', 'DELETE', `${API_ORIGIN}/rest/v1/members`, false],
    ['GET', 'GET', `${API_ORIGIN}/rest/v1/members`, false],
    ['POST to another origin', 'POST', 'https://other.example.test/rest/v1/members', false],
    ['POST to another port', 'POST', 'https://api.example.test:8443/rest/v1/members', false],
    ['an unparsable URL', 'POST', 'not a url', false],
  ])('%s: %s', (_label, method, url, expected) => {
    expect(isApiWriteCheckTarget(method, url, API_ORIGIN)).toBe(expected);
  });

  it.each<[string, string, boolean]>([
    ['the approved origin and path with a query', `${API_ORIGIN}/rest/v1/members?select=*`, true],
    ['the approved origin and path', `${API_ORIGIN}/rest/v1/members`, true],
    ['another path', `${API_ORIGIN}/rest/v1/admins`, false],
    ['a longer path', `${API_ORIGIN}/rest/v1/members/1`, false],
    ['another origin', 'https://other.example.test/rest/v1/members', false],
    ['credentials in the URL', 'https://user:pass@api.example.test/rest/v1/members', false],
    ['an unparsable URL', 'not a url', false],
  ])('the endpoint: %s', (_label, url, expected) => {
    expect(isApiWriteEndpointUrl(url, ENDPOINT)).toBe(expected);
  });
});
