const fs = require('fs')
const path = require('path')
const { globSync } = require('glob')
const { nanoid } = require('nanoid')
const { spawn } = require('child_process')
const { app } = require('electron')
const _ = require('lodash')
const { getRootPath } = require('../modules/utils.js')

const isExecutable = (filepath) => {
  try {
    fs.accessSync(filepath, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

const whichSync = (name) => {
  const pathExts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE').split(';') : ['']
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const ext of pathExts) {
      const candidate = path.join(dir, name + ext)
      if (isExecutable(candidate)) return candidate
    }
  }
  return undefined
}

// 打包后 7zip-bin 位于 app.asar 内，二进制必须从 app.asar.unpacked 中执行
const unpackedPath = (p) => p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)

// Windows 下 exe 位于安装根目录，macOS 下 exe 在 Contents/MacOS，而资源在 Contents/Resources
const getExtraResourcesPath = () => {
  if (app.isPackaged) return path.join(process.resourcesPath, 'extraResources')
  return path.join(getRootPath(), 'resources', 'extraResources')
}

const resolve7z = () => {
  const extraResources = getExtraResourcesPath()
  const candidates = []
  if (process.platform === 'win32') {
    // Windows 附带带 7z.dll 的完整版 7z，支持 rar 等格式
    candidates.push(path.join(extraResources, '7z.exe'))
  } else {
    // 随包分发的完整版 7zz（通用二进制），支持 zip/7z/rar
    candidates.push(path.join(extraResources, '7zz'), path.join(extraResources, '7za'))
    // 退回到系统安装的 7z/7zz
    for (const name of ['7zz', '7z']) {
      const found = whichSync(name)
      if (found) candidates.push(found)
    }
    candidates.push('/opt/homebrew/bin/7zz', '/usr/local/bin/7zz')
    // 最后退回到 7zip-bin 附带的 7za（仅开发环境，不支持 rar）
    try {
      candidates.push(unpackedPath(require('7zip-bin').path7za))
    } catch {
      // 7zip-bin 未安装时忽略
    }
    const za = whichSync('7za')
    if (za) candidates.push(za)
  }
  const found = candidates.find(isExecutable)
  if (!found) {
    throw new Error('7z executable not found, install 7-Zip (e.g. "brew install sevenzip")')
  }
  return found
}

let _7z
const get7z = () => _7z || (_7z = resolve7z())

const getArchivelist = async (libraryPath) => {
  const list = globSync('**/*.@(rar|7z|cb7|cbr)', {
    cwd: libraryPath,
    nocase: true,
    nodir: true,
    follow: true,
    absolute: true
  })
  return list
}

const solveBookTypeArchive = async (filepath, TEMP_PATH, COVER_PATH) => {
  const tempFolder = path.join(TEMP_PATH, nanoid(8))
  const output = await spawnPromise(get7z(), ['l', filepath, '-slt', '-sccUTF-8', '-p123456'], 2 * 60 * 1000)
  let pathlist = _.filter(output.split(/\r?\n/), s => _.startsWith(s, 'Path') && !_.includes(s, '__MACOSX'))
  pathlist = pathlist.map(p => {
    const match = /(?<== ).*$/.exec(p)
    return match ? match[0] : ''
  })
  let imageList = _.filter(pathlist, p => ['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif'].includes(path.extname(p).toLowerCase()))
  imageList = imageList.sort((a, b) => a.localeCompare(b, undefined, {numeric: true, sensitivity: 'base'}))

  let targetFile
  let targetFilePath
  let coverFile
  let tempCoverPath
  let coverPath
  if (imageList.length > 8) {
    targetFile = imageList[7]
    coverFile = imageList[0]
    await spawnPromise(get7z(), ['x', '-o'+tempFolder, '-p123456', '--', filepath, targetFile], 2 * 60 * 1000)
    await spawnPromise(get7z(), ['x', '-o'+tempFolder, '-p123456', '--', filepath, coverFile], 2 * 60 * 1000)
  } else if (imageList.length > 0) {
    targetFile = imageList[0]
    coverFile = imageList[0]
    await spawnPromise(get7z(), ['x', '-o'+tempFolder, '-p123456', '--', filepath, targetFile], 2 * 60 * 1000)
  } else {
    throw new Error('compression package isnot include image')
  }
  targetFilePath = path.join(TEMP_PATH, nanoid(8) + path.extname(targetFile))
  await fs.promises.copyFile(path.join(tempFolder, targetFile), targetFilePath)

  tempCoverPath = path.join(TEMP_PATH, nanoid(8) + path.extname(coverFile))
  await fs.promises.copyFile(path.join(tempFolder, coverFile), tempCoverPath)

  coverPath = path.join(COVER_PATH, nanoid() + '.webp')

  const fileStat = await fs.promises.stat(filepath)
  return {targetFilePath, tempCoverPath, coverPath, pageCount: imageList.length, bundleSize: fileStat?.size, mtime: fileStat?.mtime}
}

