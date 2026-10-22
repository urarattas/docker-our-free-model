#!/usr/bin/env node
/**
 * LAN management relay for the standalone service in a container.
 *
 * ## Why this exists
 *
 * The upstream standalone service binds a loopback address and guards its
 * management surface with a host/origin fence (`src/trust.js` →
 * `structuralRejection`): a request must arrive with a loopback `Host`,
 * and any `Origin`/`Referer` must match it. That fence is why upstream
 * issue #216 ("standalone 容器化支持") is still open — there is no
 * `--host` or `OFM_ALLOW_NON_LOOPBACK` switch.
 *
 * This process is the container-side counterpart of that fence: it makes
 * the request *look local* to the service while letting it come from
 * anywhere on the LAN. It rewrites what the service sees —
 *
 *   - `Host` becomes the service's own loopback authority, so the
 *     "host must be loopback" rule passes;
 *   - `Origin`/`Referer` are rewritten to match, so the same-origin rule
 *     passes for the browser that made the request.
 *
 * The service's own fence is untouched: the service still listens only on
 * loopback, and this relay is the only thing inside the container that
 * can reach it.
 *
 * ## How the browser authenticates
 *
 * The compiled frontend addresses the service with **root-absolute**
 * paths (`/api/management/...`, `/assets/...`) — they are constants in
 * the bundle, not derived from the page's location. So a URL path prefix
 * cannot carry the secret: the page would load, and then its own API
 * calls would go out without the prefix.
 *
 * The relay therefore keeps the paths exactly as they are and separates
 * the two credentials:
 *
 *   - **the browser → the relay** is authenticated by a session cookie
 *     the relay issues. The browser obtains it once by opening
 *     `http://<host>:<port>/?key=<secret>`; the relay validates the
 *     secret and sets an HttpOnly cookie. After that the browser just
 *     works, with no key in the URL.
 *   - **the relay → the service** is authenticated with the service's own
 *     `forwardKey`, read from the service's settings file. The service's
 *     session cookie is scoped to the service's port, so the browser
 *     would never send it back; the relay therefore acts for the browser.
 *
 * The secret never reaches the service, and after the first exchange it
 * is not in the URL either.
 *
 * ## The trade-off, stated plainly
 *
 * **Anyone who can reach this port and knows the secret has the
 * management console.** The upstream fence exists to keep the console on
 * the machine that owns the credentials; in a container, that machine is
 * the container, and this relay hands the console to whoever reaches the
 * published port. So publish it on a LAN you trust, never on the
 * internet, and give it a long random secret.
 *
 * Usage:
 *   node docker/management-relay.mjs --port 18902 --target 18900
 *
 * Environment:
 *   OFM_RELAY_KEY     required: the shared secret clients authenticate with
 *   OFM_RELAY_PORT    listen port (default 18902)
 *   OFM_RELAY_TARGET  service port (default 18900)
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

const LOOPBACK = '127.0.0.1'
const SESSION_MS = 8 * 60 * 60 * 1000
const COOKIE_NAME = 'ofm_relay'

function parseArgs(argv) {
  const options = {}
  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === '--port') { options.port = Number(argv[++i]); continue }
    if (flag === '--target') { options.target = Number(argv[++i]); continue }
    if (flag === '--data-dir') { options.dataDir = argv[++i]; continue }
    throw new Error(`未知参数：${flag}`)
  }
  return options
}

const args = parseArgs(process.argv)
const port = args.port ?? Number(process.env.OFM_RELAY_PORT ?? 18902)
const targetPort = args.target ?? Number(process.env.OFM_RELAY_TARGET ?? 18900)
const dataDir = args.dataDir ?? process.env.OFM_HOME ?? '/data'

const relayKey = process.env.OFM_RELAY_KEY ?? ''
if (relayKey === '') {
  process.stderr.write('OFM_RELAY_KEY 未设置：管理转发必须带一把共享密钥，否则局域网里任何人都能打开管理台。\n')
  process.exit(1)
}

/**
 * The service's own API key, read from its settings file.
 *
 * The relay needs it because the management API requires a bearer, and the
 * service's session cookie is scoped to the service's own port — a cookie
 * the browser will not send to the relay's port. So the relay
 * authenticates to the service on the browser's behalf.
 */
