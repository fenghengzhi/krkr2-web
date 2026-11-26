import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { discBootDirectory, discBootProjectFiles, discBootVolume } from '../tests/helpers/disc-boot.ts'

assert.equal(process.env.GITHUB_ACTIONS, 'true')
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
const output = resolve('out/verification/disc-volumes'), hash = (bytes) => createHash('sha256').update(bytes).digest('hex'),
  manifest = { schema: 1, complete: false, commit: process.env.GITHUB_SHA, images: [], commands: [], error: null },
  save = () => writeFileSync(join(output, 'boot-manifest.json'), JSON.stringify(manifest, null, 2) + '\n'),
  run = (program, args) => {
    manifest.commands.push({ program, args })
    return execFileSync(program, args, { maxBuffer: 64 * 1024 * 1024, timeout: 120000 })
  }
mkdirSync(output, { recursive: true })
try {
  manifest.genisoimageVersion = run('genisoimage', ['--version']).toString()
  for (const binary of [false, true]) {
    const mode = binary ? 'bytecode' : 'source', name = `boot-${mode}.iso`,
      input = join(output, `boot-${mode}-files`), project = join(input, discBootDirectory)
    rmSync(input, { recursive: true, force: true })
    cpSync(join(output, 'story-files'), input, { recursive: true })
    mkdirSync(project, { recursive: true })
    const projectFiles = discBootProjectFiles(binary)
    for (const file of projectFiles) writeFileSync(join(project, file.name), file.buffer)
    run('genisoimage', ['-quiet', '-input-charset', 'utf-8', '-J', '-V', discBootVolume, '-o', join(output, name), input])
    const listing = run('isoinfo', ['-i', join(output, name), '-J', '-f'])
    writeFileSync(join(output, `boot-${mode}-listing.txt`), listing)
    const paths = new Map(listing.toString('utf8').trim().split(/\r?\n/).map((path) => [path.split(';', 1)[0], path])),
      independentlyExtracted = []
    for (const file of projectFiles) {
      const path = `/${discBootDirectory}/${file.name}`, stored = paths.get(path)
      assert(stored, `No original project input on ISO: ${path}`)
      const actual = run('isoinfo', ['-i', join(output, name), '-J', '-x', stored])
      assert.deepEqual(actual, file.buffer, `Independent ISO extraction differs: ${path}`)
      independentlyExtracted.push(path)
    }
    const files = [], collect = (directory, prefix = '') => {
      for (const item of readdirSync(directory, { withFileTypes: true })) {
        const relative = prefix + item.name, path = join(directory, item.name)
        if (item.isDirectory()) collect(path, relative + '/')
        else { const bytes = readFileSync(path); files.push({ name: relative, bytes: bytes.length, sha256: hash(bytes) }) }
      }
    }
    collect(input); files.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    const bytes = readFileSync(join(output, name))
    manifest.images.push({ name, mode, bytes: bytes.length, sha256: hash(bytes), files, independentlyExtracted })
    save()
  }
  manifest.complete = true
} catch (error) { manifest.error = String(error); throw error }
finally { save() }
