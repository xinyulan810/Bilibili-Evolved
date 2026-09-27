import Fuse from 'fuse.js'
import { bilibiliApi, getJsonWithCredentials } from '@/core/ajax'
import { formatDuration } from '@/core/utils/formatters'
import { createHistoryKeyword, ensurePinyinFields, matchesHistoryKeyword } from './pinyin'

/** 历史项目类型, 值为 API 中的 `history.business` */
export enum HistoryType {
  All = 'all',
  Video = 'archive',
  Live = 'live',
  Article = 'article',
  Bangumi = 'pgc',
  Cheese = 'cheese',
}

export interface HistoryItem {
  id: string | number
  url: string
  title: string
  /** 视频/直播的封面 */
  cover: string
  /** 专栏封面 */
  covers: string[]
  type: HistoryType
  upName: string
  upID: number
  upFaceUrl: string
  /** 观看时间戳 */
  viewAt: number
  /** 观看时间对象 */
  time: Date
  /** 观看时间展示文字 */
  timeText: string
  /** 进度, `-1` 为已看完, 否则为已观看的秒数 */
  progress: number
  /** 进度展示文字 */
  progressText: string
  /** 时长 */
  duration: number
  /** 时长展示文字 */
  durationText: string
  /** 视频的分 P */
  page?: number
  /** 视频的分 P 数 */
  pages?: number
  /** 直播状态: 0 未开播 1 直播中 2 轮播中 */
  liveStatus?: number
  /** 视频的 tag / 直播的分区名 */
  tagName?: string
  /** 预小写的标题, 用于快速搜索 (避免每次都对全量数据 toLowerCase) */
  titleLower?: string
  /** 预小写的 UP 主名, 用于快速搜索 */
  upNameLower?: string
  /**
   * 标题的拼音搜索串 (`<全拼>|<首字母>`, 含多音字时再补 `|<次读音全拼>|<次读音首字母>`,
   * 如 `瑶光` -> `yaoguang|yg`, `音乐` -> `yinle|yl|yinyue|yy`), 用于拼音/首字母搜索。
   * 老记录 (改动前存下的, 或旧格式的串) 由 `ensurePinyinFields` 按 `pinyinVersion` 重算。
   */
  titlePinyin?: string
  /** UP 主名的拼音搜索串, 格式同 `titlePinyin` */
  upNamePinyin?: string
  /** 拼音字段的格式版本, 见 `pinyin.ts` 的 `PINYIN_VERSION` */
  pinyinVersion?: number
  /** 观看时间的本地化完整字符串, 用于 title 提示 */
  timeTitle?: string
}

export interface TypeFilter {
  name: HistoryType
  displayName: string
  icon: string
  checked: boolean
  apiType: string
}

/** 顶栏可筛选的历史记录类型 */
export const navbarFilterTypes = [
  {
    name: HistoryType.All,
    displayName: '全部',
    icon: '',
    checked: true,
    apiType: '',
  },
  {
    name: HistoryType.Video,
    displayName: '视频',
    icon: 'mdi-play-circle-outline',
    checked: false,
    apiType: 'archive',
  },
  {
    name: HistoryType.Bangumi,
    displayName: '番剧',
    icon: 'mdi-television-classic',
    checked: false,
    // b 站的历史不区分视频和番剧, 只能混着拿然后过滤
    apiType: 'archive',
  },
  {
    name: HistoryType.Live,
    displayName: '直播',
    icon: 'mdi-video-wireless-outline',
    checked: false,
    apiType: 'live',
  },
  {
    name: HistoryType.Article,
    displayName: '专栏',
    icon: 'mdi-newspaper-variant-outline',
    checked: false,
    apiType: 'article',
  },
] as TypeFilter[]

const getTimeData = () => {
  const now = new Date()
  const today = Number(new Date(now.getFullYear(), now.getMonth(), now.getDate()))
  const oneDay = 24 * 3600000
  const yesterday = today - oneDay
  const lastWeek = today - 7 * oneDay
  return {
    now,
    today,
    oneDay,
    yesterday,
    lastWeek,
  }
}

