import { test, expect, describe } from 'bun:test'
import {
  collectThreadHistory,
  isThreadReply,
  normalizeChatEnvelope,
  normalizeChatText,
  type ChatAttachmentDownloader,
  type ChatHistoryFetcher
} from './normalize'
import type { ChatListMessage, GoogleChatEnvelope } from './types'

const BOT_USER = 'users/bot-account'

function messageEnvelope(overrides: Partial<GoogleChatEnvelope> = {}): GoogleChatEnvelope {
  return {
    type: 'MESSAGE',
    eventTime: '2026-01-01T00:00:00Z',
    space: { name: 'spaces/AAAA', type: 'SPACE' },
    message: {
      name: 'spaces/AAAA/messages/M1',
      text: '<users/bot-account> hello',
      sender: { name: 'users/U1', displayName: 'Alice' }
    },
    ...overrides
  }
}

describe('normalizeChatEnvelope', () => {
  test('produces a NormalizedChatEvent for a MESSAGE in a space', async () => {
    const normalized = await normalizeChatEnvelope(messageEnvelope(), BOT_USER)
    expect(normalized).not.toBeNull()
    expect(normalized!.thread_key).toBe('chat:spaces:AAAA:spaces:AAAA:messages:M1')
    expect(normalized!.message_id).toBe('spaces/AAAA/messages/M1')
    expect(normalized!.user_id).toBe('users/U1')
    expect(normalized!.user_name).toBe('Alice')
    expect(normalized!.is_mention).toBe(true)
    expect(normalized!.space_type).toBe('SPACE')
    expect(normalized!.parts).toHaveLength(1)
    expect(normalized!.parts[0]).toMatchObject({ type: 'text' })
  })

  test('treats a slash command as a mention and uses argumentText as the prompt', async () => {
    const normalized = await normalizeChatEnvelope(
      messageEnvelope({
        message: {
          name: 'spaces/AAAA/messages/M1',
          text: '/centaur ship the feature',
          argumentText: 'ship the feature',
          sender: { name: 'users/U1', displayName: 'Alice' },
          annotations: [{ type: 'SLASH_COMMAND', slashCommand: { commandName: '/centaur' } }]
        }
      }),
      BOT_USER
    )
    expect(normalized!.is_mention).toBe(true)
    expect(normalized!.parts[0]).toMatchObject({ type: 'text', text: 'ship the feature' })
  })

  test('isThreadReply distinguishes a reply from a thread root', async () => {
    const root = await normalizeChatEnvelope(
      messageEnvelope({
        thread: { name: 'spaces/AAAA/threads/M1' },
        message: {
          name: 'spaces/AAAA/messages/M1',
          text: 'hi',
          thread: { name: 'spaces/AAAA/threads/M1' },
          sender: { name: 'users/U1', displayName: 'Alice' }
        }
      }),
      BOT_USER
    )
    const reply = await normalizeChatEnvelope(
      messageEnvelope({
        thread: { name: 'spaces/AAAA/threads/M1' },
        message: {
          name: 'spaces/AAAA/messages/M1.R2',
          text: 'follow up',
          thread: { name: 'spaces/AAAA/threads/M1' },
          sender: { name: 'users/U1', displayName: 'Alice' }
        }
      }),
      BOT_USER
    )
    expect(isThreadReply(root!)).toBe(false)
    expect(isThreadReply(reply!)).toBe(true)
  })

  test('does not include the dropped vaporware fields', async () => {
    const normalized = await normalizeChatEnvelope(messageEnvelope(), BOT_USER)
    expect(normalized).not.toBeNull()
    // is_command and command_id were shipped by PR #2 but never read by the
    // workflow; ensure they stay stripped so we don't drift back into them.
    expect(normalized).not.toHaveProperty('is_command')
    expect(normalized).not.toHaveProperty('command_id')
  })

  test('drops APP_COMMAND and CARD_CLICKED events instead of forwarding garbage', async () => {
    const appCmd = await normalizeChatEnvelope(
      {
        type: 'APP_COMMAND',
        space: { name: 'spaces/AAAA', type: 'SPACE' },
        appCommandMetadata: { appCommandId: 42, appCommandType: 'SLASH_COMMAND' }
      },
      BOT_USER
    )
    expect(appCmd).toBeNull()

    const cardClick = await normalizeChatEnvelope(
      { type: 'CARD_CLICKED', space: { name: 'spaces/AAAA', type: 'SPACE' } },
      BOT_USER
    )
    expect(cardClick).toBeNull()
  })

  test('emits a synthetic event for ADDED_TO_SPACE', async () => {
    const added = await normalizeChatEnvelope(
      { type: 'ADDED_TO_SPACE', space: { name: 'spaces/BBBB', type: 'SPACE' } },
      BOT_USER
    )
    expect(added).not.toBeNull()
    expect(added!.message_id).toBe('chat:spaces/BBBB:added_to_space')
    expect(added!.is_mention).toBe(true)
  })

  test('returns null for REMOVED_FROM_SPACE', async () => {
    const removed = await normalizeChatEnvelope(
      { type: 'REMOVED_FROM_SPACE', space: { name: 'spaces/BBBB', type: 'SPACE' } },
      BOT_USER
    )
    expect(removed).toBeNull()
  })

  test('skips the bot’s own messages', async () => {
    const own = await normalizeChatEnvelope(
      messageEnvelope({
        message: {
          name: 'spaces/AAAA/messages/M2',
          text: 'echo',
          sender: { name: BOT_USER, displayName: 'Bot' }
        }
      }),
      BOT_USER
    )
    expect(own).toBeNull()
  })
})

