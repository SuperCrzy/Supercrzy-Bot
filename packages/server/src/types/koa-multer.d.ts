/**
 * @koa/multer 类型声明（该包无官方类型,且 @types/koa__multer 基于 Koa 2 已过时）
 */
declare module '@koa/multer' {
  interface File {
    fieldname: string
    originalname: string
    encoding: string
    mimetype: string
    size: number
    destination: string
    filename: string
    path: string
    buffer: Buffer
  }

  type FileFilterCallback = (error: Error | null, acceptFile: boolean) => void

  interface DiskStorageOptions {
    destination?: (req: any, file: File, cb: (error: Error | null, destination: string) => void) => void
    filename?: (req: any, file: File, cb: (error: Error | null, filename: string) => void) => void
  }

  interface Options {
    storage?: any
    fileFilter?: (req: any, file: File, cb: FileFilterCallback) => void
    limits?: {
      fileSize?: number
      files?: number
      [key: string]: number | undefined
    }
  }

  const multer: {
    (options?: Options): any
    diskStorage(options: DiskStorageOptions): any
  }

  export = multer
}

/** Express.Multer.File 全局引用（upload.ts 使用） */
declare namespace Express {
  namespace Multer {
    interface File {
      fieldname: string
      originalname: string
      encoding: string
      mimetype: string
      size: number
      destination: string
      filename: string
      path: string
      buffer: Buffer
    }
  }
}
