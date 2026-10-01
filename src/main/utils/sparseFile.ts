import type { FileHandle } from 'fs/promises'

/** winioctl.h의 FSCTL_SET_SPARSE. 입력 버퍼가 없으면 희소 플래그를 켠다. */
const FSCTL_SET_SPARSE = 0x000900c4

type SetSparse = (fd: number) => boolean

/** 첫 Windows 호출에서 한 번 만든다. 실패한 로드도 그대로 두어 다시 시도하지 않는다. */
let setSparse: Promise<SetSparse> | null = null
let warned = false

/**
 * fd의 OS HANDLE에 FSCTL_SET_SPARSE를 거는 함수를 koffi로 만든다. macOS·Linux가 네이티브 모듈을 읽지 않도록
 * Windows에서만 불러온다.
 *
 * fd → HANDLE은 ucrtbase.dll의 _get_osfhandle이 아니라 실행 파일의 libuv(uv_get_osfhandle)로 얻는다.
 * node.exe·Electron은 CRT를 정적 링크해 fd 표가 ucrtbase와 따로라, ucrtbase에 넘기면 잘못된 인자로 보고
 * 프로세스가 즉시 죽는다(0xC0000409). uv_get_osfhandle은 없는 fd면 -1을 돌려준다.
 */
async function loadSetSparse(): Promise<SetSparse> {
  const koffi = await import('koffi')
  const getOsfHandle = koffi.load(process.execPath).func('intptr_t uv_get_osfhandle(int fd)')
  const deviceIoControl = koffi
    .load('kernel32.dll')
    .func(
      'bool __stdcall DeviceIoControl(intptr_t handle, uint32_t code, void *inBuf, uint32_t inSize, void *outBuf, uint32_t outSize, _Out_ uint32_t *returned, void *overlapped)'
    )
  return (fd) => {
    const handle = getOsfHandle(fd)
    if (handle === -1) return false
    return deviceIoControl(handle, FSCTL_SET_SPARSE, null, 0, null, 0, [0], null)
  }
}

/**
 * Windows에서 파일을 희소 파일로 표시한다. NTFS는 ftruncate로 늘린 파일의 유효 데이터 길이를 0에 두므로,
 * 끝쪽 오프셋에 처음 쓸 때 그 앞을 모두 0으로 채우고 그동안 같은 파일의 다른 쓰기도 막는다. 희소 파일은 그 빈
 * 곳을 0으로 채우지 않는다. 쓰기 전, 크기를 늘리기 전에 불러야 한다.
 *
 * 다른 OS에서는 아무것도 하지 않는다. 최적화일 뿐이라 던지지 않는다: 실패하면 한 번만 경고하고 false다.
 */
export async function markSparse(file: FileHandle): Promise<boolean> {
  if (process.platform !== 'win32') return false
  try {
    setSparse ??= loadSetSparse()
    if ((await setSparse)(file.fd)) return true
    warnOnce(new Error('DeviceIoControl(FSCTL_SET_SPARSE) failed'))
  } catch (err) {
    warnOnce(err)
  }
  return false
}

function warnOnce(err: unknown): void {
  if (warned) return
  warned = true
  console.warn('[sparseFile] Failed to mark a download sparse, NTFS will zero-fill it:', err)
}
