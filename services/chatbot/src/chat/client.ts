import type { AppConfig } from '../config'
import type { GoogleChatMessage } from './types'

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

    const scope = 'https://www.googleapis.com/auth/chat.bot'
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
   */
  async createMessage(spaceName: string, message: Partial<GoogleChatMessage>): Promise<GoogleChatMessage> {
    return this.request('POST', `spaces/${spaceName}/messages`, message)
  }

  /**
   * Update a message.
   * Path: PATCH /v1/{message.name}
   */
  async updateMessage(messageName: string, update: Partial<GoogleChatMessage>): Promise<GoogleChatMessage> {
    return this.request('PATCH', messageName, update)
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
   */
  async listMessages(
    spaceName: string,
    opts: { pageSize?: number; pageToken?: string } = {}
  ): Promise<{ messages?: GoogleChatMessage[]; nextPageToken?: string }> {
    const params = new URLSearchParams()
    if (opts.pageSize) params.set('pageSize', String(opts.pageSize))
    if (opts.pageToken) params.set('pageToken', opts.pageToken)
    const query = params.toString()
    return this.request('GET', `spaces/${spaceName}/messages${query ? `?${query}` : ''}`)
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
