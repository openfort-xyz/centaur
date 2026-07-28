import { describe, expect, test } from 'bun:test'
import {
  CONFIRMED_SPACE_TTL_MS,
  FAILED_LOOKUP_TTL_MS,
  SpaceDmVerifier,
  classifySpaceAsDm
} from './space-verify'
import type { ChatSpaceResource } from './types'

/** What Google returns for a real 1:1 DM (shape confirmed against three prod
 * DMs: DIRECT_MESSAGE, singleUserBotDm, exactly one joined human). */
const CONFIRMED_DM: ChatSpaceResource = {
  name: 'spaces/AAAA',
  spaceType: 'DIRECT_MESSAGE',
  singleUserBotDm: true,
  membershipCount: { joinedDirectHumanUserCount: 1 }
}

describe('classifySpaceAsDm', () => {
  test('confirms a 1:1 DM Google itself describes as one', () => {
    expect(classifySpaceAsDm(CONFIRMED_DM)).toEqual({
      confirmed: true,
      spaceType: 'DIRECT_MESSAGE',
      singleUserBotDm: true
    })
  })

  // The core threat: the request body's `spaceType: DIRECT_MESSAGE` never
  // reaches here. Only what Google returned is classified, and a shared room
  // stays a shared room no matter what the envelope claimed.
  test.each(['GROUP_CHAT', 'SPACE'] as const)('rejects a %s space', spaceType => {
    expect(classifySpaceAsDm({ ...CONFIRMED_DM, spaceType })).toEqual({
      confirmed: false,
      reason: 'space_not_dm'
    })
  })

  test.each([
    ['absent', undefined],
    ['blank', ''],
    ['null', null],
    ['the deprecated ROOM value', 'ROOM'],
    ['lower-case', 'direct_message']
  ])('rejects a spaceType that is %s', (_label, spaceType) => {
    expect(classifySpaceAsDm({ ...CONFIRMED_DM, spaceType }).confirmed).toBe(false)
  })

  // Reading `type` instead of `spaceType` would be a silent downgrade: the
  // deprecated field cannot express GROUP_CHAT, so a group DM reads as a DM.
  test('ignores the deprecated `type` field entirely', () => {
    const groupChat = {
      spaceType: 'GROUP_CHAT',
      type: 'DM',
      membershipCount: { joinedDirectHumanUserCount: 1 }
    } as ChatSpaceResource
    expect(classifySpaceAsDm(groupChat)).toEqual({ confirmed: false, reason: 'space_not_dm' })
  })

  test.each([
    ['zero', 0],
    ['two', 2],
    ['three', 3],
    ['six', 6],
    ['negative', -1],
    ['fractional', 1.5]
  ] as const)('rejects a joined-human count that is %s', (_label, count) => {
    expect(classifySpaceAsDm({
      ...CONFIRMED_DM,
      membershipCount: { joinedDirectHumanUserCount: count }
    })).toEqual({ confirmed: false, reason: 'space_not_dm' })
  })

  // `Number(true) === 1` and `Number('1') === 1`: coercing the count would
  // manufacture a passing "one human" out of a field that stated no such thing.
  test.each([
    ['a boolean true', { joinedDirectHumanUserCount: true }],
    ['a numeric string', { joinedDirectHumanUserCount: '1' }],
    ['null', { joinedDirectHumanUserCount: null }],
    ['undefined', { joinedDirectHumanUserCount: undefined }],
    ['NaN', { joinedDirectHumanUserCount: Number.NaN }],
    ['an empty object', {}]
  ])('rejects a joined-human count that is %s', (_label, membershipCount) => {
    expect(classifySpaceAsDm({ ...CONFIRMED_DM, membershipCount })).toEqual({
      confirmed: false,
      reason: 'space_not_dm'
    })
  })

  test.each([
    ['membershipCount is missing', {}],
    ['membershipCount is null', { membershipCount: null }]
  ])('rejects a DIRECT_MESSAGE where %s', (_label, overrides) => {
    const space = { spaceType: 'DIRECT_MESSAGE', singleUserBotDm: true, ...overrides }
    expect(classifySpaceAsDm(space).confirmed).toBe(false)
  })

  // Google's own value, strictly: a truthy non-boolean must not become `true`
  // in the session metadata a downstream guard then reads.
  test.each([
    [undefined, false],
    ['true', false],
    [1, false],
    [false, false],
    [true, true]
  ])('reports singleUserBotDm %p as %p', (singleUserBotDm, expected) => {
    const out = classifySpaceAsDm({ ...CONFIRMED_DM, singleUserBotDm })
    expect(out.confirmed && out.singleUserBotDm).toBe(expected)
  })
})

