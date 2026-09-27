import {
  PINYIN_ALTERNATE_TABLE,
  PINYIN_INDEX_BASE,
  PINYIN_SYLLABLES,
  PINYIN_TABLE,
  PINYIN_TABLE_START,
} from './pinyin-table'

/**
 * 拼音搜索串里分隔"全拼"与"首字母"的分隔符: `瑶光` -> `yaoguang|yg`。
 * 两种形式放进同一个字段, 搜索时一次 `includes` 就能同时覆盖全拼与首字母输入。
 * 多音字还会在后面补上"次读音"变体, 例如 `音乐` -> `yinle|yl|yinyue|yy`。
 */
const PINYIN_SEPARATOR = '|'

/**
 * 拼音字段的格式版本。记录里存的版本与此不一致时会重新生成拼音
 * (例如旧记录里 `音乐` 只有 `yinle`, 不含多音字的 `yinyue`)。
 */
export const PINYIN_VERSION = 2

/** 拼音表覆盖的最后一个汉字的码点 */
const PINYIN_TABLE_END = PINYIN_TABLE_START + PINYIN_TABLE.length - 1

/**
 * 解码多音字次读音表: 表里交替存放 [码点增量, 音节下标], 下标 0 是跨越大间隔的占位。
 * @returns 码点 → 次读音
 */
const createAlternateSyllables = () => {
  const result = new Map<number, string>()
  let code = PINYIN_TABLE_START - 1
  for (let i = 0; i < PINYIN_ALTERNATE_TABLE.length; i += 2) {
    code += PINYIN_ALTERNATE_TABLE.charCodeAt(i) - PINYIN_INDEX_BASE
    const syllable = PINYIN_SYLLABLES[PINYIN_ALTERNATE_TABLE.charCodeAt(i + 1) - PINYIN_INDEX_BASE]
    if (syllable) {
      result.set(code, syllable)
    }
  }
  return result
}

/** 多音字的次读音 (码点 → 读音), 只有多音字才在里面 */
const alternateSyllables = createAlternateSyllables()

/** 转换结果缓存上限, 超过后整体清空 (缓存只为省去重复查表, 不需要精确淘汰) */
const CACHE_LIMIT = 20000
const cache = new Map<string, string>()

/**
 * 生成文本的拼音搜索串, 格式为 `<全拼>|<首字母>`。
 *
 * 含多音字时会再补上 `<次读音全拼>|<次读音首字母>`(每个多音字取其第二个读音,
 * 其余字保持主读音), 这样 `音乐` 既能被 `yinle` 也能被 `yinyue` 搜到。
 * 非汉字字符(英文/数字/符号)、基本区以外的汉字, 以及表里没有拼音数据的字都会被跳过。
 * @param text 原始文本
 */
export const buildPinyinSearchText = (text: string) => {
  if (!text) {
    return ''
  }
  const cached = cache.get(text)
  if (cached !== undefined) {
    return cached
  }
  let full = ''
  let initials = ''
  let alternateFull = ''
  let alternateInitials = ''
  let hasAlternate = false
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < PINYIN_TABLE_START || code > PINYIN_TABLE_END) {
      continue
    }
    const index = PINYIN_TABLE.charCodeAt(code - PINYIN_TABLE_START) - PINYIN_INDEX_BASE
    const syllable = PINYIN_SYLLABLES[index]
    if (!syllable) {
      continue
    }
    full += syllable
    initials += syllable[0]
    const alternate = alternateSyllables.get(code)
    if (alternate) {
      hasAlternate = true
    }
    const alternateSyllable = alternate ?? syllable
    alternateFull += alternateSyllable
    alternateInitials += alternateSyllable[0]
  }
  let result = full ? full + PINYIN_SEPARATOR + initials : ''
  // 不含多音字时次读音串与主串完全相同, 不再重复存储
  if (hasAlternate) {
    result += PINYIN_SEPARATOR + alternateFull + PINYIN_SEPARATOR + alternateInitials
  }
  if (cache.size >= CACHE_LIMIT) {
    cache.clear()
  }
  cache.set(text, result)
  return result
}

