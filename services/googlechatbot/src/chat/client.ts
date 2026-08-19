import type { AppConfig } from '../config'
import type { StateAdapter } from 'chat'
import type {
  ChatListMessage,
  NormalizedBinaryPart,
  ChatSpaceResource,
  GoogleChatMessage,
  UploadAttachmentResponse
} from './types'

const CHAT_API_BASE = 'https://chat.googleapis.com/v1'
const CHAT_UPLOAD_BASE = 'https://chat.googleapis.com/upload/v1'
const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024
export const MAX_DRIVE_EXPORT_BYTES = 10 * 1024 * 1024
const MAX_JSON_RESPONSE_BYTES = 16 * 1024 * 1024
const MAX_FETCH_ATTEMPTS = 3
const MAX_RETRY_DELAY_MS = 30_000
const SPACE_READ_INTERVAL_MS = Math.ceil(1_000 / 15)

export type ChatCredential =
  | 'app'
  | 'upload-user'
  | 'dm-setup-user'
  | 'reaction-reader'
  | { kind: 'delegated-reader' | 'delegated-etl-reader'; subject: string }

export type ChatPageOptions = {
  pageSize?: number
  pageToken?: string
  credential?: ChatCredential
}

export type ChatSpacePage = { spaces?: ChatSpaceResource[]; nextPageToken?: string }
export type ChatMessagePage = { messages?: ChatListMessage[]; nextPageToken?: string }
export type ChatMembership = {
  name?: string
  state?: string
  role?: string
  member?: { name?: string; displayName?: string; type?: 'HUMAN' | 'BOT' }
}
export type ChatMembershipPage = { memberships?: ChatMembership[]; nextPageToken?: string }
export type ChatReaction = {
  name?: string
  user?: { name?: string; displayName?: string }
  emoji?: { unicode?: string; customEmoji?: { uid?: string } }
  messageName?: string
}
export type ChatReactionPage = {
  reactions?: ChatReaction[]
  nextPageToken?: string
  incomplete?: boolean
}
export type ChatAttachmentResource = NonNullable<ChatListMessage['attachment']>[number]
export type AttachmentReadCredential = 'app' | { kind: 'delegated-reader'; subject: string }
export type ResolvedChatAttachment = {
  attachment: ChatAttachmentResource
  credential: AttachmentReadCredential
}
export type DownloadedAttachment = {
  data: ArrayBuffer
  mimeType: string
  name: string
  size: number
}

export class ChatEdgeClient {
  private accessToken: string | null = null
  private tokenExpiry = 0
  private readonly uploadUserTokens = new Map<string, { token: string | null; expiry: number }>()
  private readonly delegatedMutationTokens = new Map<string, { token: string | null; expiry: number }>()
  private readonly dmSetupTokens = new Map<string, { token: string | null; expiry: number }>()
  private reactionReadToken: string | null = null
  private reactionReadTokenExpiry = 0
  private driveReadToken: string | null = null
  private driveReadTokenExpiry = 0
  // DWD read tokens are keyed by the impersonated user (the requester), since a
  // DM's history is only readable by that DM's human member — not a fixed user.
  private readonly userReadTokens = new Map<string, { token: string | null; expiry: number }>()
  private readonly userEtlReadTokens = new Map<string, { token: string | null; expiry: number }>()
  private botUserNamePromise: Promise<string | undefined> | null = null
  private readonly serviceAccountEmail: string | null
  private readonly privateKey: string | null
  private readonly uploadUser: string
  private readonly reactionReadUser: string
  private readonly driveDownloadUser: string
  private readonly apiTimeoutMs: number
  private readonly now: () => number
  private readonly sleep: (milliseconds: number) => Promise<void>
  private readonly quotaState?: StateAdapter
  private readonly writeTails = new Map<string, Promise<void>>()
  private readonly nextWriteStart = new Map<string, number>()
  private readonly reactionReadTails = new Map<string, Promise<void>>()
  private readonly nextReactionReadStart = new Map<string, number>()

