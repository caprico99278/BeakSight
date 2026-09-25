/** `null` でも配列でもないオブジェクトか。 */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 0より大きい有限の数か。 */
export const isPositiveFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

/** 0以上の安全な整数か。 */
export const isNonNegativeSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** 0より大きい安全な整数か。 */
export const isPositiveSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/** 0以上の有限の数か。 */
export const isNonNegativeFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
