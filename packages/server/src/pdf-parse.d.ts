/**
 * pdf-parse@2 为纯 JS 包（无 TS 类型）——补充 ambient 声明，修复 server tsc 报错。
 * 用法（wechat-bot-runner.ts）：const { PDFParse } = await import('pdf-parse')
 */
declare module 'pdf-parse' {
  export interface PDFParseOptions {
    data?: Buffer | ArrayBuffer | Uint8Array
    [key: string]: unknown
  }
  export class PDFParse {
    constructor(options?: PDFParseOptions)
    getText(): Promise<{ text: string }>
  }
  export default PDFParse
}
