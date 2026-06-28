export interface LocalThumbnailRequest {
  localPath: string
  fileSize: number
  modifiedAt: string
}

export interface LocalThumbnailResult {
  cacheKey: string
  dataUrl: string
  width: number
  height: number
  fromCache: boolean
}

export interface RemoteFolderPreviewRequest {
  remotePath: string
}

export interface RemoteFolderPreview {
  name: string
  size: number
  modifiedAt: string
  /**
   * Number of entries in the folder, excluding the "." and ".." references.
   * A preview only exists for folders that contain a displayable image, so the
   * count badge is shown only for those "thumbnail-capable" folders.
   */
  itemCount: number
}

export interface LocalFolderPreviewRequest {
  localPath: string
}

export interface LocalFolderPreview {
  name: string
  path: string
  size: number
  modifiedAt: string
  /**
   * Number of entries in the folder, excluding the "." and ".." references.
   * A preview only exists for folders that contain a displayable image, so the
   * count badge is shown only for those "thumbnail-capable" folders.
   */
  itemCount: number
}
