const fs = require('fs')
const path = require('path')
const { pathToFileURL } = require('url')
const { createRequire } = require('module')
const { globSync } = require('glob')
const { nanoid } = require('nanoid')

// pdfjs-dist v5 需要 Node >= 20.16 的 process.getBuiltinModule，
// 而 Electron 26 内置 Node 18，这里补一个等价的 shim 即可正常在 Node 侧渲染。
if (typeof process.getBuiltinModule !== 'function') {
  process.getBuiltinModule = (name) => require(name)
}

const DEFAULT_RENDER_WIDTH = 1600
const MAX_RENDER_SCALE = 4
const MIN_RENDER_SCALE = 0.05
// 单页最多 40M 像素，避免超长页面一次性分配过大 canvas
const MAX_RENDER_PIXELS = 40 * 1000 * 1000

// 打包后 pdfjs-dist 位于 app.asar.unpacked，ESM 动态导入需要真实路径
const unpackedPath = (p) => p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)

const PDFJS_ROOT = path.dirname(require.resolve('pdfjs-dist/package.json'))
const STANDARD_FONT_DATA_URL = unpackedPath(path.join(PDFJS_ROOT, 'standard_fonts')) + path.sep
const CMAP_URL = unpackedPath(path.join(PDFJS_ROOT, 'cmaps')) + path.sep

let pdfjsPromise
let pdfjsEntryPath
const getPdfjsEntryPath = () => pdfjsEntryPath || (pdfjsEntryPath = unpackedPath(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')))
const loadPdfjs = () => {
  if (!pdfjsPromise) {
    pdfjsPromise = import(pathToFileURL(getPdfjsEntryPath()).href)
  }
  return pdfjsPromise
}

let canvasModule
// 必须从 pdfjs 相同的路径解析 @napi-rs/canvas，否则打包后（asar / asar.unpacked）
// 会各自加载一份独立实例，导致 pdfjs 内部的 Path2D 与画布上下文类型不匹配。
const loadCanvas = () => {
  if (!canvasModule) {
    const pdfjsRequire = createRequire(pathToFileURL(getPdfjsEntryPath()).href)
    canvasModule = pdfjsRequire('@napi-rs/canvas')
  }
  return canvasModule
}

const getPdfFilelist = async (libraryPath) => {
  const list = globSync('**/*.pdf', {
    cwd: libraryPath,
    nocase: true,
    nodir: true,
    follow: true,
    absolute: true
  })
  return list
}

const getPdfDocument = async (filepath) => {
  const pdfjs = await loadPdfjs()
  const data = new Uint8Array(await fs.promises.readFile(filepath))
  return pdfjs.getDocument({
    data,
    cMapUrl: CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
    disableFontFace: true,
    isEvalSupported: false,
    verbosity: 0
  }).promise
}

const resolveScale = (viewport, maxWidth) => {
  const targetWidth = maxWidth || DEFAULT_RENDER_WIDTH
  let scale = targetWidth / viewport.width
  scale = Math.min(Math.max(scale, MIN_RENDER_SCALE), MAX_RENDER_SCALE)
  const pixelCount = viewport.width * scale * viewport.height * scale
  if (pixelCount > MAX_RENDER_PIXELS) {
    scale *= Math.sqrt(MAX_RENDER_PIXELS / pixelCount)
  }
  return scale
}

// 渲染一页并写入 destPath（按扩展名输出 png / jpg），返回实际像素尺寸
const renderPageToFile = async (doc, pageIndex, destPath, options = {}) => {
  const { createCanvas } = loadCanvas()
  const page = await doc.getPage(pageIndex)
  try {
    const baseViewport = page.getViewport({ scale: 1 })
    const scale = resolveScale(baseViewport, options.maxWidth)
    const viewport = page.getViewport({ scale })
    const canvas = createCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)))
    const context = canvas.getContext('2d')
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    await page.render({ canvasContext: context, viewport, canvas }).promise
    const ext = path.extname(destPath).toLowerCase()
    const buffer = ext === '.png' ? canvas.toBuffer('image/png') : canvas.toBuffer('image/jpeg', 90)
    await fs.promises.mkdir(path.dirname(destPath), { recursive: true })
    await fs.promises.writeFile(destPath, buffer)
    return { width: canvas.width, height: canvas.height }
  } finally {
    page.cleanup()
  }
}