describe('normalizeChatEnvelope (attachments)', () => {
  type StubDownloader = ChatAttachmentDownloader & { calls: string[] }
  function downloader(result: Uint8Array | Error): StubDownloader {
    const calls: string[] = []
    return {
      calls,
      async downloadAttachment(resourceName) {
        calls.push(resourceName)
        if (result instanceof Error) throw result
        return result.buffer as ArrayBuffer
      }
    }
  }

  function attachmentEnvelope(
    attachment: NonNullable<NonNullable<GoogleChatEnvelope['message']>['attachment']>
  ): GoogleChatEnvelope {
    return messageEnvelope({
      message: {
        name: 'spaces/AAAA/messages/M1',
        text: '<users/bot-account> look at this',
        sender: { name: 'users/U1', displayName: 'Alice' },
        attachment
      }
    })
  }

  const uploadedImage = {
    name: 'spaces/AAAA/messages/M1/attachments/1',
    contentName: 'diagram.png',
    contentType: 'image/png',
    source: 'UPLOADED_CONTENT' as const,
    attachmentDataRef: { resourceName: 'media-resource-1' }
  }

  test('uploaded image → image part with inlined base64 data', async () => {
    const client = downloader(new TextEncoder().encode('png-bytes'))
    const normalized = await normalizeChatEnvelope(
      attachmentEnvelope([uploadedImage]),
      BOT_USER,
      client
    )
    expect(client.calls).toEqual(['media-resource-1'])
    expect(normalized!.parts).toHaveLength(2)
    expect(normalized!.parts[1]).toEqual({
      type: 'image',
      name: 'diagram.png',
      mime_type: 'image/png',
      size: 9,
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: Buffer.from('png-bytes').toString('base64')
      }
    })
  })

  test('non-image upload → file part with inlined base64 data', async () => {
    const normalized = await normalizeChatEnvelope(
      attachmentEnvelope([
        {
          ...uploadedImage,
          contentName: 'report.pdf',
          contentType: 'application/pdf'
        }
      ]),
      BOT_USER,
      downloader(new TextEncoder().encode('%PDF-'))
    )
    expect(normalized!.parts[1]).toMatchObject({
      type: 'file',
      name: 'report.pdf',
      mime_type: 'application/pdf',
      size: 5
    })
    expect((normalized!.parts[1] as { source?: unknown }).source).toBeDefined()
  })

  test('drive file → file part without data and no download attempt', async () => {
    const client = downloader(new TextEncoder().encode('never'))
    const normalized = await normalizeChatEnvelope(
      attachmentEnvelope([
        {
          name: 'spaces/AAAA/messages/M1/attachments/2',
          contentName: 'roadmap.png',
          contentType: 'image/png',
          source: 'DRIVE_FILE',
          driveDataRef: { driveFileId: 'drive-file-1' }
        }
      ]),
      BOT_USER,
      client
    )
    expect(client.calls).toEqual([])
    // Always 'file' for Drive (even images): no bytes ever, so the part exists
    // purely to reach the placeholder-text path with the name.
    expect(normalized!.parts[1]).toEqual({
      type: 'file',
      name: 'roadmap.png',
      mime_type: 'image/png',
      size: 0
    })
  })

  test('download failure → part survives without data', async () => {
    const normalized = await normalizeChatEnvelope(
      attachmentEnvelope([uploadedImage]),
      BOT_USER,
      downloader(new Error('Chat API media download failed: 500 boom'))
    )
    expect(normalized!.parts[1]).toEqual({
      type: 'image',
      name: 'diagram.png',
      mime_type: 'image/png',
      size: 0
    })
  })

  test('declared size over the inline cap → download skipped, part without data', async () => {
    const client = downloader(new TextEncoder().encode('never'))
    const declaredSize = 26 * 1024 * 1024
    const normalized = await normalizeChatEnvelope(
      attachmentEnvelope([{ ...uploadedImage, size: String(declaredSize) }]),
      BOT_USER,
      client
    )
    expect(client.calls).toEqual([])
    expect(normalized!.parts[1]).toEqual({
      type: 'image',
      name: 'diagram.png',
      mime_type: 'image/png',
      size: declaredSize
    })
  })

  test('downloaded bytes over the inline cap → data dropped, real size kept', async () => {
    const normalized = await normalizeChatEnvelope(
      attachmentEnvelope([uploadedImage]),
      BOT_USER,
      downloader(new Uint8Array(25 * 1024 * 1024 + 1))
    )
    const part = normalized!.parts[1] as { size: number; source?: unknown }
    expect(part.size).toBe(25 * 1024 * 1024 + 1)
    expect(part.source).toBeUndefined()
  })

  test('no attachments → text-only parts, unchanged behavior', async () => {
    const client = downloader(new TextEncoder().encode('never'))
    const normalized = await normalizeChatEnvelope(messageEnvelope(), BOT_USER, client)
    expect(client.calls).toEqual([])
    expect(normalized!.parts).toHaveLength(1)
    expect(normalized!.parts[0]).toMatchObject({ type: 'text' })
  })

  test('missing attachmentDataRef or absent client → stub part, never throws', async () => {
    const noRef = await normalizeChatEnvelope(
      attachmentEnvelope([{ ...uploadedImage, attachmentDataRef: {} }]),
      BOT_USER,
      downloader(new TextEncoder().encode('never'))
    )
    expect(noRef!.parts[1]).toMatchObject({ type: 'image', name: 'diagram.png', size: 0 })

    const noClient = await normalizeChatEnvelope(attachmentEnvelope([uploadedImage]), BOT_USER)
    expect(noClient!.parts[1]).toMatchObject({ type: 'image', name: 'diagram.png', size: 0 })
    expect((noClient!.parts[1] as { source?: unknown }).source).toBeUndefined()
  })
})

