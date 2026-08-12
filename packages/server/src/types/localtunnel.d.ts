/**
 * localtunnel 类型声明（该包无官方类型）
 */
declare module 'localtunnel' {
  interface Tunnel {
    url: string
    on(event: string, cb: (...args: any[]) => void): void
    close(): void
  }

  interface TunnelOptions {
    port?: number
    host?: string
    subdomain?: string
    local_host?: string
    [key: string]: unknown
  }

  function localtunnel(opts: TunnelOptions & { port: number }): Promise<Tunnel>
  function localtunnel(port: number, opts?: TunnelOptions): Promise<Tunnel>

  export = localtunnel
}
