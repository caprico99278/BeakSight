// CCX-3（共通化の台帳の CC-052、CC-053。`CC-plan.md` の「設計者の判断」の 2）: 制御文字・行と段落の区切り・向きを変える文字・
// 対になっていないサロゲートの判定を `src/core/text.ts` に 1 か所にまとめる前と後で、各場所の判定の結果が変わらないことを固定する表。
// - 各場所の意味（Cc だけか、Zl・Zp も含むか、向きを変える文字とサロゲートを見るか）は、場所ごとに違う。表は、文字ごとの性質（Cc、
//   Zl・Zp、向きを変える文字、対になっていないサロゲート、`\s`）を明示し、各場所が今の意味で受けるか、どう書き換えるかを確かめる。
// - 変わるのは、profile-policy の環境の証拠の参照で U+061C（ARABIC LETTER MARK）を拒むようになることだけ（設計者の判断）。
//   その 1 件は、下の「CCX-3 の判断で変えた期待」で明示する。
// - isolated-auditor の要約の掃除（Node の側の関数。公開していない）は、`tests/integration/isolated-interaction.test.ts` の
//   「removes %s from a click failure reason」の表で固定する。
import { describe, expect, it } from 'vitest';
import type { AuditConfig } from '../../src/config/types.js';
import { AUTH_SETUP_SCHEMA_VERSION_2, type AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import { validateAuthSetup } from '../../src/control/auth/auth-setup-policy.js';
import { SITE_PROFILE_SCHEMA_VERSION, type SiteProfile, type ValidatedSiteProfile } from '../../src/control/contracts.js';
import { validateSiteProfile, type ProfileValidationContext } from '../../src/control/profile-policy.js';
import { WORKER_PROTOCOL_VERSION, toWorkerFailureDetail, validateWorkerToParentMessage } from '../../src/control/worker-protocol.js';
import { technicalDetailText } from '../../src/cli/output.js';
import { isPortableRelativeArtifactPath } from '../../src/core/artifact-layout.js';
import { createTestConfig } from '../helpers/test-config.js';

/** 文字の性質（表の列）。 */
interface CharacterTraits {
  /** Unicode の一般カテゴリ Cc（C0、DEL、C1）。 */
  readonly cc?: true;
  /** 行・段落の区切り（一般カテゴリ Zl、Zp。U+2028、U+2029）。 */
  readonly lineSeparator?: true;
  /** 向きを変える文字（U+061C、U+200E、U+200F、U+202A〜U+202E、U+2066〜U+2069）。 */
  readonly bidi?: true;
  /** 対になっていないサロゲート。 */
  readonly loneSurrogate?: true;
  /** 正規表現の `\s` に当たる（CLI の詳細の空白の正規化で、空白 1 つになる）。 */
  readonly whitespace?: true;
}

/** 固定する文字の表（境界の文字と、似ているが対象でない文字を含む）。 */
/** ARABIC LETTER MARK（U+061C）。期待を CCX-3 の判断で変えた文字。 */
const ARABIC_LETTER_MARK = '\u061c';

const CHARACTERS: readonly (readonly [string, string, CharacterTraits])[] = [
  ['ASCII letter', 'x', {}],
  ['Latin letter with accent', 'é', {}],
  ['Hiragana', 'あ', {}],
  ['surrogate pair (emoji)', '\u{1F600}', {}],
  ['NUL', '\u0000', { cc: true }],
  ['TAB', '\t', { cc: true, whitespace: true }],
  ['LF', '\n', { cc: true, whitespace: true }],
  ['CR', '\r', { cc: true, whitespace: true }],
  ['ESC', '\u001b', { cc: true }],
  ['U+001F', '\u001f', { cc: true }],
  ['SPACE', ' ', { whitespace: true }],
  ['DEL', '\u007f', { cc: true }],
  ['U+0080', '\u0080', { cc: true }],
  ['NEL (U+0085)', '\u0085', { cc: true }],
  ['C1 CSI (U+009B)', '\u009b', { cc: true }],
  ['U+009F', '\u009f', { cc: true }],
  ['NO-BREAK SPACE', ' ', { whitespace: true }],
  ['SOFT HYPHEN (Cf)', '­', {}],
  ['ARABIC NUMBER SIGN (Cf)', '؀', {}],
  ['ARABIC LETTER MARK (U+061C)', ARABIC_LETTER_MARK, { bidi: true }],
  ['ZERO WIDTH SPACE', '\u200b', {}],
  ['ZERO WIDTH JOINER', '\u200d', {}],
  ['LRM (U+200E)', '\u200e', { bidi: true }],
  ['RLM (U+200F)', '\u200f', { bidi: true }],
  ['U+2027', '‧', {}],
  ['LINE SEPARATOR (U+2028)', '\u2028', { lineSeparator: true, whitespace: true }],
  ['PARAGRAPH SEPARATOR (U+2029)', '\u2029', { lineSeparator: true, whitespace: true }],
  ['LRE (U+202A)', '\u202a', { bidi: true }],
  ['PDF (U+202C)', '\u202c', { bidi: true }],
  ['RLO (U+202E)', '\u202e', { bidi: true }],
  ['NARROW NO-BREAK SPACE (U+202F)', ' ', { whitespace: true }],
  ['WORD JOINER (U+2060)', '\u2060', {}],
  ['U+2065', '⁥', {}],
  ['LRI (U+2066)', '\u2066', { bidi: true }],
  ['PDI (U+2069)', '\u2069', { bidi: true }],
  ['U+206A (Cf, not bidi)', '⁪', {}],
  ['BOM (U+FEFF)', '\ufeff', { whitespace: true }],
  ['lone high surrogate', '\ud800', { loneSurrogate: true }],
  ['lone high surrogate (U+DBFF)', '\udbff', { loneSurrogate: true }],
  ['lone low surrogate', '\udc00', { loneSurrogate: true }],
  ['lone low surrogate (U+DFFF)', '\udfff', { loneSurrogate: true }],
];

const TEST_ORIGIN = 'https://app.example.invalid';
const targetConfig: AuditConfig = {
  ...createTestConfig(TEST_ORIGIN),
  site: { startUrl: `${TEST_ORIGIN}/`, allowedOrigins: [TEST_ORIGIN] },
};
const context: ProfileValidationContext = { targetConfig };

const profileWithEvidence = (environmentEvidenceRef: string): SiteProfile => ({
  schemaVersion: SITE_PROFILE_SCHEMA_VERSION,
  profileId: 'example-test-env',
  revision: 1,
  targetConfigPath: 'local/targets/example-test.json',
  environment: 'TEST',
  mode: 'TEST_AUTH_PASSIVE',
  auth: 'MANUAL_SESSION',
  approvedTestOrigins: [TEST_ORIGIN],
  environmentEvidenceRef,
});

const manualProfile = ((): ValidatedSiteProfile => {
  const result = validateSiteProfile(profileWithEvidence('evidence/example-test-env/isolation-check-1'), context);
  if (!result.ok) {
    throw new Error(`the test profile was rejected: ${JSON.stringify(result.errors)}`);
  }
  return result.profile;
})();

const setupWithSelector = (selector: string): AuthSetup => ({
  schemaVersion: AUTH_SETUP_SCHEMA_VERSION_2,
  profileId: 'example-test-env',
  profileRevision: 1,
  loginStartUrl: `${TEST_ORIGIN}/admin/login`,
  loginPostEndpoints: [{ origin: TEST_ORIGIN, path: '/admin/login' }],
  successCondition: { pathPrefix: '/admin/dashboard', selector },
  sessionLostCondition: { pathPrefix: null },
  excludedPaths: ['/admin/logout'],
  auditPathPrefixes: ['/admin/'],
  maxLoginAttempts: 2,
  allowedIdpOrigins: [],
  automatedLogin: null,
});

const failedMessageWith = (detail: string): unknown =>
  ({ protocol: WORKER_PROTOCOL_VERSION, type: 'FAILED', reason: 'UNEXPECTED_FAILURE', detail });

/** 環境の証拠の参照が受けられるか（profile-policy）。 */
const evidenceAccepted = (character: string): boolean =>
  validateSiteProfile(profileWithEvidence(`evidence${character}ref`), context).ok;

describe('CCX-3: the character class decisions of each place, fixed before and after the commonization', () => {
  it.each(CHARACTERS)('artifact-layout rejects only Cc in a relative artifact path (%s)', (_label, character, traits) => {
    expect(isPortableRelativeArtifactPath(`a${character}b`)).toBe(traits.cc !== true);
  });

  it.each(CHARACTERS)('cli turns only Cc (and whitespace) into a single space in a technical detail (%s)', (_label, character, traits) => {
    const expected = traits.cc === true || traits.whitespace === true ? 'a b' : `a${character}b`;
    expect(technicalDetailText(`a${character}b`)).toBe(expected);
  });

  it.each(CHARACTERS)('worker-protocol rejects Cc, Zl, Zp and lone surrogates in a FAILED detail (%s)', (_label, character, traits) => {
    const rejected = traits.cc === true || traits.lineSeparator === true || traits.loneSurrogate === true;
    expect(validateWorkerToParentMessage(failedMessageWith(`a${character}b`)).ok).toBe(!rejected);
  });

  it.each(CHARACTERS)('worker-protocol cleans Cc, Zl, Zp to a space and lone surrogates to U+FFFD (%s)', (_label, character, traits) => {
    const expected = traits.cc === true || traits.lineSeparator === true
      ? 'a b'
      : traits.loneSurrogate === true ? 'a�b' : `a${character}b`;
    expect(toWorkerFailureDetail(`a${character}b`)).toBe(expected);
  });

  it.each(CHARACTERS)('auth-setup-policy rejects Cc, Zl, Zp and lone surrogates in a selector (%s)', (_label, character, traits) => {
    const rejected = traits.cc === true || traits.lineSeparator === true || traits.loneSurrogate === true;
    expect(validateAuthSetup(setupWithSelector(`#a${character}b`), manualProfile, context).ok).toBe(!rejected);
  });

  it.each(CHARACTERS.filter(([, character]) => character !== ARABIC_LETTER_MARK))(
    'profile-policy rejects Cc, Zl, Zp, bidirectional controls and lone surrogates in the evidence reference (%s)',
    (_label, character, traits) => {
      const rejected = traits.cc === true || traits.lineSeparator === true || traits.bidi === true || traits.loneSurrogate === true;
      expect(evidenceAccepted(character)).toBe(!rejected);
    },
  );
});

describe('CCX-3: the expectation changed by the ruling', () => {
  // 共通化の前の profile-policy は、向きを変える文字の一覧に U+061C を含めず、受けていた（isolated-auditor は除いていた）。
  // 設計者の判断（`CC-plan.md` の「設計者の判断」の 2）で、一覧に U+061C を含め、拒む側に寄せた。期待を「受ける」から「拒む」に変えたのは
  // この 1 件だけ（ほかの場所と文字の期待は、共通化の前と同じ）。
  it('profile-policy rejects U+061C (ARABIC LETTER MARK) in the evidence reference (accepted before CCX-3)', () => {
    expect(evidenceAccepted(ARABIC_LETTER_MARK)).toBe(false);
    expect(validateSiteProfile(profileWithEvidence(`evidence${ARABIC_LETTER_MARK}ref`), context)).toMatchObject({
      ok: false,
      errors: [{ code: 'PROFILE_ENVIRONMENT_EVIDENCE_REQUIRED' }],
    });
  });
});