/**
 * 把搜索关键词归一化成拼音串的写法: 转小写, ü 写作 v。
 * 输入的 `nv`、`nü`、`nu:` 都会归一化成 `nv`, 与拼音表中的写法一致。
 */
export const normalizePinyinQuery = (text: string) =>
  text
    .trim()
    .toLowerCase()
    .replace(/[üǖǘǚǜ]/g, 'v')
    .replace(/u:/g, 'v')

/** 只有纯拉丁字母的关键词才可能是拼音输入 (含汉字/数字等一律按原文匹配) */
export const isPinyinQuery = (text: string) => /^[a-z]+$/.test(text)

/**
 * 参与拼音搜索的记录字段。
 * `HistoryItem` 在结构上兼容, 这里刻意不反向依赖 `types.ts`, 便于单独测试本模块。
 */
export interface PinyinSearchableItem {
  title: string
  upName: string
  /** 预小写的标题 */
  titleLower?: string
  /** 预小写的 UP 主名 */
  upNameLower?: string
  /** 标题的拼音搜索串 */
  titlePinyin?: string
  /** UP 主名的拼音搜索串 */
  upNamePinyin?: string
  /** 拼音字段的格式版本, 与 `PINYIN_VERSION` 不一致时重新生成 */
  pinyinVersion?: number
}

/** 归一化后的搜索关键词 */
export interface HistoryKeyword {
  /** 小写的原文关键词 */
  text: string
  /** 拼音关键词, 关键词不是纯字母时为空串 */
  pinyin: string
}

/**
 * 补全记录的拼音搜索字段 (版本不符时才计算)。
 *
 * 需要重算的两种情况: 改动前存进 IndexedDB 的旧记录只有 `titleLower`/`upNameLower`;
 * 拼音串格式升级(例如加入多音字次读音)后, 旧记录里存的是旧格式的串。
 * @param item 待补全的记录, 就地修改
 */
export const ensurePinyinFields = <T extends PinyinSearchableItem>(item: T) => {
  if (item.pinyinVersion !== PINYIN_VERSION) {
    item.titlePinyin = buildPinyinSearchText(item.title)
    item.upNamePinyin = buildPinyinSearchText(item.upName)
    item.pinyinVersion = PINYIN_VERSION
  }
  return item
}

/**
 * 归一化搜索关键词。空查询返回 `null`, 调用方据此跳过过滤。
 * @param query 搜索框原文
 */
export const createHistoryKeyword = (query: string): HistoryKeyword | null => {
  const text = query.trim().toLowerCase()
  if (!text) {
    return null
  }
  const pinyin = normalizePinyinQuery(text)
  return { text, pinyin: isPinyinQuery(pinyin) ? pinyin : '' }
}

/**
 * 判断记录是否命中关键词: 先比原文(标题/UP主), 纯字母关键词再比拼音串(全拼/首字母)。
 * @param item 待判定的记录
 * @param keyword 归一化后的关键词
 */
export const matchesHistoryKeyword = (item: PinyinSearchableItem, keyword: HistoryKeyword) => {
  if ((item.titleLower ?? item.title.toLowerCase()).includes(keyword.text)) {
    return true
  }
  if ((item.upNameLower ?? item.upName.toLowerCase()).includes(keyword.text)) {
    return true
  }
  if (!keyword.pinyin) {
    return false
  }
  // 旧记录可能还没有拼音字段, 这里按需补算 (算过一次就写回对象, 后续搜索不会重复计算)
  ensurePinyinFields(item)
  return (
    (item.titlePinyin ?? '').includes(keyword.pinyin) ||
    (item.upNamePinyin ?? '').includes(keyword.pinyin)
  )
}
