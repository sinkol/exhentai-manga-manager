const fs = require('fs')
const path = require('path')
const { globSync } = require('glob')
const yauzl = require('yauzl')
const iconv = require('iconv-lite')
const { nanoid } = require('nanoid')

const imageExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif']

const getZipFilelist = async (libraryPath) => {
  const list = globSync('**/*.@(zip|cbz)', {
    cwd: libraryPath,
    nocase: true,
    nodir: true,
    follow: true,
    absolute: true
  })
  return list
}

const isDirectoryEntry = (entry) => {
  const name = entry.fileName
  return Buffer.isBuffer(name) ? name[name.length - 1] === 0x2f : /\/$/.test(name)
}

// ZIP 条目名不带 UTF-8 标记时通常是 GBK/Shift-JIS 等旧编码，用 GB18030 解码（兼容 GBK）
const decodeEntryName = (entry) => {
  const utf8Flag = (entry.generalPurposeBitFlag & 0x800) !== 0
  if (utf8Flag || typeof entry.fileName === 'string') return entry.fileName.toString('utf8')
  return iconv.decode(entry.fileName, 'gb18030')
}

// 列出所有非目录条目，保留 entryIndex 供后续按索引解压
const listZipEntries = (filepath) => {
  return new Promise((resolve, reject) => {
    yauzl.open(filepath, { lazyEntries: true, decodeStrings: false, autoClose: true }, (err, zipfile) => {
      if (err) return reject(err)
      const entries = []
      zipfile.on('entry', entry => {
        if (!isDirectoryEntry(entry)) entries.push(entry)
        zipfile.readEntry()
      })
      zipfile.on('error', reject)
      zipfile.on('end', () => resolve(entries))
      zipfile.readEntry()
    })
  })
}

const getZipImageEntries = async (filepath) => {
  const rawEntries = await listZipEntries(filepath)
  const entries = rawEntries
    .map((entry, entryIndex) => ({ relativePath: decodeEntryName(entry), size: entry.uncompressedSize, entryIndex }))
    .filter(entry => imageExtensions.includes(path.extname(entry.relativePath).toLowerCase()))
  entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath, undefined, { numeric: true, sensitivity: 'base' }))
  return entries
}

// 按 entryIndex 解压单个条目到指定文件（目标文件名由调用方决定，避免非法文件名）
const extractZipEntryToFile = (filepath, entryIndex, destPath) => {
  return new Promise((resolve, reject) => {
    yauzl.open(filepath, { lazyEntries: true, decodeStrings: false, autoClose: true }, (err, zipfile) => {
      if (err) return reject(err)
      let index = 0
      let settled = false
      const fail = (e) => { if (!settled) { settled = true; reject(e) } }
      zipfile.on('entry', entry => {
        if (isDirectoryEntry(entry)) return zipfile.readEntry()
        if (index === entryIndex) {
          zipfile.openReadStream(entry, (err, readStream) => {
            if (err) return fail(err)
            const writeStream = fs.createWriteStream(destPath)
            readStream.on('error', fail)
            writeStream.on('error', fail)
            writeStream.on('close', () => { if (!settled) { settled = true; resolve(destPath) } })
            readStream.pipe(writeStream)
          })
          return
        }
        index++
        zipfile.readEntry()
      })
      zipfile.on('error', fail)
      zipfile.on('end', () => fail(new Error('zip entry not found: ' + entryIndex)))
      zipfile.readEntry()
    })
  })
}

// 一次打开压缩包批量解压多个条目，返回 Map(entryIndex -> 本地路径)
const extractZipEntriesToDir = (filepath, targets, destDir) => {
  return new Promise((resolve, reject) => {
    const targetMap = new Map(targets.map(t => [t.entryIndex, t]))
    const results = new Map()
    yauzl.open(filepath, { lazyEntries: true, decodeStrings: false, autoClose: true }, (err, zipfile) => {
      if (err) return reject(err)
      let index = 0
      zipfile.on('entry', entry => {
        if (isDirectoryEntry(entry)) return zipfile.readEntry()
        const entryIndex = index
        index++
        const target = targetMap.get(entryIndex)
        if (!target) return zipfile.readEntry()
        const destPath = path.join(destDir, `img_${entryIndex}${target.ext}`)
        zipfile.openReadStream(entry, (err, readStream) => {
          if (err) return reject(err)
          const writeStream = fs.createWriteStream(destPath)
          readStream.on('error', reject)
          writeStream.on('error', reject)
          writeStream.on('close', () => {
            results.set(entryIndex, destPath)
            zipfile.readEntry()
          })
          readStream.pipe(writeStream)
        })
      })
      zipfile.on('error', reject)
      zipfile.on('end', () => resolve(results))
      zipfile.readEntry()
    })
  })
}

const solveBookTypeZip = async (filepath, TEMP_PATH, COVER_PATH) => {
  const imageList = await getZipImageEntries(filepath)
  if (imageList.length === 0) {
    throw new Error('compression package isnot include image')
  }
  const targetEntry = imageList.length > 8 ? imageList[7] : imageList[0]
  const coverEntry = imageList[0]

  const targetFilePath = path.join(TEMP_PATH, nanoid(8) + path.extname(targetEntry.relativePath))
  await extractZipEntryToFile(filepath, targetEntry.entryIndex, targetFilePath)

  const tempCoverPath = path.join(TEMP_PATH, nanoid(8) + path.extname(coverEntry.relativePath))
  await extractZipEntryToFile(filepath, coverEntry.entryIndex, tempCoverPath)

  const coverPath = path.join(COVER_PATH, nanoid() + '.webp')

  const fileStat = await fs.promises.stat(filepath)
  return { targetFilePath, tempCoverPath, coverPath, pageCount: imageList.length, bundleSize: fileStat?.size, mtime: fileStat?.mtime }
}

module.exports = {
  getZipFilelist,
  solveBookTypeZip,
  getZipImageEntries,
  extractZipEntryToFile,
  extractZipEntriesToDir
}
