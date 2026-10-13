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
  /** 그리드를 그리는 패널의 id(1~64자). 취소는 이 뷰어의 소유만 뺀다(multi-connection §4.3) */
  viewerId: string
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
