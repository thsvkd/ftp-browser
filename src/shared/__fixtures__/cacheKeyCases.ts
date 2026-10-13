/**
 * 썸네일 캐시 키의 입력 표(multi-connection Test-999). main `generateCacheKey`와 렌더러
 * `generateCacheKeyRenderer`의 테스트가 같은 표로 같은 문자열을 확인한다. 테스트가 아닌 모듈이다.
 */
import { THUMBNAIL_SIZE } from '../constants'

export interface CacheKeyCase {
  conn: string
  remotePath: string
  size: number
  modifiedAt: string
  key: string
}

export const CACHE_KEY_CASES: CacheKeyCase[] = [
  {
    conn: 'me@ftp.example.com:21',
    remotePath: '/images/photo.jpg',
    size: 1024,
    modifiedAt: '2024-01-01',
    key: `me@ftp.example.com:21:/images/photo.jpg:1024:2024-01-01:${THUMBNAIL_SIZE}`
  },
  {
    conn: 'other@ftp.example.com:21',
    remotePath: '/images/photo.jpg',
    size: 1024,
    modifiedAt: '2024-01-01',
    key: `other@ftp.example.com:21:/images/photo.jpg:1024:2024-01-01:${THUMBNAIL_SIZE}`
  },
  {
    conn: 'anonymous@host.com:2121',
    remotePath: '/path with spaces/한글파일.jpg',
    size: 100,
    modifiedAt: '2024-05-01T10:20:30.000Z',
    key: `anonymous@host.com:2121:/path with spaces/한글파일.jpg:100:2024-05-01T10:20:30.000Z:${THUMBNAIL_SIZE}`
  },
  {
    conn: 'a@b@host.com:21',
    remotePath: '/a:b/@c.png',
    size: 0,
    modifiedAt: '',
    key: `a@b@host.com:21:/a:b/@c.png:0::${THUMBNAIL_SIZE}`
  }
]
