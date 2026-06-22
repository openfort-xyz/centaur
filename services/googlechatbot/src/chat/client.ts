import type { AppConfig } from '../config'
import type { ChatListMessage, GoogleChatMessage } from './types'

const CHAT_API_BASE = 'https://chat.googleapis.com/v1'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'

export class ChatEdgeClient {
  private accessToken: string | null = null
  private tokenExpiry = 0
  private readonly serviceAccountEmail: string | null
  private readonly privateKey: string | null

  constructor(config: AppConfig) {
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
    const now = Math.floor(Date.now() / 1000)
    const expiry = now + 3600

    const jwt = await createJWT({
      email: this.serviceAccountEmail,
      key: this.privateKey,
      scope,
      iat: now,
      exp: expiry
    })

    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt
      })
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Google OAuth2 token exchange failed: ${response.status} ${errorText}`)
    }

    const data = (await response.json()) as {
      access_token?: string
      expires_in?: number
    }
    this.accessToken = data.access_token ?? null
    this.tokenExpiry = Date.now() + ((data.expires_in ?? 3600) - 120) * 1000
    return this.accessToken
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    baseUrl = CHAT_API_BASE
  ): Promise<T> {
    const url = `${baseUrl}/${path.replace(/^\//, '')}`
    const token = await this.getAccessToken()
    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000)
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
   */
  async listMessages(
    spaceName: string,
    opts: {
      pageSize?: number
      pageToken?: string
      filter?: string
      orderBy?: string
    } = {}
  ): Promise<{ messages?: ChatListMessage[]; nextPageToken?: string }> {
    const id = spaceName.startsWith('spaces/') ? spaceName.slice('spaces/'.length) : spaceName
    const params = new URLSearchParams()
    if (opts.pageSize) params.set('pageSize', String(opts.pageSize))
    if (opts.pageToken) params.set('pageToken', opts.pageToken)
    if (opts.filter) params.set('filter', opts.filter)
    if (opts.orderBy) params.set('orderBy', opts.orderBy)
    const query = params.toString()
    return this.request('GET', `spaces/${id}/messages${query ? `?${query}` : ''}`)
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
   * Upload a file attachment to a space.
   * Path: POST /upload/v1/spaces/{space}/attachments:upload
   */
  async uploadAttachment(
    spaceName: string,
    fileName: string,
    contentType: string,
    data: Uint8Array
  ): Promise<{ attachmentDataRef?: { resourceName?: string } }> {
    const token = await this.getAccessToken()
    const url = `${CHAT_API_BASE}/upload/v1/spaces/${spaceName}/attachments:upload?uploadType=media`

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${fileName}"`,
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      // Coerce to BufferSource — tsgo's BodyInit overload set rejects the bare
      // Uint8Array<ArrayBufferLike> shape Bun infers here.
      body: data as BodyInit,
      signal: AbortSignal.timeout(30_000)
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Chat API upload failed: ${response.status} ${errorText}`)
    }

    return (await response.json()) as { attachmentDataRef?: { resourceName?: string } }
  }
}

async function createJWT(opts: {
  email: string
  key: string
  scope: string
  iat: number
  exp: number
}): Promise<string> {
  const header = base64urlEncode(
    JSON.stringify({ alg: 'RS256', typ: 'JWT' })
  )
  const payload = base64urlEncode(
    JSON.stringify({
      iss: opts.email,
      sub: opts.email,
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
