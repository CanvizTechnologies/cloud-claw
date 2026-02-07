const CDP_HOST = 'http://cloudflare.browser'
const MAX_CHUNK = 1048575
const HEADER = 4

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

function encode(data: string): Uint8Array[] {
  const bytes = textEncoder.encode(data)
  const first = new Uint8Array(Math.min(MAX_CHUNK, HEADER + bytes.length))
  new DataView(first.buffer).setUint32(0, bytes.length, true)
  first.set(bytes.subarray(0, MAX_CHUNK - HEADER), HEADER)

  const chunks: Uint8Array[] = [first]
  for (let i = MAX_CHUNK - HEADER; i < bytes.length; i += MAX_CHUNK)
    chunks.push(bytes.subarray(i, i + MAX_CHUNK))
  return chunks
}

function createDecoder() {
  const pending: Uint8Array[] = []

  return (chunk: Uint8Array): string | null => {
    pending.push(chunk)
    const first = pending[0]
    if (!first) return null

    const expected = new DataView(first.buffer, first.byteOffset).getUint32(0, true)
    let total = -HEADER

    for (let i = 0; i < pending.length; i++) {
      total += pending[i].length
      if (total === expected) {
        const parts = pending.splice(0, i + 1)
        parts[0] = first.subarray(HEADER)

        const combined = new Uint8Array(expected)
        let offset = 0
        for (const part of parts) {
          combined.set(part, offset)
          offset += part.length
        }
        return textDecoder.decode(combined)
      }
    }
    return null
  }
}

function send(ws: WebSocket, data: string | Uint8Array) {
  if (ws.readyState !== WebSocket.OPEN) return
  try {
    ws.send(data)
  } catch {}
}

export async function proxyCdp(
  browser: Fetcher,
  request: Request,
  proxyOrigin: string,
  token: string,
): Promise<Response> {
  const { pathname } = new URL(request.url)
  const path = pathname.replace(/^\/cloudflare\.browser\/[^/]+/, '') || '/'

  if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
    const [client, server] = Object.values(new WebSocketPair())
    server.accept()

    const decode = createDecoder()
    const pending: string[] = []
    let upstream: WebSocket | null = null

    const connect = async () => {
      const acquireRes = await browser.fetch(`${CDP_HOST}/v1/acquire`)
      if (!acquireRes.ok) {
        server.close(1011, 'Acquire failed')
        return
      }
      const { sessionId } = await acquireRes.json<{ sessionId: string }>()
      const browserRes = await browser.fetch(
        `${CDP_HOST}/v1/connectDevtools?browser_session=${sessionId}`,
        { headers: { Upgrade: 'websocket' } },
      )
      upstream = browserRes.webSocket
      if (!upstream) {
        server.close(1011, 'Browser unavailable')
        return
      }

      upstream.accept()

      for (const msg of pending) {
        for (const chunk of encode(msg)) send(upstream, chunk)
      }
      pending.length = 0

      upstream.addEventListener('message', (e) => {
        try {
          if (typeof e.data === 'string') return
          const msg = decode(new Uint8Array(e.data as ArrayBuffer))
          if (msg) send(server, msg)
        } catch {}
      })

      upstream.addEventListener('close', () => server.close())
      upstream.addEventListener('error', () => server.close())
    }

    connect().catch(() => server.close(1011, 'Upstream error'))

    server.addEventListener('message', (e) => {
      try {
        const data =
          typeof e.data === 'string'
            ? e.data
            : textDecoder.decode(new Uint8Array(e.data as ArrayBuffer))
        if (!upstream) {
          pending.push(data)
          return
        }
        for (const chunk of encode(data)) send(upstream, chunk)
      } catch {}
    })

    server.addEventListener('close', () => upstream?.close())
    server.addEventListener('error', () => upstream?.close())

    return new Response(null, { status: 101, webSocket: client })
  }

  if (path.startsWith('/json/version')) {
    return Response.json({
      Browser: 'Chrome/Headless',
      'Protocol-Version': '1.3',
      webSocketDebuggerUrl: proxyOrigin.replace(/^http/, 'ws') + `/cloudflare.browser/${token}`,
    })
  }

  const res = await browser.fetch(`${CDP_HOST}${path}`)
  return new Response(res.body, res)
}
