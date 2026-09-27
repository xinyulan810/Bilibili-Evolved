<template>
  <div class="custom-navbar-history-list">
    <div class="header">
      <div class="header-row">
        <div class="search">
          <VButton title="刷新(→全量同步)" round @click="reloadHistoryItems()">
            <VIcon icon="mdi-refresh" :size="16"></VIcon>
          </VButton>
        </div>
        <div class="operations">
          <div class="operation" @click="toggleHistoryPause">
            <VButton v-if="!paused" title="暂停记录历史" round>
              <VIcon icon="mdi-pause" :size="14"></VIcon>
            </VButton>
            <VButton v-else title="继续记录历史" round>
              <VIcon icon="mdi-play" :size="14"></VIcon>
            </VButton>
          </div>
          <a class="operation" target="_blank" href="https://www.bilibili.com/history">
            <VButton title="查看更多" round>
              <VIcon icon="mdi-dots-horizontal" :size="18"></VIcon>
            </VButton>
          </a>
        </div>
      </div>
      <div class="header-row">
        <div class="search-input">
          <input
            class="local-search-input"
            type="text"
            :value="search"
            placeholder="搜索(本地索引, 支持拼音/首字母)"
            title="支持中文、拼音全拼(yaoguang)与首字母(yg)"
            @input="onSearchInput"
            @compositionend="onSearchInput"
          />
        </div>
      </div>
      <div class="header-row">
        <div class="row-title">过滤:</div>
        <div class="type-filters">
          <div v-for="t of types" :key="t.name" class="type-filter">
            <RadioButton
              :class="{ checked: t.checked }"
              :checked="t.checked"
              :disabled="loading"
              @change="setTypeFilter(t)"
            >
              {{ t.displayName }}
            </RadioButton>
          </div>
        </div>
      </div>
      <div v-if="syncing" class="sync-status">
        <span class="sync-text">同步中… 已保存 {{ total }} 条 (批次 {{ batches }})</span>
      </div>
    </div>
    <div class="content">
      <VLoading v-if="loading"></VLoading>
      <VEmpty v-else-if="groups.length === 0"></VEmpty>
      <div v-else ref="cards" class="cards" @scroll="onCardsScroll">
        <div v-if="stickyGroup" class="virtual-sticky-group">{{ stickyGroup }}</div>
        <div class="history-virtual" :style="{ height: totalHeight + 'px' }">
          <div
            v-for="w in windowRows"
            :key="w.row.key"
            class="virtual-row"
            :class="{ 'virtual-row-divider': w.row.kind === 'divider' }"
            :style="{ transform: 'translate3d(0,' + w.top + 'px,0)' }"
          >
            <div v-if="w.row.kind === 'divider'" class="group-divider"></div>
            <div v-else class="time-group-item">
              <a class="history-cover-container" target="_blank" :href="w.row.item.url">
                <DpiImage
                  class="cover"
                  :src="w.row.item.cover"
                  :size="{ width: 160, height: 110 }"
                  placeholder-image
                ></DpiImage>
                <div
                  v-if="w.row.item.progress"
                  class="progress"
                  :style="{ width: w.row.item.progress * 100 + '%' }"
                ></div>
                <div
                  v-if="w.row.item.pages !== undefined && w.row.item.pages > 1"
                  class="floating pages"
                >
                  {{ w.row.item.page }}P / {{ w.row.item.pages }}P
                </div>
              </a>
              <a class="title" target="_blank" :href="w.row.item.url" :title="w.row.item.title">{{
                w.row.item.title || w.row.item.upName + '的直播间'
              }}</a>
              <a
                class="up"
                target="_blank"
                :href="
                  w.row.item.type === 'pgc'
                    ? w.row.item.url
                    : 'https://space.bilibili.com/' + w.row.item.upID
                "
                :title="w.row.item.upName"
              >
                <DpiImage
                  v-if="w.row.item.upFaceUrl"
                  class="up-face"
                  :size="18"
                  :src="w.row.item.upFaceUrl"
                ></DpiImage>
                <div class="up-name">{{ w.row.item.upName }}</div>
              </a>
              <div class="history-info">
                <div v-if="w.row.item.progressText" class="progress-number">
                  {{ w.row.item.progress >= 0.95 ? '已看完' : w.row.item.progressText }}
                </div>
                <div
                  v-if="w.row.item.liveStatus !== undefined"
                  class="duration live-status"
                  :class="{ on: w.row.item.liveStatus === 1 }"
                >
                  {{ w.row.item.liveStatus === 1 ? '直播中' : '未开播' }}
                </div>
                <span
                  v-if="w.row.item.progressText || w.row.item.liveStatus !== undefined"
                  class="history-info-separator"
                  >|</span
                >
                <div v-if="w.row.item.timeText" class="time" :title="w.row.item.timeTitle">
                  {{ w.row.item.timeText }}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
