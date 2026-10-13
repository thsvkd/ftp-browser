// 분할 보기의 패널 id(split-view P2). 썸네일·폴더 미리보기 IPC의 viewerId가 이 값이다.
import { createContext, useContext } from 'react'
import type { PaneId } from '@renderer/stores/useTabsStore'
import { MAIN_VIEWER } from '@shared/connKey'

/** `TabExplorer`가 자기 패널 id를 내려 준다. 패널 밖(정보 패널 등)은 단일 보기 값 `MAIN_VIEWER`다. */
export const PaneIdContext = createContext<PaneId>(MAIN_VIEWER)

export const usePaneId = (): PaneId => useContext(PaneIdContext)
