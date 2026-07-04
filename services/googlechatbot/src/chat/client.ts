import type { AppConfig } from '../config'
import type { ChatListMessage, GoogleChatMessage, UploadAttachmentResponse } from './types'

const CHAT_API_BASE = 'https://chat.googleapis.com/v1'
const CHAT_UPLOAD_BASE = 'https://chat.googleapis.com/upload/v1'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'

export class ChatEdgeClient {
  private accessToken: string | null = null
  private tokenExpiry = 0
  private uploadUserToken: string | null = null
  private uploadUserTokenExpiry = 0
  // DWD read tokens are keyed by the impersonated user (the requester), since a
  // DM's history is only readable by that DM's human member — not a fixed user.
  private readonly userReadTokens = new Map<string, { token: string | null; expiry: number }>()
  private readonly serviceAccountEmail: string | null
  private readonly privateKey: string | null
  private readonly uploadUser: string
  private readonly apiTimeoutMs: number

  constructor(config: AppConfig) {
    this.apiTimeoutMs = config.GOOGLECHATBOT_CHAT_API_TIMEOUT_MS
    this.uploadUser = config.GOOGLECHATBOT_UPLOAD_USER
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
  private async getUploadUserToken(): Promise<string | null> {
    if (!this.canUploadAttachments()) return null

    if (this.uploadUserToken && Date.now() < this.uploadUserTokenExpiry - 60_000) {
      return this.uploadUserToken
    }

    const grant = await this.exchangeJwtForToken(
      'https://www.googleapis.com/auth/chat.messages.create',
      this.uploadUser
    )
    this.uploadUserToken = grant.token
    this.uploadUserTokenExpiry = grant.expiry
    return this.uploadUserToken
  }

  /** True when uploads are configured: SA credentials + a user to impersonate. */
  canUploadAttachments(): boolean {
    return Boolean(this.serviceAccountEmail && this.privateKey && this.uploadUser)
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

  /** True when DWD user impersonation is possible: SA credentials are configured. */
  canImpersonateUser(): boolean {
    return Boolean(this.serviceAccountEmail && this.privateKey)
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
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt
      }),
      signal: AbortSignal.timeout(this.apiTimeoutMs)
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Google OAuth2 token exchange failed: ${response.status} ${errorText}`)
    }

    const data = (await response.json()) as {
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
    baseUrl = CHAT_API_BASE,
    tokenOverride?: string | null
  ): Promise<T> {
    const url = `${baseUrl}/${path.replace(/^\//, '')}`
    const token = tokenOverride ?? (await this.getAccessToken())
    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.apiTimeoutMs)
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Chat API ${method} ${path} failed: ${response.status} ${errorText}`)
    }

    return response.json() as T
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
   * thread (resource name like "spaces/<id>/threads/<id>"). In 1:1 DMs Google
   * Chat ignores the field; in named spaces it makes the bot reply land under
   * the user's message instead of in the space root.
   */
  async createMessage(
    spaceName: string,
    message: Partial<GoogleChatMessage>,
    opts: { threadName?: string } = {}
  ): Promise<GoogleChatMessage> {
    const id = spaceName.startsWith('spaces/') ? spaceName.slice('spaces/'.length) : spaceName
    const body: Partial<GoogleChatMessage> = { ...message }
    if (opts.threadName) {
      body.thread = { name: opts.threadName }
    }
    const path = opts.threadName
      ? `spaces/${id}/messages?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`
      : `spaces/${id}/messages`
    return this.request('POST', path, body)
  }

  /**
   * Update a message.
   * Path: PATCH /v1/{message.name}?updateMask=<fields>
   *
   * Google Chat requires updateMask as a query parameter listing the fields to
   * patch. We default to "text,cardsV2" because those are the only writable
   * fields we change. Pass a custom mask via opts.updateMask if patching a
   * different field.
   */
  async updateMessage(
    messageName: string,
    update: Partial<GoogleChatMessage>,
    opts: { updateMask?: string } = {}
  ): Promise<GoogleChatMessage> {
    const mask = opts.updateMask ?? 'text,cardsV2'
    const path = `${messageName}?updateMask=${encodeURIComponent(mask)}`
    return this.request('PATCH', path, update)
  }

  /**
   * Delete a message.
   * Path: DELETE /v1/{message.name}
   */
  async deleteMessage(messageName: string): Promise<void> {
    return this.request('DELETE', messageName)
  }

  /**
   * Get a single message.
   * Path: GET /v1/{message.name}
   */
  async getMessage(messageName: string): Promise<GoogleChatMessage> {
    return this.request('GET', messageName)
  }

  /**
   * List messages in a space.
   * Path: GET /v1/spaces/{space}/messages
   *
   * Pass `filter='thread.name="spaces/<id>/threads/<id>"'` to scope the listing
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
    const query = params.toString()
    const path = `spaces/${id}/messages${query ? `?${query}` : ''}`
    try {
      return await this.request('GET', path)
    } catch (error) {
      // DMs reject app auth; retry as the requesting human, the only member who
      // can read the DM. No subject (e.g. out-of-domain requester) → give up.
      if (!this.isAppAuthDmError(error) || !opts.impersonateSubject) throw error
      const userToken = await this.getUserReadToken(opts.impersonateSubject)
      if (!userToken) throw error
      return await this.request('GET', path, undefined, CHAT_API_BASE, userToken)
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
   * Create a reaction on a message.
   * Path: POST /v1/spaces/{space}/messages/{message}/reactions
   */
  async createReaction(parentResource: string, emoji: string): Promise<unknown> {
    return this.request('POST', `${parentResource}/reactions`, {
      emoji: { unicode: emoji }
    })
  }

  /**
   * List reactions on a message.
   * Path: GET /v1/{message.name}/reactions
   */
  async listReactions(messageName: string): Promise<unknown> {
    return this.request('GET', `${messageName}/reactions`)
  }

  /**
   * Delete a reaction from a message.
   * Path: DELETE /v1/{reaction.name}
   */
  async deleteReaction(reactionName: string): Promise<void> {
    return this.request('DELETE', reactionName)
  }

  /**
   * Get a space by name.
   * Path: GET /v1/{space.name}
   */
  async getSpace(spaceName: string): Promise<{
    name?: string
    type?: string
    displayName?: string
  }> {
    return this.request('GET', spaceName)
  }

  /**
   * List spaces the app is a member of.
   * Path: GET /v1/spaces
   */
  async listSpaces(opts: { pageSize?: number; pageToken?: string } = {}): Promise<{
    spaces?: Array<{ name: string; type: string; displayName?: string }>
    nextPageToken?: string
  }> {
    const params = new URLSearchParams()
    if (opts.pageSize) params.set('pageSize', String(opts.pageSize))
    if (opts.pageToken) params.set('pageToken', opts.pageToken)
    const query = params.toString()
    return this.request('GET', `spaces${query ? `?${query}` : ''}`)
  }

  /**
   * List members in a space.
   * Path: GET /v1/spaces/{space}/members
   */
  async listMembers(spaceName: string): Promise<{
    memberships?: Array<{
      name: string
      member?: { name?: string; displayName?: string; email?: string }
    }>
  }> {
    return this.request('GET', `${spaceName}/members`)
  }

  /**
   * Download the content of an uploaded attachment.
   * Path: GET /v1/media/{resourceName}?alt=media
   *
   * Media downloads live on the same chat.googleapis.com host but under
   * /v1/media/, not /v1/spaces/, and return raw bytes rather than JSON — so
   * this bypasses request() the same way uploadAttachment does.
   */
  async downloadAttachment(resourceName: string): Promise<ArrayBuffer> {
    const token = await this.getAccessToken()
    const url = `${CHAT_API_BASE}/media/${resourceName.replace(/^\//, '')}?alt=media`

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      signal: AbortSignal.timeout(this.apiTimeoutMs)
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Chat API media download failed: ${response.status} ${errorText}`)
    }

    return response.arrayBuffer()
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
    data: Uint8Array
  ): Promise<UploadAttachmentResponse> {
    const token = await this.getUploadUserToken()
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

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/related; boundary=${boundary}`,
        Authorization: `Bearer ${token}`
      },
      // Coerce to BufferSource — tsgo's BodyInit overload set rejects the bare
      // Uint8Array<ArrayBufferLike> shape Bun infers here.
      body: body as BodyInit,
      signal: AbortSignal.timeout(this.apiTimeoutMs)
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Chat API upload failed: ${response.status} ${errorText}`)
    }

    return (await response.json()) as UploadAttachmentResponse
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
    opts: { text?: string; threadName?: string } = {}
  ): Promise<GoogleChatMessage> {
    const token = await this.getUploadUserToken()
    if (!token) {
      throw new Error('attachment uploads are not configured: set GOOGLECHATBOT_UPLOAD_USER')
    }

    const id = spaceName.startsWith('spaces/') ? spaceName.slice('spaces/'.length) : spaceName
    const body: Partial<GoogleChatMessage> = {
      attachment: [attachment],
      ...(opts.text ? { text: opts.text } : {})
    }
    if (opts.threadName) body.thread = { name: opts.threadName }
    const path = opts.threadName
      ? `spaces/${id}/messages?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`
      : `spaces/${id}/messages`

    const response = await fetch(`${CHAT_API_BASE}/${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.apiTimeoutMs)
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Chat API attachment message failed: ${response.status} ${errorText}`)
    }

    return (await response.json()) as GoogleChatMessage
  }
}

/** A `type/subtype` MIME token with no CR/LF, safe to place in a header. Falls
 * back to a generic binary type for anything malformed or injection-shaped. */
function safeMimeType(value: string): string {
  return /^[\w.+-]+\/[\w.+-]+$/.test(value) ? value : 'application/octet-stream'
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
      sub: opts.sub ?? opts.email,
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
  const bytes =
    typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data)
  const base64 = btoa(String.fromCharCode(...bytes))
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function signRS256(signingInput: string, privateKeyPem: string): Promise<ArrayBuffer> {
  const pemHeader = '-----BEGIN PRIVATE KEY-----'
  const pemFooter = '-----END PRIVATE KEY-----'
  let keyData = privateKeyPem
    .replace(pemHeader, '')
    .replace(pemFooter, '')
    .replace(/\s/g, '')

  const keyBytes = Uint8Array.from(atob(keyData), c => c.charCodeAt(0))
  const algorithm: HmacImportParams = { name: 'HMAC', hash: 'SHA-256' }

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