  constructor(
    config: AppConfig,
    timing: {
      now?: () => number
      sleep?: (milliseconds: number) => Promise<void>
      quotaState?: StateAdapter
    } = {}
  ) {
    this.apiTimeoutMs = config.GOOGLECHATBOT_CHAT_API_TIMEOUT_MS
    this.now = timing.now ?? Date.now
    this.sleep = timing.sleep
      ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)))
    this.quotaState = timing.quotaState
    this.uploadUser = config.GOOGLECHATBOT_UPLOAD_USER
    this.reactionReadUser = config.GOOGLECHATBOT_REACTION_READ_USER
    this.driveDownloadUser = config.GOOGLECHATBOT_DRIVE_DOWNLOAD_USER
    if (config.GOOGLE_SERVICE_ACCOUNT_JSON) {
      try {
        const parsed = JSON.parse(config.GOOGLE_SERVICE_ACCOUNT_JSON) as {
          client_email?: string
          private_key?: string
        }
        this.serviceAccountEmail = parsed.client_email ?? null
        this.privateKey = parsed.private_key ?? null
      } catch {
        this.serviceAccountEmail = null
        this.privateKey = null
      }
    } else {
      this.serviceAccountEmail = null
      this.privateKey = null
    }
  }

  /** Resolve the calling app alias through its membership and cache Google's
   * canonical numeric `users/<id>` resource name. */
  async getBotUserName(
    spaceName: string,
    readerSubject?: string
  ): Promise<string | undefined> {
    if (!this.serviceAccountEmail || !this.privateKey) return undefined
    if (!this.botUserNamePromise) {
      const id = spaceName.startsWith('spaces/') ? spaceName.slice('spaces/'.length) : spaceName
      const path = `spaces/${encodeURIComponent(id)}/members/app`
      this.botUserNamePromise = (async () => {
        let membership = await this.request<ChatMembership>('GET', path).catch(() => null)
        if (!canonicalBotName(membership)) {
          const subject = readerSubject || this.uploadUser
          const readerToken = validEmail(subject)
            ? await this.getUserEtlReadToken(subject)
            : null
          membership = readerToken
            ? await this.request<ChatMembership>('GET', path, undefined, { token: readerToken })
            : null
        }
        return canonicalBotName(membership)
      })()
        .then(name => {
          if (!name) this.botUserNamePromise = null
          return name
        })
        .catch(error => {
          this.botUserNamePromise = null
          throw error
        })
    }
    return this.botUserNamePromise
  }

  private async getAccessToken(): Promise<string | null> {
    if (!this.serviceAccountEmail || !this.privateKey) {
      return null
    }

    if (this.accessToken && Date.now() < this.tokenExpiry - 60_000) {
      return this.accessToken
    }

    // chat.bot: act as the app for sends/edits/deletes. Self-granted, no admin step.
    // chat.app.messages.readonly: read sibling messages in threads the app is mentioned in.
    // Requires one-time Workspace admin install of the private Marketplace listing.
    const scope = [
      'https://www.googleapis.com/auth/chat.bot',
      'https://www.googleapis.com/auth/chat.app.messages.readonly'
    ].join(' ')
    const grant = await this.exchangeJwtForToken(scope)
    this.accessToken = grant.token
    this.tokenExpiry = grant.expiry
    return this.accessToken
  }

  /**
   * Token for attachment uploads. media.upload rejects app auth (chat.bot) —
   * the official headless path is domain-wide delegation: the SA impersonates
   * a Workspace user (`sub` claim) with the chat.messages.create scope, so the
   * upload AND the message referencing it both run as that user.
   */
  private async getUploadUserToken(subject = this.uploadUser): Promise<string | null> {
    if (!this.canUploadAttachments(subject)) return null
    const cached = this.uploadUserTokens.get(subject)
    if (cached?.token && Date.now() < cached.expiry - 60_000) return cached.token

    const grant = await this.exchangeJwtForToken(
      'https://www.googleapis.com/auth/chat.messages.create',
      subject
    )
    this.uploadUserTokens.set(subject, grant)
    return grant.token
  }

  private async getDelegatedMutationToken(subject = this.uploadUser): Promise<string | null> {
    if (!this.canUploadAttachments(subject)) return null
    const cached = this.delegatedMutationTokens.get(subject)
    if (cached?.token && Date.now() < cached.expiry - 60_000) return cached.token
    const grant = await this.exchangeJwtForToken(
      [
        'https://www.googleapis.com/auth/chat.messages',
        'https://www.googleapis.com/auth/chat.memberships.readonly'
      ].join(' '),
      subject
    )
    this.delegatedMutationTokens.set(subject, grant)
    return grant.token
  }

  /** True when uploads are configured: SA credentials + a user to impersonate. */
  canUploadAttachments(subject = this.uploadUser): boolean {
    return Boolean(this.serviceAccountEmail && this.privateKey && subject)
  }

  canSetupDm(): boolean {
    return Boolean(this.serviceAccountEmail && this.privateKey)
  }

  canReadReactions(): boolean {
    return Boolean(this.serviceAccountEmail && this.privateKey && this.reactionReadUser)
  }

  canDownloadDriveAttachments(): boolean {
    return Boolean(this.serviceAccountEmail && this.privateKey && this.driveDownloadUser)
  }

  private async getDriveReadToken(): Promise<string | null> {
    if (!this.canDownloadDriveAttachments()) return null
    if (this.driveReadToken && Date.now() < this.driveReadTokenExpiry - 60_000) {
      return this.driveReadToken
    }
    const grant = await this.exchangeJwtForToken(
      'https://www.googleapis.com/auth/drive.readonly',
      this.driveDownloadUser
    )
    this.driveReadToken = grant.token
    this.driveReadTokenExpiry = grant.expiry
    return grant.token
  }

  private async getReactionReadToken(): Promise<string | null> {
    if (!this.canReadReactions()) return null
    if (this.reactionReadToken && Date.now() < this.reactionReadTokenExpiry - 60_000) {
      return this.reactionReadToken
    }
    const grant = await this.exchangeJwtForToken(
      'https://www.googleapis.com/auth/chat.messages.reactions.readonly',
      this.reactionReadUser
    )
    this.reactionReadToken = grant.token
    this.reactionReadTokenExpiry = grant.expiry
    return grant.token
  }

  private async getDmSetupToken(subject: string): Promise<string | null> {
    if (!this.canSetupDm()) return null
    const cached = this.dmSetupTokens.get(subject)
    if (cached?.token && Date.now() < cached.expiry - 60_000) {
      return cached.token
    }
    const grant = await this.exchangeJwtForToken(
      'https://www.googleapis.com/auth/chat.spaces.create',
      subject
    )
    this.dmSetupTokens.set(subject, grant)
    return grant.token
  }

  /**
   * Token for READING messages as an impersonated Workspace user (domain-wide
   * delegation). App auth (chat.bot / chat.app.messages.readonly) CANNOT read
   * DM spaces — Google rejects it with 400 "DMs are not supported for methods
   * requiring app authentication with administrator approval." The only headless
   * way to read a DM's history is to impersonate a HUMAN member of that DM —
   * i.e. the requester (`subject`), never a fixed service user, who would not be
   * in someone else's DM. Scope is read-only so this grant can never write.
   * Requires the SA's DWD client to be authorized for chat.messages.readonly in
   * the Workspace Admin console (same client already authorized for
   * chat.messages.create used by uploads). `subject` must be a user in the SA's
   * Workspace domain; out-of-domain requesters cannot be impersonated and the
   * token exchange will fail (caller degrades to app auth / empty history).
   */
  private async getUserReadToken(subject: string): Promise<string | null> {
    if (!this.serviceAccountEmail || !this.privateKey || !subject) return null

    const cached = this.userReadTokens.get(subject)
    if (cached && cached.token && Date.now() < cached.expiry - 60_000) {
      return cached.token
    }

    const grant = await this.exchangeJwtForToken(
      'https://www.googleapis.com/auth/chat.messages.readonly',
      subject
    )
    this.userReadTokens.set(subject, grant)
    return grant.token
  }

  /** Combined read-only grant used only by the owner-scoped DM ETL broker. */
  private async getUserEtlReadToken(subject: string): Promise<string | null> {
    if (!this.serviceAccountEmail || !this.privateKey || !subject) return null

    const cached = this.userEtlReadTokens.get(subject)
    if (cached && cached.token && Date.now() < cached.expiry - 60_000) {
      return cached.token
    }

    const grant = await this.exchangeJwtForToken(
      [
        'https://www.googleapis.com/auth/chat.messages.readonly',
        'https://www.googleapis.com/auth/chat.spaces.readonly',
        'https://www.googleapis.com/auth/chat.memberships.readonly',
        'https://www.googleapis.com/auth/chat.messages.reactions.readonly'
      ].join(' '),
      subject
    )
    this.userEtlReadTokens.set(subject, grant)
    return grant.token
  }

  private async exchangeJwtForToken(
    scope: string,
    sub?: string
  ): Promise<{ token: string | null; expiry: number }> {
    if (!this.serviceAccountEmail || !this.privateKey) return { token: null, expiry: 0 }
    const now = Math.floor(Date.now() / 1000)

    const jwt = await createJWT({
      email: this.serviceAccountEmail,
      key: this.privateKey,
      scope,
      sub,
      iat: now,
      exp: now + 3600
    })

    // Bound the token exchange too: it runs before every request()'s own timed
    // fetch, so an unbounded hang here would stall the whole handoff despite the
    // downstream call being timed.
    const response = await fetchWithRetry(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt
      })
    }, this.apiTimeoutMs)

    const responseText = await boundedResponseText(response)
    if (!response.ok) {
      const errorText = responseText
      throw new Error(`Google OAuth2 token exchange failed: ${response.status} ${errorText}`)
    }

    const data = (responseText ? JSON.parse(responseText) : {}) as {
      access_token?: string
      expires_in?: number
    }
    return {
      token: data.access_token ?? null,
      expiry: Date.now() + ((data.expires_in ?? 3600) - 120) * 1000
    }
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    opts: {
      baseUrl?: string
      token?: string | null
      timeoutMs?: number
      credential?: ChatCredential
    } = {}
  ): Promise<T> {
    const url = `${opts.baseUrl ?? CHAT_API_BASE}/${path.replace(/^\//, '')}`
    const token = opts.token ?? (await this.tokenForCredential(opts.credential ?? 'app'))
    const send = () => fetchWithRetry(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    }, opts.timeoutMs ?? this.apiTimeoutMs)
    const writeSpace = method === 'GET' ? undefined : spaceFromApiPath(path)
    const response = writeSpace
      ? await this.scheduleSpaceWrite(writeSpace, send)
      : await send()

    if (!response.ok) {
      const rawErrorText = await boundedResponseText(response)
      const errorText = token ? rawErrorText.replaceAll(token, '[redacted]') : rawErrorText
      throw new ChatApiError(method, path, response.status, errorText)
    }

    if (response.status === 204 || response.headers.get('content-length') === '0') {
      return {} as T
    }
    const text = await boundedResponseText(response)
    return (text ? JSON.parse(text) : {}) as T
  }

  private scheduleSpaceWrite<T>(spaceName: string, write: () => Promise<T>): Promise<T> {
    if (this.quotaState) {
      return this.reserveDistributedQuota('write', spaceName, 1_000).then(write)
    }
    const previous = this.writeTails.get(spaceName) ?? Promise.resolve()
    const scheduled = previous.catch(() => undefined).then(async () => {
      const delay = Math.max(0, (this.nextWriteStart.get(spaceName) ?? 0) - this.now())
      if (delay) await this.sleep(delay)
      this.nextWriteStart.set(spaceName, this.now() + 1_000)
      return write()
    })
    const tail = scheduled.then(() => undefined, () => undefined)
    this.writeTails.set(spaceName, tail)
    void tail.finally(() => {
      if (this.writeTails.get(spaceName) === tail) this.writeTails.delete(spaceName)
    })
    return scheduled
  }

  private async reserveDistributedQuota(
    operation: 'write' | 'reaction-read',
    spaceName: string,
    intervalMs: number
  ): Promise<void> {
    const state = this.quotaState!
    const key = `google-chat-quota:${operation}:${spaceName}`
    const deadline = this.now() + this.apiTimeoutMs
    while (true) {
      const lock = await state.acquireLock(key, 5_000)
      if (lock) {
        try {
          const previous = await state.get<number>(key)
          const delay = Math.max(
            0,
            (Number.isFinite(previous) ? previous! + intervalMs : 0) - this.now()
          )
          if (delay) await this.sleep(delay)
          await state.set(key, this.now(), 60_000)
          return
        } finally {
          await state.releaseLock(lock)
        }
      }
      if (this.now() >= deadline) {
        throw new ChatConfigurationError('Google Chat per-space write quota gate timed out')
      }
      await this.sleep(25)
    }
  }

  private async tokenForCredential(credential: ChatCredential): Promise<string | null> {
    if (credential === 'app') return this.getAccessToken()
    if (credential === 'upload-user') return this.getUploadUserToken()
    if (credential === 'dm-setup-user') {
      throw new ChatConfigurationError('DM setup credentials require a target email')
    }
    if (credential === 'reaction-reader') return this.getReactionReadToken()
    return credential.kind === 'delegated-etl-reader'
      ? this.getUserEtlReadToken(credential.subject)
      : this.getUserReadToken(credential.subject)
  }

  /**
   * Create a message in a Google Chat space.
   * Path: POST /v1/spaces/{space}/messages
   *
   * Accepts either a bare space id ("lw57hyAAAAE") or a fully-qualified resource
   * name ("spaces/lw57hyAAAAE") — Google Chat's MESSAGE event sends the latter,
   * so we normalize to avoid double-prefixing the URL.
   *
   * When threadName is provided, the new message is threaded under the given
   * thread (resource name like "spaces/<id>/threads/<id>"), so the bot's reply
   * lands under the user's message instead of in the space root.
   *
   * This applies to DMs and group chats too. Google shipped in-line threading to
   * both on 2025-11-05, and `spaces.get` on a 1:1 bot DM now reports
   * `spaceThreadingState: THREADED_MESSAGES`. The `messages.create` reference
   * still says messageReplyOption is "Only supported in named spaces"; that line
   * is stale. Probed live against a real DM on 2026-08-19: the create succeeded,
   * landed in the requested thread, and came back `threadReply: true`.
   *
   * For a space that genuinely does not thread (continuous meeting chat, legacy
   * pre-2022 group conversations) Google documents the field as ignored, and
   * REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD is the forgiving variant by design —
   * it starts a new thread rather than failing the write.
   */
  async createMessage(
    spaceName: string,
    message: Partial<GoogleChatMessage>,
    opts: { messageId?: string; threadName?: string } = {}
  ): Promise<GoogleChatMessage> {
    const id = spaceName.startsWith('spaces/') ? spaceName.slice('spaces/'.length) : spaceName
    const body: Partial<GoogleChatMessage> = { ...message }
    const query = new URLSearchParams()
    if (opts.threadName) {
      body.thread = { name: opts.threadName }
      query.set('messageReplyOption', 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD')
    }
    // Generate both idempotency keys once per invocation; fetch retries reuse
    // this exact URL instead of duplicating a committed message.
    query.set('messageId', opts.messageId ?? generatedMessageId())
    query.set('requestId', crypto.randomUUID())
    const path = `spaces/${id}/messages${query.size ? `?${query}` : ''}`
    return this.request('POST', path, body)
  }

  /**
   * Update a message.
   * Path: PATCH /v1/{message.name}?updateMask=text,cardsV2
   *
   * Google Chat requires updateMask as a query parameter listing the fields to
   * patch. fallbackText is create-only and is not a supported update path.
   */
  async updateMessage(
    messageName: string,
    update: Partial<GoogleChatMessage>
  ): Promise<GoogleChatMessage> {
    const path = `${messageName}?updateMask=${encodeURIComponent('text,cardsV2')}`
    return this.request('PATCH', path, update)
  }

  /**
   * Delete a message.
   * Path: DELETE /v1/{message.name}
   */
  async deleteMessage(messageName: string): Promise<void> {
    return this.request('DELETE', messageName)
  }

  /** Mutate only messages authored by this app or the configured delegated
   * upload user. Google also checks ownership, but doing it here prevents a
   * broader future credential from turning this internal API into an arbitrary
   * message editor. */
  async updateOwnedMessage(
    spaceName: string,
    messageName: string,
    update: Partial<GoogleChatMessage>,
    readerSubject?: string
  ): Promise<GoogleChatMessage> {
    const owner = await this.ownedMessageCredential(spaceName, messageName, readerSubject)
    return this.request(
      'PATCH',
      `${messageName}?updateMask=${encodeURIComponent(
        owner.kind === 'app' ? 'text,cardsV2' : 'text'
      )}`,
      update,
      { token: owner.token }
    )
  }

  async deleteOwnedMessage(
    spaceName: string,
    messageName: string,
    readerSubject?: string
  ): Promise<Record<string, never>> {
    const owner = await this.ownedMessageCredential(spaceName, messageName, readerSubject)
    return this.request('DELETE', messageName, undefined, { token: owner.token })
  }

  private async ownedMessageCredential(
    spaceName: string,
    messageName: string,
    readerSubject?: string
  ): Promise<{ kind: 'app' | 'delegated'; token: string }> {
    const botToken = await this.getAccessToken()
    if (!botToken) throw new ChatOwnershipError('Google Chat app credentials are not configured')
    const message = await this.request<ChatListMessage>('GET', messageName, undefined, {
      token: botToken
    }).catch(() => null)
    const botUserName = await this.getBotUserName(spaceName, readerSubject).catch(() => undefined)
    if (botUserName && message?.sender?.name === botUserName) {
      return { kind: 'app', token: botToken }
    }

    if (botUserName && !message && readerSubject) {
      const readerToken = await this.getUserEtlReadToken(readerSubject)
      const readerView = readerToken
        ? await this.request<ChatListMessage>('GET', messageName, undefined, {
            token: readerToken
          })
        : null
      if (readerView?.sender?.name === botUserName) {
        return { kind: 'app', token: botToken }
      }
    }

    const mutationSubject = readerSubject || this.uploadUser
    const delegatedToken = await this.getDelegatedMutationToken(mutationSubject)
    if (delegatedToken) {
      const id = spaceName.startsWith('spaces/') ? spaceName.slice('spaces/'.length) : spaceName
      const membership = await this.request<ChatMembership>(
        'GET',
        `spaces/${encodeURIComponent(id)}/members/${encodeURIComponent(mutationSubject)}`,
        undefined,
        { token: delegatedToken }
      )
      const delegatedView = await this.request<ChatListMessage>('GET', messageName, undefined, {
        token: delegatedToken
      })
      if (
        membership.member?.name
        && delegatedView.sender?.name === membership.member.name
        && centaurGeneratedMessage(delegatedView.clientAssignedMessageId)
      ) {
        return { kind: 'delegated', token: delegatedToken }
      }
    }
    throw new ChatOwnershipError('Google Chat message is not owned by this integration')
  }

  /**
   * List messages in a space.
   * Path: GET /v1/spaces/{space}/messages
   *
   * Pass `filter='thread.name = spaces/<id>/threads/<id>'` to scope the listing
   * to a single thread — this is how thread-history context is fetched after a
   * bot @mention. Requires `chat.app.messages.readonly` (admin-approved) or a
   * user-auth scope; the self-granted `chat.bot` scope is rejected with 403.
   *
   * App auth cannot read DM spaces at all (Google returns 400 "DMs are not
   * supported for methods requiring app authentication..."). When that happens
   * we transparently retry as the impersonated user (DWD), which is the only
   * headless way to read a DM's history — mirroring how uploads impersonate.
   */
  async listMessages(
    spaceName: string,
    opts: {
      pageSize?: number
      pageToken?: string
      filter?: string
      orderBy?: string
      showDeleted?: boolean
      credential?: ChatCredential
      /** Requester email to impersonate (DWD) if app auth is refused on a DM. */
      impersonateSubject?: string
    } = {}
  ): Promise<{ messages?: ChatListMessage[]; nextPageToken?: string }> {
    const id = spaceName.startsWith('spaces/') ? spaceName.slice('spaces/'.length) : spaceName
    const params = new URLSearchParams()
    if (opts.pageSize) params.set('pageSize', String(opts.pageSize))
    if (opts.pageToken) params.set('pageToken', opts.pageToken)
    if (opts.filter) params.set('filter', opts.filter)
    if (opts.orderBy) params.set('orderBy', opts.orderBy)
    if (opts.showDeleted) params.set('showDeleted', 'true')
    const query = params.toString()
    const path = `spaces/${id}/messages${query ? `?${query}` : ''}`
    try {
      return await this.request('GET', path, undefined, { credential: opts.credential })
    } catch (error) {
      // DMs reject app auth; retry as the requesting human, the only member who
      // can read the DM. No subject (e.g. out-of-domain requester) → give up.
      if (!this.isAppAuthDmError(error) || !opts.impersonateSubject) throw error
      const userToken = await this.getUserReadToken(opts.impersonateSubject)
      if (!userToken) throw error
      return await this.request('GET', path, undefined, { token: userToken })
    }
  }

  /**
   * True for the specific Google Chat failure where app auth is refused on a DM
   * space. The message is stable ("DMs are not supported for methods requiring
   * app authentication...") and rides a 400; match on it so we only fall back to
   * the heavier user-impersonation path for this case, not for every read error.
   */
  private isAppAuthDmError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error)
    return message.includes('DMs are not supported')
  }

  /**
   * Get a space by name.
   * Path: GET /v1/spaces/{space}
   *
   * This is the only statement about a space that comes from GOOGLE rather than
   * from the (attacker-controllable, signature-unbound) request body, so it is
   * what the identity gate classifies a DM from. App auth is accepted here
   * including on DM spaces — the 400 "DMs are not supported for methods
   * requiring app authentication" refusal is specific to spaces.messages.list,
   * not spaces.get.
   *
   * Fields stay `unknown` on purpose: the caller must reject a
   * joinedDirectHumanUserCount that is absent, null, boolean or a string rather
   * than coerce it into a passing "1".
   *
   * `timeoutMs` overrides GOOGLECHATBOT_CHAT_API_TIMEOUT_MS because this call
   * can sit in front of a turn; a hung Chat backend must cost the turn seconds,
   * not the deployment-wide 30s ceiling.
   */
  async getSpace(
    spaceName: string,
    opts: { timeoutMs?: number; credential?: ChatCredential } = {}
  ): Promise<ChatSpaceResource> {
    const id = spaceName.startsWith('spaces/') ? spaceName.slice('spaces/'.length) : spaceName
    return this.request('GET', `spaces/${encodeURIComponent(id)}`, undefined, opts)
  }

  async listSpaces(opts: ChatPageOptions = {}): Promise<ChatSpacePage> {
    const params = new URLSearchParams()
    if (opts.pageSize) params.set('pageSize', String(opts.pageSize))
    if (opts.pageToken) params.set('pageToken', opts.pageToken)
    const query = params.toString()
    return this.request('GET', `spaces${query ? `?${query}` : ''}`, undefined, {
      credential: opts.credential
    })
  }

  async listMemberships(
    spaceName: string,
    opts: ChatPageOptions = {}
  ): Promise<ChatMembershipPage> {
    const id = spaceName.startsWith('spaces/') ? spaceName.slice('spaces/'.length) : spaceName
    return this.listNamedResource(`spaces/${id}`, 'members', opts)
  }

  async listMessageReactions(
    messageName: string,
    opts: ChatPageOptions = {}
  ): Promise<ChatReactionPage> {
    const read = () => this.listNamedResource<ChatReactionPage>(messageName, 'reactions', {
      ...opts,
      ...(opts.pageSize ? { pageSize: Math.min(opts.pageSize, 200) } : {})
    })
    const spaceName = spaceFromMessageName(messageName)
    return spaceName ? this.scheduleReactionRead(spaceName, read) : read()
  }

  private scheduleReactionRead<T>(spaceName: string, read: () => Promise<T>): Promise<T> {
    if (this.quotaState) {
      return this.reserveDistributedQuota(
        'reaction-read',
        spaceName,
        SPACE_READ_INTERVAL_MS
      ).then(read)
    }
    const previous = this.reactionReadTails.get(spaceName) ?? Promise.resolve()
    const scheduled = previous.catch(() => undefined).then(async () => {
      const delay = Math.max(
        0,
        (this.nextReactionReadStart.get(spaceName) ?? 0) - this.now()
      )
      if (delay) await this.sleep(delay)
      this.nextReactionReadStart.set(spaceName, this.now() + SPACE_READ_INTERVAL_MS)
      return read()
    })
    const tail = scheduled.then(() => undefined, () => undefined)
    this.reactionReadTails.set(spaceName, tail)
    void tail.finally(() => {
      if (this.reactionReadTails.get(spaceName) === tail) this.reactionReadTails.delete(spaceName)
    })
    return scheduled
  }

  async getAttachment(
    messageName: string,
    attachmentId: string,
    readerSubject?: string
  ): Promise<ChatAttachmentResource> {
    return (await this.resolveAttachment(messageName, attachmentId, readerSubject)).attachment
  }

  async resolveAttachment(
    messageName: string,
    attachmentId: string,
    readerSubject?: string
  ): Promise<ResolvedChatAttachment> {
    const expectedName = `${messageName}/attachments/${attachmentId}`
    // attachments.get is app-auth only. For a user-authored upload, resolve
    // metadata from the exact parent message and keep that delegated credential
    // for media.download rather than crossing credential boundaries.
    if (!readerSubject) {
      try {
        const attachment = await this.request<ChatAttachmentResource>(
          'GET',
          `${messageName}/attachments/${encodeURIComponent(attachmentId)}`
        )
        if (attachment.name !== expectedName) {
          throw new ChatConfigurationError('Google Chat attachment resource mismatch')
        }
        return { attachment, credential: 'app' }
      } catch (error) {
        if (!(error instanceof ChatApiError) || error.status !== 403 || !validEmail(this.uploadUser)) {
          throw error
        }
        readerSubject = this.uploadUser
      }
    }

    if (!validEmail(readerSubject)) {
      throw new ChatConfigurationError('Google Chat attachment reader must be an email address')
    }
    const credential = { kind: 'delegated-reader', subject: readerSubject } as const
    const message = await this.request<ChatListMessage>('GET', messageName, undefined, {
      credential
    })
    if (message.name !== messageName) {
      throw new ChatConfigurationError('Google Chat attachment parent message mismatch')
    }
    const attachment = message.attachment?.find(candidate => candidate.name === expectedName)
    if (!attachment) {
      throw new ChatConfigurationError('Google Chat attachment resource mismatch')
    }
    return { attachment, credential }
  }

  async setupDm(targetIdentity: string): Promise<ChatSpaceResource> {
    if (!validEmail(targetIdentity)) {
      throw new ChatConfigurationError('Google Chat DM target must be an email address')
    }
    const token = await this.getDmSetupToken(targetIdentity)
    if (!token) throw new ChatConfigurationError('Google Chat DM setup is not configured')
    return this.request('POST', 'spaces:setup', {
      space: { spaceType: 'DIRECT_MESSAGE', singleUserBotDm: true },
      requestId: crypto.randomUUID(),
      memberships: []
    }, { token })
  }

  private async listNamedResource<T>(
    parent: string,
    resource: string,
    opts: ChatPageOptions
  ): Promise<T> {
    const params = new URLSearchParams()
    if (opts.pageSize) params.set('pageSize', String(opts.pageSize))
    if (opts.pageToken) params.set('pageToken', opts.pageToken)
    const query = params.toString()
    return this.request('GET', `${parent}/${resource}${query ? `?${query}` : ''}`, undefined, {
      credential: opts.credential
    })
  }

  /**
   * Download the content of an uploaded attachment.
   * Path: GET /v1/media/{resourceName}?alt=media
   *
   * Media downloads live on the same chat.googleapis.com host but under
   * /v1/media/, not /v1/spaces/, and return raw bytes rather than JSON — so
   * this bypasses request() the same way uploadAttachment does.
   */
  async downloadAttachment(
    resourceName: string,
    expectedMimeType?: string,
    expectedSize?: number,
    credential: AttachmentReadCredential = 'app'
  ): Promise<ArrayBuffer> {
    if (!validAttachmentDataResource(resourceName)) {
      throw new ChatConfigurationError('invalid Google Chat attachment resource ID')
    }
    const token = await this.tokenForCredential(credential)
    const url = `${CHAT_API_BASE}/media/${resourceName.replace(/^\//, '')}?alt=media`

    const response = await fetchWithRetry(url, {
      method: 'GET',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      }
    }, this.apiTimeoutMs)

    if (!response.ok) {
      const errorText = await boundedResponseText(response)
      throw new Error(`Chat API media download failed: ${response.status} ${errorText}`)
    }

    const mimeType = response.headers.get('content-type')?.split(';', 1)[0]?.trim()
    if (
      isHtmlContentType(mimeType)
      || (expectedMimeType && mimeType !== expectedMimeType && mimeType !== 'application/octet-stream')
    ) {
      throw new ChatConfigurationError('Google Chat attachment MIME type mismatch')
    }
    const declared = contentLength(response)
    if (declared !== undefined && declared > MAX_DOWNLOAD_BYTES) {
      await response.body?.cancel().catch(() => undefined)
      throw new ChatConfigurationError('Google Chat attachment exceeds 100 MiB')
    }
    if (declared !== undefined && expectedSize !== undefined && declared !== expectedSize) {
      await response.body?.cancel().catch(() => undefined)
      throw new ChatConfigurationError('Google Chat attachment size mismatch')
    }
    const body = await boundedResponseBytes(response, MAX_DOWNLOAD_BYTES)
    if (!body.data) {
      throw new ChatConfigurationError('Google Chat attachment exceeds 100 MiB')
    }
    if (expectedSize !== undefined && body.size !== expectedSize) {
      throw new ChatConfigurationError('Google Chat attachment size mismatch')
    }
    return body.data
  }

  async downloadDriveAttachment(input: {
    driveFileId: string
    expectedMimeType: string
    declaredSize?: number
  }): Promise<{
    data?: ArrayBuffer
    mimeType?: string
    name?: string
    size?: number
    unavailableReason?: NormalizedBinaryPart['unavailable_reason']
  }> {
    if (safeMimeType(input.expectedMimeType) !== input.expectedMimeType) {
      return { unavailableReason: 'metadata_mismatch' }
    }
    if (!this.canDownloadDriveAttachments()) {
      return { unavailableReason: 'download_not_configured' }
    }
    if (
      input.declaredSize !== undefined
      && (!Number.isSafeInteger(input.declaredSize) || input.declaredSize < 0)
    ) return { unavailableReason: 'metadata_mismatch' }
    if (!validDriveFileId(input.driveFileId)) return { unavailableReason: 'invalid_resource' }
    if (input.declaredSize !== undefined && input.declaredSize > MAX_DOWNLOAD_BYTES) {
      return { unavailableReason: 'declared_too_large' }
    }
    const token = await this.getDriveReadToken()
    if (!token) return { unavailableReason: 'download_not_configured' }

    const path = `files/${encodeURIComponent(input.driveFileId)}`
    const metadataResponse = await this.driveFetch(
      `${DRIVE_API_BASE}/${path}?fields=id,name,mimeType,size,capabilities(canDownload)&supportsAllDrives=true`,
      token
    )
    if (!metadataResponse.ok) throw await driveApiError('metadata', metadataResponse)
    if (!isJsonContentType(metadataResponse.headers.get('content-type'))) {
      throw new DriveApiError('metadata', 502, 'unexpected content type')
    }
    const metadataText = await boundedResponseText(
      metadataResponse,
      MAX_JSON_RESPONSE_BYTES,
      'Google Drive API response exceeded the size limit'
    )
    const metadata = JSON.parse(metadataText) as {
      id?: string
      name?: string
      mimeType?: string
      size?: string
      capabilities?: { canDownload?: boolean }
    }
    const metadataSize = parseByteSize(metadata.size)
    const exportFormat = driveExportFormat(metadata.mimeType)
    const googleNative = typeof metadata.mimeType === 'string'
      && isGoogleNativeMimeType(metadata.mimeType)
    if (
      metadata.id !== input.driveFileId
      || typeof metadata.name !== 'string'
      || !metadata.name
      || !metadata.mimeType
      || metadata.mimeType !== input.expectedMimeType
      || metadata.capabilities?.canDownload !== true
      || (!googleNative && metadataSize === undefined)
      || (metadataSize !== undefined && metadataSize > MAX_DOWNLOAD_BYTES)
      || (input.declaredSize !== undefined && metadataSize !== input.declaredSize)
    ) {
      return { mimeType: metadata.mimeType, size: metadataSize, unavailableReason: 'metadata_mismatch' }
    }
    if (googleNative && !exportFormat) {
      return {
        mimeType: metadata.mimeType,
        name: metadata.name,
        unavailableReason: 'unsupported_native_file'
      }
    }

    const response = await this.driveFetch(
      exportFormat
        ? `${DRIVE_API_BASE}/${path}/export?mimeType=${encodeURIComponent(exportFormat.mimeType)}`
        : `${DRIVE_API_BASE}/${path}?alt=media&supportsAllDrives=true`,
      token
    )
    if (!response.ok) {
      if (exportFormat && await isDriveExportTooLarge(response)) {
        return { name: metadata.name, unavailableReason: 'export_too_large' }
      }
      throw await driveApiError('download', response)
    }
    const mimeType = response.headers.get('content-type')?.split(';', 1)[0]?.trim()
    const length = contentLength(response)
    const maxBytes = exportFormat ? MAX_DRIVE_EXPORT_BYTES : MAX_DOWNLOAD_BYTES
    if (
      mimeType !== (exportFormat?.mimeType ?? metadata.mimeType)
      || isHtmlContentType(mimeType)
      || (length !== undefined && (
        (!exportFormat && length !== metadataSize) || length > maxBytes
      ))
    ) {
      return {
        mimeType,
        size: length,
        unavailableReason: exportFormat && length !== undefined && length > maxBytes
          ? 'export_too_large'
          : 'metadata_mismatch'
      }
    }
    const body = await boundedResponseBytes(response, maxBytes)
    if (!body.data || (!exportFormat && body.size !== metadataSize)) {
      return {
        mimeType,
        size: body.size,
        unavailableReason: exportFormat && body.size > maxBytes
          ? 'export_too_large'
          : 'metadata_mismatch'
      }
    }
    return {
      data: body.data,
      mimeType,
      name: exportFormat
        ? withExtension(metadata.name, exportFormat.extension)
        : metadata.name,
      size: body.size
    }
  }

  async downloadAttachmentResource(
    attachment: ChatAttachmentResource,
    credential: AttachmentReadCredential = 'app'
  ): Promise<DownloadedAttachment> {
    const name = attachment.contentName ?? 'attachment'
    const mimeType = attachment.contentType ?? 'application/octet-stream'
    if (safeMimeType(mimeType) !== mimeType) {
      throw new ChatConfigurationError('invalid Google attachment MIME type')
    }
    if (attachment.source === 'DRIVE_FILE') {
      const driveFileId = attachment.driveDataRef?.driveFileId
      if (!driveFileId) throw new ChatConfigurationError('invalid Google Drive attachment resource')
      const result = await this.downloadDriveAttachment({
        driveFileId,
        expectedMimeType: mimeType
      })
      if (!result.data || !result.mimeType || result.size === undefined) {
        throw new ChatConfigurationError(
          `Google Drive attachment is unavailable: ${result.unavailableReason ?? 'download_failed'}`
        )
      }
      return { data: result.data, mimeType: result.mimeType, name: result.name ?? name, size: result.size }
    }
    const resourceName = attachment.attachmentDataRef?.resourceName
    if (!resourceName) throw new ChatConfigurationError('invalid Google Chat attachment resource')
    const data = await this.downloadAttachment(resourceName, mimeType, undefined, credential)
    return { data, mimeType, name, size: data.byteLength }
  }

  private async driveFetch(url: string, token: string): Promise<Response> {
    let current = new URL(url)
    for (let redirects = 0; redirects <= 3; redirects++) {
      if (!allowedDriveHost(current.hostname)) {
        throw new DriveApiError('redirect', 502, 'unapproved redirect host')
      }
      const response = await fetchWithRetry(current, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        redirect: 'manual'
      }, this.apiTimeoutMs)
      if (![301, 302, 303, 307, 308].includes(response.status)) return response
      const location = response.headers.get('location')
      if (!location) throw new DriveApiError('redirect', 502, 'redirect missing location')
      current = new URL(location, current)
    }
    throw new DriveApiError('redirect', 502, 'too many redirects')
  }

  /**
   * Upload a file attachment to a space.
   * Path: POST https://chat.googleapis.com/upload/v1/spaces/{space}/attachments:upload
   *
   * Official flow ("Upload media as a file attachment"): a multipart upload
   * whose JSON metadata part carries the required UploadAttachmentRequest
   * `filename`, followed by the media bytes. Runs on the impersonated-user
   * token — app auth (chat.bot) is rejected by media.upload. The returned
   * UploadAttachmentResponse is what a message's `attachment` list expects.
   */
  async uploadAttachment(
    spaceName: string,
    fileName: string,
    contentType: string,
    data: Uint8Array,
    subject?: string
  ): Promise<UploadAttachmentResponse> {
    const token = await this.getUploadUserToken(subject)
    if (!token) {
      throw new Error(
        'attachment uploads are not configured: set GOOGLECHATBOT_UPLOAD_USER '
          + '(a Workspace user the service account may impersonate via '
          + 'domain-wide delegation with the chat.messages.create scope)'
      )
    }

    const id = encodeURIComponent(
      spaceName.startsWith('spaces/') ? spaceName.slice('spaces/'.length) : spaceName
    )
    const url = `${CHAT_UPLOAD_BASE}/spaces/${id}/attachments:upload?uploadType=multipart`
    const boundary = `centaur-upload-${crypto.randomUUID()}`
    const encoder = new TextEncoder()
    const head = encoder.encode(
      `--${boundary}\r\n`
        + 'Content-Type: application/json; charset=UTF-8\r\n\r\n'
        // filename is JSON-escaped; mimeType is validated to a token/token grammar
        // so neither can inject CRLF or extra part headers into the multipart body.
        + `${JSON.stringify({ filename: fileName })}\r\n`
        + `--${boundary}\r\n`
        + `Content-Type: ${safeMimeType(contentType)}\r\n\r\n`
    )
    const tail = encoder.encode(`\r\n--${boundary}--\r\n`)
    const body = new Uint8Array(head.byteLength + data.byteLength + tail.byteLength)
    body.set(head, 0)
    body.set(data, head.byteLength)
    body.set(tail, head.byteLength + data.byteLength)

    const response = await this.scheduleSpaceWrite(spaceName, () => fetchWithRetry(url, {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/related; boundary=${boundary}`,
          Authorization: `Bearer ${token}`
        },
        // Coerce to BufferSource — tsgo's BodyInit overload set rejects the bare
        // Uint8Array<ArrayBufferLike> shape Bun infers here.
        body: body as BodyInit
      }, this.apiTimeoutMs, 'rate-limit-only'))

    if (!response.ok) {
      const errorText = await boundedResponseText(response)
      throw new Error(`Chat API upload failed: ${response.status} ${errorText}`)
    }

    const responseText = await boundedResponseText(response)
    return (responseText ? JSON.parse(responseText) : {}) as UploadAttachmentResponse
  }

  /**
   * Create a message carrying an uploaded attachment.
   * Path: POST /v1/spaces/{space}/messages
   *
   * Must run on the SAME impersonated-user credential as the upload — the
   * attachment reference is bound to it, and app auth can't attach files.
   */
  async createAttachmentMessage(
    spaceName: string,
    attachment: UploadAttachmentResponse,
    opts: { text?: string; threadName?: string; subject?: string } = {}
  ): Promise<GoogleChatMessage> {
    const token = await this.getUploadUserToken(opts.subject)
    if (!token) {
      throw new Error('attachment uploads are not configured: set GOOGLECHATBOT_UPLOAD_USER')
    }

    const id = spaceName.startsWith('spaces/') ? spaceName.slice('spaces/'.length) : spaceName
    const body: Partial<GoogleChatMessage> = {
      attachment: [attachment],
      ...(opts.text ? { text: opts.text } : {})
    }
    if (opts.threadName) body.thread = { name: opts.threadName }
    const query = new URLSearchParams({
      messageId: generatedMessageId(),
      requestId: crypto.randomUUID()
    })
    if (opts.threadName) {
      query.set('messageReplyOption', 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD')
    }
    const path = `spaces/${id}/messages?${query}`

    return this.request('POST', path, body, { token })
  }
}

function driveExportFormat(
  sourceMimeType: string | undefined
): { mimeType: string; extension: string } | undefined {
  switch (sourceMimeType) {
    case 'application/vnd.google-apps.document':
      return { mimeType: 'text/markdown', extension: '.md' }
    case 'application/vnd.google-apps.spreadsheet':
      return {
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        extension: '.xlsx'
      }
    case 'application/vnd.google-apps.presentation':
      return {
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        extension: '.pptx'
      }
    case 'application/vnd.google-apps.drawing':
      return { mimeType: 'application/pdf', extension: '.pdf' }
    case 'application/vnd.google-apps.script':
      return { mimeType: 'application/vnd.google-apps.script+json', extension: '.json' }
    default:
      return undefined
  }
}

function isGoogleNativeMimeType(mimeType: string): boolean {
  return mimeType.startsWith('application/vnd.google-apps.')
}

function withExtension(name: string, extension: string): string {
  return name.toLowerCase().endsWith(extension) ? name : `${name}${extension}`
}

export class ChatOwnershipError extends Error {}

export class ChatConfigurationError extends Error {}

export class DriveApiError extends Error {
  constructor(readonly operation: string, readonly status: number, detail: string) {
    super(`Drive API ${operation} failed: ${status}${detail ? ` ${detail}` : ''}`)
  }
}

export class ChatApiError extends Error {
  readonly category: 'unauthenticated' | 'forbidden' | 'rate_limited' | 'upstream' | 'request'

  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    detail: string
  ) {
    super(`Chat API ${method} ${path} failed: ${status}${detail ? ` ${detail}` : ''}`)
    this.category = status === 401
      ? 'unauthenticated'
      : status === 403
        ? 'forbidden'
        : status === 429
          ? 'rate_limited'
          : status >= 500
            ? 'upstream'
            : 'request'
  }
}

/** A `type/subtype` MIME token with no CR/LF, safe to place in a header. Falls
 * back to a generic binary type for anything malformed or injection-shaped. */
function safeMimeType(value: string): string {
  return /^[\w.+-]+\/[\w.+-]+$/.test(value) ? value : 'application/octet-stream'
}

function validAttachmentDataResource(value: string): boolean {
  return /^[A-Za-z0-9._/=-]{1,512}$/.test(value) && !value.includes('..')
}

function validDriveFileId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,256}$/.test(value)
}

function validEmail(value: string): boolean {
  return /^[^@\s/]+@[^@\s/]+$/.test(value)
}

function spaceFromApiPath(path: string): string | undefined {
  const id = /^spaces\/([^/?]+)/.exec(path)?.[1]
  return id ? `spaces/${id}` : undefined
}

function spaceFromMessageName(name: string): string | undefined {
  const id = /^spaces\/([^/]+)\/messages\/[^/]+$/.exec(name)?.[1]
  return id ? `spaces/${id}` : undefined
}

function generatedMessageId(): string {
  return `client-centaur-${crypto.randomUUID().replaceAll('-', '')}`
}

function centaurGeneratedMessage(clientAssignedMessageId: string | undefined): boolean {
  return Boolean(clientAssignedMessageId?.match(/^client-centaur-[A-Za-z0-9._-]+$/))
}

function canonicalBotName(membership: ChatMembership | null): string | undefined {
  const name = membership?.member?.name
  return membership?.member?.type === 'BOT' && /^users\/\d+$/.test(name ?? '')
    ? name
    : undefined
}

function parseByteSize(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

function contentLength(response: Response): number | undefined {
  return parseByteSize(response.headers.get('content-length') ?? undefined)
}

async function boundedResponseText(
  response: Response,
  maxBytes = MAX_JSON_RESPONSE_BYTES,
  errorMessage = 'Google Chat API response exceeded the size limit'
): Promise<string> {
  const body = await boundedResponseBytes(response, maxBytes)
  if (!body.data) throw new Error(errorMessage)
  return new TextDecoder().decode(body.data)
}

async function boundedResponseBytes(
  response: Response,
  maxBytes: number
): Promise<{ data?: ArrayBuffer; size: number }> {
  const declared = contentLength(response)
  if (declared !== undefined && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    return { size: declared }
  }
  const reader = response.body?.getReader()
  if (!reader) return { data: new ArrayBuffer(0), size: 0 }
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined)
        return { size }
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { data: bytes.buffer, size }
}

async function fetchWithRetry(
  input: string | URL,
  init: RequestInit,
  timeoutMs: number,
  mode: 'safe' | 'rate-limit-only' = 'safe'
): Promise<Response> {
  for (let attempt = 0; attempt < MAX_FETCH_ATTEMPTS; attempt += 1) {
    let response: Response
    try {
      response = await fetch(input, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs)
      })
    } catch (error) {
      if (mode === 'rate-limit-only' || attempt === MAX_FETCH_ATTEMPTS - 1) throw error
      const delayMs = Math.random() * Math.min(MAX_RETRY_DELAY_MS, 250 * 2 ** attempt)
      if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs))
      continue
    }
    if (
      !retryableStatus(response.status)
      || (mode === 'rate-limit-only' && response.status !== 429)
      || attempt === MAX_FETCH_ATTEMPTS - 1
    ) return response
    const retryAfter = retryAfterMs(response.headers.get('retry-after'))
    await response.body?.cancel().catch(() => undefined)
    const delayMs = retryAfter ?? retryBackoffMs(response.status, attempt)
    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs))
  }
  throw new Error('unreachable')
}

export function retryBackoffMs(
  status: number,
  attempt: number,
  random: () => number = Math.random
): number {
  if (status === 429) {
    return Math.min(MAX_RETRY_DELAY_MS, 1_000 * 2 ** attempt + random() * 1_000)
  }
  return random() * Math.min(MAX_RETRY_DELAY_MS, 250 * 2 ** attempt)
}

function retryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504
}

function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  const delay = Number.isFinite(seconds)
    ? seconds * 1_000
    : Date.parse(value) - Date.now()
  return Number.isFinite(delay) ? Math.max(0, Math.min(MAX_RETRY_DELAY_MS, delay)) : undefined
}

function isJsonContentType(value: string | null): boolean {
  return value?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json'
}

function isHtmlContentType(value: string | null | undefined): boolean {
  const normalized = value?.toLowerCase()
  return normalized === 'text/html' || normalized === 'application/xhtml+xml'
}

function allowedDriveHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return host === 'www.googleapis.com'
    || host === 'content.googleapis.com'
    || host.endsWith('.googleusercontent.com')
}

async function driveApiError(operation: string, response: Response): Promise<DriveApiError> {
  // Never echo OAuth or signed-download diagnostics across the internal boundary.
  await response.body?.cancel().catch(() => undefined)
  return new DriveApiError(operation, response.status, '')
}

async function isDriveExportTooLarge(response: Response): Promise<boolean> {
  try {
    const payload = JSON.parse(await boundedResponseText(response)) as {
      error?: { errors?: Array<{ reason?: string }> }
    }
    return payload.error?.errors?.some(error => error.reason === 'exportSizeLimitExceeded') ?? false
  } catch {
    return false
  }
}

async function createJWT(opts: {
  email: string
  key: string
  scope: string
  // Domain-wide delegation: the Workspace user to impersonate.
  sub?: string
  iat: number
  exp: number
}): Promise<string> {
  const header = base64urlEncode(
    JSON.stringify({ alg: 'RS256', typ: 'JWT' })
  )
  const payload = base64urlEncode(
    JSON.stringify({
      iss: opts.email,
      ...(opts.sub ? { sub: opts.sub } : {}),
      scope: opts.scope,
      aud: 'https://oauth2.googleapis.com/token',
      iat: opts.iat,
      exp: opts.exp
    })
  )

  const signingInput = `${header}.${payload}`
  const signature = await signRS256(signingInput, opts.key)
  const signatureB64 = base64urlEncode(signature)

  return `${signingInput}.${signatureB64}`
}

function base64urlEncode(data: string | ArrayBuffer): string {
  return Buffer.from(typeof data === 'string' ? data : new Uint8Array(data)).toString('base64url')
}

async function signRS256(signingInput: string, privateKeyPem: string): Promise<ArrayBuffer> {
  const keyData = privateKeyPem
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s/g, '')

  const keyBytes = Buffer.from(keyData, 'base64')

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    keyBytes,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  )

  const data = new TextEncoder().encode(signingInput)
  return crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, data)
}