<script lang="ts">
import { getCsrf } from '@/core/utils'
import { bilibiliApi, getJsonWithCredentials, postTextWithCredentials } from '@/core/ajax'
import { VButton, VIcon, RadioButton, VLoading, VEmpty, DpiImage } from '@/ui'
import { popperMixin } from '../../../components/style/custom-navbar/mixins'
import {
  HistoryItem,
  HistoryType,
  TypeFilter,
  createHistoryIndex,
  filterHistory,
  group,
  navbarFilterTypes,
} from './types'
import { ensurePinyinFields } from './pinyin'
import { getAllHistory } from './history-db'
import { syncHistory } from './history-fetch'

/** 分组分隔线行高 (px, 约等于一个视频卡片高度, 让分组切换更明显) */
const DIVIDER_HEIGHT = 55
/** 单个历史条目行高 (px, 含卡片 55px + 8px 间距) */
const ITEM_HEIGHT = 63
/** 可视区上下额外预渲染的行数, 避免快速滚动时出现空白 */
const OVERSCAN = 10

/** 扁平化后的虚拟列表行: 分组分隔线行 或 历史条目行 */
interface FlatRow {
  key: string
  kind: 'divider' | 'item'
  /** 所属组名 (分隔线行与条目行都有, 用于顶部悬浮组名) */
  groupName: string
  /** 条目行的历史数据 */
  item?: HistoryItem
}

/**
 * 在升序数组 `arr` 中查找第一个 `>= target` 的下标; 找不到时返回 `arr.length`。
 * 用于在虚拟列表的前缀偏移数组上二分定位可视窗口。
 */
const lowerBound = (arr: number[], target: number) => {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (arr[mid] < target) {
      lo = mid + 1
    } else {
      hi = mid
    }
  }
  return lo
}

/**
 * 在升序数组 `arr` 中查找最后一个 `<= target` 的下标; 全部大于 `target` 时返回 `-1`。
 * 用于按滚动位置定位视口顶部当前所在的行。
 */
const lastIndexAtMost = (arr: number[], target: number) => {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (arr[mid] <= target) {
      lo = mid + 1
    } else {
      hi = mid
    }
  }
  return lo - 1
}

