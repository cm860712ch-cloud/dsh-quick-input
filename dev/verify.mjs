#!/usr/bin/env node
/**
 * 应声 · 快捷输入 —— 离线自检。
 *
 * 不装任何东西、不连网、不碰 profile：在临时目录里真跑两个半区。
 *   宿主半区：假 ctx 真 apply、真注册路由、真收发请求、真落盘；
 *   浏览器半区：node:vm + 迷你 React 真渲染组件树，真点按钮、真翻页、真保存。
 *
 * 用法：node dev\verify.mjs
 * 它验不了的：真实槽位、真实主题、真实光标——那些只能在页面里看。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

import { CELLS_PER_PAGE, MAX_PAGES, defaultPresets, normalizePresets } from '../presets.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = resolve(HERE, '..')

let passed = 0
let failed = 0
const failures = []

function check(ok, label, detail = '') {
  if (ok) {
    passed++
    console.log(`  ✓ ${label}`)
  } else {
    failed++
    failures.push(label)
    console.log(`  ✗ ${label}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

function section(title) {
  console.log(`\n${title}`)
}

const flush = () => new Promise((resolve_) => setImmediate(resolve_))

// ============================================================ ① 静态

section('① 静态：清单、声明、禁用项')

const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'))
check(pkg.name === 'dsh-quick-input', '包名是 dsh-quick-input', pkg.name)
check(pkg.type === 'module', 'package.json 声明 type: module')
check(pkg.private !== true, '没有 private: true（否则 npm 拒绝发布）')
check(pkg.license === 'MIT', 'license 是 MIT', String(pkg.license))
check(existsSync(join(PKG, 'LICENSE')), 'LICENSE 文件存在')
check(/^(git\+)?https:\/\/github\.com\/cm860712ch-cloud\/dsh-quick-input/.test(String(pkg.repository?.url ?? '')), 'repository 指向作者的 GitHub 仓库', String(pkg.repository?.url))
check(String(pkg.homepage ?? '') !== '' && String(pkg.bugs?.url ?? '') !== '', 'homepage / bugs 都填了')
check(Array.isArray(pkg.keywords) && pkg.keywords.includes('dsh-plugin'), 'keywords 里有 dsh-plugin（市场认这个标签）')
check(/^\d+\.\d+\.\d+/.test(String(pkg.version)), 'version 是语义化版本号', String(pkg.version))
check(
  Array.isArray(pkg.files) && ['index.js', 'client.js', 'presets.js', 'cordis.patch.yml', 'icon.svg', 'README.md', 'LICENSE'].every((name) => pkg.files.includes(name)),
  'files 白名单覆盖了运行需要的每个文件',
  JSON.stringify(pkg.files),
)
const bilingualDescription = String(pkg.description ?? '')
check(/[\u4e00-\u9fa5]/.test(bilingualDescription) && /[a-zA-Z]{4}/.test(bilingualDescription), '一句话介绍是中英双语（市场卡片两种语言都要）')
check(pkg.exports?.['./client'] === './client.js', 'exports 暴露 ./client → client.js')
check(pkg.exports?.['.'] === './index.js', 'exports 暴露 . → index.js')
check(pkg.dsh?.bundle?.patch === './cordis.patch.yml', '声明 dsh.bundle.patch')
check(pkg.dsh?.client?.platform === 'web', '声明 dsh.client.platform = web')
check(pkg.dsh?.client?.immediately === true, '声明 dsh.client.immediately = true')
check(
  Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-conversation'),
  '声明 client.inject 等 ui-conversation 先激活',
)

const patch = readFileSync(join(PKG, 'cordis.patch.yml'), 'utf8')
check(/^\s*-?\s*insert:/m.test(patch), 'cordis.patch.yml 里有 insert')
check(patch.includes("name: 'dsh-quick-input'"), 'patch 里的 name 指向本包')
check(/id:\s*quick-input/.test(patch), 'patch 里有 id: quick-input')
check(existsSync(join(PKG, 'icon.svg')), 'icon.svg 存在')

const clientSource = readFileSync(join(PKG, 'client.js'), 'utf8')
const hostSource = readFileSync(join(PKG, 'index.js'), 'utf8')
check(clientSource.includes('window.__ModuleLoader__.load('), 'client.js 走 __ModuleLoader__.load')
check(/id:\s*'dsh-quick-input'/.test(clientSource), 'client.js 的模块 id 等于包名')
check(!/require\(\s*['"]@deepseek-ai\//.test(clientSource), 'client.js 没有 require 任何 DSH 客户端包')
check(!/from\s+['"]@deepseek-ai\//.test(hostSource), 'index.js 没有 import 任何 DSH 包（零依赖）')
check(!/document\.body\s*[.[=]/.test(clientSource), 'client.js 没有读写 document.body')

// ============================================================ ② 宿主半区

section('② 宿主半区：路由、规范化、落盘')

const homeDir = mkdtempSync(join(tmpdir(), 'quick-input-verify-'))
process.env.DSH_HOME = homeDir
const presetsFile = join(homeDir, 'quick-input', 'presets.json')

function sendJsonBody(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function fakeRes() {
  let settle
  const done = new Promise((resolve_) => {
    settle = resolve_
  })
  return {
    done,
    res: {
      statusCode: 0,
      body: '',
      writeHead(status) {
        this.statusCode = status
      },
      end(text) {
        this.body = text ?? ''
        settle()
      },
    },
  }
}

function fakeReq(method, url, body) {
  const handlers = { data: [], end: [], error: [] }
  return {
    method,
    url,
    on(event, handler) {
      if (handlers[event]) handlers[event].push(handler)
      return this
    },
    /** 等 handler 挂上监听器之后再喂数据。 */
    feed() {
      setImmediate(() => {
        if (body !== undefined) for (const handler of handlers.data) handler(Buffer.from(body))
        for (const handler of handlers.end) handler()
      })
    },
  }
}

