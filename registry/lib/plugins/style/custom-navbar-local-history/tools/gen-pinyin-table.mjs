#!/usr/bin/env node
/**
 * 生成同级目录下的 `pinyin-table.ts` (汉字拼音索引表 + 多音字次读音表)。
 *
 * 数据来源: mozillazg/pinyin-data (MIT License)
 * https://github.com/mozillazg/pinyin-data
 * - kMandarin.txt: 每字的最常用读音, 用作主读音
 * - pinyin.txt: 每字的全部读音, 用作次读音 (取第一个与主读音不同的)
 *
 * 编码方式:
 * 主表覆盖 CJK 基本区 `U+4E00 - U+9FFF`, 按码点顺序把每个字的拼音换成 `PINYIN_SYLLABLES`
 * 里的下标, 再以 `U+E000 + 下标` 的字符存进 `PINYIN_TABLE` (下标 0 表示没有拼音数据)。
 * 次读音是稀疏的, 存进 `PINYIN_ALTERNATE_TABLE`: 交替存放 [码点增量, 音节下标],
 * 音节下标 0 表示仅用于跨越大间隔的占位, 解码时跳过。
 * 音调去除, ü 写作 v。
 *
 * 用法:
 *   node gen-pinyin-table.mjs                       # 自动下载数据后生成
 *   node gen-pinyin-table.mjs --data kMandarin.txt --data-alt pinyin.txt
 *   node gen-pinyin-table.mjs --out /tmp/x.ts       # 默认覆盖同级 pinyin-table.ts
 *
 * 生成的表交给 eslint --fix 格式化即可 (与仓库 prettier 配置一致)。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DATA_URL = 'https://raw.githubusercontent.com/mozillazg/pinyin-data/master/kMandarin.txt'
const DATA_ALT_URL = 'https://raw.githubusercontent.com/mozillazg/pinyin-data/master/pinyin.txt'

/** 表覆盖范围: CJK 统一表意文字基本区 */
const START = 0x4e00
const END = 0x9fff
/** 索引字符的码点基准 (私有使用区 U+E000 - U+F8FF) */
const INDEX_BASE = 0xe000
const INDEX_MAX = 0xf8ff - INDEX_BASE
/** 分片长度, 保证每行不超过 prettier 的 printWidth */
const CHUNK = 80

const here = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const argOf = name => {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}

/** 去掉声调符号, ü 统一写成 v */
const stripTone = raw =>
  raw
    .normalize('NFD')
    .replace(/u\u0308/gi, 'v')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()

/** 解析 `U+4E50: lè,yuè  # 乐` 形式的拼音数据 */
const parseData = (content, multiple) => {
  const result = new Map()
  for (const line of content.split('\n')) {
    const matched = /^U\+([0-9A-Fa-f]+):\s*([^#]+)/.exec(line.trim())
    if (!matched) {
      continue
    }
    // 读音之间可能是逗号, 也可能是空格 (kMandarin 里有 `U+4E07: wàn mò` 这种)
    const values = matched[2]
      .split(/[,\s]+/)
      .map(value => stripTone(value.trim()))
      .filter(value => /^[a-z]+$/.test(value))
    if (values.length === 0) {
      continue
    }
    result.set(parseInt(matched[1], 16), multiple ? values : values[0])
  }
  return result
}

const readData = async (localPath, url, cacheName) => {
  if (localPath) {
    return fs.readFileSync(localPath, 'utf8')
  }
  console.log(`下载拼音数据: ${url}`)
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`下载失败: HTTP ${response.status}`)
  }
  const content = await response.text()
  fs.writeFileSync(path.join(os.tmpdir(), cacheName), content)
  return content
}

/** 把字符序列切成等长片段, 每片一个单引号字符串行 */
const toChunks = text => {
  const lines = []
  for (let i = 0; i < text.length; i += CHUNK) {
    // 内容只有私有区字符, 不会出现引号
    lines.push(`  '${text.slice(i, i + CHUNK)}',`)
  }
  return lines.join('\n')
}