describe('collectThreadHistory', () => {
  type CapturedCall = { spaceName: string; filter?: string; orderBy?: string; pageToken?: string }
  function fetcher(
    pages: Array<{ messages: ChatListMessage[]; nextPageToken?: string }>,
    captured?: CapturedCall[]
  ): ChatHistoryFetcher {
    let i = 0
    return {
      async listMessages(spaceName, opts) {
        captured?.push({
          spaceName,
          filter: opts.filter,
          orderBy: opts.orderBy,
          pageToken: opts.pageToken
        })
        const page = pages[i] ?? { messages: [] }
        i++
        return page
      }
    }
  }

  const baseOpts = {
    spaceName: 'spaces/AAAA',
    threadName: 'spaces/AAAA/threads/T1',
    currentMessageName: 'spaces/AAAA/messages/T1.M3',
    botUserName: BOT_USER
  }

  test('fetches prior thread messages, infers roles, drops the current one and chronologizes', async () => {
    const captured: CapturedCall[] = []
    const history: ChatListMessage[] = [
      // Newest first — Google returns desc by createTime as we asked.
      {
        name: 'spaces/AAAA/messages/T1.M3',
        text: 'what about it?',
        sender: { name: 'users/U1', displayName: 'Alice', type: 'HUMAN' },
        createTime: '2026-01-01T00:00:03Z'
      },
      {
        name: 'spaces/AAAA/messages/T1.M2',
        argumentText: 'sure, what do you want to know?',
        sender: { name: 'users/bot-numeric-id', displayName: 'Bot', type: 'BOT' },
        createTime: '2026-01-01T00:00:02Z'
      },
      {
        name: 'spaces/AAAA/messages/T1.M1',
        text: 'hey can we chat about openfort',
        sender: { name: 'users/U1', displayName: 'Alice', type: 'HUMAN' },
        createTime: '2026-01-01T00:00:01Z'
      }
    ]
    const out = await collectThreadHistory(
      fetcher([{ messages: history }], captured),
      baseOpts
    )

    expect(out).toHaveLength(2)
    const [first, second] = out
    expect(first).toMatchObject({ role: 'user', message_id: 'spaces/AAAA/messages/T1.M1' })
    expect(first?.parts[0]).toMatchObject({ type: 'text', text: 'hey can we chat about openfort' })
    expect(second).toMatchObject({ role: 'assistant', message_id: 'spaces/AAAA/messages/T1.M2' })
    expect(second?.parts[0]).toMatchObject({ type: 'text', text: 'sure, what do you want to know?' })

    expect(captured).toHaveLength(1)
    expect(captured[0]?.spaceName).toBe('spaces/AAAA')
    expect(captured[0]?.filter).toBe('thread.name = "spaces/AAAA/threads/T1"')
    expect(captured[0]?.orderBy).toBe('createTime desc')
  })

  test('returns [] without an API call when the message *is* the thread root', async () => {
    const captured: CapturedCall[] = []
    const out = await collectThreadHistory(fetcher([], captured), {
      ...baseOpts,
      // Real Google shape: thread.name uses /threads/<T>, message.name uses /messages/<T>
      threadName: 'spaces/AAAA/threads/r23TZL4dpqk',
      currentMessageName: 'spaces/AAAA/messages/r23TZL4dpqk'
    })
    expect(out).toEqual([])
    expect(captured).toHaveLength(0)
  })

  test('treats /messages/<T>.<reply> as inside thread <T>, not the root', async () => {
    const captured: CapturedCall[] = []
    await collectThreadHistory(fetcher([{ messages: [] }], captured), {
      ...baseOpts,
      threadName: 'spaces/AAAA/threads/r23TZL4dpqk',
      currentMessageName: 'spaces/AAAA/messages/r23TZL4dpqk.Rcgc9eeTD7Q'
    })
    expect(captured).toHaveLength(1)
  })

  test('rejects malformed threadName without calling the API (injection defense)', async () => {
    const captured: CapturedCall[] = []
    const hostile = 'spaces/AAAA/threads/T1" OR thread.name = "spaces/OTHER/threads/Z'
    const out = await collectThreadHistory(fetcher([], captured), {
      ...baseOpts,
      threadName: hostile
    })
    expect(out).toEqual([])
    expect(captured).toHaveLength(0)
  })

  test('paginates and caps at THREAD_HISTORY_LIMIT (50), keeping the newest', async () => {
    // Build 60 desc-ordered messages across two pages of 100 (one with token, one without).
    const desc: ChatListMessage[] = Array.from({ length: 60 }, (_, i) => {
      const idx = 60 - i // 60, 59, ..., 1
      return {
        name: `spaces/AAAA/messages/T1.M${String(idx).padStart(3, '0')}`,
        text: `msg ${idx}`,
        sender: { name: 'users/U1', type: 'HUMAN' as const },
        createTime: `2026-01-01T00:${String(idx).padStart(2, '0')}:00Z`
      }
    })
    const captured: CapturedCall[] = []
    const out = await collectThreadHistory(
      fetcher(
        [
          { messages: desc.slice(0, 30), nextPageToken: 'pg2' },
          { messages: desc.slice(30, 60) }
        ],
        captured
      ),
      { ...baseOpts, currentMessageName: 'spaces/AAAA/messages/never-matches' }
    )
    expect(out).toHaveLength(50)
    // Chronologically ordered: the OLDEST in the returned slice should be msg 11
    // (i.e. the 50 newest of 60 are msgs 11..60, ascending).
    expect(out[0]?.message_id).toBe('spaces/AAAA/messages/T1.M011')
    expect(out[out.length - 1]?.message_id).toBe('spaces/AAAA/messages/T1.M060')
    // We should have stopped paginating once we hit the cap — second page started
    // mid-iteration but the loop breaks at 50.
    expect(captured.length).toBeLessThanOrEqual(2)
  })

  test('infers role=assistant via botUserName fallback when sender.type is missing', async () => {
    const out = await collectThreadHistory(
      fetcher([
        {
          messages: [
            {
              name: 'spaces/AAAA/messages/T1.M1',
              text: 'older bot turn',
              sender: { name: BOT_USER } // no type field
            }
          ]
        }
      ]),
      baseOpts
    )
    expect(out).toHaveLength(1)
    expect(out[0]?.role).toBe('assistant')
  })

  test('drops the bot’s own "_Condor is thinking…_" ack messages from history', async () => {
    const out = await collectThreadHistory(
      fetcher([
        {
          messages: [
            {
              name: 'spaces/AAAA/messages/T1.M2',
              text: '_Condor is thinking…_',
              sender: { name: 'users/bot', type: 'BOT' }
            },
            {
              name: 'spaces/AAAA/messages/T1.M1',
              text: 'real user content',
              sender: { name: 'users/U1', type: 'HUMAN' }
            }
          ]
        }
      ]),
      baseOpts
    )
    expect(out).toHaveLength(1)
    expect(out[0]?.message_id).toBe('spaces/AAAA/messages/T1.M1')
  })

  test('drops content-less messages (card-only or empty)', async () => {
    const out = await collectThreadHistory(
      fetcher([
        {
          messages: [
            { name: 'spaces/AAAA/messages/T1.M2', text: '', sender: { name: 'users/U1' } },
            {
              name: 'spaces/AAAA/messages/T1.M1',
              text: 'hello',
              sender: { name: 'users/U1' }
            }
          ]
        }
      ]),
      baseOpts
    )
    expect(out).toHaveLength(1)
    expect(out[0]?.message_id).toBe('spaces/AAAA/messages/T1.M1')
  })

  test('returns [] on Chat API 503', async () => {
    const breaking: ChatHistoryFetcher = {
      async listMessages() {
        throw new Error('Chat API GET spaces/X/messages failed: 503 backend unavailable')
      }
    }
    const out = await collectThreadHistory(breaking, baseOpts)
    expect(out).toEqual([])
  })

  test('returns [] on Chat API 403 (scope misconfig) — logged as scope_denied', async () => {
    const breaking: ChatHistoryFetcher = {
      async listMessages() {
        throw new Error('Chat API GET spaces/X/messages failed: 403 PERMISSION_DENIED')
      }
    }
    const out = await collectThreadHistory(breaking, baseOpts)
    expect(out).toEqual([])
  })

  test('strips bot mention from user-authored history, not the user’s own resource name', async () => {
    const out = await collectThreadHistory(
      fetcher([
        {
          messages: [
            {
              name: 'spaces/AAAA/messages/T1.M1',
              text: 'hey <users/bot-account> can you help',
              sender: { name: 'users/U1', type: 'HUMAN' }
            }
          ]
        }
      ]),
      baseOpts
    )
    // Mention is stripped; surrounding double-space is left as-is (cosmetic only).
    expect(out[0]?.parts[0]).toMatchObject({ type: 'text', text: 'hey  can you help' })
  })
})

