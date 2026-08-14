import { describe, expect, test } from 'bun:test'
import corpus from '../../../../fixtures/google_chat_card_text.json'
import { cardFallbackText } from './card-text'

describe('cardFallbackText shared corpus', () => {
  for (const fixture of corpus) {
    test(fixture.name, () => expect(cardFallbackText(fixture.message)).toBe(fixture.text))
  }
})