function readServiceKey() {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'))
    return typeof parsed.forwardKey === 'string' ? parsed.forwardKey : ''
  } catch {
    return ''
  }
}

let serviceKey = readServiceKey()
if (serviceKey === '') {
  process.stderr.write(`等待 ${dataDir}/settings.json 出现（独立服务正在生成 API Key）…\n`)
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 1000))
    serviceKey = readServiceKey()
    if (serviceKey !== '') break
  }
}
if (serviceKey === '') {
  process.stderr.write(`无法从 ${dataDir}/settings.json 读到独立服务的 API Key，管理转发无法鉴权。\n`)
  process.exit(1)
}

/** Constant-time comparison, so the secret cannot be recovered by timing. */
function secretMatches(presented) {
  if (typeof presented !== 'string' || presented === '') return false
  const a = Buffer.from(presented)
  const b = Buffer.from(relayKey)
  return a.byteLength === b.byteLength && crypto.timingSafeEqual(a, b)
}

/** The relay's own sessions, handed out after a successful key exchange. */
const sessions = new Map()

function readCookie(req, name) {
  return String(req.headers.cookie ?? '')
    .split(';')
    .map(part => part.trim())
    .find(part => part.startsWith(`${name}=`))
    ?.slice(name.length + 1)
}

function isAuthenticated(req, url) {
  const session = readCookie(req, COOKIE_NAME)
  if (session && sessions.has(session) && sessions.get(session) > Date.now()) return true
  // A header works for scripted clients; the query parameter is how a
  // browser performs the initial exchange.
  const header = req.headers['x-ofm-relay-key']
  if (typeof header === 'string' && secretMatches(header)) return true
  return secretMatches(url.searchParams.get('key') ?? '')
}

/** Hand out a session cookie after a successful key exchange. */
function grantSession(res) {
  const id = crypto.randomBytes(32).toString('base64url')
  sessions.set(id, Date.now() + SESSION_MS)
  res.setHeader('set-cookie', `${COOKIE_NAME}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}`)
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

  if (!isAuthenticated(req, url)) {
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: '管理转发需要密钥：先用 ?key=<密钥> 打开一次以换取会话' }))
    return
  }

  // The key was presented in the query string: exchange it for a cookie
  // and drop it from the URL, so it does not linger in history or logs.
  if (url.searchParams.has('key')) {
    grantSession(res)
    url.searchParams.delete('key')
  }

  // Rebuild the request so the service sees it as a local one.
  const headers = { ...req.headers }
  headers.host = `${LOOPBACK}:${targetPort}`
  delete headers['sec-fetch-site']
  delete headers['x-ofm-relay-key']
  if (headers.origin) headers.origin = `http://${LOOPBACK}:${targetPort}`
  if (headers.referer) headers.referer = `http://${LOOPBACK}:${targetPort}/`

  // The service's own bearer goes on the management API calls. The page
  // assets are public to the service.
  const isApi = url.pathname === '/api/management' || url.pathname.startsWith('/api/management/')
  if (isApi) headers.authorization = `Bearer ${serviceKey}`

  const upstream = http.request({
    host: LOOPBACK,
    port: targetPort,
    method: req.method,
    path: `${url.pathname}${url.search}`,
    headers,
  }, upstreamRes => {
    const out = { ...upstreamRes.headers }
    // The service sets a session cookie scoped to its own port and to
    // /api/management. The browser talks to the relay's port, so it would
    // never be sent back. The relay manages the browser's session
    // itself, so the service's cookie is dropped rather than forwarded
    // with a path that would never match.
    delete out['set-cookie']
    res.writeHead(upstreamRes.statusCode ?? 502, out)
    upstreamRes.pipe(res)
  })

  upstream.on('error', error => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
    }
    res.end(JSON.stringify({ error: `独立服务不可达：${error.message}` }))
  })

  req.pipe(upstream)
})

server.listen(port, '0.0.0.0', () => {
  process.stdout.write(`管理转发监听 0.0.0.0:${port} → 127.0.0.1:${targetPort}\n`)
  process.stdout.write(`首次访问：http://<本机地址>:${port}/?key=<OFM_RELAY_KEY>\n`)
})
