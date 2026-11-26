import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  sourcePath = resolve(root, 'native/legacy-media/source.json'), sourceBytes = readFileSync(sourcePath),
  source = JSON.parse(sourceBytes), sdk = process.env.EMSDK || resolve(root, '../toolchains/krkr2/emsdk'),
  em = resolve(sdk, 'upstream/emscripten'),
  toolchain = readFileSync(resolve(em, 'emscripten-version.txt'), 'utf8').trim().replaceAll('"', ''),
  build = resolve(root, 'out/native/legacy-media'), output = resolve(root, '.generated/legacy-media'),
  sources = resolve(build, 'source'), prefix = resolve(build, 'prefix'),
  hash = (bytes) => createHash('sha256').update(bytes).digest('hex'), commands = []
if (source.schema !== 1 || source.toolchain !== '6.0.9' || toolchain !== source.toolchain)
  throw new Error('Legacy media source/toolchain mismatch')
for (const directory of [build, output, sources, prefix]) mkdirSync(directory, { recursive: true })
const env = { ...process.env, PATH: em + ':' + process.env.PATH,
  PKG_CONFIG_PATH: resolve(prefix, 'lib/pkgconfig'), EM_PKG_CONFIG_PATH: resolve(prefix, 'lib/pkgconfig') }
function run(command, args, cwd) {
  commands.push({ command, args, cwd })
  writeFileSync(resolve(build, 'commands.json'), JSON.stringify(commands, null, 2) + '\n')
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit', timeout: 20 * 60 * 1000 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Legacy media build failed: ${command} (${result.status})`)
}
for (const [name, entry] of Object.entries(source).filter(([name]) => name === 'ffmpeg' || name === 'openh264')) {
  const response = await fetch(entry.url, { signal: AbortSignal.timeout(120000) })
  if (!response.ok) throw new Error(`Legacy media ${name} download failed (${response.status})`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.length !== entry.bytes || hash(bytes) !== entry.sha256) throw new Error(`Legacy media ${name} source hash mismatch`)
  const archive = resolve(build, name + '.archive')
  writeFileSync(archive, bytes)
  // Only regular files/directories under the pinned root are extracted. No
  // downloaded program executes until this hosted build's explicit steps.
  run('python3', ['-c', `
import pathlib,sys,tarfile
archive,destination,expected=sys.argv[1:]
with tarfile.open(archive) as bundle:
 for item in bundle:
  path=pathlib.PurePosixPath(item.name)
  if not path.parts or path.parts[0]!=expected or '..' in path.parts or path.is_absolute() or not (item.isfile() or item.isdir()):
   raise RuntimeError('Unexpected source archive member: '+item.name)
 bundle.extractall(destination,filter='data')
`, archive, sources, entry.directory], root)
}
const h264 = resolve(sources, source.openh264.directory), ffmpeg = resolve(sources, source.ffmpeg.directory),
  makeH264 = ['-j2', 'OS=linux', 'ARCH=wasm', 'USE_ASM=No', 'USE_STACK_PROTECTOR=No', 'CC=emcc', 'CXX=em++', 'AR=emar',
    'CFLAGS_OPT=-O2', 'STATIC_LDFLAGS=-lc++ -lm', `PREFIX=${prefix}`]
