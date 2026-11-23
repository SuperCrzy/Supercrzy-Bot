/** Network access gate for APIs that use the optional LAN bearer token. */
const LOCAL_ORIGINS = new Set([
  'http://localhost:5173', 'http://127.0.0.1:5173',
])

export function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** A Host header alone never proves that the connection is local. */
export function allowsDevNoAuth(input: {
  enabled: string | undefined
  packaged: string | undefined
  remoteAddress: string | undefined
  requestIp: string | undefined
  hostname: string
}): boolean {
  return input.enabled === '1' && input.packaged !== '1'
    && isLoopbackAddress(input.remoteAddress) && isLoopbackAddress(input.requestIp)
    && ['127.0.0.1', 'localhost', '::1'].includes(input.hostname)
}

export function allowsNetworkApi(input: {
  ip: string
  origin: string
  authorization: string
  apiToken: string
  port?: string
}): boolean {
  const loopback = isLoopbackAddress(input.ip)
  const port = input.port || '3000'
  const serverOrigins = /^\d+$/.test(port)
    ? [`http://localhost:${port}`, `http://127.0.0.1:${port}`]
    : []
  if (loopback && (!input.origin || LOCAL_ORIGINS.has(input.origin) || serverOrigins.includes(input.origin))) return true
  return !!input.apiToken && input.authorization === `Bearer ${input.apiToken}`
}