async function callRoute(route, method, url, body) {
  const { res, done } = fakeRes()
  const req = fakeReq(method, url, body)
  const pending = route.handler(req, res)
  req.feed()
  await done
  if (pending && typeof pending.then === 'function') await pending
  let parsed = null
  try {
    parsed = res.body === '' ? null : JSON.parse(res.body)
  } catch {
    parsed = null
  }
  return { status: res.statusCode, body: parsed }
}

const registered = []
const hostLogs = []
const fakeHostCtx = {
  logger: () => ({
    info: (...args) => hostLogs.push(['info', ...args]),
    warn: (...args) => hostLogs.push(['warn', ...args]),
  }),
  inject(services, callback) {
    if (!services.includes('webServer')) return () => {}
    const scoped = {
      webServer: {
        register(route) {
          registered.push(route)
          return () => {}
        },
      },
      effect(fn) {
        return fn()
      },
    }
    callback(scoped)
    return () => {}
  },
}

const host = await import(pathToFileURL(join(PKG, 'index.js')).href)
check(typeof host.apply === 'function', 'index.js 导出 apply')
check(host.name === 'quick-input', 'index.js 导出 name', String(host.name))

host.apply(fakeHostCtx, undefined)
check(registered.length === 1, '注册了 1 条路由', `实际 ${registered.length}`)
const route = registered[0]
check(route && route.kind === 'prefix' && route.path === '/quick-input', '路由是 prefix /quick-input', route && `${route.kind} ${route.path}`)

const health = await callRoute(route, 'GET', '/quick-input/health')
check(health.status === 200 && health.body?.ok === true, 'GET /quick-input/health → 200 ok')
check(health.body?.pages === 0, '预设文件还没建时 /health 只读不写（报 0 页）', String(health.body?.pages))
check(!existsSync(presetsFile), '/health 没有偷偷写盘')
check(health.body?.client === null, '还没浏览器报到时 health.client 是 null')

const hello = await callRoute(route, 'POST', '/quick-input/hello', JSON.stringify({ version: '0.1.0+build9' }))
check(hello.status === 200 && hello.body?.value?.version === '0.1.0+build9', 'POST /quick-input/hello 记下客户端构建号')
const healthAfterHello = await callRoute(route, 'GET', '/quick-input/health')
check(healthAfterHello.body?.client?.version === '0.1.0+build9', 'health 里能看到浏览器半区跑的是哪一份')
const helloBad = await callRoute(route, 'POST', '/quick-input/hello', '{ 坏 json')
check(helloBad.status === 200 && helloBad.body?.value?.version === 'unknown', '报到内容坏掉也不报错，只记 unknown')

// 英文界面先来一次：文件还不存在时，种的是英文示例。
const enFirst = await callRoute(route, 'GET', '/quick-input/presets?lang=en')
check(enFirst.body?.value?.pages?.[0]?.title === 'Common', '英文界面首次打开种英文示例', String(enFirst.body?.value?.pages?.[0]?.title))
check(enFirst.body?.value?.pages?.[0]?.cells?.[0]?.text === 'Continue', '英文种子的第一格是 Continue')
rmSync(presetsFile, { force: true })
check(!existsSync(presetsFile), '清掉刚生成的英文种子，接着验中文种子')

const first = await callRoute(route, 'GET', '/quick-input/presets')
check(first.status === 200 && first.body?.ok === true, 'GET /quick-input/presets → 200 ok')
check(first.body?.value?.pages?.length === 2, '读到 2 页')
check(
  first.body?.value?.pages?.every((page) => page.cells.length === CELLS_PER_PAGE),
  `每页都是 ${CELLS_PER_PAGE} 格`,
)
check(first.body?.value?.pages?.[0]?.cells?.[0]?.text === '继续', '第一格内容是种子里的「继续」')
check(existsSync(presetsFile), '种子已落盘到 $DSH_HOME/quick-input/presets.json', presetsFile)

const emptyPost = await callRoute(route, 'POST', '/quick-input/presets', JSON.stringify({ pages: [] }))
check(emptyPost.status === 400 && emptyPost.body?.error === 'empty', 'POST 空页面 → 400 empty')

const badPost = await callRoute(route, 'POST', '/quick-input/presets', '{ not json')
check(badPost.status === 400 && badPost.body?.error === 'bad-body', 'POST 坏 JSON → 400 bad-body')

