import { fetchHistoryPage, HistoryItem } from './types'
import { clearHistory, countHistory, getHistoryItems, putHistory } from './history-db'

export interface SyncStatus {
  /** 本地已保存条数 */
  total: number
  /** 是否后台同步中 */
  syncing: boolean
  /** 已完成的抓取批次序号 */
  batches: number
}

export interface SyncOptions {
  /** 每次翻页后回调, 用于展示进度 */
  onProgress?: (status: SyncStatus) => void
}

/** 每次翻页的条数上限 */
const PAGE_SIZE = 30
/**
 * 单次同步的最大翻页数, 防止接口异常时无限翻页。
 * 30 * 200 = 6000 条, 足以覆盖绝大多数账号的观看历史。
 */
const MAX_BATCHES = 200

/**
 * 判断接口返回的记录相对本地记录是否需要写入覆盖。
 *
 * 两种情况下本地记录已过时: 本地没有这条记录, 或者服务端记录比本地更新
 * (重新播放某个视频会把它的观看时间推到现在, 进度/分 P 也可能变化, 而 id 不变)。
 * @param item 接口返回的记录
 * @param local 本地同 id 的记录, 不存在时为 `undefined`
 */
const isHistoryItemUpdated = (item: HistoryItem, local?: HistoryItem) => {
  if (!local) {
    return true
  }
  if (item.viewAt !== local.viewAt) {
    // 只接受更晚的观看时间, 避免服务端短暂返回更旧的记录时把本地最新记录覆盖回去
    return item.viewAt > local.viewAt
  }
  // 观看时间相同, 但进度或分 P 变了, 同样需要覆盖
  return item.progress !== local.progress || item.page !== local.page
}

/**
 * 把 B 站观看历史同步到本地 IndexedDB, 抓取新增记录并覆盖已更新的记录。
 *
 * B 站 `history/cursor` 接口按时间降序返回, 新观看的记录总是出现在最新端。
 * 因此从最新一页开始翻, 每页把新增/变化的记录按 `id` 覆盖写入, 一旦某一页的记录
 * 全部与本地一致, 说明已经覆盖到已有历史的边界, 停止翻页。
 * @returns 同步结束后的状态
 */
export const syncHistory = async (options: SyncOptions = {}): Promise<SyncStatus> => {
  let viewTime = 0
  let previousViewTime = -1
  let batches = 0

  for (; batches < MAX_BATCHES; batches++) {
    const items = await fetchHistoryPage(viewTime, '', PAGE_SIZE)
    if (items.length === 0) {
      break
    }

    // 逐条与本地比对, 取出新增的和被服务端更新过的记录 (重新播放过的视频属于后者)
    const localItems = await getHistoryItems(items.map(item => item.id))
    const changedItems = items.filter(item =>
      isHistoryItemUpdated(item, localItems.get(item.id as string | number)),
    )

    if (changedItems.length === 0) {
      // 本页记录全部与本地一致, 说明已覆盖到已有历史的边界, 无需再往更早翻
      break
    }
    await putHistory(changedItems)

    // 下一页从本页最早一条开始; 若游标不再前进则停止 (接口没有更早数据)
    const nextViewTime = items[items.length - 1].viewAt
    if (nextViewTime === viewTime || nextViewTime === previousViewTime) {
      break
    }
    previousViewTime = viewTime
    viewTime = nextViewTime

    options.onProgress?.({
      total: await countHistory(),
      syncing: true,
      batches: batches + 1,
    })
  }

  const total = await countHistory()
  return { total, syncing: false, batches }
}

/**
 * 清空本地历史, 下次同步时重新全量抓取。
 */
export const reSyncHistory = async (options: SyncOptions = {}): Promise<SyncStatus> => {
  await clearHistory()
  return syncHistory(options)
}
