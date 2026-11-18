/** Network access gate for APIs that use the optional LAN bearer token. */
const LOCAL_ORIGINS = new Set([
  'http://localhost:5173', 'http://127.0.0.1:5173',
])

export function allowsNetworkApi(input: {
  ip: string
  origin: string
  authorization: string
  apiToken: string
  port?: string
}): boolean {
  const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(input.ip)
  const port = input.port || '3000'
  const serverOrigins = /^\d+$/.test(port)
    ? [`http://localhost:${port}`, `http://127.0.0.1:${port}`]
    : []
  if (loopback && (!input.origin || LOCAL_ORIGINS.has(input.origin) || serverOrigins.includes(input.origin))) return true
  return !!input.apiToken && input.authorization === `Bearer ${input.apiToken}`
}
