/**
 * 应声 · 快捷输入 —— 宿主半区。
 *
 * 职责只有两件：
 *   1. 持有预设（$DSH_HOME/quick-input/presets.json），首次使用时写入默认种子；
 *   2. 用 ctx.webServer 注册 /quick-input/* 路由，给浏览器半区读、存预设。
 *
 * 界面、点击、插入草稿全在浏览器半区（client.js）：那件事只有页面里做得了。
 * 设计约束：本文件不 import 任何 @deepseek-ai/* 包，只用 Node 内置模块 + 同目录 presets.js，
 * 这样宿主不会因为包解析不到而加载失败。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { defaultPresets, normalizePresets } from './presets.js'

/** 插件名（诊断日志里显示）。 */
export const name = 'quick-input'

/** 与 package.json 对齐，只用于 /health 自证。 */
const VERSION = '0.1.0'

const ROUTE_PATH = '/quick-input'
const BODY_LIMIT = 256 * 1024

/** 取一个可用的日志对象；拿不到就退回 console。 */
function makeLogger(ctx) {
  try {
    const logger = typeof ctx.logger === 'function' ? ctx.logger('quick-input') : undefined
    if (logger && typeof logger.info === 'function') return logger
  } catch {
    /* 忽略：日志能力不该影响插件 */
  }
  return console
}

/** 预设文件位置：$DSH_HOME/quick-input/presets.json。 */
function storeFile() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'quick-input', 'presets.json')
}

