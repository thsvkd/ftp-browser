import fs from 'fs/promises'
import { createReadStream, createWriteStream } from 'fs'
import path from 'path'
import { app } from 'electron'
import { isImageFile } from '@shared/constants'
import type { LocalFileEntry, LocalListResult } from '@shared/types/local'

export class LocalFileSystem {
  async list(dirPath: string): Promise<LocalListResult> {
    const dirents = await fs.readdir(dirPath, { withFileTypes: true })
    const entries: LocalFileEntry[] = []

    for (const dirent of dirents) {
      // Hidden (dotfile) entries are returned too; the renderer decides whether
      // to show them based on the "show hidden files" setting.
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

  /**
   * Recursively collect every file under `root`, with paths relative to `root`
   * and their sizes. Used to build a flat work list for copy progress.
   */
  async collectFiles(root: string): Promise<Array<{ abs: string; rel: string; size: number }>> {
    const out: Array<{ abs: string; rel: string; size: number }> = []

    const walk = async (dir: string, rel: string): Promise<void> => {
      const dirents = await fs.readdir(dir, { withFileTypes: true })
      for (const dirent of dirents) {
        const abs = path.join(dir, dirent.name)
        const childRel = rel ? path.join(rel, dirent.name) : dirent.name
        if (dirent.isDirectory()) {
          await walk(abs, childRel)
        } else if (dirent.isFile()) {
          const stat = await fs.stat(abs)
          out.push({ abs, rel: childRel, size: stat.size })
        }
      }
    }

    await walk(root, '')
    return out
  }

  async delete(targetPath: string, isDirectory: boolean): Promise<void> {
    if (isDirectory) {
      await fs.rm(targetPath, { recursive: true, force: false })
    } else {
      await fs.unlink(targetPath)
    }
  }

  /**
   * Stream-copy a single file, reporting each read chunk's length so callers can
   * accumulate byte progress. Polls `shouldCancel` between chunks; on cancel it
   * removes the partial destination and throws an error tagged `cancelled`.
   */
  async copyFileWithProgress(
    src: string,
    dest: string,
    onBytes: (chunkLength: number) => void,
    shouldCancel: () => boolean
  ): Promise<void> {
    const readStream = createReadStream(src)
    const writeStream = createWriteStream(dest)
    try {
      await new Promise<void>((resolve, reject) => {
        const fail = (err: Error): void => {
          readStream.destroy()
          writeStream.destroy()
          reject(err)
        }

        readStream.on('data', (chunk) => {
          if (shouldCancel()) {
            fail(new Error('cancelled'))
            return
          }
          onBytes(chunk.length)
        })
        readStream.on('error', fail)
        writeStream.on('error', fail)
        writeStream.on('finish', () => resolve())

        readStream.pipe(writeStream)
      })
    } catch (err) {
      // Wait for the write handle to fully close before removing the partial
      // file — on Windows `fs.rm` fails while the descriptor is still open.
      if (!writeStream.closed) {
        await new Promise<void>((resolve) => writeStream.once('close', () => resolve()))
      }
      await fs.rm(dest, { force: true }).catch(() => undefined)
      throw err
    }
  }
}
