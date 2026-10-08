/**
 * 预设的纯逻辑层：默认种子 + 规范化。
 *
 * 只被宿主半区（index.js）import；浏览器半区是一段脚本文本、不能 import 任何东西，
 * 所以它内部有一份等价的最小规范化（那边只信自己 POST 出去的东西，风险面更小）。
 *
 * 数据形状（presets.json）：
 *   { version: 1, pages: [ { title: string, cells: (null | { label, text })[] } ] }
 * 每页固定 CELLS_PER_PAGE 个格子（长度不足补 null，多余截断）。
 */

/** 每页格子数：3×3 九宫格。 */
export const CELLS_PER_PAGE = 9

/** 最多几页。 */
export const MAX_PAGES = 12

/** 单格正文上限（字符）。 */
export const MAX_CELL_TEXT = 2000

/** 格子上显示的短标签上限（字符）。 */
export const MAX_LABEL = 12

/** 页名上限（字符）。 */
export const MAX_PAGE_TITLE = 12

/** 中文种子：两页，第一页九格填满。 */
const SEED_ZH = {
  version: 1,
  pages: [
    {
      title: '常用',
      cells: [
        { label: '继续', text: '继续' },
        { label: '先给结论', text: '先给结论，再给理由。' },
        { label: '说短点', text: '用更短的版本重说一遍。' },
        { label: '列步骤', text: '列成编号步骤，每步一句话。' },
        { label: '说人话', text: '用大白话解释，不要术语。' },
        { label: '表格对比', text: '用表格对比这几个方案。' },
        { label: '风险点', text: '这条方案的风险和代价是什么？' },
        { label: '举个例', text: '给一个具体的例子。' },
        { label: '你来定', text: '你直接定，选最好的那个，别问我。' },
      ],
    },
    {
      title: '代码',
      cells: [
        { label: '解释代码', text: '解释这段代码在做什么，重点说数据流。' },
        { label: '找 bug', text: '找出这段代码里的 bug，按严重程度排序。' },
        { label: '补测试', text: '给这段代码补单元测试，覆盖边界情况。' },
        { label: '重构', text: '重构这段代码，保持行为不变。' },
        { label: '过一遍', text: '按 code review 的方式过一遍，指出可以改进的地方。' },
      ],
    },
  ],
}

/** English seed: same shape, so an English UI starts with English phrases. */
const SEED_EN = {
  version: 1,
  pages: [
    {
      title: 'Common',
      cells: [
        { label: 'Continue', text: 'Continue' },
        { label: 'Answer first', text: 'Give the conclusion first, then the reasoning.' },
        { label: 'Shorter', text: 'Say it again in a shorter version.' },
        { label: 'Steps', text: 'Turn this into numbered steps, one sentence each.' },
        { label: 'Plain words', text: 'Explain it in plain language, no jargon.' },
        { label: 'Compare', text: 'Compare these options in a table.' },
        { label: 'Risks', text: 'What are the risks and costs of this approach?' },
        { label: 'Example', text: 'Give me one concrete example.' },
        { label: 'You decide', text: 'You decide — pick the best one, do not ask me.' },
      ],
    },
    {
      title: 'Code',
      cells: [
        { label: 'Explain', text: 'Explain what this code does, focusing on the data flow.' },
        { label: 'Find bugs', text: 'Find the bugs in this code, ordered by severity.' },
        { label: 'Add tests', text: 'Add unit tests for this code, covering the edge cases.' },
        { label: 'Refactor', text: 'Refactor this code, keeping the behaviour unchanged.' },
        { label: 'Review', text: 'Do a code review pass and point out what could be improved.' },
      ],
    },
  ],
}

/**
 * 默认种子：按界面语言给一套（`en*` 给英文，其余给中文）。
 * 只在预设文件还不存在时用一次；用户改过之后就以文件为准。
 */
export function defaultPresets(lang) {
  const english = typeof lang === 'string' && lang.toLowerCase().startsWith('en')
  return normalizePresets(english ? SEED_EN : SEED_ZH)
}

/** 一行文本 → 短标签：去掉换行与多余空白，超长截断并加省略号。 */
export function toLabel(value, fallbackText = '') {
  const source = typeof value === 'string' && value.trim() !== '' ? value : fallbackText
  const flat = String(source).replace(/\s+/g, ' ').trim()
  if (flat === '') return '未命名'
  return flat.length > MAX_LABEL ? `${flat.slice(0, MAX_LABEL - 1)}…` : flat
}

/** 页名：去换行、限长；空则给一个序号名。 */
function toTitle(value, index) {
  const flat = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  if (flat === '') return `第 ${index + 1} 页`
  return flat.length > MAX_PAGE_TITLE ? flat.slice(0, MAX_PAGE_TITLE) : flat
}

/**
 * 把任意输入收成一个合法文档。永不抛异常——脏数据只会退化成空格子。
 * @param input 任意值（来自文件、请求体或配置）。
 * @returns `{ version, pages }`（pages 可能为空数组，由调用方决定怎么处理）
 */
export function normalizePresets(input) {
  const rawPages = Array.isArray(input?.pages) ? input.pages : []
  const pages = []
  for (const rawPage of rawPages) {
    if (pages.length >= MAX_PAGES) break
    const rawCells = Array.isArray(rawPage?.cells) ? rawPage.cells : []
    const cells = []
    for (let i = 0; i < CELLS_PER_PAGE; i++) {
      const rawCell = rawCells[i]
      const text = typeof rawCell?.text === 'string' ? rawCell.text.slice(0, MAX_CELL_TEXT) : ''
      if (text.trim() === '') {
        cells.push(null)
        continue
      }
      cells.push({ label: toLabel(rawCell?.label, text), text })
    }
    pages.push({ title: toTitle(rawPage?.title, pages.length), cells })
  }
  return { version: 1, pages }
}
