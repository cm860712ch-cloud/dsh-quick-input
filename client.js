/**
 * 应声 · 快捷输入 —— 浏览器半区。
 *
 * 这段代码不是被 import 的，而是被 DSH 的客户端模块加载器当成脚本文本取走、
 * 在页面里执行。约定：
 *   1. 调用 window.__ModuleLoader__.load({ id, factory })
 *   2. id 必须等于 package.json 里的包名
 *   3. factory(require) 里用 require('react') 拿 React（宿主模块表提供，不要自己装）
 *   4. factory 只负责返回插件对象，副作用放在 apply 里
 *
 * 它做三件事：
 *   - 在输入框工具行最左边画一个 ⊞（槽位 conversation.input.left）
 *   - 点开后，在输入框左上角浮出 3×3 九宫格（槽位 conversation.input.overlay）
 *   - 点某一格 → 把该格文字插到草稿的「光标处」（官方 inputActions.insertText）
 *
 * 不碰 document.body、不读别的插件的 DOM、不 require 任何 @deepseek-ai/* 包。
 */

window.__ModuleLoader__.load({
  id: 'dsh-quick-input',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    // ------------------------------------------------------------ 常量

    const TOGGLE_SLOT = 'conversation.input.left'
    const PANEL_SLOT = 'conversation.input.overlay'
    const API = '/quick-input'

    /** 客户端构建号：页面加载时回报给宿主，`GET /quick-input/health` 里能看到跑的是哪一份。 */
    const CLIENT_BUILD = '0.1.0+build8'

    /** 文案命名空间：注册槽位时带上它，槽位就会把 `t` 交给组件。 */
    const NS = 'quick-input'

    /**
     * 中英文字典。DSH 的 locale 服务要求一次把两种语言都注册齐；
     * 缺 key 时会依次回退到 common 命名空间，最后直接显示 key 本身。
     * `{name}` 是占位符，由 t(key, { name }) 填。
     */
    const DICT = {
      zh: {
        toggleShow: '展开快捷输入（常驻在输入框左边）',
        toggleHide: '收起快捷输入',
        toggleAria: '快捷输入',
        panelAria: '快捷输入九宫格',
        prevPage: '上一页',
        nextPage: '下一页',
        addPage: '新增一页',
        addPageShort: '＋页',
        editPresets: '编辑预设',
        finishEdit: '完成编辑',
        done: '完成',
        collapse: '收起（也可点 ⊞）',
        pageName: '页名',
        deletePage: '删页',
        deletePageHint: '至少要保留一页',
        pageNumber: '第 {index} 页',
        pageHint: '{title} · 第 {index}/{total} 页',
        loading: '正在读取预设…',
        readFailed: '读预设失败：{message}',
        retry: '重试',
        retryRead: '读预设失败，重试',
        unknownError: '未知错误',
        unnamed: '未命名',
        emptyCell: '这一格还空着，点一下填内容',
        editCell: '改这一格：{text}',
        cellName: '名称',
        cellNamePlaceholder: '格子上显示的短标签',
        cellText: '内容',
        cellTextPlaceholder: '点击这一格时要插进输入框的文字',
        save: '保存',
        saving: '保存中…',
        clearCell: '清空此格',
        back: '返回',
        saved: '已保存',
        cleared: '已清空这一格',
        newPageReady: '新页已建好，填第一个格子吧',
        textRequired: '内容不能为空；想清空这一格请用右边那个按钮',
        pageGone: '这一页已经不存在了',
        inserted: '已插入：{text}',
        insertBusy: '正在发送，等这轮结束再点',
        insertInert: '当前输入框不可编辑',
        insertNoInput: '这个位置插不进去：输入框没接上',
        insertConflict: '草稿刚变过，再点一次',
      },
      en: {
        toggleShow: 'Show quick input (docked left of the composer)',
        toggleHide: 'Hide quick input',
        toggleAria: 'Quick input',
        panelAria: 'Quick input grid',
        prevPage: 'Previous page',
        nextPage: 'Next page',
        addPage: 'Add a page',
        addPageShort: '+ Page',
        editPresets: 'Edit presets',
        finishEdit: 'Finish editing',
        done: 'Done',
        collapse: 'Hide (or click ⊞)',
        pageName: 'Page name',
        deletePage: 'Delete',
        deletePageHint: 'Keep at least one page',
        pageNumber: 'Page {index}',
        pageHint: '{title} · page {index} of {total}',
        loading: 'Loading presets…',
        readFailed: 'Failed to load presets: {message}',
        retry: 'Retry',
        retryRead: 'Load failed — retry',
        unknownError: 'Unknown error',
        unnamed: 'Untitled',
        emptyCell: 'Empty cell — click to fill it',
        editCell: 'Edit cell: {text}',
        cellName: 'Name',
        cellNamePlaceholder: 'Short label shown on the cell',
        cellText: 'Text',
        cellTextPlaceholder: 'Text inserted into the composer when this cell is clicked',
        save: 'Save',
        saving: 'Saving…',
        clearCell: 'Clear cell',
        back: 'Back',
        saved: 'Saved',
        cleared: 'Cell cleared',
        newPageReady: 'New page created — fill in the first cell',
        textRequired: 'Text cannot be empty; use the button on the right to clear this cell',
        pageGone: 'That page no longer exists',
        inserted: 'Inserted: {text}',
        insertBusy: 'Sending — try again when this turn finishes',
        insertInert: 'The composer is not editable right now',
        insertNoInput: 'Cannot insert here: the composer is not connected',
        insertConflict: 'The draft just changed — click again',
      },
    }

    /** 当前的界面语言（`en` / `zh` …），只用于"文件还不存在时种哪套示例"。 */
    let activeLocaleId = 'zh'
    /** `ctx.locale.bind(NS)` 拿到的翻译函数：给不是组件的那些函数兜底。 */
    let boundT = null

    /** 填 `{name}` 占位符。 */
    function format(template, params) {
      if (typeof template !== 'string') return ''
      if (!params) return template
      return template.replace(/\{(\w+)\}/g, (whole, key) => (params[key] === undefined ? whole : String(params[key])))
    }

    /** 中文兜底（拿不到 locale 服务时至少不会显示成 key）。 */
    function zhT(key, params) {
      return format(DICT.zh[key] ?? key, params)
    }

    /** 模块级取词：错误信息、短标签这些不在组件里的地方用它。 */
    function tr(key, params) {
      return (boundT ?? zhT)(key, params)
    }

    /** 组件取词：优先用槽位注入的 t（跟随 DSH 的语言设置），拿不到才退回模块级。 */
    function translator(props) {
      return props && typeof props.t === 'function' ? props.t : tr
    }

    const CELLS_PER_PAGE = 9
    const MAX_PAGES = 12
    const MAX_LABEL = 12
    const MAX_PAGE_TITLE = 12
    const MAX_CELL_TEXT = 2000

    /**
     * 面板形态：
     *   true  → 常驻贴在输入框左边，高度与输入框卡片一致（默认；窗口太窄时退回上面浮层）
     *   false → 固定成输入框上方的一块浮层（旧形态）
     * 侧挂时渲染后自测一次：探测点落在自己身上才保留，否则退回浮层。
     */
    const SIDE_BY_SIDE = true

    /** 量不到输入框卡片高度时的兜底高度（≈ 空草稿时卡片的高度）。 */
    const DEFAULT_CARD_HEIGHT = 104

    /**
     * 面板的最小高度：3 行 × 两行文字（24px）+ 行距 + 控制栏 + 内边距。
     * 空草稿的输入框卡片约 102px，比这个矮，所以面板会上下各外扩几像素；
     * 草稿变长、卡片超过这个高度时，两者就严格等高。
     */
    const MIN_PANEL_HEIGHT = 116

    /**
     * 面板宽度：不写死，按「输入框左边到会话列左边缘」的实测空隙自适应。
     * 空隙不够就窄一点，窄到下限还放不下才退回上方浮层。
     */
    const PANEL_MIN_WIDTH = 120
    const PANEL_MAX_WIDTH = 232
    /** 面板与输入框之间的缝。 */
    const PANEL_GAP = 8

    const CSS = `
.dsq-btn{box-sizing:border-box;width:28px;height:28px;flex:none;display:grid;place-items:center;padding:0;border:0;border-radius:999px;background:var(--dsw-specific-selector,var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12)));color:var(--dsw-alias-label-primary,#1f2328);cursor:pointer;transition:background-color .12s ease}
.dsq-btn:hover{background:var(--dsw-alias-interactive-bg-hover-solid,var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.2)))}
.dsq-btn-on{color:var(--dsw-alias-brand-primary,#4d6bfe)}
.dsq-panel{position:absolute;z-index:40;box-sizing:border-box;max-width:calc(100vw - 24px);display:flex;flex-direction:column;gap:3px;padding:4px;border-radius:var(--dsw-radius-panel,12px);background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1,#fff));border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));box-shadow:var(--dsw-elevation-soft,0 8px 28px rgba(0,0,0,.18));color:var(--dsw-alias-label-primary,#1f2328);text-align:left;font-size:11px;line-height:12px}
.dsq-body{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.dsq-body-scroll{overflow-y:auto}
.dsq-grid{flex:1;min-height:0;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));grid-auto-rows:minmax(0,1fr);gap:3px}
.dsq-cell{box-sizing:border-box;min-height:18px;display:flex;align-items:flex-start;gap:2px;padding:2px 4px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,#1f2328);font-size:11px;line-height:12px;text-align:left;overflow-wrap:anywhere;cursor:pointer;transition:background-color .12s ease,border-color .12s ease}
.dsq-cell:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));border-color:var(--dsw-alias-border-l2,rgba(0,0,0,.2))}
.dsq-cell-label{flex:1;min-width:0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.dsq-cell-mark{margin-left:auto;font-size:9px;line-height:12px;opacity:.55}
.dsq-cell-empty{justify-content:center;align-items:center;border-style:dashed;color:var(--dsw-alias-state-idle-primary,#98a2b3);font-size:12px}
.dsq-bar{display:flex;align-items:center;gap:2px;flex:none;height:14px;font-size:10px;line-height:14px;color:var(--dsw-alias-label-secondary,#667085)}
.dsq-mini{box-sizing:border-box;flex:none;height:14px;padding:0 3px;border:0;border-radius:4px;background:transparent;color:inherit;font-size:10px;line-height:14px;cursor:pointer}
.dsq-mini:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,#1f2328)}
.dsq-mini:disabled{opacity:.45;cursor:default}
.dsq-count{flex:none;min-width:30px;text-align:center;font-size:10px;color:var(--dsw-alias-label-secondary,#667085)}
.dsq-pagename{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;color:var(--dsw-alias-label-primary,#1f2328)}
.dsq-flash{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right;font-size:10px}
.dsq-row{display:flex;align-items:center;gap:6px}
.dsq-row-label{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary,#667085)}
.dsq-input,.dsq-textarea{box-sizing:border-box;width:100%;padding:5px 8px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary,#1f2328);font-family:inherit;font-size:12px;line-height:18px;outline:none}
.dsq-textarea{resize:vertical;min-height:84px;white-space:pre-wrap}
.dsq-input:focus,.dsq-textarea:focus{border-color:var(--dsw-alias-brand-primary,#4d6bfe)}
.dsq-actions{display:flex;align-items:center;gap:6px}
.dsq-action{box-sizing:border-box;height:26px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary,#1f2328);font-size:12px;line-height:18px;cursor:pointer}
.dsq-action:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dsq-action-primary{border-color:transparent;background:var(--dsw-alias-brand-primary,#4d6bfe);color:#fff}
.dsq-action-primary:hover{background:var(--dsw-alias-brand-primary,#4d6bfe);opacity:.9}
.dsq-ok{color:var(--dsw-alias-state-success-primary,#12b76a)}
.dsq-err{color:var(--dsw-alias-state-error-primary,#d92d20)}
.dsq-muted{color:var(--dsw-alias-label-secondary,#667085)}
`

    // ------------------------------------------------------------ 小工具

    /** 任何异常都变成一句能显示的话。 */
    function messageOf(error) {
      if (error instanceof Error && error.message) return error.message
      if (typeof error === 'string' && error !== '') return error
      return tr('unknownError')
    }

    /** 按鼠标/焦点事件不要抢走编辑器的光标（插入点靠它保住）。 */
    function keepFocus(event) {
      if (event && typeof event.preventDefault === 'function') event.preventDefault()
    }

    /** 去换行、限长的短标签。 */
    function toLabel(value, fallbackText) {
      const source = typeof value === 'string' && value.trim() !== '' ? value : fallbackText
      const flat = String(source || '').replace(/\s+/g, ' ').trim()
      if (flat === '') return tr('unnamed')
      return flat.length > MAX_LABEL ? `${flat.slice(0, MAX_LABEL - 1)}…` : flat
    }

    /** 把宿主给的文档收成页面数组；脏数据只会退化成空格子。 */
    function normalizeDoc(input) {
      const rawPages = input && Array.isArray(input.pages) ? input.pages : []
      const pages = []
      for (const rawPage of rawPages) {
        if (pages.length >= MAX_PAGES) break
        const rawCells = rawPage && Array.isArray(rawPage.cells) ? rawPage.cells : []
        const cells = []
        for (let i = 0; i < CELLS_PER_PAGE; i++) {
          const rawCell = rawCells[i]
          const text = rawCell && typeof rawCell.text === 'string' ? rawCell.text.slice(0, MAX_CELL_TEXT) : ''
          if (text.trim() === '') {
            cells.push(null)
            continue
          }
          cells.push({ label: toLabel(rawCell.label, text), text })
        }
        const flatTitle =
          rawPage && typeof rawPage.title === 'string' ? rawPage.title.replace(/\s+/g, ' ').trim() : ''
        pages.push({
          title: flatTitle === '' ? tr('pageNumber', { index: pages.length + 1 }) : flatTitle.slice(0, MAX_PAGE_TITLE),
          cells,
        })
      }
      return { pages }
    }

    function clonePages() {
      return store.doc.pages.map((page) => ({
        title: page.title,
        cells: page.cells.map((cell) => (cell ? { label: cell.label, text: cell.text } : null)),
      }))
    }

    // ------------------------------------------------------------ 常驻开关的记忆

    const OPEN_KEY = 'quick-input.open'

    /** 记住面板是开着还是关着：开着就刷新页面后依然常驻在输入框左边。 */
    function readOpenFlag() {
      try {
        return window.localStorage !== undefined && window.localStorage !== null && window.localStorage.getItem(OPEN_KEY) === '1'
      } catch {
        return false
      }
    }

    function writeOpenFlag(value) {
      try {
        if (window.localStorage) window.localStorage.setItem(OPEN_KEY, value ? '1' : '0')
      } catch {
        /* 存不了就算了，不影响界面 */
      }
    }

    /** 本会话的面板开着吗：没手动开过关过，就跟着上次的常驻开关走。 */
    function isOpen(sessionId) {
      return store.open.has(sessionId) ? store.open.get(sessionId) === true : readOpenFlag()
    }

    // ------------------------------------------------------------ 模块级共享状态

    /**
     * 两个槽位是两个独立注册项，靠这份模块级 store 通信。
     * 所有会话相关的键都用 sessionId，避免多个会话（侧边栏对话标签）串台。
     */
    const store = {
      open: new Map(),
      page: new Map(),
      /** 是否处于「编辑态」：格子的左键从「插入」变成「改这一格」。 */
      editMode: new Map(),
      /** 正在编辑哪一格：`{ page, cell }`，null 表示没在编辑器里。 */
      editing: new Map(),
      flash: new Map(),
      doc: { status: 'idle', pages: [], error: '' },
      listeners: new Set(),
      emit() {
        for (const listener of Array.from(this.listeners)) {
          try {
            listener()
          } catch {
            /* 单个订阅者出错不该影响别人 */
          }
        }
      },
      subscribe(listener) {
        this.listeners.add(listener)
        return () => {
          this.listeners.delete(listener)
        }
      },
    }

    const flashTimers = new Map()

    /** 在面板底部闪一条结果，2.4 秒后自动消失。 */
    function setFlash(sessionId, kind, text) {
      store.flash.set(sessionId, { kind, text })
      const previous = flashTimers.get(sessionId)
      if (previous !== undefined) clearTimeout(previous)
      flashTimers.set(
        sessionId,
        setTimeout(() => {
          flashTimers.delete(sessionId)
          store.flash.delete(sessionId)
          store.emit()
        }, 2400),
      )
      store.emit()
    }

    // ------------------------------------------------------------ 与宿主通信

    async function request(path, options) {
      const response = await fetch(`${API}${path}`, options)
      let body = null
      try {
        body = await response.json()
      } catch {
        body = null
      }
      if (!response.ok || !body || body.ok !== true) {
        const detail = body && (body.message || body.error) ? String(body.message || body.error) : ''
        throw new Error(detail === '' ? `HTTP ${response.status}` : detail)
      }
      return body.value
    }

    /** 拉一次预设；不 force 时已有数据就不重复拉。 */
    function ensureDoc(force) {
      if (store.doc.status === 'loading') return
      if (force !== true && store.doc.status === 'ready') return
      store.doc = { status: 'loading', pages: store.doc.pages, error: '' }
      store.emit()
      // 带上界面语言：预设文件还不存在时，宿主按它种一套对应语言的示例。
      request(`/presets?lang=${encodeURIComponent(activeLocaleId)}`)
        .then((value) => {
          store.doc = { status: 'ready', pages: normalizeDoc(value).pages, error: '' }
          store.emit()
        })
        .catch((error) => {
          // 读失败也保留上一次的页面：别的会话还开着面板时，不该跟着一起变空。
          store.doc = { status: 'error', pages: store.doc.pages, error: messageOf(error) }
          store.emit()
        })
    }

    /** 存一整份文档；成功后用宿主返回的规范化结果刷新本地。 */
    async function commit(pages) {
      const saved = await request('/presets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pages }),
      })
      store.doc = { status: 'ready', pages: normalizeDoc(saved).pages, error: '' }
      store.emit()
    }

    // ------------------------------------------------------------ 插入草稿

    /**
     * 把文字插到草稿的光标处。
     *
     * `insertText` 有两种失败原因，必须分开说：
     *   1. 正在发送/裁决（phase = adjudicating | submitting）——重试也没用，等这一轮结束；
     *   2. 草稿版本变了（用户刚好在打字）——重新抓一次光标再试，两次都失败才提示。
     * `phase` 来自槽位给的 useInput；拿不到就当未知，照常尝试。
     */
    function insertIntoDraft(inputActions, text, phase) {
      if (phase === 'adjudicating' || phase === 'submitting') {
        return { ok: false, reason: tr('insertBusy') }
      }
      if (phase === 'inert') return { ok: false, reason: tr('insertInert') }
      if (!inputActions || typeof inputActions.insertText !== 'function') {
        return { ok: false, reason: tr('insertNoInput') }
      }
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          const span = inputActions.captureInsertion()
          if (inputActions.insertText(text, span)) return { ok: true }
        }
        return { ok: false, reason: tr('insertConflict') }
      } catch (error) {
        return { ok: false, reason: messageOf(error) }
      }
    }

    /** 从 InputState 里只取 phase（原始值选择器，避免每次敲键都重渲染）。 */
    function selectPhase(state) {
      return state && typeof state.phase === 'string' ? state.phase : undefined
    }

    // ------------------------------------------------------------ 位置自测

    /**
     * 找「输入框卡片」这个盒子：面板往上走，第一个高度不是 0 的祖先就是它
     * （中间的槽位容器和锚点都是零高度）。只用来量高度；读不到就当量不到。
     */
    function findCardElement(node) {
      try {
        let current = node && node.parentElement ? node.parentElement : null
        for (let depth = 0; current && depth < 6; depth++) {
          const rect = typeof current.getBoundingClientRect === 'function' ? current.getBoundingClientRect() : null
          if (rect && rect.height > 20) return current
          current = current.parentElement
        }
      } catch {
        /* 读不到就当没有 */
      }
      return null
    }

    /**
     * 找「会话列」这个盒子：卡片往上走，第一个明显比卡片宽的祖先就是它。
     * 用它算出输入框左边还剩多少空隙——面板宽度按这个空隙自适应。
     */
    function findColumnRect(cardNode) {
      try {
        if (!cardNode || typeof cardNode.getBoundingClientRect !== 'function') return null
        const cardRect = cardNode.getBoundingClientRect()
        let current = cardNode.parentElement
        for (let depth = 0; current && depth < 5; depth++) {
          const rect = typeof current.getBoundingClientRect === 'function' ? current.getBoundingClientRect() : null
          if (rect && rect.width > cardRect.width + 24) return rect
          current = current.parentElement
        }
      } catch {
        /* 读不到就当量不到 */
      }
      return null
    }

    /**
     * 侧挂是否可行：量自己的框，再用 elementFromPoint 探自己身上的一点。
     * 探到的不是自己（被裁掉、或被左侧栏盖住）就退回「输入框上方浮层」。
     */
    function canSideDock(node) {
      if (!node || typeof node.getBoundingClientRect !== 'function') return false
      try {
        const rect = node.getBoundingClientRect()
        if (!rect || rect.width <= 0 || rect.height <= 0) return false
        if (rect.left < 8 || rect.right > window.innerWidth + 1) return false
        const doc = window.document
        if (!doc || typeof doc.elementFromPoint !== 'function') return false
        const probe = doc.elementFromPoint(Math.round(rect.left) + 6, Math.round(rect.top) + 6)
        return probe !== null && probe !== undefined && typeof node.contains === 'function' && node.contains(probe)
      } catch {
        return false
      }
    }

    // ------------------------------------------------------------ hook 小工具

    /** 订阅 store：任何一处 emit 都让本组件重渲染。 */
    function useStore() {
      const [, bump] = React.useState(0)
      React.useEffect(
        () =>
          store.subscribe(() => {
            bump((n) => n + 1)
          }),
        [],
      )
    }

    // ------------------------------------------------------------ 图标

    /** 3×3 圆点：一眼就是「九宫格」。 */
    function GridIcon() {
      const dots = []
      for (let row = 0; row < 3; row++) {
        for (let column = 0; column < 3; column++) {
          dots.push(
            h('rect', {
              key: `${row}-${column}`,
              x: 1.5 + column * 5,
              y: 1.5 + row * 5,
              width: 3.4,
              height: 3.4,
              rx: 1.1,
            }),
          )
        }
      }
      return h(
        'svg',
        { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': 'true' },
        dots,
      )
    }

    // ------------------------------------------------------------ ⊞ 开关

    function QuickToggle(props) {
      useStore()
      const t = translator(props)
      const sessionId = props.sessionId
      const open = isOpen(sessionId)
      return h(
        React.Fragment,
        null,
        h('style', null, CSS),
        h(
          'button',
          {
            type: 'button',
            className: open ? 'dsq-btn dsq-btn-on' : 'dsq-btn',
            style: { WebkitAppearance: 'none' },
            title: open ? t('toggleHide') : t('toggleShow'),
            'aria-label': t('toggleAria'),
            'aria-expanded': open ? 'true' : 'false',
            onMouseDown: keepFocus,
            onClick: () => {
              const next = open !== true
              store.open.set(sessionId, next)
              writeOpenFlag(next)
              if (next) ensureDoc(false)
              store.emit()
            },
          },
          h(GridIcon, null),
        ),
      )
    }

    // ------------------------------------------------------------ 单格编辑器

    /** 编辑一格：名称 + 内容；保存走 POST /quick-input/presets。 */
    function CellEditor(props) {
      const t = translator(props)
      const sessionId = props.sessionId
      const page = store.doc.pages[props.page]
      const original = page && page.cells[props.cell] ? page.cells[props.cell] : null
      const [label, setLabel] = React.useState(original ? original.label : '')
      const [text, setText] = React.useState(original ? original.text : '')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')

      const close = () => {
        store.editing.set(sessionId, null)
        store.emit()
      }

      const saveCell = async (value) => {
        if (busy) return
        setBusy(true)
        setError('')
        const pages = clonePages()
        const target = pages[props.page]
        if (!target) {
          setError(t('pageGone'))
          setBusy(false)
          return
        }
        target.cells[props.cell] = value
        try {
          await commit(pages)
          setFlash(sessionId, 'ok', value === null ? t('cleared') : t('saved'))
          close()
        } catch (failure) {
          setError(messageOf(failure))
        } finally {
          setBusy(false)
        }
      }

      return h(
        'div',
        { className: 'dsq-actions', style: { flexDirection: 'column', alignItems: 'stretch', gap: 6 } },
        h('div', { className: 'dsq-row' }, h('span', { className: 'dsq-row-label' }, t('cellName'))),
        h('input', {
          className: 'dsq-input',
          value: label,
          maxLength: 40,
          placeholder: t('cellNamePlaceholder'),
          onChange: (event) => setLabel(event.target.value),
        }),
        h('div', { className: 'dsq-row' }, h('span', { className: 'dsq-row-label' }, t('cellText'))),
        h('textarea', {
          className: 'dsq-textarea',
          value: text,
          maxLength: MAX_CELL_TEXT,
          placeholder: t('cellTextPlaceholder'),
          onChange: (event) => setText(event.target.value),
        }),
        error !== '' ? h('div', { className: 'dsq-err' }, error) : null,
        h(
          'div',
          { className: 'dsq-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'dsq-action dsq-action-primary',
              disabled: busy,
              onClick: () => {
                if (text.trim() === '') {
                  setError(t('textRequired'))
                  return
                }
                saveCell({ label: label.trim() === '' ? toLabel('', text) : label.trim(), text })
              },
            },
            busy ? t('saving') : t('save'),
          ),
          original
            ? h(
                'button',
                { type: 'button', className: 'dsq-action', disabled: busy, onClick: () => saveCell(null) },
                t('clearCell'),
              )
            : null,
          h('button', { type: 'button', className: 'dsq-action', disabled: busy, onClick: close }, t('back')),
        ),
      )
    }

    // ------------------------------------------------------------ 页名/删页

    /** 编辑态下的一行：改页名、删这一页。 */
    function PageRow(props) {
      const t = translator(props)
      const sessionId = props.sessionId
      const page = store.doc.pages[props.page]
      const [title, setTitle] = React.useState(page ? page.title : '')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')

      const rename = async () => {
        const next = title.replace(/\s+/g, ' ').trim()
        if (busy || !page || next === page.title) return
        setBusy(true)
        setError('')
        try {
          const pages = clonePages()
          pages[props.page].title = next
          await commit(pages)
        } catch (failure) {
          setError(messageOf(failure))
        } finally {
          setBusy(false)
        }
      }

      const removePage = async () => {
        if (busy || store.doc.pages.length <= 1) return
        setBusy(true)
        setError('')
        try {
          const pages = clonePages()
          pages.splice(props.page, 1)
          await commit(pages)
          store.page.set(sessionId, Math.max(0, props.page - 1))
          store.editing.set(sessionId, null)
          store.emit()
        } catch (failure) {
          setError(messageOf(failure))
        } finally {
          setBusy(false)
        }
      }

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        h(
          'div',
          { className: 'dsq-row' },
          h('span', { className: 'dsq-row-label' }, t('pageName')),
          h('input', {
            className: 'dsq-input',
            value: title,
            maxLength: 40,
            onChange: (event) => setTitle(event.target.value),
            onBlur: rename,
            onKeyDown: (event) => {
              if (event.key === 'Enter') rename()
            },
          }),
          h(
            'button',
            {
              type: 'button',
              className: 'dsq-action',
              disabled: busy || store.doc.pages.length <= 1,
              title: store.doc.pages.length <= 1 ? t('deletePageHint') : `${t('deletePage')}: ${store.doc.pages[props.page]?.title ?? ''}`,
              onClick: removePage,
            },
            t('deletePage'),
          ),
        ),
        error !== '' ? h('div', { className: 'dsq-err' }, error) : null,
      )
    }

    // ------------------------------------------------------------ 九宫格面板

    function QuickPanel(props) {
      useStore()
      const t = translator(props)
      const sessionId = props.sessionId
      const open = isOpen(sessionId)
      const rootRef = React.useRef(null)
      const [dock, setDock] = React.useState(SIDE_BY_SIDE ? 'side' : 'above')
      const [panelWidth, setPanelWidth] = React.useState(PANEL_MAX_WIDTH)
      const [cardHeight, setCardHeight] = React.useState(0)
      const [room, setRoom] = React.useState(420)
      // 槽位标准 prop；拿不到就当未知（undefined），按老路照常尝试插入。
      const phase = typeof props.useInput === 'function' ? props.useInput(selectPhase) : undefined

      React.useEffect(() => {
        if (open) ensureDoc(false)
      }, [open])

      /**
       * 常驻形态下要自己量三件事（都只量自己和自己的宿主容器）：
       *   1. 侧挂（贴输入框左边）有没有被裁掉——量自己的框 + 探一个点；被裁就换窄一级再试，
       *      都放不下才退回「输入框上方浮层」；
       *   2. 输入框卡片有多高——面板要和它等高（往上找到第一个非零高度的祖先就是卡片）；
       *   3. 编辑态临时长高时上方还剩多少高度——超过可用空间的部分会被祖先的 overflow 裁掉。
       * 窗口尺寸变了、卡片随草稿长高了，都要重量一次。
       */
      React.useEffect(() => {
        if (!open) return
        /** @param allowSideRetry 窗口变化时允许从浮层状态重新试一次侧挂。 */
        const measure = (allowSideRetry) => {
          const node = rootRef.current
          // 自己还没挂上时什么都不动：探不到位置不等于「被裁」，别急着降级。
          if (!node || typeof node.getBoundingClientRect !== 'function') return
          let card = 0
          let free = null
          let space = 420
          try {
            const cardNode = findCardElement(node)
            const cardRect =
              cardNode && typeof cardNode.getBoundingClientRect === 'function' ? cardNode.getBoundingClientRect() : null
            if (cardRect && Number.isFinite(cardRect.height) && cardRect.height > 20) {
              card = Math.round(cardRect.height)
            }
            const columnRect = findColumnRect(cardNode)
            if (cardRect && columnRect && Number.isFinite(cardRect.left) && Number.isFinite(columnRect.left)) {
              free = Math.round(cardRect.left - columnRect.left)
            }
            const rect = node.getBoundingClientRect()
            // 侧挂时 rect.bottom 就是卡片下沿（视口坐标）；上方浮层时它是面板自己的下沿。
            if (rect && Number.isFinite(rect.bottom)) {
              space =
                dock === 'above'
                  ? Math.max(180, Math.min(460, Math.round(rect.bottom - 72)))
                  : Math.max(220, Math.min(460, Math.round(rect.bottom - 150)))
            }
          } catch {
            /* 量不到就用兜底值 */
          }

          // 1) 位置：左侧空隙连最窄的面板都放不下，就别试了。
          const enough = free === null || free - PANEL_GAP >= PANEL_MIN_WIDTH
          if (SIDE_BY_SIDE) {
            if (dock === 'above') {
              if (allowSideRetry === true && enough) {
                setDock('side')
                return
              }
            } else if (!enough) {
              setDock('above')
              return
            }
          }

          // 2) 宽度：贴着可用空隙走（浮层形态不受左侧限制，用最宽）。
          const wanted =
            dock === 'above' || free === null
              ? PANEL_MAX_WIDTH
              : Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, free - PANEL_GAP))
          if (wanted !== panelWidth) {
            // 先把宽度落到 DOM 上，下一轮再判位置——否则探的是旧宽度。
            setPanelWidth(wanted)
            return
          }

          // 3) 位置复核：宽度已经是最新的，真探一下自己还在不在。
          const probeOk = dock === 'above' ? null : canSideDock(node)
          if (SIDE_BY_SIDE && dock !== 'above' && probeOk !== true) {
            setDock('above')
            return
          }

          setCardHeight((previous) => (previous === card ? previous : card))
          setRoom((previous) => (previous === space ? previous : space))
          reportLayout({
            dock,
            width: panelWidth,
            card,
            free,
            probe: probeOk,
            innerWidth: window.innerWidth,
            locale: activeLocaleId,
          })
        }
        measure(false)
        const disposers = []
        if (typeof window.addEventListener === 'function') {
          const onResize = () => measure(true)
          window.addEventListener('resize', onResize)
          disposers.push(() => window.removeEventListener('resize', onResize))
        }
        // 草稿变长时卡片会长高，面板要跟着等高。
        const cardNode = findCardElement(rootRef.current)
        const Observer = window.ResizeObserver
        if (cardNode && typeof Observer === 'function') {
          try {
            const observer = new Observer(() => measure(false))
            observer.observe(cardNode)
            disposers.push(() => observer.disconnect())
          } catch {
            /* 观察不了就只靠 resize */
          }
        }
        return () => {
          for (const dispose of disposers) {
            try {
              dispose()
            } catch {
              /* 忽略 */
            }
          }
        }
      }, [open, store.doc.status, dock, panelWidth])

      if (!open) return null

      const pages = store.doc.pages
      const pageIndex = pages.length === 0 ? 0 : Math.min(Math.max(store.page.get(sessionId) ?? 0, 0), pages.length - 1)
      const page = pages[pageIndex]
      const editing = store.editing.get(sessionId) ?? null
      const editMode = store.editMode.get(sessionId) === true
      const flash = store.flash.get(sessionId) ?? null
      /** 编辑/改格子时要输入框和按钮，网格形态放不下，所以那两种形态临时长高并改为向上生长。 */
      const roomy = editMode === true || editing !== null
      const measured = cardHeight > 0 ? cardHeight : DEFAULT_CARD_HEIGHT
      const panelHeight = Math.max(measured, MIN_PANEL_HEIGHT)
      // 卡片比最小高度还矮时（空草稿就是），上下各外扩一半，视觉上仍然和输入框齐平。
      const overhang = Math.max(0, panelHeight - measured)

      const position =
        dock === 'side'
          ? roomy
            ? { right: '100%', bottom: 0, marginRight: PANEL_GAP, width: panelWidth, maxHeight: room }
            : {
                right: '100%',
                top: -overhang,
                marginRight: PANEL_GAP,
                width: panelWidth,
                height: panelHeight,
              }
          : { left: 0, bottom: 0, marginBottom: PANEL_GAP, width: panelWidth, maxHeight: room }

      const selectPage = (index) => {
        store.page.set(sessionId, index)
        store.editing.set(sessionId, null)
        store.emit()
      }

      const openEditor = (cell) => {
        store.page.set(sessionId, pageIndex)
        store.editing.set(sessionId, { page: pageIndex, cell })
        store.emit()
      }

      const close = () => {
        store.open.set(sessionId, false)
        store.editing.set(sessionId, null)
        store.editMode.set(sessionId, false)
        store.flash.delete(sessionId)
        writeOpenFlag(false)
        const timer = flashTimers.get(sessionId)
        if (timer !== undefined) {
          clearTimeout(timer)
          flashTimers.delete(sessionId)
        }
        store.emit()
      }

      const addPage = async () => {
        if (pages.length >= MAX_PAGES) return
        const created = {
          title: t('pageNumber', { index: pages.length + 1 }),
          cells: new Array(CELLS_PER_PAGE).fill(null),
        }
        const next = clonePages()
        next.push(created)
        try {
          await commit(next)
          store.page.set(sessionId, next.length - 1)
          store.editMode.set(sessionId, true)
          store.editing.set(sessionId, { page: next.length - 1, cell: 0 })
          setFlash(sessionId, 'ok', t('newPageReady'))
        } catch (failure) {
          setFlash(sessionId, 'err', messageOf(failure))
        }
      }

      const insertCell = (cell) => {
        const result = insertIntoDraft(props.inputActions, cell.text, phase)
        if (result.ok) setFlash(sessionId, 'ok', t('inserted', { text: toLabel('', cell.text) }))
        else setFlash(sessionId, 'err', result.reason)
      }

      /**
       * 底部一条 15px 的控制栏：翻页 + 编辑 + 关闭，以及一闪而过的结果提示。
       * 常驻形态和输入框等高，高度很紧，所以不放标题、不放提示文案。
       */
      const bar = h(
        'div',
        { className: 'dsq-bar' },
        pages.length > 1
          ? h(
              'button',
              {
                type: 'button',
                className: 'dsq-mini',
                title: t('prevPage'),
                onMouseDown: keepFocus,
                onClick: () => selectPage((pageIndex - 1 + pages.length) % pages.length),
              },
              '‹',
            )
          : null,
        h('span', { className: 'dsq-count', title: page ? page.title : '' }, `${pageIndex + 1}/${Math.max(pages.length, 1)}`),
        pages.length > 1
          ? h(
              'button',
              {
                type: 'button',
                className: 'dsq-mini',
                title: t('nextPage'),
                onMouseDown: keepFocus,
                onClick: () => selectPage((pageIndex + 1) % pages.length),
              },
              '›',
            )
          : null,
        editMode && pages.length < MAX_PAGES
          ? h(
              'button',
              { type: 'button', className: 'dsq-mini', title: t('addPage'), onMouseDown: keepFocus, onClick: addPage },
              t('addPageShort'),
            )
          : null,
        flash
          ? h('span', { className: `dsq-flash ${flash.kind === 'ok' ? 'dsq-ok' : 'dsq-err'}`, title: flash.text }, flash.text)
          : store.doc.status === 'error'
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'dsq-mini dsq-err',
                  title: t('readFailed', { message: store.doc.error }),
                  onMouseDown: keepFocus,
                  onClick: () => ensureDoc(true),
                },
                t('retryRead'),
              )
            : h(
                'span',
                {
                  className: 'dsq-pagename',
                  // 页名常驻在这里；翻页、改名都跟着变，长了就省略号 + 悬停看全名。
                  title: page
                    ? t('pageHint', { title: page.title, index: pageIndex + 1, total: Math.max(pages.length, 1) })
                    : '',
                },
                page ? page.title : '',
              ),
        h(
          'button',
          {
            type: 'button',
            className: 'dsq-mini',
            title: editMode ? t('finishEdit') : t('editPresets'),
            onMouseDown: keepFocus,
            onClick: () => {
              if (pages.length === 0) return
              store.editing.set(sessionId, null)
              store.editMode.set(sessionId, editMode !== true)
              store.emit()
            },
          },
          editMode ? t('done') : '✎',
        ),
        h(
          'button',
          { type: 'button', className: 'dsq-mini', title: t('collapse'), onMouseDown: keepFocus, onClick: close },
          '✕',
        ),
      )

      let body = null
      if (store.doc.status === 'loading' && pages.length === 0) {
        body = h('div', { className: 'dsq-muted' }, t('loading'))
      } else if (store.doc.status === 'error' && pages.length === 0) {
        body = h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          h('div', { className: 'dsq-err', style: { textAlign: 'left' } }, t('readFailed', { message: store.doc.error })),
          h(
            'button',
            { type: 'button', className: 'dsq-action', onMouseDown: keepFocus, onClick: () => ensureDoc(true) },
            t('retry'),
          ),
        )
      } else if (editing !== null) {
        body = h(
          React.Fragment,
          null,
          h(PageRow, { key: `page-${pageIndex}`, sessionId, page: pageIndex, t }),
          h(CellEditor, {
            key: `cell-${pageIndex}-${editing.cell}`,
            sessionId,
            page: pageIndex,
            cell: editing.cell,
            t,
          }),
        )
      } else if (page) {
        body = h(
          'div',
          { className: 'dsq-grid' },
          page.cells.map((cell, index) =>
            cell
              ? h(
                  'button',
                  {
                    key: `cell-${index}`,
                    type: 'button',
                    className: 'dsq-cell',
                    title: editMode ? t('editCell', { text: cell.text }) : cell.text,
                    onMouseDown: keepFocus,
                    // 编辑态：左键改成「改这一格」；平时：左键 = 插到输入框。
                    onClick: () => (editMode ? openEditor(index) : insertCell(cell)),
                    onContextMenu: (event) => {
                      if (event && typeof event.preventDefault === 'function') event.preventDefault()
                      openEditor(index)
                    },
                  },
                  h('span', { className: 'dsq-cell-label' }, cell.label),
                  editMode ? h('span', { className: 'dsq-cell-mark' }, '✎') : null,
                )
              : h(
                  'button',
                  {
                    key: `cell-${index}`,
                    type: 'button',
                    className: 'dsq-cell dsq-cell-empty',
                    title: t('emptyCell'),
                    onMouseDown: keepFocus,
                    onClick: () => openEditor(index),
                  },
                  '＋',
                ),
          ),
        )
      }

      return h(
        React.Fragment,
        null,
        h('style', null, CSS),
        h(
          'div',
          {
            ref: rootRef,
            className: 'dsq-panel',
            style: position,
            role: 'group',
            'aria-label': t('panelAria'),
          },
          h('div', { className: roomy ? 'dsq-body dsq-body-scroll' : 'dsq-body' }, body),
          bar,
        ),
      )
    }

    // ------------------------------------------------------------ 兜底

    /** 组件崩了就藏起来，绝不让整个槽位变空白。 */
    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }
      static getDerivedStateFromError() {
        return { failed: true }
      }
      componentDidCatch(error) {
        try {
          console.error('[quick-input] 界面渲染失败：', error)
        } catch {
          /* 忽略 */
        }
      }
      render() {
        return this.state.failed ? null : this.props.children
      }
    }

    function GuardedToggle(props) {
      return h(Boundary, null, h(QuickToggle, props))
    }

    function GuardedPanel(props) {
      return h(Boundary, null, h(QuickPanel, props))
    }

    // ------------------------------------------------------------ 插件对象

    /** 向宿主报到：这样 `GET /quick-input/health` 能证明页面正在跑哪一份客户端代码。 */
    function announceBuild() {
      postHello({ version: CLIENT_BUILD })
    }

    /**
     * 把版面实测数字回报给宿主（只在数据变化时发一次）。
     * 面板在真实页面里落在哪、为什么降级，靠这个在 `/quick-input/health` 里读出来。
     */
    let lastLayoutKey = ''
    function reportLayout(layout) {
      const key = JSON.stringify(layout)
      if (key === lastLayoutKey) return
      lastLayoutKey = key
      postHello({ version: CLIENT_BUILD, layout })
    }

    function postHello(payload) {
      try {
        const call = fetch(`${API}/hello`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })
        if (call && typeof call.catch === 'function') call.catch(() => {})
      } catch {
        /* 报到失败不影响界面 */
      }
    }

    return {
      // locale 是客户端核心服务：注册中英字典、并把命名空间交给槽位（组件因此拿到 t）。
      inject: ['slots', 'locale'],
      apply(ctx) {
        const locale = ctx.locale
        if (locale && typeof locale.register === 'function') {
          ctx.effect(() => locale.register(NS, DICT))
          if (typeof locale.bind === 'function') boundT = locale.bind(NS)
          const sync = () => {
            try {
              const snapshot =
                typeof locale.getSnapshot === 'function' ? locale.getSnapshot() : locale.getLocale()
              if (snapshot && typeof snapshot.active === 'string' && snapshot.active !== '') {
                if (snapshot.active !== activeLocaleId) {
                  activeLocaleId = snapshot.active
                  // 语言变了：让已经挂着的面板/按钮立刻用新语言重渲染一次。
                  store.emit()
                }
              }
            } catch {
              /* 拿不到语言就保持默认（中文兜底） */
            }
          }
          sync()
          if (typeof locale.subscribe === 'function') ctx.effect(() => locale.subscribe(sync))
        }
        ctx.slots.inject(TOGGLE_SLOT, () =>
          ctx.slots.register({ name: TOGGLE_SLOT, id: 'quick-input-toggle', order: 4, locale: NS }, GuardedToggle),
        )
        ctx.slots.inject(PANEL_SLOT, () =>
          ctx.slots.register({ name: PANEL_SLOT, id: 'quick-input-panel', order: 20, locale: NS }, GuardedPanel),
        )
        announceBuild()
      },
    }
  },
})
