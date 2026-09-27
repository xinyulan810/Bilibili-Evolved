import { PluginMetadata } from '@/plugins/plugin'
import type { CustomNavbarItemInit } from '../../../components/style/custom-navbar/custom-navbar-item'

/**
 * 把顶栏"历史"弹窗的搜索替换为"本地历史库"版本:
 * 全量抓取历史存到 IndexedDB, 搜索直接在最全的本地数据上过滤,
 * 从而能搜到早期观看的视频。
 */
export const plugin: PluginMetadata = {
  name: 'customNavbar.items.localHistory',
  displayName: '自定义顶栏 - 本地历史搜索',
  author: {
    name: 'xinyulan810 (with DeepSeek)',
    link: 'https://github.com/xinyulan810',
  },
  async setup({ addData }) {
    addData('customNavbar.items', (items: CustomNavbarItemInit[]) => {
      const historyItem = items.find(item => item.name === 'history')
      if (!historyItem) {
        return
      }
      // 仅当登录后才可能抓取历史
      historyItem.loginRequired = true
      // 覆盖弹窗内容为本地检索组件
      historyItem.popupContent = () => import('./NavbarLocalHistory.vue').then(m => m.default)
    })
  },
}
