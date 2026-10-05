import { randomUUID } from 'crypto'

const BATCH_PREFIX = 'batch-'
/** 오래된 묶음부터 잊는다. 그 id로 기다리면 알 수 없는 id(끝난 것)로 취급된다. */
const MAX_BATCHES = 200

/**
 * 여러 파일 전송을 에이전트에게 id 하나로 돌려준다. 폴더 하나가 수천 개의 전송이 되므로
 * 전송 id를 모두 돌려주면 결과와 다음 `wait_for_jobs` 인자가 모두 수백 KB가 된다.
 * 요청마다 새 McpServer를 만들므로 이 객체는 앱 수명 동안 하나를 공유한다.
 */
export class JobHandles {
  private batches = new Map<string, string[]>()

  /** 전송이 하나면 그 id, 여럿이면 묶음 id, 없으면 undefined */
  handle(ids: string[]): string | undefined {
    if (ids.length <= 1) return ids[0]
    const id = `${BATCH_PREFIX}${randomUUID()}`
    this.batches.set(id, [...ids])
    if (this.batches.size > MAX_BATCHES) {
      this.batches.delete(this.batches.keys().next().value!)
    }
    return id
  }

  /** 묶음 id의 전송 id들. 묶음이 아니면 undefined */
  members(id: string): string[] | undefined {
    return this.batches.get(id)
  }

  /** 묶음을 펼친 전체 id(중복 없음, 처음 나온 순서) */
  expand(ids: string[]): string[] {
    return [...new Set(ids.flatMap((id) => this.batches.get(id) ?? [id]))]
  }
}
