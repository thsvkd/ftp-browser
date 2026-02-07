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