const solveBookTypePdf = async (filepath, TEMP_PATH, COVER_PATH) => {
  const doc = await getPdfDocument(filepath)
  try {
    const pageCount = doc.numPages
    if (!pageCount) throw new Error('pdf isnot include page')
    const coverIndex = 1
    const targetIndex = pageCount > 8 ? 8 : 1

    const tempCoverPath = path.join(TEMP_PATH, nanoid(8) + '.jpg')
    await renderPageToFile(doc, coverIndex, tempCoverPath, { maxWidth: 1000 })

    const targetFilePath = path.join(TEMP_PATH, nanoid(8) + '.jpg')
    if (targetIndex === coverIndex) {
      await fs.promises.copyFile(tempCoverPath, targetFilePath)
    } else {
      await renderPageToFile(doc, targetIndex, targetFilePath, { maxWidth: 1000 })
    }

    const coverPath = path.join(COVER_PATH, nanoid() + '.webp')
    const fileStat = await fs.promises.stat(filepath)
    return { targetFilePath, tempCoverPath, coverPath, pageCount, bundleSize: fileStat.size, mtime: fileStat.mtime }
  } finally {
    await doc.destroy()
  }
}

// 只列出页，不渲染（阅读时按页按需渲染）
const getPdfImageEntries = async (filepath) => {
  const doc = await getPdfDocument(filepath)
  try {
    const entries = []
    for (let pageIndex = 1; pageIndex <= doc.numPages; pageIndex++) {
      entries.push({ relativePath: `page_${pageIndex}`, entryIndex: pageIndex })
    }
    return entries
  } finally {
    await doc.destroy()
  }
}

// 渲染指定的单页到 destPath
const extractPdfPageToFile = async (filepath, pageIndex, destPath, options = {}) => {
  const doc = await getPdfDocument(filepath)
  try {
    await renderPageToFile(doc, pageIndex, destPath, options)
  } finally {
    await doc.destroy()
  }
  return destPath
}

// 一次打开文档，批量渲染多页到 destDir，返回 Map(pageIndex -> 本地路径)
const extractPdfPagesToDir = async (filepath, pages, destDir, options = {}) => {
  const doc = await getPdfDocument(filepath)
  const results = new Map()
  try {
    await fs.promises.mkdir(destDir, { recursive: true })
    for (const page of pages) {
      const pageIndex = page.entryIndex ?? page.pageIndex
      const destPath = path.join(destDir, `page_${pageIndex}.jpg`)
      await renderPageToFile(doc, pageIndex, destPath, options)
      results.set(pageIndex, destPath)
    }
  } finally {
    await doc.destroy()
  }
  return results
}

// 一次性渲染整本（仅供不使用懒加载的兜底路径使用）
const getImageListFromPdf = async (filepath, VIEWER_PATH, options = {}) => {
  const doc = await getPdfDocument(filepath)
  const tempFolder = path.join(VIEWER_PATH, nanoid(8))
  const list = []
  try {
    await fs.promises.mkdir(tempFolder, { recursive: true })
    for (let pageIndex = 1; pageIndex <= doc.numPages; pageIndex++) {
      const destPath = path.join(tempFolder, `page_${pageIndex}.jpg`)
      await renderPageToFile(doc, pageIndex, destPath, options)
      list.push({ relativePath: `page_${pageIndex}`, absolutePath: destPath })
    }
    return list
  } finally {
    await doc.destroy()
  }
}

module.exports = {
  getPdfFilelist,
  solveBookTypePdf,
  getPdfImageEntries,
  extractPdfPageToFile,
  extractPdfPagesToDir,
  getImageListFromPdf
}
