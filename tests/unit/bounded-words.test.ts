// CC-136: 英語の語の境界の比べの 1 か所（`src/core/bounded-words.ts`）。
import { describe, expect, it } from 'vitest';
import { separatedWordsOf, sequenceHasBoundedWord } from '../../src/core/bounded-words.js';

describe('CC-136: the bounded word in a word sequence', () => {
  it('matches the words in a row (the last also with s), not a part of a word, and not before an excluded follower', () => {
    expect(sequenceHasBoundedWord(separatedWordsOf('Book Now!'), ['book', 'now'])).toBe(true);
    expect(sequenceHasBoundedWord(separatedWordsOf('our carts'), ['cart'])).toBe(true);
    expect(sequenceHasBoundedWord(separatedWordsOf('address'), ['add'])).toBe(false);
    expect(sequenceHasBoundedWord(['reset', 'guide'], ['reset'], ['guide'])).toBe(false);
    expect(sequenceHasBoundedWord(['reset'], [])).toBe(false);
  });
});
