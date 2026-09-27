import type { HistoryItem } from './types'

const DB_NAME = 'bilibili-evolved-custom-navbar-history'
const DB_VERSION = 1

export const historyStoreName = 'history'
export const historyIndexName = 'viewAt'
export const metaStoreName = 'meta'

/** 在 IndexedDB 中保存的同步元数据键 */
export const metaKeys = {
  /** 最近一次抓取的观看时间 (ms), 增量同步用 */
  lastViewAt: 'lastViewAt',
  /** 是否已完成全量抓取 */
  fullSyncDone: 'fullSyncDone',
} as const

async function database() {
  return new Promise((resolve: (db: IDBDatabase) => void, reject) => {
    const req = unsafeWindow.indexedDB.open(DB_NAME, DB_VERSION)
    req.onerror = reject
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(historyStoreName)) {
        const store = db.createObjectStore(historyStoreName, { keyPath: 'id' })
        store.createIndex(historyIndexName, 'viewAt')
      }
      if (!db.objectStoreNames.contains(metaStoreName)) {
        db.createObjectStore(metaStoreName)
      }
    }
    req.onsuccess = () => resolve(req.result)
  })
}

async function objectStore(name: string, mode?: IDBTransactionMode) {
  const db = await database()
  return new Promise((resolve: (db: IDBObjectStore) => void, reject) => {
    const tr = db.transaction(name, mode)
    resolve(tr.objectStore(name))
    tr.onerror = reject
  })
}

/** 读取一条历史 */
export async function getHistory(id: IDBValidKey): Promise<HistoryItem | undefined> {
  const store = await objectStore(historyStoreName)
  return new Promise((resolve: (v: HistoryItem | undefined) => void, reject) => {
    const res = store.get(id)
    res.onerror = reject
    res.onsuccess = () => resolve(res.result)
  })
}

/** 批量写入历史 (按 id 覆盖同名记录, 重新播放产生的更新记录靠这里覆盖旧的) */
export async function putHistory(items: HistoryItem[]): Promise<void> {
  if (items.length === 0) {
    return
  }
  const db = await database()
  await new Promise((resolve: (v: void) => void, reject) => {
    const tr = db.transaction(historyStoreName, 'readwrite')
    tr.onerror = reject
    tr.oncomplete = () => resolve()
    const store = tr.objectStore(historyStoreName)
    items.forEach(item => store.put(item))
  })
}

/**
 * 批量读取本地的历史记录, 用于和接口返回的记录逐条比对
 * (只看 id 是否存在无法判断服务端记录是否已更新, 例如重新播放后的观看时间/进度)
 * @param ids 待读取的 id 数组
 * @returns id → 本地记录的映射, 本地不存在的 id 不会出现在映射里
 */
export async function getHistoryItems(
  ids: IDBValidKey[],
): Promise<Map<string | number, HistoryItem>> {
  if (ids.length === 0) {
    return new Map()
  }
  const store = await objectStore(historyStoreName)
  const results = await Promise.all(
    ids.map(
      id =>
        new Promise<HistoryItem | undefined>((resolve, reject) => {
          const req = store.get(id)
          req.onerror = reject
          req.onsuccess = () => resolve(req.result)
        }),
    ),
  )
  const items = new Map<string | number, HistoryItem>()
  ids.forEach((id, index) => {
    const item = results[index]
    if (item) {
      items.set(id as string | number, item)
    }
  })
  return items
}

/** 清除全部本地历史 */
export async function clearHistory(): Promise<void> {
  const store = await objectStore(historyStoreName, 'readwrite')
  return new Promise((resolve: (v: void) => void, reject) => {
    const req = store.clear()
    req.onerror = reject
    req.onsuccess = () => resolve()
  })
}

/** 读取全部历史 (按观看时间降序) */
export async function getAllHistory(): Promise<HistoryItem[]> {
  const db = await database()
  return new Promise((resolve: (items: HistoryItem[]) => void, reject) => {
    const tr = db.transaction(historyStoreName)
    tr.onerror = reject
    const store = tr.objectStore(historyStoreName)
    const index = store.index(historyIndexName)
    const req = index.getAll()
    req.onerror = reject
    req.onsuccess = () => {
      const list = (req.result as HistoryItem[]).sort((a, b) => b.viewAt - a.viewAt)
      resolve(list)
    }
  })
}

/** 历史总数 */
export async function countHistory(): Promise<number> {
  const store = await objectStore(historyStoreName)
  return new Promise((resolve: (n: number) => void, reject) => {
    const req = store.count()
    req.onerror = reject
    req.onsuccess = () => resolve(req.result)
  })
}

/** 写入同步元数据 */
export async function setMeta(key: string, value: unknown): Promise<void> {
  const store = await objectStore(metaStoreName, 'readwrite')
  return new Promise((resolve: (v: void) => void, reject) => {
    const req = store.put(value, key)
    req.onerror = reject
    req.onsuccess = () => resolve()
  })
}

/** 读取同步元数据 */
export async function getMeta<T = any>(key: string): Promise<T | undefined> {
  const store = await objectStore(metaStoreName)
  return new Promise((resolve: (v: T | undefined) => void, reject) => {
    const req = store.get(key)
    req.onerror = reject
    req.onsuccess = () => resolve(req.result as T | undefined)
  })
}