describe('normalizeChatEnvelope (no client → no history)', () => {
  test('does not attach history_messages by itself; index.ts merges them in', async () => {
    const env: GoogleChatEnvelope = {
      type: 'MESSAGE',
      eventTime: '2026-01-01T00:00:00Z',
      space: { name: 'spaces/AAAA', type: 'SPACE' },
      thread: { name: 'spaces/AAAA/threads/T1' },
      message: {
        name: 'spaces/AAAA/messages/T1.M2',
        text: '<users/bot-account> hi',
        thread: { name: 'spaces/AAAA/threads/T1' },
        sender: { name: 'users/U1', displayName: 'Alice' }
      }
    }
    const normalized = await normalizeChatEnvelope(env, BOT_USER)
    expect(normalized).not.toBeNull()
    expect(normalized!.history_messages).toBeUndefined()
  })
})

describe('normalizeChatText', () => {
  test('strips the bot mention and HTML-decodes content', () => {
    const out = normalizeChatText('<users/bot-account> hello &amp; world', 'bot-account')
    expect(out).toBe('hello & world')
  })

  test('rewrites user mentions to a friendly @handle form', () => {
    const out = normalizeChatText('hello <users/u-1>', undefined)
    expect(out).toBe('hello @u-1')
  })

  test('preserves links and decodes HTML entities', () => {
    const out = normalizeChatText('see <https://example.com|the docs> &lt;here&gt;', undefined)
    expect(out).toBe('see the docs (https://example.com) <here>')
  })
})