export default Vue.extend({
  components: {
    VButton,
    VIcon,
    RadioButton,
    VLoading,
    VEmpty,
    DpiImage,
  },
  mixins: [popperMixin],
  data() {
    return {
      types: navbarFilterTypes,
      search: '',
      cards: [] as HistoryItem[],
      groups: [] as { name: string; items: HistoryItem[] }[],
      loading: true,
      syncing: false,
      total: 0,
      batches: 0,
      paused: false,
      searchIndex: null as ReturnType<typeof createHistoryIndex> | null,
      scrollTop: 0,
      scrollHeight: 0,
      scrollRaf: 0,
      groupsUpdatePending: false,
    }
  },
  computed: {
    /** 把分组结果扁平化为一行一行的序列 (分隔线行 + 条目行), 供虚拟滚动定位 */
    rows() {
      const result: FlatRow[] = []
      this.groups.forEach((g, index) => {
        // 分组之间用一条横线分隔, 首个分组前不需要
        if (index > 0) {
          result.push({ key: `d-${g.name}`, kind: 'divider', groupName: g.name })
        }
        for (const item of g.items) {
          result.push({ key: `i-${item.id}`, kind: 'item', groupName: g.name, item })
        }
      })
      return result
    },
    /** 每一行顶部的偏移 (前缀和), 用于二分定位可视窗口 */
    rowTops() {
      const tops: number[] = []
      let acc = 0
      for (const row of this.rows) {
        tops.push(acc)
        acc += row.kind === 'divider' ? DIVIDER_HEIGHT : ITEM_HEIGHT
      }
      return tops
    },
    /** 列表总高度, 用于撑高滚动容器 */
    totalHeight() {
      const tops = this.rowTops
      if (tops.length === 0) {
        return 0
      }
      const last = this.rows[this.rows.length - 1]
      return tops[tops.length - 1] + (last.kind === 'divider' ? DIVIDER_HEIGHT : ITEM_HEIGHT)
    },
    /** 当前应渲染的窗口: 可视区 + 上下 OVERSCAN 缓冲的行 */
    windowRows() {
      const { rows } = this
      if (rows.length === 0) {
        return []
      }
      const viewTop = Math.max(0, this.scrollTop)
      const viewHeight = this.scrollHeight || 600
      const endBound = viewTop + viewHeight
      const endExclusive = Math.min(rows.length, lowerBound(this.rowTops, endBound))
      const start = Math.max(0, lowerBound(this.rowTops, viewTop) - OVERSCAN)
      const result: { row: FlatRow; top: number }[] = []
      for (let i = start; i < endExclusive; i++) {
        result.push({ row: rows[i], top: this.rowTops[i] })
      }
      return result
    },
    /**
     * 当前视口顶部所在行的组名, 用于顶部悬浮的分组条。
     * 必须按 `scrollTop` 定位, 不能用 `windowRows` 的首行 —— 渲染窗口含 OVERSCAN 缓冲,
     * 首行在视口上方约 10 行, 会让悬浮组名滞后约一屏才切换。
     */
    stickyGroup() {
      const { rows } = this
      if (rows.length === 0) {
        return ''
      }
      const index = lastIndexAtMost(this.rowTops, Math.max(0, this.scrollTop))
      return rows[Math.max(0, index)].groupName
    },
  },
  watch: {
    search() {
      this.queueGroupsUpdate()
    },
    loading(value) {
      // 列表容器在 loading 结束 (v-else) 后才存在, 结束时测量其可视高度
      if (!value) {
        this.$nextTick(() => this.measureScroll())
      }
    },
  },
  async created() {
    try {
      await Promise.all([this.loadAll(), this.updateHistoryPauseState()])
      // 增量同步新记录, 完成后会重载显示。
      // 同步与加载分离: loadAll 不再触发 backgroundSync, 避免两者相互调用形成循环。
      this.backgroundSync()
    } finally {
      this.loading = false
    }
  },
  mounted() {
    this.resizeHandler = () => this.measureScroll()
    window.addEventListener('resize', this.resizeHandler)
  },
  beforeDestroy() {
    window.removeEventListener('resize', this.resizeHandler)
  },
  methods: {
    onSearchInput(event: Event) {
      // 直接用 @input 同步 search, 不经过 TextBox 的 change/composition 逻辑,
      // 避免输入法切换导致 search 与输入框值不一致, 从而被 :value 回写覆盖(表现为输入内容闪失)
      this.search = (event.target as HTMLInputElement).value
    },
    setTypeFilter(typeFilter: TypeFilter) {
      navbarFilterTypes.forEach(t => (t.checked = t.name === typeFilter.name))
      this.updateGroups()
    },
    async loadAll() {
      const all = await getAllHistory()
      if (all.length === 0) {
        // 本地还没有任何历史, 触发首次全量抓取
        await this.syncAll()
        return
      }
      // 改动前存下的记录没有拼音字段, 先统一补算 (只算缺字段的, 结果有缓存)
      all.forEach(ensurePinyinFields)
      this.cards = all
      this.searchIndex = createHistoryIndex(all)
      // 数据刷新(首次读取/后台增量同步完成后重载)时保留当前滚动位置,
      // 避免用户在浏览过程中被强制拉回顶部。
      // 注意: loadAll 不得在末尾触发 backgroundSync, 否则 backgroundSync 完成后的
      // `await this.loadAll()` 会再次进入这里, 两者相互调用形成无限循环。
      this.updateGroups(false)
    },
    async backgroundSync() {
      this.syncing = true
      try {
        await syncHistory({
          onProgress: status => {
            this.total = status.total
            this.batches = status.batches
          },
        })
        await this.loadAll()
      } finally {
        this.syncing = false
      }
    },
    async syncAll() {
      this.syncing = true
      this.loading = true
      try {
        await syncHistory({
          onProgress: status => {
            this.total = status.total
            this.batches = status.batches
          },
        })
        await this.loadAll()
      } finally {
        this.syncing = false
        this.loading = false
      }
    },
    async reloadHistoryItems() {
      await this.syncAll()
    },
    /**
     * 弹窗每次展开时由 CustomNavbarItem 调用 (refreshOnPopup 开启时) 自动刷新。
     * popup 组件在首次展开后常驻 DOM, created 只会执行一次, 后续展开靠这里增量同步。
     */
    async popupRefresh() {
      await this.backgroundSync()
    },
    queueGroupsUpdate() {
      if (this.groupsUpdatePending) {
        return
      }
      this.groupsUpdatePending = true
      requestAnimationFrame(() => {
        this.groupsUpdatePending = false
        this.updateGroups()
      })
    },
    measureScroll() {
      const el = this.$refs.cards as HTMLElement
      if (el) {
        this.scrollHeight = el.clientHeight
      }
    },
    /** 滚动时用 rAF 节流更新 scrollTop, 避免每帧触发虚拟窗口重算 */
    onCardsScroll() {
      if (this.scrollRaf) {
        return
      }
      this.scrollRaf = requestAnimationFrame(() => {
        this.scrollRaf = 0
        const el = this.$refs.cards as HTMLElement
        if (el) {
          this.scrollTop = el.scrollTop
        }
      })
    },
    updateGroups(resetScroll = true) {
      // 过滤/分组结果变化时重新生成分组数据。
      // resetScroll=true: 搜索/切换类型等用户主动改变结果时回到顶部(默认)。
      // resetScroll=false: 数据刷新(loadAll)时保留滚动位置, 避免打断浏览。
      const checkedType = this.types.find(t => t.checked)
      const filtered = filterHistory(this.cards, this.search, this.searchIndex ?? undefined)
      const grouped = group(filtered)
      if (checkedType && checkedType.name !== HistoryType.All) {
        this.groups = grouped
          .map(g => ({
            name: g.name,
            items: g.items.filter(item => item.type === checkedType.name),
          }))
          .filter(g => g.items.length > 0)
      } else {
        this.groups = grouped.filter(g => g.items.length > 0)
      }
      if (resetScroll) {
        this.scrollTop = 0
      }
      this.$nextTick(() => {
        const el = this.$refs.cards as HTMLElement
        if (el) {
          if (resetScroll) {
            el.scrollTop = 0
          }
          this.measureScroll()
        }
      })
    },
    async updateHistoryPauseState() {
      const result = await bilibiliApi(
        getJsonWithCredentials('https://api.bilibili.com/x/v2/history/shadow'),
      )
      /*
        result == true: 暂停
        result == {}: 没暂停
      */
      this.paused = result === true
    },
    async toggleHistoryPause() {
      const targetState = !this.paused
      try {
        this.paused = targetState
        await postTextWithCredentials(
          'https://api.bilibili.com/x/v2/history/shadow/set',
          new URLSearchParams({
            csrf: getCsrf(),
            switch: targetState.toString(),
          }).toString(),
        )
      } catch (error) {
        this.paused = !targetState
      }
    },
  },
})
</script>
<style lang="scss">
@import 'common';
@import '../../../components/style/custom-navbar/popup';