const savedPost = await callRoute(
  route,
  'POST',
  '/quick-input/presets',
  JSON.stringify({
    pages: [
      { title: '只有一页', cells: [{ label: '打招呼', text: '你好，我是应声。' }, null, null, null, null, null, null, null, null] },
    ],
  }),
)
check(savedPost.status === 200 && savedPost.body?.ok === true, 'POST 合法内容 → 200 ok')
check(savedPost.body?.value?.pages?.length === 1, '存进去 1 页')
check(savedPost.body?.value?.pages?.[0]?.cells?.[1] === null, '空格子规范化成 null')
const onDisk = JSON.parse(readFileSync(presetsFile, 'utf8'))
check(onDisk.pages?.[0]?.cells?.[0]?.text === '你好，我是应声。', '文件里就是新内容')
const second = await callRoute(route, 'GET', '/quick-input/presets')
check(second.body?.value?.pages?.[0]?.cells?.[0]?.label === '打招呼', 'GET 读回刚存的内容')

const notFound = await callRoute(route, 'GET', '/quick-input/nope')
check(notFound.status === 404, '未知路径 → 404')
const badUrl = await callRoute(route, 'GET', 'http://[bad')
check(badUrl.status === 400, '坏 URL → 400')

const normalized = normalizePresets({
  pages: [
    { title: '   ', cells: Array.from({ length: 12 }, (_, i) => ({ text: ` t${i} ` })) },
    ...Array.from({ length: MAX_PAGES + 3 }, () => ({ title: 'x', cells: [] })),
  ],
})
check(normalized.pages.length === MAX_PAGES, `页数被截到上限 ${MAX_PAGES}`, String(normalized.pages.length))
check(normalized.pages[0].cells.length === CELLS_PER_PAGE, '格子数被截到每页上限')
check(normalized.pages[0].title === '第 1 页', '空白页名补成「第 1 页」', normalized.pages[0].title)
check(normalizePresets(null).pages.length === 0, 'normalizePresets(null) 不抛异常')
check(defaultPresets().pages[0].cells[9] === undefined, '种子每页就是 9 格（没有第 10 格）')

// ============================================================ ③ 浏览器半区

section('③ 浏览器半区：槽位注册、九宫格、插入、翻页、保存')

// ---- 迷你 React：够用来真渲染函数组件/class 错误边界，并按状态更新 ----
function createMiniReact() {
  const stores = new Map()
  let hooks = []
  let index = 0

  const React = {
    createElement: (type, props, ...children) => {
      const flat = children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false && child !== true)
      const merged = { ...(props ?? {}) }
      if (flat.length === 1) merged.children = flat[0]
      else if (flat.length > 1) merged.children = flat
      return { type, props: merged, children: flat }
    },
    Fragment: Symbol('Fragment'),
    Component: class {
      constructor(props) {
        this.props = props ?? {}
        this.state = {}
      }
    },
    useState(initial) {
      const slot = index++
      const store = hooks
      if (!(slot in store)) store[slot] = typeof initial === 'function' ? initial() : initial
      return [
        store[slot],
        (value) => {
          store[slot] = typeof value === 'function' ? value(store[slot]) : value
        },
      ]
    },
    useRef(initial) {
      const slot = index++
      const store = hooks
      if (!(slot in store)) store[slot] = { current: initial }
      return store[slot]
    },
    useCallback(fn) {
      index++
      return fn
    },
    useEffect(fn, deps) {
      const slot = index++
      const previous = hooks[slot]
      const changed = previous === undefined || deps === undefined || deps.some((item, i) => item !== previous[i])
      if (!changed) return
      hooks[slot] = deps ?? []
      const cleanup = hooks[slot + 100000]
      if (typeof cleanup === 'function') {
        try {
          cleanup()
        } catch {
          /* 忽略 */
        }
      }
      hooks[slot + 100000] = fn()
    },
  }

  function mount(element) {
    if (element === null || element === undefined || typeof element !== 'object') return element
    if (Array.isArray(element)) return element.map(mount)
    const { type, props, children } = element
    if (typeof type === 'function') {
      const isClass = type.prototype && typeof type.prototype.render === 'function'
      if (isClass) {
        const instance = new type(props)
        instance.props = props
        return mount(instance.render())
      }
      const previous = hooks
      const previousIndex = index
      hooks = stores.get(type) ?? []
      stores.set(type, hooks)
      index = 0
      let rendered
      try {
        rendered = mount(type(props))
      } finally {
        hooks = previous
        index = previousIndex
      }
      return rendered
    }
    const ref = props?.ref
    if (ref !== null && typeof ref === 'object') {
      // 假的 DOM 节点：rect 给一串数字，parentElement 链模拟「零高度槽位容器 → 有高度的输入框卡片」，
      // contains 由 probeHit 控制，用来分别走通「侧挂成功」和「探测失败退回浮层」两条路。
      ref.current = {
        getBoundingClientRect: () => ({ left: 100, top: 700, right: 336, bottom: 804, width: 236, height: 104 }),
        contains: () => probeRule(),
        parentElement: {
          getBoundingClientRect: () => ({ left: 344, top: 700, right: 580, bottom: 700, width: 236, height: 0 }),
          parentElement: {
            getBoundingClientRect: () => ({ left: 344, top: 686, right: 580, bottom: 804, width: 236, height: cardRectHeight }),
            parentElement: {
              // 会话列：明显比卡片宽，插件用它算「输入框左边还剩多少空隙」。
              getBoundingClientRect: () => ({ left: columnLeft, top: 60, right: columnLeft + 900, bottom: 810, width: 900, height: 750 }),
              parentElement: null,
            },
          },
        },
      }
    }
    return { type, props, children: mount(children) }
  }

  return { React, mount }
}