/** 写 JSON 响应。 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** 读取请求体，带字节上限。 */
function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** 落盘：先写临时文件再改名，避免半个文件被读到。 */
let tmpSeq = 0
function writePresets(presets) {
  const file = storeFile()
  mkdirSync(dirname(file), { recursive: true })
  // 临时名带上 pid + 序号：万一有两个进程写同一个 DSH_HOME，也不会互相踩。
  tmpSeq += 1
  const tmp = `${file}.${process.pid}.${tmpSeq}.tmp`
  writeFileSync(tmp, `${JSON.stringify(presets, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
  return file
}

/**
 * 读预设：文件不存在或全是空的，就用种子重建（并落盘）。
 * 文件坏掉时不删除它——只在日志里说一声，然后用种子顶上。
 * `create: false` 时只读不写（`/health` 这种诊断请求不该有副作用）。
 * @param options.lang 界面语言（`en*` 给英文种子）；options.create 是否允许落盘。
 */
function readPresets(seed, log, options) {
  const lang = options && options.lang !== undefined ? options.lang : undefined
  const create = !options || options.create !== false
  try {
    const parsed = JSON.parse(readFileSync(storeFile(), 'utf8'))
    const normalized = normalizePresets(parsed)
    if (normalized.pages.length > 0) return normalized
    log.warn?.('[quick-input] 预设文件里没有有效页面，改用种子重建')
  } catch (error) {
    const code = error && typeof error === 'object' ? error.code : undefined
    if (code !== 'ENOENT') {
      log.warn?.(
        '[quick-input] 读预设失败，改用种子：',
        error instanceof Error ? error.message : String(error),
      )
    }
  }
  const rebuilt = seed() ?? defaultPresets(lang)
  if (!create) return { version: 1, pages: [] }
  try {
    writePresets(rebuilt)
  } catch (error) {
    log.warn?.('[quick-input] 种子落盘失败（不影响本次使用）：', error instanceof Error ? error.message : String(error))
  }
  return rebuilt
}

/** patch 里 config.presets 给出的种子（可选）；没写就按语言用内置默认。 */
function seedFromConfig(rawConfig) {
  const configured = rawConfig && typeof rawConfig === 'object' ? rawConfig.presets : undefined
  if (configured === undefined) return () => null
  const normalized = normalizePresets(configured)
  if (normalized.pages.length === 0) return () => null
  return () => normalized
}

/**
 * 插件入口。
 * @param ctx - Cordis 上下文。
 * @param rawConfig - cordis.patch.yml 那一行的 config（只认 presets 作为种子）。
 */
export function apply(ctx, rawConfig) {
  const log = makeLogger(ctx)
  const seed = seedFromConfig(rawConfig)

  /** 浏览器半区最近一次报到：用于证明「页面正在跑哪一份客户端代码」。 */
  let lastClient = null

  /** GET /quick-input/presets 读；POST 存。 */
  async function handleRequest(req, res) {
    let url
    try {
      url = new URL(req.url ?? '/', 'http://localhost')
    } catch {
      sendJson(res, 400, { ok: false, error: 'bad-url' })
      return
    }
    const pathname = url.pathname

    if (pathname === `${ROUTE_PATH}/hello` && req.method === 'POST') {
      try {
        const text = await readBody(req)
        const payload = text === '' ? {} : JSON.parse(text)
        lastClient = {
          version: String(payload?.version ?? 'unknown').slice(0, 64),
          at: Date.now(),
          // 浏览器半区回报的版面实测数字，用于排查「面板为什么降级成浮层」。
          layout: payload?.layout && typeof payload.layout === 'object' ? payload.layout : (lastClient?.layout ?? null),
        }
      } catch {
        // 报到内容坏掉也无所谓，记一笔就好。
        lastClient = { version: 'unknown', at: Date.now(), layout: null }
      }
      log.info?.(`[quick-input] 浏览器半区报到：${lastClient.version} ${JSON.stringify(lastClient.layout ?? {})}`)
      sendJson(res, 200, { ok: true, value: lastClient })
      return
    }

    if (pathname === `${ROUTE_PATH}/health` && (req.method === 'GET' || req.method === 'HEAD')) {
      // 诊断请求只读不写：第一次打开页面之前调它，不会把种子语言定死。
      const presets = readPresets(seed, log, { create: false })
      sendJson(res, 200, {
        ok: true,
        name,
        version: VERSION,
        file: storeFile(),
        pages: presets.pages.length,
        client: lastClient,
      })
      return
    }

    if (pathname === `${ROUTE_PATH}/presets` && (req.method === 'GET' || req.method === 'HEAD')) {
      // 浏览器半区会带上自己的界面语言：文件还不存在时按它种一套对应语言的示例。
      const lang = url.searchParams.get('lang') ?? undefined
      sendJson(res, 200, { ok: true, value: readPresets(seed, log, { lang, create: true }) })
      return
    }

    if (pathname === `${ROUTE_PATH}/presets` && req.method === 'POST') {
      let payload
      try {
        const text = await readBody(req)
        payload = text === '' ? {} : JSON.parse(text)
      } catch (error) {
        sendJson(res, 400, {
          ok: false,
          error: 'bad-body',
          message: error instanceof Error ? error.message : String(error),
        })
        return
      }
      const normalized = normalizePresets(payload)
      if (normalized.pages.length === 0) {
        sendJson(res, 400, { ok: false, error: 'empty', message: '至少要保留一页' })
        return
      }
      try {
        writePresets(normalized)
      } catch (error) {
        sendJson(res, 500, {
          ok: false,
          error: 'write-failed',
          message: error instanceof Error ? error.message : String(error),
        })
        return
      }
      sendJson(res, 200, { ok: true, value: normalized })
      return
    }

    sendJson(res, 404, { ok: false, error: 'not-found', path: pathname })
  }

  // webServer 是可选的：没有它，页面拿不到预设，但插件本身照常加载。
  ctx.inject(['webServer'], (scoped) => {
    scoped.effect(
      () =>
        scoped.webServer.register({
          kind: 'prefix',
          path: ROUTE_PATH,
          // 返回 Promise，让 webServer 等响应真正写完。
          handler: (req, res) =>
            handleRequest(req, res).catch((error) => {
              log.warn?.(
                '[quick-input] 请求处理失败：',
                error instanceof Error ? error.message : String(error),
              )
              try {
                sendJson(res, 500, { ok: false, error: 'internal' })
              } catch {
                /* 响应可能已经发出 */
              }
            }),
        }),
      'quick-input.route',
    )
  })

  log.info?.(`[quick-input] 预设文件：${storeFile()}`)
}
