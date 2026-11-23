import { lookup, Resolver as DnsResolver } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP } from 'node:net'
import { promisify } from 'node:util'
import { brotliDecompress, gunzip, inflate } from 'node:zlib'

const deniedV4 = new BlockList()
for (const [address, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as Array<[string, number]>) deniedV4.addSubnet(address, bits, 'ipv4')
const globalV6 = new BlockList()
globalV6.addSubnet('2000::', 3, 'ipv6')
const deniedV6 = new BlockList()
deniedV6.addSubnet('2001::', 23, 'ipv6')
deniedV6.addSubnet('2001:db8::', 32, 'ipv6')

export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return !deniedV4.check(address, 'ipv4')
  if (family === 6) return globalV6.check(address, 'ipv6') && !deniedV6.check(address, 'ipv6')
  return false
}

type Address = { address: string; family: number }
type Resolver = (host: string) => Promise<Address[]>

const fakeV4 = new BlockList()
fakeV4.addSubnet('198.18.0.0', 15, 'ipv4')

/** A fake-IP DNS answer cannot be used as proof of a public destination. */
async function resolveIndependentPublicDns(host: string): Promise<Address[]> {
  const resolver = new DnsResolver({ timeout: 2000, tries: 1 })
  resolver.setServers(['1.1.1.1', '8.8.8.8'])
  const results = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)])
  const addresses: Address[] = []
  for (const [index, result] of results.entries()) {
    if (result.status === 'fulfilled') {
      addresses.push(...result.value.map(address => ({ address, family: index === 0 ? 4 : 6 })))
    } else if (!['ENODATA', 'ENOTFOUND'].includes((result.reason as NodeJS.ErrnoException)?.code || '')) {
      throw new Error('independent_dns_failed')
    }
  }
  return addresses
}

/** Resolve every candidate before connecting; one private candidate fails closed. */
export async function resolvePublicTarget(rawUrl: string, resolver: Resolver = (host) => lookup(host, { all: true, verbatim: true }), independentResolver: Resolver = resolveIndependentPublicDns): Promise<{ url: URL; address: Address }> {
  let url: URL
  try { url = new URL(rawUrl) } catch { throw new Error('invalid_url') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid_url')
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '')
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) throw new Error('private_target')
  const ip = isIP(host)
  let addresses = ip ? [{ address: host, family: ip }] : await resolver(host)
  // Do not trust or connect to the synthetic address. Resolve the domain again
  // through an independent resolver, then apply the same public-IP checks.
  const isFake = (entry: Address) => entry.family === 4 && isIP(entry.address) === 4 && fakeV4.check(entry.address, 'ipv4')
  if (!ip && addresses.some(isFake) && addresses.every(entry => entry.family === isIP(entry.address) && (isFake(entry) || isPublicAddress(entry.address)))) {
    try { addresses = await independentResolver(host) } catch { throw new Error('fake_ip_dns_unavailable') }
  }
  if (!addresses.length || addresses.some((entry) => !isPublicAddress(entry.address) || entry.family !== isIP(entry.address))) throw new Error('private_target')
  return { url, address: addresses[0] }
}

type WebResponse = { status: number; location?: string; contentType: string; text: string }
type Transport = (url: URL, address: Address, signal: AbortSignal) => Promise<WebResponse>
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024
const decompressors = { gzip: promisify(gunzip), deflate: promisify(inflate), br: promisify(brotliDecompress) }

async function decodeContentEncoding(bytes: Buffer, contentEncoding: string, contentType: string): Promise<Buffer> {
  const encodings = contentEncoding.split(',').map(value => value.trim().toLowerCase()).filter(value => value && value !== 'identity')
  if (encodings.length > 3) throw new Error('unsupported_content_encoding')
  // Some servers omit Content-Encoding even though a textual response is gzip.
  if (!encodings.length && !contentEncoding && /^(text\/|application\/json\b)/i.test(contentType) && bytes[0] === 0x1f && bytes[1] === 0x8b) encodings.push('gzip')
  for (const encoding of encodings.reverse()) {
    const decompress = decompressors[encoding as keyof typeof decompressors]
    if (!decompress) throw new Error('unsupported_content_encoding')
    try { bytes = await decompress(bytes, { maxOutputLength: MAX_RESPONSE_BYTES }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') throw new Error('response_too_large')
      throw new Error('invalid_compressed_response')
    }
  }
  return bytes
}

function decodeResponse(bytes: Buffer, contentType: string): string {
  const headerCharset = /charset\s*=\s*["']?\s*([^\s;"']+)/i.exec(contentType)?.[1]
  const prefix = contentType.toLowerCase().includes('text/html') ? bytes.subarray(0, 4096).toString('latin1') : ''
  const metaCharset = /<meta\b[^>]*\bcharset\s*=\s*["']?\s*([^\s;"'/>]+)/i.exec(prefix)?.[1]
  const bomCharset = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 'utf-8'
    : bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
      : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : undefined
  try { return new TextDecoder(bomCharset || headerCharset || metaCharset || 'utf-8').decode(bytes) }
  catch { return new TextDecoder('utf-8').decode(bytes) }
}

const sendPinned: Transport = async (url, address, signal) => {
    return new Promise<WebResponse>((resolve, reject) => {
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
        method: 'GET', signal, family: address.family,
        // node:https sends HTTP/1.1; explicitly negotiate it for endpoints
        // that reject TLS connections without an ALPN protocol.
        ...(url.protocol === 'https:' ? { ALPNProtocols: ['http/1.1'] } : {}),
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SUPERCRZY-BOT/1.0)' },
        lookup: (_host, _options, callback) => callback(null, address.address, address.family),
      }, (res) => {
        const status = res.statusCode || 0
        if (status >= 300 && status < 400) {
          res.resume()
          resolve({ status, location: res.headers.location, contentType: '', text: '' })
          return
        }
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > MAX_RESPONSE_BYTES) { res.destroy(new Error('response_too_large')); return }
          chunks.push(chunk)
        })
        res.on('error', reject)
        res.on('end', async () => {
          try {
            signal.throwIfAborted()
            const contentType = res.headers['content-type'] || ''
            const bytes = await decodeContentEncoding(Buffer.concat(chunks), res.headers['content-encoding'] || '', contentType)
            signal.throwIfAborted()
            resolve({ status, contentType, text: decodeResponse(bytes, contentType) })
          } catch (error) { reject(error) }
        })
      })
      request.on('error', reject)
      request.end()
    })
}

/** GET with a DNS-pinned socket, independently validating every redirect. */
export async function fetchPublicWeb(rawUrl: string, signal: AbortSignal, resolver?: Resolver, transport: Transport = sendPinned, independentResolver?: Resolver): Promise<{ status: number; contentType: string; text: string }> {
  let next = rawUrl
  for (let hop = 0; hop <= 5; hop++) {
    const { url, address } = await resolvePublicTarget(next, resolver, independentResolver)
    const response = await transport(url, address, signal)
    if (response.status < 300 || response.status >= 400) return response
    if (!response.location || hop === 5) throw new Error('invalid_redirect')
    next = new URL(response.location, url).toString()
  }
  throw new Error('invalid_redirect')
}
