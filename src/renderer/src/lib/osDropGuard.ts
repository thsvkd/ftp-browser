import { useDnd } from '@renderer/components/explorer/dnd'

/**
 * document 레벨 드래그 기본 동작 방지(창이 놓은 파일로 이동하지 않게) + 대상 없는 곳의
 * Files 드래그는 금지 커서. 놓기 대상은 dragover에서 stopPropagation하므로 여기까지 오지
 * 않는다. 해제 함수를 돌려준다.
 */
export function installDropGuard(doc: Document): () => void {
  const onDragOver = (e: DragEvent): void => {
    e.preventDefault()
    if (
      e.dataTransfer &&
      useDnd.getState().items === null &&
      Array.from(e.dataTransfer.types).includes('Files')
    ) {
      e.dataTransfer.dropEffect = 'none'
    }
  }
  const onDrop = (e: DragEvent): void => e.preventDefault()
  doc.addEventListener('dragover', onDragOver)
  doc.addEventListener('drop', onDrop)
  return () => {
    doc.removeEventListener('dragover', onDragOver)
    doc.removeEventListener('drop', onDrop)
  }
}
