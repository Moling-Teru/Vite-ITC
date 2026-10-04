import { defineConfig, type DefaultTheme } from 'vitepress'
import type { Plugin } from 'vite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓库根目录（即 VitePress 的 source root），本项目不改变教材原有目录结构 */
const rootDir = fileURLToPath(new URL('..', import.meta.url))

/** 侧边栏标题覆盖：相对根目录的路径（posix 风格）-> 展示名称 */
const titleOverrides: Record<string, string> = {
  'README.md': '关于本教材',
  '总览.md': '总览',
  '教程/硬件/README.md': '硬件',
  '教程/系统/README.md': '系统',
  '教程/常用软件/README.md': '常用软件',
  '教程/常用软件/办公软件/README.md': '办公软件',
  '教程/常用软件/3.3 办公软件/README.md': '3.3 办公软件',
  '教程/网络/README.md': '网络',
  '教程/常用基础操作/README.md': '常用基础操作'
}

/** 这些标题过于泛化，不适合作为侧边栏条目名，遇到时回退到文件名 */
const genericHeadings = new Set(['目录', '摘要', '本章节内容概览'])

/** 读取 Markdown 文件中第一个有效标题（跳过 frontmatter 与代码块） */
function readHeading(absPath: string): string | null {
  let text: string
  try {
    text = fs.readFileSync(absPath, 'utf8')
  } catch {
    return null
  }

  const lines = text.split(/\r?\n/)
  let inFrontmatter = lines[0]?.trim() === '---'
  let inFence = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (inFrontmatter) {
      if (i > 0 && line.trim() === '---') inFrontmatter = false
      continue
    }

    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue

    const matched = /^#{1,3}\s+(.+?)\s*#*\s*$/.exec(line)
    if (matched) {
      const title = matched[1]
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[*_`]/g, '')
        .trim()
      if (title && !genericHeadings.has(title)) return title
    }
  }
  return null
}

/** 生成单个条目的显示名 */
function labelOf(absPath: string, relPath: string, fallback: string): string {
  return titleOverrides[relPath] ?? readHeading(absPath) ?? fallback
}

type OrderKey = [number[], string]

/** 依据标题中的编号（如 2.3.1）排序，无编号的排在最后 */
function orderKeyOf(label: string, fileName: string): OrderKey {
  const matched = /^(\d+(?:\.\d+)*)/.exec(label)
  return matched ? [matched[1].split('.').map(Number), fileName] : [[9999], fileName]
}

function compareKey(a: OrderKey, b: OrderKey): number {
  const [aNums, aName] = a
  const [bNums, bName] = b
  const len = Math.max(aNums.length, bNums.length)
  for (let i = 0; i < len; i++) {
    const x = aNums[i] ?? -1
    const y = bNums[i] ?? -1
    if (x !== y) return x - y
  }
  return aName.localeCompare(bName, 'zh-Hans-CN')
}

/**
 * 递归扫描目录生成侧边栏条目（不改变磁盘上的任何文件）。
 * 目录中的 README.md 作为所在分组的可点击标题，不再单独列出。
 */
function buildItems(
  absDir: string,
  routePrefix: string,
  skipReadme = false
): DefaultTheme.SidebarItem[] {
  const entries = fs.readdirSync(absDir, { withFileTypes: true })
  const hasReadme = entries.some(
    (entry) => entry.isFile() && /^readme\.md$/i.test(entry.name)
  )
  const collected: { item: DefaultTheme.SidebarItem; key: OrderKey }[] = []

  for (const entry of entries) {
    if (entry.isFile() && /\.md$/i.test(entry.name)) {
      if (skipReadme && hasReadme && /^readme\.md$/i.test(entry.name)) continue

      const absFile = path.join(absDir, entry.name)
      const relFile = path.relative(rootDir, absFile).split(path.sep).join('/')
      const baseName = entry.name.replace(/\.md$/i, '')
      const label = labelOf(absFile, relFile, baseName)

      collected.push({
        item: { text: label, link: `${routePrefix}/${baseName}` },
        key: orderKeyOf(label, entry.name)
      })
      continue
    }

    if (entry.isDirectory()) {
      const subAbsDir = path.join(absDir, entry.name)
      const subPrefix = `${routePrefix}/${entry.name}`
      const subReadme = path.join(subAbsDir, 'README.md')
      const readmeExists = fs.existsSync(subReadme)

      const anchorFile = readmeExists ? subReadme : subAbsDir
      const relFile = path.relative(rootDir, anchorFile).split(path.sep).join('/')
      const label = readmeExists ? labelOf(anchorFile, relFile, entry.name) : entry.name

      const group: DefaultTheme.SidebarItem = {
        text: label,
        collapsed: true,
        items: buildItems(subAbsDir, subPrefix, readmeExists)
      }
      if (readmeExists) group.link = `${subPrefix}/README`

      collected.push({ item: group, key: orderKeyOf(label, entry.name) })
    }
  }

  collected.sort((a, b) => compareKey(a.key, b.key))
  return collected.map((entry) => entry.item)
}

/** 预定义部分板块的排序与显示标题（未在表中列出的新目录将自动排在后面） */
const knownPartConfig: Record<string, { order: number; text: string }> = {
  '硬件': { order: 1, text: 'Part 1. 硬件' },
  '系统': { order: 2, text: 'Part 2. 系统' },
  '常用软件': { order: 3, text: 'Part 3. 常用软件' },
  '网络': { order: 4, text: 'Part 4. 网络' },
  '常用基础操作': { order: 5, text: 'Part 5. 常用基础操作' }
}

/**
 * 自动扫描「教程」目录下的所有子文件夹，生成对应的大模块配置。
 * 以后在此目录下新增任何子文件夹都会被自动识别并展示，无需反复手动修改配置。
 */
function getTutorialParts() {
  const tutorialDir = path.join(rootDir, '教程')
  if (!fs.existsSync(tutorialDir)) return []

  const entries = fs.readdirSync(tutorialDir, { withFileTypes: true })
  const scanned = entries
    .filter((entry) => entry.isDirectory())
    .map((entry, index) => {
      const folderName = entry.name
      const known = knownPartConfig[folderName]
      const numMatch = folderName.match(/^(\d+)/)
      const order = known ? known.order : (numMatch ? parseInt(numMatch[1], 10) : 100 + index)
      const text = known ? known.text : folderName

      return {
        order,
        text,
        dir: `教程/${folderName}`,
        prefix: `/教程/${folderName}`
      }
    })

  scanned.sort((a, b) => a.order - b.order)
  return scanned.map(({ text, dir, prefix }) => ({ text, dir, prefix }))
}

const parts = getTutorialParts()

const sidebar: DefaultTheme.SidebarItem[] = [
  {
    text: '开始',
    items: [
      { text: '总览', link: '/总览' },
      { text: '计算机通识 Class 101', link: '/101' },
      { text: '教材格式要求（试行）', link: '/标准格式试行' },
      { text: '关于本教材', link: '/README' }
    ]
  },
  ...parts.map<DefaultTheme.SidebarItem>((part) => ({
    text: part.text,
    collapsed: false,
    link: `${part.prefix}/README`,
    items: buildItems(path.join(rootDir, part.dir), part.prefix, true)
  }))
]

/** 会被当作静态资源处理的扩展名（用于识别“疑似资源”的相对引用） */
const ASSET_EXT_RE =
  /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico|tiff?|mp4|webm|ogv|mp3|wav|ogg|woff2?|ttf|otf|eot|pdf)$/i

/** 生成一张“图片缺失”占位图（内联 SVG），上面标注缺失文件的路径 */
function missingAssetPlaceholder(label: string): string {
  const escaped = label.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const text = escaped.length > 60 ? `${escaped.slice(0, 57)}...` : escaped
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">' +
    '<rect width="640" height="360" fill="#f6f6f7" stroke="#d0d0d5" stroke-width="4" stroke-dasharray="14 10"/>' +
    '<text x="320" y="168" text-anchor="middle" font-family="system-ui, sans-serif" font-size="36" fill="#9a9aa2">图片缺失</text>' +
    `<text x="320" y="216" text-anchor="middle" font-family="system-ui, sans-serif" font-size="20" fill="#b4b4bc">${text}</text>` +
    '</svg>'
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

/**
 * 教材中部分图片尚未随文档一起提供，相对路径指向的文件并不存在。
 * Vite 默认会因此中断构建，这里改为解析成一张占位图，
 * 既保留原有 Markdown，又能在页面上直观看到缺失位置。
 */
function missingAssetsPlugin(): Plugin {
  const prefix = '\0missing-asset:'

  return {
    name: 'vitepress:missing-assets-placeholder',
    enforce: 'pre',

    async resolveId(source, importer) {
      if (!importer || source.startsWith('\0')) return null
      if (!source.startsWith('./') && !source.startsWith('../')) return null

      const bare = source.split(/[?#]/)[0]
      if (!ASSET_EXT_RE.test(bare) && !bare.endsWith('/')) return null

      // 文件真实存在时保持 Vite 的默认处理方式
      if (await this.resolve(source, importer, { skipSelf: true })) return null

      const absTarget = path.resolve(path.dirname(importer), bare)
      const label = path.relative(rootDir, absTarget).split(path.sep).join('/')
      return prefix + encodeURIComponent(label)
    },

    load(id) {
      if (!id.startsWith(prefix)) return null
      const label = decodeURIComponent(id.slice(prefix.length))
      return `export default ${JSON.stringify(missingAssetPlaceholder(label))}`
    }
  }
}

export default defineConfig({
  lang: 'zh-CN',
  title: '计算机与互联网通识教材',
  description:
    '面向初学者：计算机与互联网使用通识教程，涵盖硬件、系统、常用软件与网络。',

  // 直接以仓库根目录作为站点根目录，保持教材原有的目录结构与相对链接不变
  srcDir: '.',
  srcExclude: ['node_modules/**', '**/node_modules/**'],

  // 教材中原有的部分站内链接尚未指向实际文件，先忽略死链以保证构建通过
  ignoreDeadLinks: true,
  lastUpdated: true,

  // 教材大多数页面以 “## 2.3 标题” 开头而没有一级标题，
  // 这会让页面标题、上一篇/下一篇文字变空，这里统一从首个标题补全
  transformPageData(pageData) {
    if (pageData.title) return
    const heading = readHeading(path.join(rootDir, pageData.relativePath))
    if (heading) pageData.title = heading
  },

  markdown: {
    lineNumbers: false,
    theme: { light: 'github-light', dark: 'github-dark' }
  },

  vite: {
    plugins: [missingAssetsPlugin()],
    // 教材的图片存在大写扩展名（如 .JPG），Vite 默认的 assetsInclude 只匹配小写
    assetsInclude: [
      '**/*.JPG',
      '**/*.JPEG',
      '**/*.PNG',
      '**/*.GIF',
      '**/*.SVG',
      '**/*.WEBP',
      '**/*.BMP',
      '**/*.AVIF'
    ]
  },

  themeConfig: {
    outline: { level: [2, 3], label: '本页目录' },
    nav: [
      { text: '总览', link: '/总览' },
      ...parts.map((part) => ({
        text: part.text.replace(/^Part \d+\.\s*/, ''),
        link: `${part.prefix}/README`
      }))
    ],
    sidebar,
    search: { provider: 'local' },
    docFooter: { prev: '上一篇', next: '下一篇' },
    lastUpdated: { text: '最后更新于' },
    returnToTopLabel: '回到顶部',
    sidebarMenuLabel: '目录',
    darkModeSwitchLabel: '外观',
    langMenuLabel: '语言',
    externalLinkIcon: true,
    footer: {
      message: '本教材供学习交流使用，欢迎参与编写与指正。',
      copyright: '由南京师范大学附属中学（察哈尔路校区）开发者社编写 使用CC BY-SA 4.0协议发布'
    }
  }
})