describe('SpaceDmVerifier', () => {
  /** A lookup that counts how many times Google was actually asked. */
  const countingLookup = (answer: ChatSpaceResource | Error) => {
    const lookups: string[] = []
    const lookup = async (spaceName: string): Promise<ChatSpaceResource> => {
      lookups.push(spaceName)
      if (answer instanceof Error) throw answer
      return answer
    }
    return { lookups, lookup }
  }

  test('confirms a DM from Google and caches the answer', async () => {
    const { lookups, lookup } = countingLookup(CONFIRMED_DM)
    const verifier = new SpaceDmVerifier(lookup)

    expect(await verifier.confirm('spaces/AAAA')).toEqual({
      confirmed: true,
      spaceType: 'DIRECT_MESSAGE',
      singleUserBotDm: true
    })
    expect(await verifier.confirm('spaces/AAAA')).toMatchObject({ confirmed: true })
    // A space's classification is immutable, so the second turn costs nothing.
    expect(lookups).toEqual(['spaces/AAAA'])
  })

  test('caches per space, not globally', async () => {
    const lookups: string[] = []
    const verifier = new SpaceDmVerifier(async spaceName => {
      lookups.push(spaceName)
      return spaceName === 'spaces/DM' ? CONFIRMED_DM : { spaceType: 'SPACE' }
    })

    expect((await verifier.confirm('spaces/DM')).confirmed).toBe(true)
    expect((await verifier.confirm('spaces/ROOM')).confirmed).toBe(false)
    expect(lookups).toEqual(['spaces/DM', 'spaces/ROOM'])
  })

  // Fail closed for credentials: a Chat API that cannot answer confirms nothing.
  test('reports space_unverified when the lookup fails, and never throws', async () => {
    const { lookup } = countingLookup(new Error('Chat API GET spaces/AAAA failed: 403 forbidden'))
    const verifier = new SpaceDmVerifier(lookup)
    expect(await verifier.confirm('spaces/AAAA')).toEqual({
      confirmed: false,
      reason: 'space_unverified'
    })
  })

  test('expires a confirmed answer only after the long TTL', async () => {
    let now = 1_000_000
    const { lookups, lookup } = countingLookup(CONFIRMED_DM)
    const verifier = new SpaceDmVerifier(lookup, { now: () => now })

    await verifier.confirm('spaces/AAAA')
    now += CONFIRMED_SPACE_TTL_MS - 1
    await verifier.confirm('spaces/AAAA')
    expect(lookups).toHaveLength(1)

    now += 1
    await verifier.confirm('spaces/AAAA')
    expect(lookups).toHaveLength(2)
  })

  // A transient outage must not pin a space to "unverified" for the long TTL —
  // that would turn a blip into hours of missing credential grants.
  test('retries a failed lookup after the short TTL', async () => {
    let now = 1_000_000
    let fail = true
    const lookups: string[] = []
    const verifier = new SpaceDmVerifier(
      async spaceName => {
        lookups.push(spaceName)
        if (fail) throw new Error('Chat API GET spaces/AAAA failed: 503 unavailable')
        return CONFIRMED_DM
      },
      { now: () => now }
    )

    expect(await verifier.confirm('spaces/AAAA')).toMatchObject({ reason: 'space_unverified' })
    now += FAILED_LOOKUP_TTL_MS - 1
    expect(await verifier.confirm('spaces/AAAA')).toMatchObject({ reason: 'space_unverified' })
    expect(lookups).toHaveLength(1)

    fail = false
    now += 1
    expect(await verifier.confirm('spaces/AAAA')).toMatchObject({ confirmed: true })
    expect(lookups).toHaveLength(2)
  })

  test('caches a negative classification for the long TTL', async () => {
    let now = 1_000_000
    const { lookups, lookup } = countingLookup({ spaceType: 'GROUP_CHAT' })
    const verifier = new SpaceDmVerifier(lookup, { now: () => now })

    expect(await verifier.confirm('spaces/ROOM')).toEqual({
      confirmed: false,
      reason: 'space_not_dm'
    })
    now += FAILED_LOOKUP_TTL_MS * 2
    expect(await verifier.confirm('spaces/ROOM')).toMatchObject({ reason: 'space_not_dm' })
    // Google answered; a GROUP_CHAT never becomes a DM, so this is not retried.
    expect(lookups).toHaveLength(1)
  })
})