const clockPatch = resolve(root, 'native/legacy-media/elementary-mpeg1-clock.patch')
run('patch', ['--batch', '--fuzz=0', '-p1', '-i', clockPatch], ffmpeg)
run('make', [...makeH264, 'install-static'], h264)
const link = ['-O2', '-sMODULARIZE=1', '-sEXPORT_ES6=1', '-sEXPORT_NAME=createLegacyMedia',
  '-sENVIRONMENT=worker,node', '-sFORCE_FILESYSTEM=1', '-lworkerfs.js',
  '-sEXPORTED_RUNTIME_METHODS=FS,WORKERFS,callMain', '-sINCOMING_MODULE_JS_API=print,printErr,noInitialRun,locateFile,wasmBinary',
  '-sALLOW_MEMORY_GROWTH=1', '-sMAXIMUM_MEMORY=536870912', '-sINITIAL_MEMORY=33554432',
  '-sSTACK_SIZE=1048576', '-sEXIT_RUNTIME=0', '-sABORTING_MALLOC=0', '-sASSERTIONS=0',
  '--post-js', resolve(root, 'native/legacy-media/post.js')],
  configure = ['--target-os=none', '--arch=x86_32', '--cpu=generic', '--enable-cross-compile',
    '--cc=emcc', '--cxx=em++', '--ld=em++', '--ar=emar', '--ranlib=emranlib', `--nm=${resolve(sdk, 'upstream/bin/llvm-nm')}`,
    '--disable-asm', '--disable-x86asm', '--disable-inline-asm', '--disable-stripping',
    '--disable-pthreads', '--disable-w32threads', '--disable-os2threads', '--disable-autodetect',
    '--disable-network', '--disable-doc', '--disable-debug', '--disable-everything', '--disable-programs',
    '--enable-ffmpeg', '--disable-avdevice', '--disable-postproc', '--disable-shared', '--enable-static',
    '--enable-avformat', '--enable-avcodec', '--enable-avfilter', '--enable-swscale', '--enable-swresample',
    '--enable-libopenh264', '--enable-protocol=file', '--enable-demuxer=mpegps,mpegvideo,avi,asf',
    '--enable-decoder=mpeg1video,mp2,cinepak,mjpeg,wmv1,wmv2,wmav1,wmav2,pcm_u8,pcm_s16le,pcm_s24le,pcm_s32le,pcm_f32le,pcm_f64le',
    '--enable-parser=mpegvideo,mpegaudio,mjpeg,h264,aac', '--enable-encoder=libopenh264,aac', '--enable-muxer=mp4',
    '--enable-filter=buffer,buffersink,abuffer,abuffersink,null,anull,format,aformat,scale,aresample',
    '--enable-bsf=aac_adtstoasc,extract_extradata', '--pkg-config=pkg-config',
    `--extra-cflags=-O2 -std=gnu11 -I${prefix}/include -Wno-error=incompatible-function-pointer-types`,
    `--extra-ldflags=-L${prefix}/lib`, '--extra-libs=-lc++ -lm']
run('sh', ['./configure', ...configure], ffmpeg)
// Configure's target-feature link checks do not need the exported CLI or its
// post-JS wrapper. Add those only to the actual executable link configuration.
appendFileSync(resolve(ffmpeg, 'ffbuild/config.mak'), '\nLDFLAGS += ' + link.join(' ') + '\n')
run('make', ['-j2', 'EXESUF=.mjs', 'ffmpeg_g.mjs'], ffmpeg)
const assets = {}
for (const kind of ['mjs', 'wasm']) {
  const bytes = readFileSync(resolve(ffmpeg, 'ffmpeg_g.' + kind)), sha256 = hash(bytes),
    file = `legacy-media-${sha256.slice(0, 16)}.${kind}`
  if (bytes.length <= 0 || bytes.length >= 16 * 1024 ** 2) throw new Error(`Legacy media ${kind} exceeds offline single-asset budget`)
  writeFileSync(resolve(output, file), bytes); assets[kind] = { file, bytes: bytes.length, sha256 }
}
const licenses = resolve(root, 'public/licenses/legacy-media')
mkdirSync(licenses, { recursive: true })
copyFileSync(clockPatch, resolve(licenses, 'elementary-mpeg1-clock.patch'))
copyFileSync(resolve(ffmpeg, 'COPYING.LGPLv2.1'), resolve(licenses, 'FFmpeg-LICENSE.txt'))
copyFileSync(resolve(h264, 'LICENSE'), resolve(licenses, 'OpenH264-LICENSE.txt'))
writeFileSync(resolve(licenses, 'CREDITS.txt'), `Legacy movie compatibility transcoding.\nFFmpeg ${source.ffmpeg.version}, LGPL-2.1-or-later; OpenH264 ${source.openh264.version}, BSD-2-Clause.\nNo GPL or nonfree components are enabled. This build modifies the FFmpeg CLI clock for raw MPEG-1 video. The source change is included in elementary-mpeg1-clock.patch.\nSource/relink recipe: native/legacy-media/source.json and scripts/build-legacy-media.mjs in this application's source repository.\n${source.ffmpeg.url}\nSHA-256 ${source.ffmpeg.sha256}\n${source.openh264.url}\nSHA-256 ${source.openh264.sha256}\nThe reproducible build accepts replacement source libraries by changing the manifest; the independent module's JavaScript ABI is public in src/backends/video/legacy/module.ts.\nH.264/AAC output is a lossy compatibility conversion, not a DirectShow pixel/audio identity claim.\n`)
const manifest = { abi: 1, library: 'FFmpeg', version: source.ffmpeg.version, openh264: source.openh264.version, toolchain,
  source: { manifestSha256: hash(sourceBytes), ffmpegSha256: source.ffmpeg.sha256, openh264Sha256: source.openh264.sha256,
    buildSha256: hash(readFileSync(fileURLToPath(import.meta.url))), elementaryClockSha256: hash(readFileSync(clockPatch)),
    postSha256: hash(readFileSync(resolve(root, 'native/legacy-media/post.js'))) }, assets }
writeFileSync(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(JSON.stringify(manifest, null, 2))
