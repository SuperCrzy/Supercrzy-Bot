/**
 * qrcode 类型声明（该包无官方类型）
 */
declare module 'qrcode' {
  function toDataURL(text: string, options?: Record<string, unknown>): Promise<string>
  function toBuffer(text: string, options?: Record<string, unknown>): Promise<Buffer>
  namespace QRCode {
    export { toDataURL, toBuffer }
  }
  export = QRCode
}