const main = async () => {
  const mainContent = await readData(
    argOf('--data'),
    DATA_URL,
    'kMandarin.txt',
  )
  const altContent = await readData(
    argOf('--data-alt'),
    DATA_ALT_URL,
    'pinyin.txt',
  )

  const primaryOf = parseData(mainContent, false)
  const allOf = parseData(altContent, true)

  // 下标 0 留作 "无拼音" 占位; 音节表要含主读音与次读音用到的全部音节
  const allSyllables = new Set(primaryOf.values())
  for (const values of allOf.values()) {
    for (const value of values) {
      allSyllables.add(value)
    }
  }
  const syllables = ['', ...[...allSyllables].sort()]
  const syllableIndex = new Map(syllables.map((syllable, index) => [syllable, index]))

  let table = ''
  let covered = 0
  const alternates = []
  for (let code = START; code <= END; code++) {
    const primary = primaryOf.get(code)
    if (!primary) {
      table += String.fromCharCode(INDEX_BASE)
      continue
    }
    covered++
    table += String.fromCharCode(INDEX_BASE + syllableIndex.get(primary))
    const alternate = (allOf.get(code) ?? []).find(value => value !== primary)
    if (alternate && syllableIndex.has(alternate)) {
      alternates.push({ code, alternate })
    }
  }

  // 次读音稀疏表: [码点增量, 音节下标], 增量过大时先插入占位项
  let alternateTable = ''
  let previousCode = START - 1
  for (const { code, alternate } of alternates) {
    let delta = code - previousCode
    while (delta > INDEX_MAX) {
      alternateTable += String.fromCharCode(INDEX_BASE + INDEX_MAX, INDEX_BASE)
      previousCode += INDEX_MAX
      delta = code - previousCode
    }
    alternateTable += String.fromCharCode(
      INDEX_BASE + delta,
      INDEX_BASE + syllableIndex.get(alternate),
    )
    previousCode = code
  }

  const output = `/**
 * 汉字拼音索引表 (自动生成, 请勿手工编辑)
 *
 * 数据来源: mozillazg/pinyin-data (MIT License)
 * https://github.com/mozillazg/pinyin-data
 * - 主读音: kMandarin.txt (每字最常用的读音)
 * - 次读音: pinyin.txt (取第一个与主读音不同的读音, 用于多音字搜索)
 *
 * 编码方式: 主表覆盖 CJK 基本区 \`U+${START.toString(16).toUpperCase()} - U+${END.toString(
    16,
  ).toUpperCase()}\`, 按码点顺序把每个字的
 * 拼音压缩成 \`PINYIN_TABLE\` 中的一个字符, 该字符的码点减 \`PINYIN_INDEX_BASE\`
 * 即 \`PINYIN_SYLLABLES\` 的下标 (下标 0 表示没有拼音数据)。
 * 音调已去除, ü 统一写作 v。
 *
 * 重建方式: node tools/gen-pinyin-table.mjs
 */

/** 表覆盖的第一个汉字的码点 */
export const PINYIN_TABLE_START = 0x${START.toString(16)}

/** 索引字符的码点基准 */
export const PINYIN_INDEX_BASE = 0x${INDEX_BASE.toString(16)}

/** 无声调拼音音节表, 空格分隔, 下标 0 为空串 (表示没有拼音数据) */
export const PINYIN_SYLLABLES =
  '${syllables.join(' ')}'.split(
    ' ',
  )

/** 汉字拼音索引表 (主读音, 分片存放, 避免单行过长) */
const PINYIN_TABLE_CHUNKS = [
${toChunks(table)}
]

/** 拼接后的主读音表, 下标 = 码点 - PINYIN_TABLE_START */
export const PINYIN_TABLE = PINYIN_TABLE_CHUNKS.join('')

/**
 * 多音字次读音表 (分片存放): 交替存放 [码点增量, 音节下标]。
 * 音节下标 0 表示该位置只是为了跨越大间隔而插入的占位, 解码时跳过。
 */
const PINYIN_ALTERNATE_CHUNKS = [
${toChunks(alternateTable)}
]

/** 拼接后的次读音表, 每 2 个字符一项 */
export const PINYIN_ALTERNATE_TABLE = PINYIN_ALTERNATE_CHUNKS.join('')
`

  const outPath = argOf('--out') ?? path.join(here, '..', 'pinyin-table.ts')
  fs.writeFileSync(outPath, output, 'utf8')
  console.log(`音节数: ${syllables.length - 1}`)
  console.log(`基本区覆盖: ${covered} / ${END - START + 1}`)
  console.log(`多音字(次读音): ${alternates.length}, 稀疏表 ${alternateTable.length} 字符`)
  console.log(`输出: ${path.resolve(outPath)} (${(Buffer.byteLength(output) / 1024).toFixed(1)} KB)`)
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
