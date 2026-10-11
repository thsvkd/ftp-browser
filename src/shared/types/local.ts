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

/** 사이드바 "내 PC"의 장소. 없거나 읽을 수 없는 폴더는 null이다. */
export interface LocalPlaces {
  home: string
  desktop: string | null
  downloads: string | null
  documents: string | null
  pictures: string | null
  music: string | null
  videos: string | null
  /** win32: 있는 드라이브 루트('C:\' …). 그 밖: ['/'] */
  roots: string[]
}