const getImageListFromArchive = async (filepath, VIEWER_PATH) => {
  const tempFolder = path.join(VIEWER_PATH, nanoid(8))
  await spawnPromise(get7z(), ['x', filepath, '-o' + tempFolder, '-p123456'], 2 * 60 * 1000)
  let list = globSync('**/*.@(jpg|jpeg|png|webp|avif|gif)', {
    cwd: tempFolder,
    nocase: true
  })
  list = _.filter(list, s => !_.includes(s, '__MACOSX'))
  list = list.sort((a, b) => a.localeCompare(b, undefined, {numeric: true, sensitivity: 'base'}))
  return list.map(f => ({
    relativePath: f,
    absolutePath: path.join(tempFolder, f)
  }))
}

const imageExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif']

// 解析 7z `l -slt` 输出，返回图片条目（不做任何解压）
const getArchiveImageEntries = async (filepath) => {
  const output = await spawnPromise(get7z(), ['l', filepath, '-slt', '-sccUTF-8', '-p123456'], 2 * 60 * 1000)
  const entries = []
  let current = null
  const commit = () => {
    if (current && current.path !== filepath && !current.folder && !current.hasType &&
        !current.path.includes('__MACOSX') && imageExtensions.includes(path.extname(current.path).toLowerCase())) {
      entries.push({ relativePath: current.path, size: current.size })
    }
    current = null
  }
  for (const line of output.split(/\r?\n/)) {
    const pathMatch = /^Path = (.*)$/.exec(line)
    if (pathMatch) {
      commit()
      current = { path: pathMatch[1], size: 0, folder: false, hasType: false }
      continue
    }
    if (!current) continue
    const sizeMatch = /^Size = (\d+)$/.exec(line)
    if (sizeMatch) {
      current.size = Number(sizeMatch[1])
      continue
    }
    if (/^Folder = \+/.test(line)) {
      current.folder = true
      continue
    }
    if (/^Type = /.test(line)) current.hasType = true
  }
  commit()
  entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath, undefined, {numeric: true, sensitivity: 'base'}))
  return entries
}

// 仅解压指定的条目到目标目录
const extractArchiveEntries = async (filepath, entryNames, destDir) => {
  if (_.isEmpty(entryNames)) return
  await spawnPromise(get7z(), ['x', '-y', '-o' + destDir, '-p123456', '--', filepath, ...entryNames], 2 * 60 * 1000)
}

const deleteImageFromArchive = async (filename, filepath) => {
  await spawnPromise(get7z(), ['d', '-p123456', '--', filepath, filename])
  return true
}

const spawnPromise = (commmand, argument, timeoutMs = 30 * 1000) => {
  return new Promise((resolve, reject) => {
    const spawned = spawn(commmand, argument)
    const output = []
    const timeout = setTimeout(() => {
      spawned.kill()
      reject('7z return timeout')
    }, timeoutMs) // 默认30s超时

    spawned.on('error', data => {
      clearTimeout(timeout)
      reject(data)
    })
    spawned.on('exit', code => {
      clearTimeout(timeout)
      if (code === 0) {
        setTimeout(() => resolve(Buffer.concat(output).toString('utf8')), 50)
      } else {
        reject('close code is ' + code)
      }
    })
    spawned.stdout.on('data', data => {
      output.push(data)
    })
  })
}

module.exports = {
  getArchivelist,
  solveBookTypeArchive,
  getImageListFromArchive,
  getArchiveImageEntries,
  extractArchiveEntries,
  deleteImageFromArchive
}