const formatTime = (date: Date) => {
  const { yesterday, today } = getTimeData()
  const timestamp = Number(date)
  if (timestamp >= yesterday) {
    return `${timestamp >= today ? '今天' : '昨天'} ${date
      .getHours()
      .toString()
      .padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`
  }
  return `${(date.getMonth() + 1).toString().padStart(2, '0')}-${date
    .getDate()
    .toString()
    .padStart(2, '0')} ${date.getHours().toString().padStart(2, '0')}:${date
    .getMinutes()
    .toString()
    .padStart(2, '0')}`
}

const buildHistoryItem = (item: any): HistoryItem => {
  if (item.history.business === HistoryType.Article) {
    item.history.cid = item.history.oid
  }
  const {
    epid, // 番剧 ep号
    bvid, // 视频 bv号
    cid, // 专栏 cv号
    oid, // 直播 房间号 / 专栏 cv 号 / 课程神秘标识符
    page,
  } = item.history
  const progressParam = item.progress > 0 ? `t=${item.progress}` : 't=0'
  const progress = item.progress === -1 ? 1 : item.progress / item.duration
  const https = (url: string) => url.replace('http:', 'https:')
  const time = new Date(item.view_at * 1000)
  const cover = (() => {
    if (item.cover) {
      return https(item.cover)
    }
    if (item.covers) {
      return https(item.covers[0])
    }
    return ''
  })()
  const commonInfo = {
    title: item.title,
    viewAt: item.view_at * 1000,
    time,
    timeText: formatTime(time),
    timeTitle: time.toLocaleString(),
    titleLower: String(item.title ?? '').toLowerCase(),
    upNameLower: String(item.author_name ?? '').toLowerCase(),
    cover,
    covers: item.covers?.map(https) ?? [],
    progress,
    progressText: Number.isNaN(progress)
      ? null
      : `${formatDuration(item.progress)} / ${formatDuration(item.duration)}`,
    duration: item.duration,
    durationText: item.duration ? formatDuration(item.duration) : null,
    upName: item.author_name,
    upFaceUrl: https(item.author_face),
    upID: item.author_mid,
  }
  if (item.history.business === HistoryType.Cheese) {
    return {
      ...commonInfo,
      id: oid,
      upName: item.title,
      title: item.show_title,
      url: item.uri,
      titleLower: String(item.show_title ?? '').toLowerCase(),
      upNameLower: String(item.title ?? '').toLowerCase(),
      /** 特殊处理: 展示上分类仍归类到视频 */
      type: HistoryType.Video,
    }
  }
  if (epid) {
    return {
      ...commonInfo,
      id: epid,
      url: `https://www.bilibili.com/bangumi/play/ep${epid}?${progressParam}`,
      title: item.show_title || item.title,
      upName: item.title,
      titleLower: String((item.show_title || item.title) ?? '').toLowerCase(),
      upNameLower: String(item.title ?? '').toLowerCase(),
      type: HistoryType.Bangumi,
    }
  }
  if (bvid) {
    return {
      ...commonInfo,
      id: bvid,
      url: `https://www.bilibili.com/video/${bvid}?p=${item.history.page}&${progressParam}`,
      type: HistoryType.Video,
      page,
      pages: item.videos,
    }
  }
  if (cid) {
    return {
      ...commonInfo,
      id: cid,
      url: `https://www.bilibili.com/read/cv${cid}`,
      type: HistoryType.Article,
    }
  }
  if (oid) {
    return {
      ...commonInfo,
      id: oid,
      url: `https://live.bilibili.com/${oid}`,
      liveStatus: item.live_status,
      type: HistoryType.Live,
    }
  }
  console.error('unknown history item type', item)
  throw new Error('未知的历史项目类型')
}

/**
 * 解析接口返回的历史项目。
 * 拼音字段统一在这里生成, 而不是在各个分支里写 —— 芝士/番剧分支会改写 `title`/`upName`,
 * 放在最后能保证拼音一定按最终展示的字段计算。
 * @param item 接口返回的单条历史
 */
const parseHistoryItem = (item: any) => ensurePinyinFields(buildHistoryItem(item))

