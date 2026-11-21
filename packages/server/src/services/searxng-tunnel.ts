/**
 * Optional SSH tunnel that keeps a SearXNG instance reachable when the direct
 * cross-border link is unusable.
 *
 * Measured 2026-11-20 from a mainland host: the overseas SearXNG answered in
 * >28s and dropped roughly half of its packets, while the same query over a
 * relay host took ~1s. A relay is the difference between an empty web_search
 * and a working one, so the server keeps the tunnel alive itself instead of
 * making every user start one by hand.
 *
 * Configured through the `searxngTunnel` setting:
 *
 *   <localHost>:<localPort>:<remoteHost>:<remotePort>[|<sshTarget>]
 *   e.g. 127.0.0.1:18080:107.174.107.199:8080|root@relay.example.com
 *
 * With no setting (or an empty value) this does nothing at all, so a plain
 * install keeps its current behaviour.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import { getDB } from './database'

const CHECK_INTERVAL_MS = 60_000
const PORT_PROBE_TIMEOUT_MS = 1500

let child: ChildProcess | null = null
let timer: ReturnType<typeof setInterval> | null = null
let currentSpec = ''

function readTunnelSpec(): string {
    try {
        const row = getDB()
            .prepare('SELECT value FROM settings WHERE key = ?')
            .get('searxngTunnel') as any
        return row?.value ? String(row.value).trim() : ''
    } catch {
        return ''
    }
}

/** True when something is already listening on the local end. */
function portOpen(host: string, port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = net.connect({ host, port })
        const done = (ok: boolean) => {
            socket.removeAllListeners()
            socket.destroy()
            resolve(ok)
        }
        socket.setTimeout(PORT_PROBE_TIMEOUT_MS)
        socket.once('connect', () => done(true))
        socket.once('error', () => done(false))
        socket.once('timeout', () => done(false))
    })
}

function spawnTunnel(localHost: string, localPort: string, remoteHost: string, remotePort: string, target: string): void {
    if (child && child.exitCode === null) return
    // Plain `ssh -L local:remoteHost:remotePort target`: the target is the relay
    // and does the onward connection, which is exactly the topology we want.
    const args = [
        '-N',
        '-o', 'BatchMode=yes',
        '-o', 'ExitOnForwardFailure=yes',
        // ssh notices a dead link on its own and exits; the interval makes that
        // detection take ~90s instead of hanging until the socket times out.
        '-o', 'ServerAliveInterval=30',
        '-o', 'ServerAliveCountMax=3',
        '-o', 'TCPKeepAlive=yes',
        '-L', `${localHost}:${localPort}:${remoteHost}:${remotePort}`,
        target,
    ]
    try {
        child = spawn('ssh', args, { stdio: 'ignore', detached: false })
        child.on('exit', (code) => {
            console.warn('[searxng-tunnel] ssh exited with code', code, '- will retry on the next check')
            child = null
        })
        child.on('error', (err) => {
            console.warn('[searxng-tunnel] failed to start ssh:', err.message)
            child = null
        })
    } catch (err) {
        console.warn('[searxng-tunnel] spawn failed:', err instanceof Error ? err.message : err)
    }
}

async function tick(): Promise<void> {
    const spec = readTunnelSpec()
    if (spec !== currentSpec) {
        // The setting changed: drop whatever is running so the new one applies.
        if (child) { try { child.kill() } catch { /* already gone */ } child = null }
        currentSpec = spec
    }
    if (!spec) return

    const [forward, target = ''] = spec.split('|')
    const parts = forward.split(':')
    if (parts.length !== 4) {
        console.warn('[searxng-tunnel] malformed searxngTunnel, expected host:port:host:port|target:', spec)
        return
    }
    if (!target.trim()) {
        console.warn('[searxng-tunnel] searxngTunnel is missing the ssh target after "|":', spec)
        return
    }
    const [localHost, localPort, remoteHost, remotePort] = parts
    // The target goes straight into an ssh argv. Without a shape check, a value
    // like "-oProxyCommand=..." would be read as an option and could run an
    // arbitrary local command, so only user@host / user@host:port is accepted.
    const cleanTarget = target.trim()
    if (!/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+(:[0-9]{1,5})?$/.test(cleanTarget)) {
        console.warn('[searxng-tunnel] searxngTunnel target must look like user@host[:port]:', cleanTarget)
        return
    }
    const portOk = [localPort, remotePort].every(p => /^[0-9]{1,5}$/.test(p) && Number(p) > 0 && Number(p) < 65536)
    if (!portOk) {
        console.warn('[searxng-tunnel] searxngTunnel ports must be 1-65535:', forward)
        return
    }
    if (await portOpen(localHost, Number(localPort))) return
    spawnTunnel(localHost, localPort, remoteHost, remotePort, cleanTarget)
}

/** Starts the keep-alive loop. Safe to call once from server boot. */
export function startSearxngTunnel(): void {
    if (timer) return
    void tick()
    timer = setInterval(() => { void tick() }, CHECK_INTERVAL_MS)
    // Never hold the process open just for this timer.
    timer.unref?.()
}

/** Stops the loop and kills the tunnel. */
export function stopSearxngTunnel(): void {
    if (timer) { clearInterval(timer); timer = null }
    if (child) { try { child.kill() } catch { /* already gone */ } child = null }
    currentSpec = ''
}