function findElement(node, predicate) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findElement(child, predicate)
      if (hit) return hit
    }
    return null
  }
  if (predicate(node)) return node
  return findElement(node.children, predicate)
}

function findAll(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out)
    return out
  }
  if (predicate(node)) out.push(node)
  findAll(node.children, predicate, out)
  return out
}

function collectText(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out)
    return out
  }
  collectText(node.children, out)
  return out
}

const textOf = (node) => collectText(node).join(' ')

// ---- 假页面环境 ----
let serverDoc = defaultPresets()
const fetchCalls = []
const windowListeners = []
const localStore = new Map()
/** 假定时器：记下回调，由 fireTimers() 在需要时真触发（用来验"提示 2.4 秒后自动消失"）。 */
const timers = []
let timerSeq = 0
/** 置真时 GET /presets 一直失败（用来测错误态）。 */
let failGet = false
/** 当前会话输入框的 phase（'plain' | 'submitting' | 'inert' …）。 */
let inputPhase = 'plain'
/** elementFromPoint 探到的点是否落在面板自己身上（控制侧挂判定）。 */
let probeRule = () => true
/** 假输入框卡片的高度（控制"等高"计算）。 */
let cardRectHeight = 118
/** 假会话列的左边缘：卡片左边到它的距离就是"输入框左侧可用空隙"。 */
let columnLeft = 40

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

async function fakeFetch(url, options) {
  const path = String(url)
  const method = options && options.method ? String(options.method) : 'GET'
  fetchCalls.push({ path, method, body: options ? options.body : undefined })
  if (path.startsWith('/quick-input/presets') && method === 'GET') {
    if (failGet) return jsonResponse(500, { ok: false, error: 'boom' })
    return jsonResponse(200, { ok: true, value: serverDoc })
  }
  if (path === '/quick-input/hello') return jsonResponse(200, { ok: true, value: { version: 'harness' } })
  if (path.startsWith('/quick-input/presets') && method === 'POST') {
    let payload = null
    try {
      payload = JSON.parse(String(options.body))
    } catch {
      return jsonResponse(400, { ok: false, error: 'bad-body' })
    }
    const normalized = normalizePresets(payload)
    if (normalized.pages.length === 0) return jsonResponse(400, { ok: false, error: 'empty' })
    serverDoc = normalized
    return jsonResponse(200, { ok: true, value: normalized })
  }
  return jsonResponse(404, { ok: false, error: 'not-found' })
}

const sandbox = {
  console,
  fetch: fakeFetch,
  setTimeout: (fn) => {
    timers.push(fn)
    timerSeq += 1
    return timerSeq
  },
  clearTimeout: (id) => {
    if (typeof id === 'number' && id > 0) timers[id - 1] = null
  },
  innerWidth: 1600,
  addEventListener: (type, handler) => windowListeners.push({ type, handler }),
  removeEventListener: () => {},
  localStorage: {
    getItem: (key) => (localStore.has(key) ? localStore.get(key) : null),
    setItem: (key, value) => localStore.set(key, String(value)),
  },
  document: { elementFromPoint: () => ({ probe: true }) },
  loaded: null,
}
sandbox.window = sandbox
sandbox.globalThis = sandbox
sandbox.__ModuleLoader__ = {
  load(spec) {
    sandbox.loaded = spec
  },
}

vm.createContext(sandbox)
vm.runInContext(clientSource, sandbox, { filename: 'client.js' })

const spec = sandbox.loaded
check(spec && typeof spec.factory === 'function', 'client.js 调用了 __ModuleLoader__.load')
check(spec?.id === pkg.name, '模块 id 与包名一致', String(spec?.id))

const mini = createMiniReact()
const requiredPackages = []
const plugin = spec.factory((name) => {
  requiredPackages.push(name)
  if (name === 'react') return mini.React
  throw new Error(`浏览器半区不该 require ${name}`)
})
check(requiredPackages.length === 1 && requiredPackages[0] === 'react', '只从宿主模块表拿了 react', requiredPackages.join(','))

const registrations = []
const injectedKeys = []
const registeredDicts = []
/** 当前语言（假 locale 服务用；测试会切成 en 再看文案）。 */
let activeLocale = 'zh'

/** 模仿官方 t：先在本命名空间的当前语言里找，找不到再退回中文，最后显示 key。 */
function fillTemplate(template, params) {
  if (typeof template !== 'string') return ''
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (whole, key) => (params[key] === undefined ? whole : String(params[key])))
}
function translate(key, params) {
  const entry = registeredDicts.length > 0 ? registeredDicts[registeredDicts.length - 1] : null
  const dict = (entry && entry.dicts[activeLocale]) || (entry && entry.dicts.zh) || {}
  return fillTemplate(dict[key] ?? key, params)
}

