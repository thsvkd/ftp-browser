export interface LocalFileEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  size: number
  modifiedAt: string
  isImage: boolean
}

export interface LocalListResult {
  path: string
  entries: LocalFileEntry[]
}

/** A single file to upload, produced by expanding dropped files/folders. */
export interface UploadFileEntry {
  localPath: string
  /** POSIX-style path relative to the drop target, preserving folder structure. */
  relativePath: string
  size: number
}
