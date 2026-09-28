import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { TjsWasmRuntime } from '../../src/backends/script/tjs-wasm/runtime.ts'
import type { ModuleFactory, WasmManifest } from '../../src/backends/script/tjs-wasm/module.ts'
import {
  isScriptObject,
  type ScriptClass,
  type ScriptValue,
} from '../../src/engine/script/runtime.ts'

const directory = resolve('.generated/wasm')
const manifest: WasmManifest = JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8'))
const assets = manifest.variants.asyncify!
const { default: factory } = (await import(
  pathToFileURL(resolve(directory, assets.mjs.file)).href
)) as { default: ModuleFactory }
const wasmBinary = new Uint8Array(readFileSync(resolve(directory, assets.wasm.file)))
const padClass: ScriptClass = {
  type: 'class',
  namespace: 'Pad',
  id: 0,
  className: 'Pad',
  properties: [],
}
const properties = [
  'text',
  'fileName',
  'color',
  'visible',
  'title',
  'fontColor',
  'fontHeight',
  'fontSize',
  'fontBold',
  'fontItalic',
  'fontUnderline',
  'fontStrikeOut',
  'fontFace',
  'readOnly',
  'wordWrap',
  'opacity',
  'showStatusBar',
  'showScrollBars',
  'statusText',
  'borderStyle',
  'width',
  'height',
  'top',
  'left',
]