/**
 * 获取指定观看时间之前的一页历史记录, 不指定则返回最新的历史记录
 * @param viewTime 观看时间 (ms)
 * @param apiType 历史类型筛选, 为空表示全部
 * @param ps 每页条数
 */
export const fetchHistoryPage = async (
  viewTime?: number,
  apiType = '',
  ps = 30,
): Promise<HistoryItem[]> => {
  const api = 'https://api.bilibili.com/x/web-interface/history/cursor'
  const params = new URLSearchParams()
  if (viewTime) {
    params.set('view_at', Math.round(viewTime / 1000).toString())
  }
  params.set('type', apiType)
  params.set('ps', ps.toString())
  const { list } = await bilibiliApi(
    getJsonWithCredentials(`${api}?${params.toString()}`),
    '获取历史记录失败',
  )
  if (!Array.isArray(list)) {
    return []
  }
  return (list as any[]).map(parseHistoryItem).filter(it => it !== null)
}

/**
 * 为本地历史创建模糊搜索索引 (fuse.js), 用于标题/UP主模糊匹配。
 * @param items 本地历史列表
 * @returns fuse.js 搜索实例
 */
export const createHistoryIndex = (items: HistoryItem[]) => {
  return new Fuse(items, {
    keys: [
      { name: 'title', weight: 0.85 },
      { name: 'upName', weight: 0.15 },
    ],
    threshold: 0.35,
    ignoreLocation: true,
    minMatchCharLength: 1,
    shouldSort: true,
    isCaseSensitive: false,
  })
}

/**
 * 精确匹配结果的条数达到该值时, 认为结果已足够多, 不再进行昂贵的 fuse.js 模糊搜索补齐。
 * 这样一方面保证了搜索的实时性(避免每次按键都对全量数据做模糊搜索), 另一方面在精确命中较少时仍能用模糊搜索兜底。
 */
const FUZZY_INDEX_THRESHOLD = 100

/**
 * 对本地历史做关键词检索: 先用字符串精确包含匹配 (标题/UP主, 基于预小写字段),
 * 纯字母关键词额外做一次拼音匹配 (全拼 + 首字母), 最后用 fuse.js 模糊搜索补充。
 * 合并时精确匹配优先, 并就地去除重复。
 * @param items 本地历史列表
 * @param query 关键词
 * @param index 可选的 fuse.js 索引, 传入时启用模糊搜索
 */
export const filterHistory = (
  items: HistoryItem[],
  query: string,
  index?: Fuse<HistoryItem>,
): HistoryItem[] => {
  const keyword = createHistoryKeyword(query)
  if (!keyword) {
    return items
  }
  // 精确匹配 (标题/UP主的原文, 以及纯字母关键词下的拼音全拼/首字母)
  const exact = items.filter(it => matchesHistoryKeyword(it, keyword))
  // 模糊匹配 (仅在提供了索引, 且精确结果还不够多时启用, 避免每次按键的昂贵模糊搜索)
  if (index && exact.length < FUZZY_INDEX_THRESHOLD) {
    const fuzzy = index.search(query).map(result => result.item)
    const merged = exact.slice()
    const existing = new Set(exact.map(it => it.id))
    fuzzy.forEach(it => {
      if (!existing.has(it.id)) {
        merged.push(it)
        existing.add(it.id)
      }
    })
    return merged
  }
  return exact
}

/**
 * 为历史记录项目分组, 包含`今天`, `昨天`, `本周`, `更早`
 * @param historyItems 历史记录项目
 */
export const group = (historyItems: HistoryItem[]) => {
  if (historyItems.length === 0) {
    return []
  }
  const { today, yesterday, lastWeek } = getTimeData()
  const groups = lodash.groupBy(historyItems, h => {
    if (h.viewAt >= today) {
      return '今天'
    }
    if (h.viewAt >= yesterday) {
      return '昨天'
    }
    if (h.viewAt >= lastWeek) {
      return '本周'
    }
    return '更早'
  })
  return Object.entries(groups).map(([key, value]) => ({
    name: key,
    items: value,
  }))
}
