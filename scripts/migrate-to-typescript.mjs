#!/usr/bin/env node
/**
 * One-time migration: copy .js sources to .ts under src/, test/, examples/, scripts/.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

const rootLibraryFiles = fs
  .readdirSync(root)
  .filter((f) => f.endsWith('.js') && fs.statSync(path.join(root, f)).isFile())

for (const file of rootLibraryFiles) {
  const src = path.join(root, file)
  const dest = path.join(root, 'src', file.replace(/\.js$/, '.ts'))
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  let content = fs.readFileSync(src, 'utf8')
  content = content.replace(
    /path\.join\(__dirname,\s*['"]proto['"],\s*['"]mtdd\.proto['"]\)/g,
    "require('./proto-path').getProtoPath()",
  )
  fs.writeFileSync(dest, content)
}

const flatSrc = path.join(root, 'flatbuffers', 'result-meta-codec.js')
if (fs.existsSync(flatSrc)) {
  const destDir = path.join(root, 'src', 'flatbuffers')
  fs.mkdirSync(destDir, { recursive: true })
  fs.copyFileSync(flatSrc, path.join(destDir, 'result-meta-codec.ts'))
}

for (const dir of ['test', 'examples', 'scripts']) {
  const abs = path.join(root, dir)
  if (!fs.existsSync(abs)) continue
  for (const file of fs.readdirSync(abs)) {
    if (!file.endsWith('.js')) continue
    const src = path.join(abs, file)
    if (!fs.statSync(src).isFile()) continue
    let content = fs.readFileSync(src, 'utf8')
    const dest = path.join(abs, file.replace(/\.js$/, '.ts'))
    if (dir === 'scripts') {
      content = content.replace(
        /path\.join\(__dirname,\s*'\.\.',\s*'proto',\s*'mtdd\.proto'\)/g,
        "require('../src/proto-path').getProtoPath()",
      )
    }
    if (dir === 'test' && file === 'helpers.js') {
      content = content.replace(
        /path\.join\(__dirname,\s*'\.\.',\s*'register\.js'\)/g,
        "path.join(__dirname, '..', 'dist', 'src', 'register.js')",
      )
      content = content.replace(
        /const packageRoot = path\.join\(__dirname,\s*'\.\.'\)/g,
        "const packageRoot = path.join(__dirname, '..')",
      )
    }
    fs.writeFileSync(dest, content)
  }
}

console.log(`Migrated ${rootLibraryFiles.length} library files to src/`)
