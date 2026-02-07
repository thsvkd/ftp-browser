import fs from 'fs/promises'
import path from 'path'
import { app } from 'electron'
import { isImageFile } from '@shared/constants'
import type { LocalFileEntry, LocalListResult } from '@shared/types/local'

export class LocalFileSystem {
  async list(dirPath: string): Promise<LocalListResult> {
    const dirents = await fs.readdir(dirPath, { withFileTypes: true })
    const entries: LocalFileEntry[] = []

    for (const dirent of dirents) {
      // Skip hidden files on unix
      if (dirent.name.startsWith('.')) continue

      try {
        const fullPath = path.join(dirPath, dirent.name)
        const stat = await fs.stat(fullPath)

        entries.push({
          name: dirent.name,
          path: fullPath,
          type: dirent.isDirectory() ? 'directory' : 'file',
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          isImage: !dirent.isDirectory() && isImageFile(dirent.name)
        })
      } catch {
        // Skip files we can't stat (permission denied, etc.)
      }
    }

    return { path: dirPath, entries }
  }

  getHomePath(): string {
    return app.getPath('home')
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath)
      return true
    } catch {
      return false
    }
  }
}
