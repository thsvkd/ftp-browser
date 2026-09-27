/* eslint-disable @typescript-eslint/explicit-function-return-type -- Node executes this build script as JavaScript. */
// build/icon.svg 하나에서 각 플랫폼 아이콘을 만든다. 아이콘을 바꾸면 SVG만 고치고 `npm run icons`.
//   build/icon.png      1024px — electron-builder 기본 아이콘(Linux 등)
//   build/icon.ico      16~256px — Windows 실행 파일·설치 프로그램·작업 표시줄
//   build/icon.icns     16~1024px — macOS
//   resources/icon.png  512px — 개발 실행과 Linux 창 아이콘(main이 import)
import { readFileSync, writeFileSync } from 'node:fs'
import sharp from 'sharp'

const svg = readFileSync('build/icon.svg')
const png = (size) => sharp(svg, { density: 384 }).resize(size, size).png().toBuffer()

// ICO: 6바이트 헤더 + 16바이트 디렉터리 항목들 + PNG 본문. 256px은 크기 칸에 0을 쓴다.
async function ico(sizes) {
  const images = await Promise.all(sizes.map(png))
  const header = Buffer.alloc(6 + 16 * sizes.length)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(sizes.length, 4)
  let offset = header.length
  sizes.forEach((size, i) => {
    const at = 6 + 16 * i
    header.writeUInt8(size % 256, at)
    header.writeUInt8(size % 256, at + 1)
    header.writeUInt16LE(1, at + 4)
    header.writeUInt16LE(32, at + 6)
    header.writeUInt32LE(images[i].length, at + 8)
    header.writeUInt32LE(offset, at + 12)
    offset += images[i].length
  })
  return Buffer.concat([header, ...images])
}

// ICNS: 'icns' + 전체 길이(BE), 항목마다 4글자 타입 + 항목 길이(BE, 헤더 포함) + PNG.
async function icns(entries) {
  const chunks = await Promise.all(
    entries.map(async ([type, size]) => {
      const data = await png(size)
      const head = Buffer.alloc(8)
      head.write(type, 0, 'ascii')
      head.writeUInt32BE(data.length + 8, 4)
      return Buffer.concat([head, data])
    })
  )
  const head = Buffer.alloc(8)
  head.write('icns', 0, 'ascii')
  head.writeUInt32BE(8 + chunks.reduce((n, c) => n + c.length, 0), 4)
  return Buffer.concat([head, ...chunks])
}

writeFileSync('build/icon.png', await png(1024))
writeFileSync('resources/icon.png', await png(512))
writeFileSync('build/icon.ico', await ico([16, 24, 32, 48, 64, 128, 256]))
writeFileSync(
  'build/icon.icns',
  await icns([
    ['icp4', 16],
    ['icp5', 32],
    ['icp6', 64],
    ['ic07', 128],
    ['ic08', 256],
    ['ic09', 512],
    ['ic10', 1024],
    ['ic11', 32],
    ['ic12', 64],
    ['ic13', 256],
    ['ic14', 512]
  ])
)
console.log('icons written')
