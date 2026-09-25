/**
 * オブジェクトと、その列挙可能な自身のプロパティを再帰的に凍結し、同じ参照を返す。
 * すでに凍結されたオブジェクトの中へは入らない（既存の実装と同じ）。
 * 先に凍結してから子へ進むので、循環参照があっても止まる。
 */
export function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return value;
}