async function program(vm: TjsWasmRuntime, binary: boolean, source: string) {
  return binary ? vm.compile(source, 'native-pad-factory.tjs') : source
}

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'

  test(
    `native Pad capability constructs real instances and supports super.Pad (${mode})`,
    { timeout: 60000 },
    async () => {
      const live = new Set<number>(),
        retired: number[] = []
      let constructions = 0
      const vm: TjsWasmRuntime = await TjsWasmRuntime.create(
        factory,
        (operation, args) => {
          if (operation === 'Factory') return { kind: 'value', value: padClass }
          if (operation === 'Pad.construct') {
            assert.equal(args.length, 1, 'Constructor arguments must not become host owners')
            assert(isScriptObject(args[0]))
            const id = ++constructions
            vm.registerNativeLifetime(args[0], 'Pad.nativeInvalidate', id)
            live.add(id)
            return { kind: 'value', value: BigInt(id) }
          }
          if (operation === 'Owners') {
            assert.equal(args.length, 2)
            assert(isScriptObject(args[0]) && isScriptObject(args[1]))
            assert.deepEqual(
              args.map((owner) => {
                assert(isScriptObject(owner))
                return vm.nativeLifetimeIdentifier(owner, 'Pad.nativeInvalidate')
              }),
              [1, 2],
            )
            assert.deepEqual([...live], [1, 2], 'Calling finalize directly must not retire a Pad')
            return { kind: 'value', value: undefined }
          }
          assert.equal(operation, 'Pad.nativeInvalidate')
          const id = Number(args[0])
          assert(live.delete(id), 'Each Pad must retire exactly once')
          retired.push(id)
          return { kind: 'value', value: undefined }
        },
        { wasmBinary },
      )
      try {
        assert.equal(manifest.capabilities?.nativePad, 1)
        await vm.execute(
          await program(
            vm,
            binary,
            `
var Pad=__host("Factory"),p=new Pad("ignored",void,<% 01 %>);
class ChildPad extends Pad {function ChildPad(){super.Pad("ignored");}}
var child=new ChildPad();
var identity=[Pad instanceof "Class",p instanceof "Pad",child instanceof "Pad",
  child instanceof "ChildPad",p.Pad instanceof "Function",p.finalize instanceof "Function"].join("|");
var nativeProperties=[${properties.map((name) => `(&p.${name}) instanceof "Property"`).join(',')}].join("|");
var repeated=0;
try{child.Pad();}catch(error){repeated++;}
p.finalize();child.finalize();__host("Owners",p,child);
invalidate p;invalidate child;
`,
          ),
        )
        assert.equal(await vm.execute('identity', '', true), '1|1|1|1|1|1')
        assert.equal(
          await vm.execute('nativeProperties', '', true),
          properties.map(() => '1').join('|'),
        )
        assert.equal(await vm.execute('repeated', '', true), 1n)
        assert.equal(constructions, 2)
        assert.deepEqual(retired, [1, 2])
        assert.equal(live.size, 0)
        await vm.collect()
        assert.equal(vm.inspect().handles, 0)
      } finally {
        vm.dispose()
      }
    },
  )

  test(
    `native Pad rejects malformed host factory identities and property replacement metadata (${mode})`,
    { timeout: 60000 },
    async () => {
      let reply: ScriptValue = padClass
      const vm = await TjsWasmRuntime.create(
        factory,
        (operation) => {
          assert.equal(operation, 'Factory')
          return { kind: 'value', value: reply }
        },
        { wasmBinary },
      )
      const cases: { value: ScriptValue; error: RegExp }[] = [
        {
          value: { ...padClass, namespace: 'Pad\0suffix' },
          error: /Invalid native class identity/,
        },
        {
          value: { ...padClass, className: 'Pad\0suffix' },
          error: /Invalid native class identity/,
        },
        { value: { ...padClass, namespace: '' }, error: /Invalid native class identity/ },
        { value: { ...padClass, className: '' }, error: /Invalid native class identity/ },
        {
          value: { type: 'proxy', namespace: 'Pad\0suffix', id: 1, className: 'Pad' },
          error: /Invalid native class identity/,
        },
        { value: { ...padClass, id: 1 }, error: /Invalid Pad class factory/ },
        { value: { ...padClass, className: 'Other' }, error: /Invalid Pad class factory/ },
        {
          value: {
            ...padClass,
            properties: [{ name: 'text', writable: true, static: false, boolean: false }],
          },
          error: /Invalid Pad class factory/,
        },
        { value: { ...padClass, systemMethods: [] }, error: /Invalid Pad class factory/ },
        { value: { ...padClass, systemProperties: [] }, error: /Invalid Pad class factory/ },
      ]
      try {
        const factoryCall = await program(vm, binary, '__host("Factory");')
        for (const entry of cases) {
          reply = entry.value
          await assert.rejects(vm.execute(factoryCall), entry.error)
        }
        reply = padClass
        await vm.execute(
          await program(
            vm,
            binary,
            'var recovered=__host("Factory");var recoveredIdentity=recovered instanceof "Class";',
          ),
        )
        assert.equal(await vm.execute('recoveredIdentity', '', true), 1n)
        await vm.collect()
        assert.equal(vm.inspect().handles, 0)
      } finally {
        vm.dispose()
      }
    },
  )

  for (const version of [undefined, 0, 2])
    test(
      `native Pad rejects a ${version === undefined ? 'missing' : `version ${version}`} factory export and recovers (${mode})`,
      { timeout: 60000 },
      async () => {
        // Mutate only the real current module's capability export. This checks
        // the runtime guard; it is not an execution claim about a historical kernel.
        let restore!: () => void
        const altered: ModuleFactory = async (options) => {
          const module = await factory(options),
            original = module._krkr_native_pad_version!
          assert.equal(original(), 1)
          if (version === undefined)
            assert(Reflect.deleteProperty(module, '_krkr_native_pad_version'))
          else module._krkr_native_pad_version = () => version
          restore = () => {
            module._krkr_native_pad_version = original
          }
          return module
        }
        const vm = await TjsWasmRuntime.create(
          altered,
          (operation) => {
            assert.equal(operation, 'Factory')
            return { kind: 'value', value: padClass }
          },
          { wasmBinary },
        )
        try {
          const factoryCall = await program(vm, binary, 'var Pad=__host("Factory");')
          await assert.rejects(vm.execute(factoryCall), /TJS WASM is missing native Pad support/)
          restore()
          await vm.execute(factoryCall)
          assert.equal(await vm.execute('Pad instanceof "Class"', '', true), 1n)
          await vm.collect()
          assert.equal(vm.inspect().handles, 0)
        } finally {
          vm.dispose()
        }
      },
    )
}