const fakeClientCtx = {
  slots: {
    inject(key, callback) {
      injectedKeys.push(key)
      callback()
      return () => {}
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  },
  effect(fn) {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  locale: {
    register(ns, dicts) {
      registeredDicts.push({ ns, dicts })
      return () => {}
    },
    bind() {
      return translate
    },
    getSnapshot() {
      return { active: activeLocale, locales: [], revision: 1 }
    },
    subscribe() {
      return () => {}
    },
  },
}
plugin.apply(fakeClientCtx)

check(Array.isArray(plugin.inject) && plugin.inject.includes('slots') && plugin.inject.includes('locale'), '插件声明依赖 slots 与 locale', String(plugin.inject))
check(registeredDicts.length === 1 && registeredDicts[0].ns === 'quick-input', '向 locale 服务注册了 quick-input 命名空间')
const dicts = registeredDicts[0] ? registeredDicts[0].dicts : {}
check(Object.keys(dicts).sort().join(',') === 'en,zh', '中英两套字典都注册了（官方要求一次注册齐）', Object.keys(dicts).join(','))
const zhKeys = Object.keys(dicts.zh ?? {}).sort()
const enKeys = Object.keys(dicts.en ?? {}).sort()
check(zhKeys.length > 20 && zhKeys.join('|') === enKeys.join('|'), '中英字典的 key 完全对齐（缺一个就会把 key 显示给用户）')
check(
  !Object.values(dicts.en ?? {}).some((value) => /[\u4e00-\u9fa5]/.test(String(value))),
  '英文文案里没有留下中文',
)
check(zhKeys.length === enKeys.length && zhKeys.length > 0, '字典不是空的', `${zhKeys.length} 个 key`)

check(injectedKeys.length === 2, '两处注册都包在 slots.inject 里', injectedKeys.join(', '))
const toggleReg = registrations.find((item) => item.options.name === 'conversation.input.left')
const panelReg = registrations.find((item) => item.options.name === 'conversation.input.overlay')
check(toggleReg?.options.id === 'quick-input-toggle', '⊞ 注册到 conversation.input.left', toggleReg?.options.id)
check(panelReg?.options.id === 'quick-input-panel', '九宫格注册到 conversation.input.overlay', panelReg?.options.id)
check(
  toggleReg?.options.locale === 'quick-input' && panelReg?.options.locale === 'quick-input',
  '两处注册都带上了文案命名空间（槽位据此注入 t）',
  `${toggleReg?.options.locale} / ${panelReg?.options.locale}`,
)

const sessionId = 'session-verify'
const insertCalls = []
let insertResult = true
const inputActions = {
  captureInsertion: () => ({ draftRev: insertCalls.length + 1, from: 0, to: 0 }),
  insertText: (text, span) => {
    insertCalls.push({ text, span })
    return insertResult
  },
}
/** 假 useInput：真实槽位给的是 SnapshotSelectorHook<InputState>，这里照同样形状给。 */
const useInput = (selector) => selector({ phase: inputPhase })
const props = { sessionId, inputActions, useInput, useSession: undefined, t: translate }

const renderToggle = () => mini.mount(mini.React.createElement(toggleReg.component, props))
const renderPanel = () => mini.mount(mini.React.createElement(panelReg.component, props))
const click = (node) => {
  node.props.onMouseDown?.({ preventDefault() {} })
  node.props.onClick?.({ preventDefault() {}, target: {} })
}
/** 模拟一次窗口尺寸变化：调用面板注册的 resize 监听。 */
const fireResize = () => {
  for (const listener of windowListeners) {
    if (listener.type === 'resize') listener.handler()
  }
}
/** 面板的 measure→setState 要几轮重挂才收敛；渲染到稳定为止。 */
const settle = (times = 6) => {
  let tree = renderPanel()
  for (let i = 1; i < times; i++) tree = renderPanel()
  return tree
}
/** 触发所有挂起的定时器（提示条的自动消失走这条路）。 */
const fireTimers = () => {
  const pending = timers.splice(0)
  for (const fn of pending) if (typeof fn === 'function') fn()
}

// ---- ⊞ 按钮 ----
let toggleTree = renderToggle()
const toggleButton = findElement(toggleTree, (node) => node.type === 'button' && node.props?.['aria-label'] === '快捷输入')
check(toggleButton !== null, '⊞ 按钮渲染出来了（中文界面）')
check(toggleButton?.props?.['aria-expanded'] === 'false', '初始 aria-expanded = false')
check(findElement(toggleTree, (node) => node.type === 'svg') !== null, '⊞ 按钮里有九宫格图标')

// ---- 切到英文：文案跟着槽位注入的 t 走 ----
activeLocale = 'en'
const enToggleTree = renderToggle()
check(
  findElement(enToggleTree, (node) => node.type === 'button' && node.props?.['aria-label'] === 'Quick input') !== null,
  '英文界面下 ⊞ 的文案跟着切换',
  JSON.stringify(collectText(enToggleTree)),
)
activeLocale = 'zh'
check(windowListeners.length === 0, '面板没开时不挂窗口监听')

let panelTree = renderPanel()
check(panelTree === null, '没点开时面板不渲染任何东西')

// ---- 拉预设失败 → 错误态 → 重试 ----
failGet = true
click(toggleButton)
toggleTree = renderToggle()
const reopened = findElement(toggleTree, (node) => node.type === 'button' && node.props?.['aria-label'] === '快捷输入')
check(reopened?.props?.['aria-expanded'] === 'true', '点击后 aria-expanded = true')
await flush()
await flush()
panelTree = renderPanel()
check(panelTree !== null, '点 ⊞ 后面板出现')
// 打开面板时的自动重拉也会失败，再等一轮才落到错误态。
await flush()
await flush()
panelTree = renderPanel()
check(textOf(panelTree).includes('读预设失败'), '拉预设失败时给出可读的错误')
const retryButton = findElement(panelTree, (node) => node.type === 'button' && textOf(node) === '重试')
check(retryButton !== null, '错误态有「重试」')
failGet = false
click(retryButton)
await flush()
await flush()
panelTree = renderPanel()
check(findElement(panelTree, (node) => node.props?.title === '继续') !== null, '点「重试」后九宫格正常加载')
check(
  fetchCalls.some((call) => call.path.startsWith('/quick-input/presets') && call.method === 'GET'),
  '面板打开时拉了 GET /quick-input/presets',
)

const anchor = findElement(panelTree, (node) => node.props?.className === 'dsq-panel')
check(anchor !== null, '面板根节点带 dsq-panel 类')
check(
  fetchCalls.some((call) => call.path.startsWith('/quick-input/presets?lang=')),
  '拉预设时带上了界面语言（首次示例按它选中文还是英文）',
)
const style = anchor?.props?.style ?? {}
check(style.right === '100%' && style.top === 0, '常驻形态：贴在输入框左边、上沿对齐', JSON.stringify(style))
check(typeof style.height === 'number' && style.height === 118, '高度取自输入框卡片的实测高度（等高）', String(style.height))
check(style.width === 232, '空隙充足时用最宽 232px', String(style.width))
check(style.marginRight === 8, '与输入框之间留 8px 缝')
check(findElement(panelTree, (node) => node.props?.className === 'dsq-body') !== null, '九宫格包在 body 容器里')
const styleTag = findElement(panelTree, (node) => node.type === 'style')
const cssText = styleTag ? String(collectText(styleTag)) : ''
check(cssText.includes('-webkit-line-clamp:2'), '格子文字限制两行')
check(cssText.includes('font-size:11px'), '格子字号 11px（比 13px 正文小）')
check(findElement(panelTree, (node) => node.props?.className === 'dsq-bar') !== null, '底部有一条 14px 控制栏')
const firstBar = findElement(panelTree, (node) => node.props?.className === 'dsq-bar')
check(textOf(firstBar).includes('常用'), '控制栏里显示当前页名（tab 名称）', textOf(firstBar))
const nameSpan = findElement(panelTree, (node) => node.props?.className === 'dsq-pagename')
check(nameSpan?.props?.title === '常用 · 第 1/2 页', '页名上带完整信息的悬停提示', String(nameSpan?.props?.title))
check(windowListeners.some((listener) => listener.type === 'resize'), '面板打开时挂了 resize 监听（窗口变了重新量）')

const hasClass = (node, name) =>
  node.type === 'button' && typeof node.props?.className === 'string' && node.props.className.split(' ').includes(name)
const cells = findAll(panelTree, (node) => hasClass(node, 'dsq-cell'))
check(cells.length === CELLS_PER_PAGE, `九宫格渲染 ${CELLS_PER_PAGE} 格`, `实际 ${cells.length}`)
check(findElement(panelTree, (node) => node.props?.title === '继续') !== null, '第一格是「继续」')

// ---- 插入 ----
const firstCell = findElement(panelTree, (node) => node.type === 'button' && node.props?.title === '继续')
click(firstCell)
check(insertCalls.length === 1 && insertCalls[0].text === '继续', '点第一格 → insertText 收到「继续」', JSON.stringify(insertCalls[0] ?? null))
check(insertCalls[0]?.span?.draftRev === 1, '插入用的是 captureInsertion() 抓到的 span')
panelTree = renderPanel()
check(textOf(panelTree).includes('已插入'), '面板上出现「已插入」反馈')
const flashBar = findElement(panelTree, (node) => node.props?.className === 'dsq-bar')
check(textOf(flashBar).includes('已插入') && !textOf(flashBar).includes('常用'), '有提示时提示临时顶替页名')

const secondCell = findElement(panelTree, (node) => node.type === 'button' && node.props?.title === '先给结论，再给理由。')
click(secondCell)
check(insertCalls.length === 2 && insertCalls[1].text === '先给结论，再给理由。', '再点第二格 → 依次插入，面板不关')
panelTree = renderPanel()
check(findElement(panelTree, (node) => node.props?.title === '继续') !== null, '插入后面板仍在（能连点）')

insertResult = false
const thirdCell = findElement(panelTree, (node) => node.type === 'button' && node.props?.title === '用更短的版本重说一遍。')
click(thirdCell)
check(insertCalls.length === 4, '插入被拒时会重抓一次 span 再试', `insertText 调用 ${insertCalls.length} 次`)
panelTree = renderPanel()
check(textOf(panelTree).includes('草稿刚变过'), '两次都失败时给出可读提示')
insertResult = true

// ---- 发送中 / 不可编辑：不白试，也不说错原因 ----
inputPhase = 'submitting'
const callsBeforeBusy = insertCalls.length
panelTree = renderPanel()
const busyCell = findElement(panelTree, (node) => node.type === 'button' && node.props?.title === '列成编号步骤，每步一句话。')
click(busyCell)
check(insertCalls.length === callsBeforeBusy, '发送中点格子根本不去试插入')
panelTree = renderPanel()
check(textOf(panelTree).includes('正在发送'), '发送中说的是「正在发送」，不是「草稿刚变过」')

inputPhase = 'inert'
const callsBeforeInert = insertCalls.length
panelTree = renderPanel()
const inertCell = findElement(panelTree, (node) => node.type === 'button' && node.props?.title === '用大白话解释，不要术语。')
click(inertCell)
check(insertCalls.length === callsBeforeInert, '输入框不可编辑时也不去试插入')
panelTree = renderPanel()
check(textOf(panelTree).includes('不可编辑'), '不可编辑时给出对应提示')
inputPhase = 'plain'

// ---- 翻页 ----
check(textOf(panelTree).includes('1/2'), '控制栏显示 1/2')
const nextPage = findElement(panelTree, (node) => node.type === 'button' && textOf(node) === '›')
check(nextPage !== null, '控制栏里有下一页按钮')
click(nextPage)
panelTree = renderPanel()
check(
  findElement(panelTree, (node) => node.props?.title === '找出这段代码里的 bug，按严重程度排序。') !== null,
  '切到第二页后渲染的是第二页的格子',
)
check(textOf(panelTree).includes('2/2'), '控制栏显示 2/2')
// 先让上一步留下的提示自动消失，页名才会回到控制栏上。
fireTimers()
panelTree = renderPanel()
const secondBar = findElement(panelTree, (node) => node.props?.className === 'dsq-bar')
check(textOf(secondBar).includes('代码'), '提示消失后控制栏显示当前页名，且翻页时跟着换', textOf(secondBar))

// ---- 空格子 ----
const emptyCell = findElement(panelTree, (node) => hasClass(node, 'dsq-cell-empty'))
check(emptyCell !== null, '空格子渲染成虚线 + 号')
panelTree = renderPanel()
const prevPage = findElement(panelTree, (node) => node.type === 'button' && textOf(node) === '‹')
click(prevPage)
panelTree = renderPanel()
check(textOf(panelTree).includes('1/2'), '翻回第一页')

// ---- 编辑与保存 ----
const editButton = findElement(panelTree, (node) => node.type === 'button' && textOf(node) === '✎')
check(editButton !== null, '控制栏里有 ✎（编辑）')
click(editButton)
panelTree = renderPanel()
check(findElement(panelTree, (node) => node.type === 'textarea') === null, '进入编辑态时先留在九宫格上（不直接跳进某一格）')
check(findElement(panelTree, (node) => node.type === 'button' && textOf(node) === '完成') !== null, '编辑态里 ✎ 变成「完成」')
const insertsBeforeEdit = insertCalls.length
const firstCellInEdit = findElement(panelTree, (node) => node.type === 'button' && node.props?.title === '改这一格：继续')
check(firstCellInEdit !== null, '编辑态的格子文案变成「改这一格」')
click(firstCellInEdit)
check(insertCalls.length === insertsBeforeEdit, '编辑态点格子不会插入文字', `插入调用 ${insertCalls.length}`)
panelTree = renderPanel()
const textarea = findElement(panelTree, (node) => node.type === 'textarea')
check(textarea !== null, '编辑态点某一格才出现内容输入框')
check(textarea?.props?.value === '继续', '输入框里是那一格的内容', String(textarea?.props?.value))
const pageTitleInput = findAll(panelTree, (node) => node.type === 'input')
check(pageTitleInput.length >= 1, '编辑态能改页名')

textarea.props.onChange({ target: { value: '新内容' } })
panelTree = renderPanel()
const labelInput = findElement(
  panelTree,
  (node) => node.type === 'input' && node.props?.placeholder === '格子上显示的短标签',
)
check(labelInput !== null, '编辑器里有名称输入框')
labelInput.props.onChange({ target: { value: '新名称' } })
panelTree = renderPanel()
const saveButton = findElement(panelTree, (node) => node.type === 'button' && textOf(node) === '保存')
check(saveButton !== null, '编辑器里有「保存」')
const postsBefore = fetchCalls.filter((call) => call.method === 'POST' && call.path.endsWith('/presets')).length
click(saveButton)
await flush()
await flush()
const posts = fetchCalls.filter((call) => call.method === 'POST' && call.path.endsWith('/presets'))
check(posts.length === postsBefore + 1, '保存发了一次 POST', `POST 次数 ${posts.length}`)
const posted = posts[posts.length - 1] ? JSON.parse(String(posts[posts.length - 1].body)) : null
check(posted?.pages?.[0]?.cells?.[0]?.text === '新内容', 'POST 的正文里是新内容', JSON.stringify(posted?.pages?.[0]?.cells?.[0] ?? null))
check(posted?.pages?.[0]?.cells?.[0]?.label === '新名称', 'POST 的正文里也带上了新名称')

panelTree = renderPanel()
check(textOf(panelTree).includes('已保存'), '保存后给出反馈')
check(findElement(panelTree, (node) => node.props?.title === '改这一格：新内容') !== null, '保存后回到九宫格，格子已换成新内容（仍在编辑态）')
check(serverDoc.pages[0].cells[0].text === '新内容', '假宿主那边也真存下了')

// ---- 退出编辑态后又回到「点格子=插入」 ----
const doneButton = findElement(panelTree, (node) => node.type === 'button' && textOf(node) === '完成')
check(doneButton !== null, '编辑态里「编辑」变成「完成」')
click(doneButton)
panelTree = renderPanel()
const insertsBeforeExit = insertCalls.length
const cellAfterEdit = findElement(panelTree, (node) => node.type === 'button' && node.props?.title === '新内容')
check(cellAfterEdit !== null, '退出编辑态后格子还是新内容')
click(cellAfterEdit)
check(insertCalls.length === insertsBeforeExit + 1, '退出编辑态后点格子重新变成「插入」')
check(insertCalls[insertCalls.length - 1]?.text === '新内容', '插入的正是刚存的内容')

// ---- 常驻开关：刷新页面后依然是开着的 ----
check(localStore.get('quick-input.open') === '1', '面板开着时把常驻开关记下来')
const otherPanel = mini.mount(mini.React.createElement(panelReg.component, { ...props, sessionId: 'session-other' }))
check(otherPanel !== null, '换个会话打开时，面板按常驻开关默认展开（不必再点 ⊞）')
const closeButton = findElement(panelTree, (node) => node.type === 'button' && node.props?.title === '收起（也可点 ⊞）')
check(closeButton !== null, '控制栏里有收起按钮')
click(closeButton)
check(localStore.get('quick-input.open') === '0', '收起后常驻开关也关掉')
panelTree = renderPanel()
check(panelTree === null, '收起后面板不再渲染')

// ---- 侧挂位置被裁时退回「输入框上方浮层」 ----
probeRule = () => false
const toggleAgain = findElement(renderToggle(), (node) => node.type === 'button' && node.props?.['aria-label'] === '快捷输入')
click(toggleAgain)
await flush()
await flush()
panelTree = settle()
const fallbackAnchor = findElement(panelTree, (node) => node.props?.className === 'dsq-panel')
const fallbackStyle = fallbackAnchor?.props?.style ?? {}
check(
  fallbackStyle.left === 0 && fallbackStyle.bottom === 0 && typeof fallbackStyle.maxHeight === 'number',
  '侧挂位置被裁时退回「输入框上方浮层」',
  JSON.stringify(fallbackStyle),
)
check(fallbackStyle.width === 232, '退回浮层时用最宽 232px', String(fallbackStyle.width))
probeRule = () => true

// ---- 左侧空隙不够 → 面板自动变窄（仍贴左边） ----
columnLeft = 200 // 空隙 = 344-200 = 144px → 宽度 = 144-8 = 136
fireResize()
panelTree = settle()
const narrowStyle = findElement(panelTree, (node) => node.props?.className === 'dsq-panel')?.props?.style ?? {}
check(narrowStyle.width === 136, '按实测空隙自适应：空隙 144px → 面板 136px', JSON.stringify(narrowStyle))
check(narrowStyle.right === '100%' && typeof narrowStyle.height === 'number', '变窄后仍是左侧常驻形态')
check(narrowStyle.marginRight === 8, '变窄后仍然和输入框留 8px 缝')

// ---- 空隙窄到放不下最窄的面板 → 才退回浮层 ----
columnLeft = 330 // 空隙只有 14px
fireResize()
panelTree = settle()
const tooNarrow = findElement(panelTree, (node) => node.props?.className === 'dsq-panel')?.props?.style ?? {}
check(
  tooNarrow.left === 0 && typeof tooNarrow.maxHeight === 'number',
  '空隙连 120px 都放不下时才退回浮层',
  JSON.stringify(tooNarrow),
)
columnLeft = 40

// ---- 卡片比最小高度还矮时：取最小高度并把多出来的高度全放到上方 ----
probeRule = () => true
cardRectHeight = 96
fireResize()
panelTree = settle()
const shortStyle = findElement(panelTree, (node) => node.props?.className === 'dsq-panel')?.props?.style ?? {}
check(shortStyle.height === 116, '卡片只有 96px 时面板取最小高度 116', JSON.stringify(shortStyle))
check(shortStyle.top === -20, '多出来的 20px 全部向上外扩（下沿和输入框对齐，不会被底部裁掉）', String(shortStyle.top))
check(shortStyle.right === '100%', '仍然是左侧常驻形态')
cardRectHeight = 118

// ---- 版面数字回报给宿主（用来排查"为什么降级"） ----
const layoutCall = fetchCalls.filter((call) => call.path === '/quick-input/hello')
const layoutBody = layoutCall.length > 0 ? JSON.parse(String(layoutCall[layoutCall.length - 1].body)) : null
check(layoutBody?.layout !== undefined && typeof layoutBody.layout?.free === 'number', '版面实测数字会回报给宿主', JSON.stringify(layoutBody?.layout ?? null))
check(layoutBody?.layout?.dock === 'side', '回报里带着当前是侧挂还是浮层', String(layoutBody?.layout?.dock))

// ---- 客户端报到 ----
const helloCall = fetchCalls.find((call) => call.path === '/quick-input/hello')
check(helloCall !== undefined && helloCall.method === 'POST', '客户端 apply 时向宿主报到')
const helloBody = helloCall ? JSON.parse(String(helloCall.body)) : null
check(/^0\.1\.0\+build\d+$/.test(String(helloBody?.version)), '报到里带着客户端构建号', String(helloBody?.version))

// ---- 收尾 ----
rmSync(homeDir, { recursive: true, force: true })

// ============================================================ 汇总

console.log(`\n${'-'.repeat(52)}`)
console.log(`通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) {
  console.log('失败清单：')
  for (const item of failures) console.log(`  - ${item}`)
  process.exit(1)
}
console.log('离线自检全绿。真机（页面里的槽位、主题、光标位置）仍需刷新页面后人眼确认。')