.custom-navbar-history-list {
  width: 400px;
  @include navbar-popup-height();
  font-size: 12px;
  padding: 0;
  margin: 0;
  @include v-stretch();
  justify-content: center;
  @mixin round-button($size: 26px) {
    width: $size;
    height: $size;
    box-sizing: border-box;
  }
  .header {
    @include v-stretch(6px);
    margin: 12px 12px 2px 12px;
    .header-row {
      @include h-stretch(8px);
      margin-bottom: 6px;
      &:last-child {
        margin-bottom: 0;
      }
      .row-title {
        @include h-center();
      }
      .search-input {
        flex: 1;
        .local-search-input {
          width: 100%;
          height: 100%;
          padding: 4px 6px;
          border: none;
          border-radius: 4px;
          outline: none !important;
          color: inherit;
          background-color: transparent;
          box-shadow: 0 0 0 1px #8884;
          &:focus {
            box-shadow: 0 0 0 1px var(--theme-color), 0 0 0 3px var(--theme-color-20);
          }
        }
      }
    }
    .type-filters {
      @include h-center(6px);
      .type-filter {
        .be-button {
          padding: 4px 8px 4px 6px;
        }
      }
    }
    .search {
      flex: 0 0 auto;
      .be-button {
        @include round-button();
      }
    }
    .operations {
      @include h-center(8px);
      margin-left: auto;
      .operation {
        .be-button {
          @include round-button();
        }
      }
    }
    .sync-status {
      @include h-center(4px);
      .sync-text {
        opacity: 0.6;
        font-size: 11px;
      }
    }
  }
  .content {
    @include v-stretch();
    @include no-scrollbar();
    justify-content: space-between;
    flex-grow: 1;
    .be-scroll-trigger,
    .be-empty,
    .be-loading {
      align-self: center;
      text-align: center;
      margin: 12px 0;
    }
    .cards {
      flex: 1;
      position: relative;
      @include no-scrollbar();
      padding-bottom: 12px;
      overflow-y: auto;
      // 把滚动容器隔离成独立 layout/paint 子树: 滚动时窗口行增删只在 .cards 内重排,
      // 不影响外部 popup; overscroll 阻止滚动穿透到容器外
      contain: layout paint;
      overscroll-behavior: contain;
      .empty-tip {
        text-align: center;
      }
      // 顶部悬浮的当前分组名, 替代原先每组的 sticky 标题
      .virtual-sticky-group {
        position: sticky;
        top: 0;
        z-index: 2;
        padding: 4px 12px 6px;
        font-size: 12px;
        font-weight: 600;
        background-color: #fff;
        body.dark & {
          background-color: var(--be-color-popup-bg, #222);
        }
      }
      // 虚拟列表总容器, 高度撑起滚动区
      .history-virtual {
        position: relative;
        min-height: 100%;
      }
      // 虚拟列表行: 绝对定位 + translateY
      // will-change: transform 让每行独立合成层, 滚动时 translateY 只走合成线程, 不触发重排/重绘
      .virtual-row {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        box-sizing: border-box;
        will-change: transform;
        &.virtual-row-divider {
          height: 55px;
        }
      }
      // 分组之间用来分隔的横线, 高度留出一个视频卡片的空间
      .group-divider {
        height: 55px;
        display: flex;
        align-items: center;
        &::before {
          content: '';
          flex: 1;
          height: 1px;
          margin: 0 12px;
          background-color: rgba(136, 136, 136, 0.3);
        }
      }
      .floating {
        @include round-bar(16);
        @include h-center();
        background-color: #000c;
        color: white;
        justify-content: center;
        position: absolute;
        font-size: 11px;
        padding: 2px 4px;
        &.pages {
          bottom: 4px;
          right: 4px;
        }
      }
      .time-group-item {
        height: 55px;
        display: grid;
        grid-template:
          'cover title title' 5fr
          'cover up time' 6fr / 80px 1fr auto;
        border-radius: 8px;
        color: black;
        background-color: #fff;
        box-shadow: 0 4px 12px 0 rgba(0, 0, 0, 0.05);
        border: 1px solid #8882;
        box-sizing: border-box;
        body.dark & {
          background-color: var(--be-color-card-bg, #282828);
          color: var(--be-color-text-title, #eee);
        }
        &:hover {
          .cover {
            transform: scale(1.05);
          }
        }
        .history-cover-container {
          $height: 55px;
          grid-area: cover;
          position: relative;
          height: $height;
          overflow: hidden;
          border-radius: 7px 0 0 7px;
          .cover {
            object-fit: cover;
            width: 80px;
            height: $height;
            body.dark &.placeholder {
              filter: invert(0.9);
            }
          }
          .progress {
            position: absolute;
            bottom: 0;
            left: 0;
            height: 2px;
            border-radius: 1px;
            background-color: var(--theme-color);
          }
        }
        .title {
          @include semi-bold();
          grid-area: title;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          align-self: end;
          margin: 0;
          line-height: normal;
          display: block;
          padding-left: 8px;
          padding-right: 6px;
          font-size: 13px;
          &:hover {
            color: var(--theme-color) !important;
          }
        }
        .up,
        .history-info {
          font-size: 11px;
          opacity: 0.75;
          align-self: center;
        }
        .up {
          grid-area: up;
          @include h-center();
          padding-left: 8px;
          opacity: 1;
          .be-icon {
            margin-right: 4px;
            font-size: 14px;
          }
          &-face {
            border-radius: 50%;
            width: 18px;
            height: 18px;
            margin-right: 4px;
          }
          &-name {
            white-space: nowrap;
            max-width: 160px;
            overflow: hidden;
            text-overflow: ellipsis;
            opacity: 0.75;
            &:hover {
              opacity: 1;
            }
          }
        }
        .history-info {
          @include h-center(4px);
          font-size: 11px;
          grid-area: time;
          padding-right: 6px;
          &-separator {
            margin: 0 4px;
          }
        }
        .progress-number,
        .live-status {
          @include single-line();
        }
        .live-status {
          &.on {
            color: var(--theme-color);
          }
        }
      }
    }
  }
}
</style>
