import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import type { SessionDependencies } from '../../src/engine/session.ts'
import { MemorySaveStore } from '../../src/engine/ports/saves.ts'
import { readText } from '../../src/backends/files/text-codecs.ts'
import { StorageResolver } from '../../src/engine/storage/resolver.ts'
import { SaveOverlay } from '../../src/engine/storage/save-overlay.ts'
import {
  chopStorageExt,
  extractStorageExt,
  extractStorageName,
  extractStoragePath,
  getFullStoragePath,
  parseStoragePath,
  storageDirectoryPath,
  storageFilePath,
  storageWritePath,
  toPublicStoragePath,
} from '../../src/engine/storage/public-path.ts'

// These are literal source-contract examples, not expectations computed with
// the implementation being tested. Archive-qualified headless resources below
// exercise VFS lookup; browser coverage separately imports actual archive bytes.
const lexicalCases = [
  ['Folder/Name.TXT', '.TXT', 'Name.TXT', 'Folder/', 'Folder/Name'],
  ['Folder\\Name.TXT', '.TXT', 'Name.TXT', 'Folder\\', 'Folder\\Name'],
  ['data.XP3>Dir/file.tar.gz', '.gz', 'file.tar.gz', 'data.XP3>Dir/', 'data.XP3>Dir/file.tar'],
  ['data.xp3>', '', '', 'data.xp3>', 'data.xp3>'],
  ['folder/', '', '', 'folder/', 'folder/'],
  ['.hidden', '.hidden', '.hidden', '', ''],
  ['name.', '.', 'name.', '', 'name'],
  ['..', '.', '..', '', '.'],
  ['v1.2/name', '', 'name', 'v1.2/', 'v1.2/name'],
  ['A:Name.TXT', '.TXT', 'A:Name.TXT', '', 'A:Name'],
  ['', '', '', '', ''],
  ['foo.txt?x.y', '.y', 'foo.txt?x.y', '', 'foo.txt?x'],
  ['file.TXT#part', '.TXT#part', 'file.TXT#part', '', 'file'],
  ['path/%2e%2e/%2f', '', '%2f', 'path/%2e%2e/', 'path/%2e%2e/%2f'],
  ['雪 🌸/行\n名.日本語', '.日本語', '行\n名.日本語', '雪 🌸/', '雪 🌸/行\n名'],
  [
    'unsupported://Host/A\\B>Leaf.Ext',
    '.Ext',
    'Leaf.Ext',
    'unsupported://Host/A\\B>',
    'unsupported://Host/A\\B>Leaf',
  ],
] as const

const canonicalCases = [
  ['', ''],
  ['.', 'game://./'],
  ['./', 'game://./'],
  ['game://./', 'game://./'],
  ['game:///scene.tjs', 'game://./scene.tjs'],
  ['/scene.tjs', 'game://./scene.tjs'],
  ['\\scene.tjs', 'game://./scene.tjs'],
  ['///scene.tjs', 'game://./scene.tjs'],
  ['//./scene.tjs', 'game://./scene.tjs'],
  ['GAME://./Folder/Name.TXT', 'game://./Folder/Name.TXT'],
  ['a/../b', 'game://./b'],
  ['a\\b\\..\\雪.TXT', 'game://./a/雪.TXT'],
  ['a//./b/', 'game://./a/b/'],
  ['a/..', 'game://./'],
  ['data.XP3>', 'game://./data.XP3>'],
  ['data.XP3>Dir/../scene.TJS', 'game://./data.XP3>scene.TJS'],
  ['data.XP3>Dir/../', 'game://./data.XP3>'],
  ['data.XP3>Dir/', 'game://./data.XP3>Dir/'],
  ['.../scene.tjs', 'game://./.../scene.tjs'],
  ['%2e%2e/%2f/File#part.tjs?x.y', 'game://./%2e%2e/%2f/File#part.tjs?x.y'],
  ['$(exepath)/file.tjs', 'game://./$(exepath)/file.tjs'],
] as const

const invalidAddresses = [
  '../outside.tjs',
  'a/../../outside.tjs',
  'pack.xp3>../outside.tjs',
  'pack.xp3>dir/../../outside.tjs',
  'outer.xp3>inner.xp3>scene.tjs',
  '\\\\server\\share\\scene.tjs',
  'C:\\outside.tjs',
  './C:\\outside.tjs',
  'inside/../https://host/scene.tjs',
  'inside/../web+file://host/scene.tjs',
  'file://./outside.tjs',
  'https://host/scene.tjs',
  'game://other/scene.tjs',
  'game://./../outside.tjs',
  'game://./inside/../file:outside.tjs',
] as const

const demand = `
function demand(actual,expected,label){
  if(actual!==expected)throw label+": expected ["+expected+"] but received ["+actual+"]";
}
`

async function fixture(
  binary: boolean,
  source: string,
  resources: Record<string, string | Uint8Array> = {},
  overrides: Partial<SessionDependencies> = {},
) {
  const harness = await headless(
    {
      ...resources,
      'startup.tjs': binary
        ? 'Scripts.compileStorage("storage-public-paths.tjs","savedata/storage-public-paths.cjs",false,true,false);Scripts.execStorage("savedata/storage-public-paths.cjs");'
        : 'Scripts.execStorage("storage-public-paths.tjs");',
      'storage-public-paths.tjs': demand + source,
    },
    overrides,
  )
  try {
    await harness.session.start()
  } catch (error) {
    await harness.session.stop()
    throw error
  }
  return harness
}

test('public path lexical helpers preserve spelling, delimiters and literal suffixes', () => {
  for (const [input, extension, name, directory, chopped] of lexicalCases) {
    assert.equal(extractStorageExt(input), extension, input)
    assert.equal(extractStorageName(input), name, input)
    assert.equal(extractStoragePath(input), directory, input)
    assert.equal(chopStorageExt(input), chopped, input)
    assert.equal(extractStoragePath(input) + extractStorageName(input), input)
  }
  // Native TJS strings have their own NUL conversion semantics; exercise the
  // pure lexical operation directly without claiming a VM can retain this text.
  assert.equal(extractStorageExt('folder/one\0two.Ext'), '.Ext')
  assert.equal(extractStorageName('folder/one\0two.Ext'), 'one\0two.Ext')
  assert.equal(chopStorageExt('folder/one\0two.Ext'), 'folder/one\0two')
})

test('public canonical names are idempotent and preserve directory and archive boundaries', () => {
  for (const [input, expected] of canonicalCases) {
    assert.equal(getFullStoragePath(input), expected, input)
    assert.equal(getFullStoragePath(expected), expected, `canonical ${input}`)
    if (expected) assert.equal(toPublicStoragePath(parseStoragePath(expected)), expected)
  }
  assert.equal(storageFilePath('GAME://./Folder/../Save.TXT'), 'Save.TXT')
  assert.equal(storageWritePath('game://./savedata/slot.bin'), 'savedata/slot.bin')
  assert.equal(storageDirectoryPath('game://./'), '')
  assert.equal(storageDirectoryPath('game://./Folder/'), 'Folder/')
  assert.equal(storageDirectoryPath('game://./pack.xp3>'), 'pack.xp3>')
  assert.equal(storageDirectoryPath('game://./pack.xp3>scene/'), 'pack.xp3>scene/')
  for (const path of ['game://./', 'game://./folder/', 'game://./pack.xp3>'])
    assert.throws(() => storageFilePath(path), path)
  for (const path of ['folder', 'game://./folder', 'game://./pack.xp3>scene.tjs'])
    assert.throws(() => storageDirectoryPath(path), path)
  assert.throws(() => storageWritePath('game://./pack.xp3>scene.tjs'), /read.only/i)
})

test('public names reject unsupported media and escapes before and after dot normalization', () => {
  for (const input of [...invalidAddresses, 'folder/one\0two.tjs', 'game://./one\0two']) {
    assert.throws(() => getFullStoragePath(input), input)
    assert.throws(() => storageFilePath(input), input)
    assert.throws(() => storageWritePath(input), input)
  }
  assert.equal(getFullStoragePath('%2e%2e/%2f/x'), 'game://./%2e%2e/%2f/x')
  assert.equal(storageFilePath('game://./%2e%2e/%2f/x'), '%2e%2e/%2f/x')
  assert.equal(getFullStoragePath('valid/../recovered.tjs'), 'game://./recovered.tjs')
})

test('mount and backup imports remain atomic relative-name boundaries while public writes use relative keys', async () => {
  const resource = (name: string, value: number) => ({
    name,
    size: 1,
    read: async () => new Uint8Array([value]),
  })
  const resolver = new StorageResolver()
  resolver.mount([resource('good.tjs', 7)])
  assert.throws(
    () =>
      resolver.mount([
        resource('new.tjs', 8),
        resource('good.tjs', 9),
        resource('game://./uri.tjs', 10),
      ]),
    /Invalid resource path/,
  )
  assert.deepEqual(resolver.list(), [{ name: 'good.tjs', size: 1 }])
  assert.deepEqual(await resolver.resolve('game://./good.tjs').read(), new Uint8Array([7]))
  assert.equal(resolver.exists('new.tjs'), false)
  assert.equal(resolver.exists('game://./uri.tjs'), false)
  resolver.mount([resource('recovered.tjs', 11)])
  assert.deepEqual(await resolver.resolve('game://./recovered.tjs').read(), new Uint8Array([11]))

  const store = new MemorySaveStore()
  const overlay = new SaveOverlay(store)
  await overlay.initialize()
  try {
    overlay.write('savedata/good.bin', new Uint8Array([21]))
    await overlay.flush()
    await assert.rejects(
      overlay.import([
        { path: 'savedata/new.bin', bytes: new Uint8Array([22]) },
        { path: 'savedata/good.bin', bytes: new Uint8Array([23]) },
        { path: 'game://./savedata/uri.bin', bytes: new Uint8Array([24]) },
      ]),
      /Invalid resource path/,
    )
    assert.deepEqual(overlay.export(), [{ path: 'savedata/good.bin', bytes: new Uint8Array([21]) }])
    assert.deepEqual(overlay.get('savedata/good.bin'), new Uint8Array([21]))
    assert.deepEqual(overlay.get('game://./savedata/good.bin'), new Uint8Array([21]))
    assert.equal(overlay.get('savedata/new.bin'), undefined)
    assert.equal(overlay.get('savedata/uri.bin'), undefined)
    assert.equal(overlay.pending, 0)
    assert.deepEqual(await store.load(), [
      { path: 'savedata/good.bin', bytes: new Uint8Array([21]) },
    ])
    overlay.write('game://./savedata/recovered.bin', new Uint8Array([25]))
    await overlay.flush()
    assert.deepEqual(overlay.get('savedata/recovered.bin'), new Uint8Array([25]))
    assert.deepEqual(
      overlay.export().map((file) => file.path),
      ['savedata/good.bin', 'savedata/recovered.bin'],
    )
    assert.deepEqual(
      (await store.load()).map((file) => file.path),
      ['savedata/good.bin', 'savedata/recovered.bin'],
    )
  } finally {
    overlay.close()
  }
})

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'

  test(`Storages lexical methods use the raw string without URI parsing (${mode})`, async () => {
    const source = lexicalCases
      .map(
        ([input, extension, name, directory, chopped], index) => `
var path${index}=${JSON.stringify(input)};
demand(Storages.extractStorageExt(path${index}),${JSON.stringify(extension)},"extension ${index}");
demand(Storages.extractStorageName(path${index}),${JSON.stringify(name)},"name ${index}");
demand(Storages.extractStoragePath(path${index}),${JSON.stringify(directory)},"directory ${index}");
demand(Storages.chopStorageExt(path${index}),${JSON.stringify(chopped)},"chop ${index}");
demand(Storages.extractStoragePath(path${index})+Storages.extractStorageName(path${index}),path${index},"join ${index}");
`,
      )
      .join('\n')
    const { session } = await fixture(binary, source + 'var lexicalComplete=true;')
    try {
      assert.equal(await session.evaluate('lexicalComplete'), '1')
    } finally {
      await session.stop()
    }
    assert.equal(session.snapshot().handles, 0)
  })

  test(`Storages full names are pure and remain stable before and after a file is created (${mode})`, async () => {
    const source =
      canonicalCases
        .map(
          ([input, expected], index) => `
var full${index}=Storages.getFullPath(${JSON.stringify(input)});
demand(full${index},${JSON.stringify(expected)},"full ${index}");
demand(Storages.getFullPath(full${index}),full${index},"idempotence ${index}");
`,
        )
        .join('\n') +
      `
var future=Storages.getFullPath("missing/future.tjs");
demand(future,"game://./missing/future.tjs","future address");
var directories=["game://./","game://./folder/","game://./data.XP3>"],directoryErrors=0;
for(var i=0;i<directories.count;i++){
  demand(Storages.getPlacedPath(directories[i]),"","directory is not a placed file");
  demand(Storages.isExistentStorage(directories[i]),false,"directory is not an existent file");
  try{Scripts.evalStorage(directories[i]);}catch(error){directoryErrors++;}
  try{["not a directory"].save(directories[i]);}catch(error){directoryErrors++;}
}
demand(directoryErrors,6,"directory reads and writes rejected");
demand(Storages.getPlacedPath(future),"","not placed before writing");
demand(Storages.isExistentStorage(future),false,"not existent before writing");
["40+2"].save(future);
demand(Storages.getFullPath("missing/future.tjs"),future,"same full address after writing");
demand(Storages.getPlacedPath(future),future,"placed after writing");
demand(Storages.isExistentStorage(future),true,"exists after writing");
demand(Scripts.evalStorage(future),42,"canonical script read");
demand(Scripts.evalStorage("missing/future.tjs"),42,"relative script read");
var fullComplete=true;
`
    const { session } = await fixture(binary, source)
    try {
      assert.equal(await session.evaluate('fullComplete'), '1')
      const saved = session.exportSaves().find((file) => file.path === 'missing/future.tjs')
      assert.ok(saved)
      assert.equal(await readText(saved.bytes), '40+2\r\n')
      assert.ok(session.exportSaves().every((file) => !file.path.startsWith('game:')))
    } finally {
      await session.stop()
    }
  })

  test(`Storages placement uses direct hits then the newest autopath without reordering duplicates (${mode})`, async () => {
    const { session } = await fixture(
      binary,
      `
Storages.addAutoPath("first/");Storages.addAutoPath("game://./second/");
demand(Storages.getPlacedPath("shared.tjs"),"game://./shared.tjs","direct first");
demand(Scripts.evalStorage(Storages.getPlacedPath("shared.tjs")),"direct","direct content");
demand(Storages.getPlacedPath("pick.tjs"),"game://./second/pick.tjs","last directory wins");
Storages.addAutoPath("game://./first/./");
demand(Storages.getPlacedPath("pick.tjs"),"game://./second/pick.tjs","duplicate does not reorder");
demand(Storages.getPlacedPath("absent/path/pick.tjs"),"game://./second/pick.tjs","basename fallback");
demand(Storages.getPlacedPath("first/pick.tjs"),"game://./first/pick.tjs","explicit existing path");
demand(Storages.getPlacedPath("nested.tjs"),"","directory search is not recursive");
Storages.addAutoPath("does-not-exist/");Storages.removeAutoPath("never-added/");
demand(Storages.getPlacedPath("pick.tjs"),"game://./second/pick.tjs","missing directory is harmless");
Storages.removeAutoPath("second/./");
demand(Storages.getPlacedPath("pick.tjs"),"game://./first/pick.tjs","remove canonical equivalent");
demand(Scripts.evalStorage(Storages.getPlacedPath("pick.tjs")),"first","placed path is readable");
Storages.removeAutoPath("game://./first/");
demand(Storages.isExistentStorage("pick.tjs"),false,"removed last directory");
var orderingComplete=true;
`,
      {
        'shared.tjs': '"direct"',
        'first/shared.tjs': '"first shared"',
        'second/shared.tjs': '"second shared"',
        'first/pick.tjs': '"first"',
        'second/pick.tjs': '"second"',
        'first/child/nested.tjs': '"nested"',
      },
    )
    try {
      assert.equal(await session.evaluate('orderingComplete'), '1')
    } finally {
      await session.stop()
    }
  })

  test(`Storages autopaths support the virtual root and separate archive roots and directories (${mode})`, async () => {
    const { session } = await fixture(
      binary,
      `
Storages.addAutoPath("game://./");
demand(Storages.getPlacedPath("absent/root-only.tjs"),"game://./root-only.tjs","root basename search");
demand(Scripts.evalStorage(Storages.getPlacedPath("absent/root-only.tjs")),"root","root read");
Storages.addAutoPath("pack.xp3>");
demand(Storages.getPlacedPath("pick.tjs"),"game://./pack.xp3>pick.tjs","archive root");
Storages.addAutoPath("game://./pack.xp3>scene/");
demand(Storages.getPlacedPath("pick.tjs"),"game://./pack.xp3>scene/pick.tjs","archive directory");
demand(Scripts.evalStorage(Storages.getPlacedPath("pick.tjs")),"archive directory","archive readback");
demand(Storages.getPlacedPath("pack.xp3>pick.tjs"),"game://./pack.xp3>pick.tjs","explicit archive member");
Storages.removeAutoPath("pack.xp3>scene/./");
demand(Scripts.evalStorage(Storages.getPlacedPath("pick.tjs")),"archive root","archive root restored");
Storages.removeAutoPath("game://./pack.xp3>");
demand(Storages.getPlacedPath("pick.tjs"),"","archive removed");
Storages.removeAutoPath("./");
demand(Storages.getPlacedPath("absent/root-only.tjs"),"","root removed");
var archiveSearchComplete=true;
`,
      {
        'root-only.tjs': '"root"',
        'pack.xp3>pick.tjs': '"archive root"',
        'pack.xp3>scene/pick.tjs': '"archive directory"',
      },
    )
    try {
      assert.equal(await session.evaluate('archiveSearchComplete'), '1')
    } finally {
      await session.stop()
    }
  })

  test(`Storages autopath registration validates trailing delimiters without damaging existing search (${mode})`, async () => {
    const { session } = await fixture(
      binary,
      `
Storages.addAutoPath("valid/");
var invalidPaths=["valid","game://./valid","pack.xp3>scene.tjs","../bad/","https://host/bad/"];
var rejected=0;
for(var i=0;i<invalidPaths.count;i++){
  try{Storages.addAutoPath(invalidPaths[i]);}catch(error){rejected++;}
  try{Storages.removeAutoPath(invalidPaths[i]);}catch(error){rejected++;}
  demand(Storages.getPlacedPath("usable.tjs"),"game://./valid/usable.tjs","search after invalid change");
}
demand(rejected,10,"all invalid additions and removals rejected");
Storages.addAutoPath("Windows\\\\");
demand(Scripts.evalStorage(Storages.getPlacedPath("backslash.tjs")),"backslash","backslash directory");
Storages.removeAutoPath("game://./Windows/");
demand(Storages.getPlacedPath("backslash.tjs"),"","backslash normalization removable");
var invalidAutopathComplete=true;
`,
      { 'valid/usable.tjs': '42', 'Windows/backslash.tjs': '"backslash"' },
    )
    try {
      assert.equal(await session.evaluate('invalidAutopathComplete'), '1')
    } finally {
      await session.stop()
    }
  })

  test(`Storages preserves exact case identities and reports ambiguous folded lookup (${mode})`, async () => {
    // Preserve two exact identities that were already present in persistence.
    // A second differently cased WRITE to a unique target now binds that target
    // instead of creating a new case-only save under the 073 stream contract.
    const saveStore = new MemorySaveStore()
    await saveStore.commit([
      { path: 'Slot.txt', bytes: Buffer.from('upper initial') },
      { path: 'slot.txt', bytes: Buffer.from('lower initial') },
    ])
    const { session } = await fixture(
      binary,
      `
var upper=Storages.getFullPath("Scene.tjs"),lower=Storages.getFullPath("scene.tjs");
demand(upper,"game://./Scene.tjs","upper full");demand(lower,"game://./scene.tjs","lower full");
demand(Scripts.evalStorage(upper),"upper","upper read");
demand(Scripts.evalStorage(lower),"lower","lower read");
demand(Storages.getPlacedPath(upper),upper,"upper placed");
demand(Storages.getPlacedPath(lower),lower,"lower placed");
var ambiguous=0;
try{var place=Storages.getPlacedPath("game://./SCENE.TJS");}catch(error){ambiguous++;}
try{var exists=Storages.isExistentStorage("SCENE.TJS");}catch(error){ambiguous++;}
try{Scripts.evalStorage("game://./SCENE.TJS");}catch(error){ambiguous++;}
demand(ambiguous,3,"ambiguous reads throw");
demand(Storages.getFullPath("SCENE.TJS"),"game://./SCENE.TJS","full name does not search");
demand(Storages.getPlacedPath("UNIQUE.TJS"),"game://./Unique.tjs","unique folded lookup preserves actual spelling");
demand(Scripts.evalStorage(Storages.getPlacedPath("UNIQUE.TJS")),"unique","unique content");
["upper save"].save("game://./Slot.txt");["lower save"].save("game://./slot.txt");
demand([].load("game://./Slot.txt")[0],"upper save","upper save remains distinct");
demand([].load("game://./slot.txt")[0],"lower save","lower save remains distinct");
demand(Storages.getPlacedPath("Slot.txt"),"game://./Slot.txt","upper save placement");
demand(Storages.getPlacedPath("slot.txt"),"game://./slot.txt","lower save placement");
var ambiguousSaves=0;
try{var place=Storages.getPlacedPath("game://./SLOT.TXT");}catch(error){ambiguousSaves++;}
try{var exists=Storages.isExistentStorage("SLOT.TXT");}catch(error){ambiguousSaves++;}
try{[].load("game://./SLOT.TXT");}catch(error){ambiguousSaves++;}
demand(ambiguousSaves,3,"ambiguous save lookup throws");
demand([].load("game://./Slot.txt")[0],"upper save","exact save read survives ambiguity");
var caseComplete=true;
`,
      { 'Scene.tjs': '"upper"', 'scene.tjs': '"lower"', 'Unique.tjs': '"unique"' },
      { saveStore },
    )
    try {
      assert.equal(await session.evaluate('caseComplete'), '1')
    } finally {
      await session.stop()
    }
  })

  test(`Storages literal percent and fragment characters round trip without URL decoding (${mode})`, async () => {
    const { session } = await fixture(
      binary,
      `
var name="%2e%2e/%2f/File#part.tjs?x.y",full=Storages.getFullPath(name);
demand(full,"game://./%2e%2e/%2f/File#part.tjs?x.y","literal address");
demand(Storages.getPlacedPath(full),full,"literal placement");
demand(Scripts.evalStorage(full),"literal content","literal read");
demand(Storages.extractStorageExt(full),".y","query has no special lexical meaning");
var literalComplete=true;
`,
      { '%2e%2e/%2f/File#part.tjs?x.y': '"literal content"' },
    )
    try {
      assert.equal(await session.evaluate('literalComplete'), '1')
    } finally {
      await session.stop()
    }
  })

  test(`Storages invalid reads and writes recover without losing valid mounts, saves or autopaths (${mode})`, async () => {
    const { session } = await fixture(
      binary,
      `
Storages.addAutoPath("valid/");["unchanged"].save("game://./savedata/healthy.txt");
var bad=${JSON.stringify(invalidAddresses)},rejected=0;
for(var i=0;i<bad.count;i++){
  try{var full=Storages.getFullPath(bad[i]);}catch(error){rejected++;}
  try{var placed=Storages.getPlacedPath(bad[i]);}catch(error){rejected++;}
  try{var exists=Storages.isExistentStorage(bad[i]);}catch(error){rejected++;}
  try{Scripts.evalStorage(bad[i]);}catch(error){rejected++;}
  try{["must not write"].save(bad[i]);}catch(error){rejected++;}
  demand(Scripts.evalStorage(Storages.getPlacedPath("usable.tjs")),42,"mount after error");
  demand([].load("game://./savedata/healthy.txt")[0],"unchanged","save after error");
}
demand(rejected,${invalidAddresses.length * 5},"invalid address failures");
["recovered"].save("game://./savedata/after.txt");
var invalidComplete=[].load("savedata/after.txt")[0];
`,
      { 'valid/usable.tjs': '42' },
    )
    try {
      assert.equal(await session.evaluate('invalidComplete'), 'recovered')
      assert.equal(session.snapshot().pendingSaves, 0)
      assert.ok(session.exportSaves().every((file) => !file.path.startsWith('game:')))
      assert.equal(
        session.exportSaves().some((file) => file.path.includes('outside')),
        false,
      )
    } finally {
      await session.stop()
    }
    assert.equal(session.snapshot().handles, 0)
  })

  test(`canonical script and text/binary streams persist relative keys into a fresh VM (${mode})`, async () => {
    const store = new MemorySaveStore()
    const first = await fixture(
      binary,
      `
var code=Storages.getFullPath("savedata/expression.cjs");
Scripts.compileStorage("game://./scripts/expression.tjs",code,true,true,true);
demand(Scripts.evalStorage(code),42,"compiled canonical script");
Scripts.execStorage("game://./scripts/side-effect.tjs");
demand(global.sideEffect,"executed","canonical execStorage");
["text","雪 🌸"].save("game://./savedata/text.txt");
var state=%[integer:9007199254740993,text:"保存 🌸",bytes:<% 00 7f ff %>];
(Dictionary.saveStruct incontextof state)("game://./savedata/state.bin","b");
var array=["array",42,<% 00 ff %>];array.saveStruct("game://./savedata/array.bin","b");
demand(Dictionary.loadStruct("game://./savedata/state.bin").text,"保存 🌸","same-session binary read");
demand([].load("savedata/text.txt")[1],"雪 🌸","relative text alias");
`,
      {
        'scripts/expression.tjs': '6*7',
        'scripts/side-effect.tjs': 'global.sideEffect="executed";',
      },
      { saveStore: store },
    )
    try {
      for (const path of [
        'savedata/expression.cjs',
        'savedata/text.txt',
        'savedata/state.bin',
        'savedata/array.bin',
      ])
        assert.ok(
          first.session.exportSaves().some((file) => file.path === path),
          path,
        )
      assert.ok(first.session.exportSaves().every((file) => !file.path.includes('://')))
      assert.equal(first.session.snapshot().pendingSaves, 0)
    } finally {
      await first.session.stop()
    }
    assert.equal(first.session.snapshot().handles, 0)
    const second = await fixture(
      binary,
      `
demand(Scripts.evalStorage("game://./savedata/expression.cjs"),42,"persisted code");
var text=[].load("game://./savedata/text.txt");
var state=Dictionary.loadStruct("game://./savedata/state.bin");
var array=[].loadStruct("game://./savedata/array.bin");
demand(text[1],"雪 🌸","persisted text");
demand(state.integer,9007199254740993,"persisted integer");
demand(state.text,"保存 🌸","persisted Unicode");
demand(state.bytes[2],255,"persisted octet");
demand(array[0],"array","persisted array");demand(array[2][1],255,"persisted array octet");
demand(Storages.getPlacedPath("savedata/text.txt"),"game://./savedata/text.txt","persisted placement");
var persistentComplete=true;
`,
      {},
      { saveStore: store },
    )
    try {
      assert.equal(await second.session.evaluate('persistentComplete'), '1')
    } finally {
      await second.session.stop()
    }
    assert.equal(second.session.snapshot().handles, 0)
  })

  test(`canonical archive members stay read-only when their flat aliases are overwritten (${mode})`, async () => {
    const { session } = await fixture(
      binary,
      `
var archive="game://./pack.xp3>scenario/member.tjs",flat="game://./scenario/member.tjs";
demand(Scripts.evalStorage(archive),"original","archive before overlay");
["\\\"overlay\\\""].save(flat);
demand(Scripts.evalStorage(flat),"overlay","flat overlay");
demand(Scripts.evalStorage(archive),"original","archive remains original");
var failures=0;
try{["overwrite"].save(archive);}catch(error){failures++;}
var state=%[value:"overwrite"];
try{(Dictionary.saveStruct incontextof state)(archive,"b");}catch(error){failures++;}
try{Scripts.compileStorage("scenario/member.tjs",archive,false,true,false);}catch(error){failures++;}
demand(failures,3,"archive writes rejected");
demand(Scripts.evalStorage(archive),"original","archive after rejected writes");
demand(Scripts.evalStorage(flat),"overlay","flat overlay after rejected writes");
demand(Storages.getPlacedPath(archive),archive,"archive placement unchanged");
var archiveWriteComplete=true;
`,
      { 'pack.xp3>scenario/member.tjs': '"original"', 'scenario/member.tjs': '"original"' },
    )
    try {
      assert.equal(await session.evaluate('archiveWriteComplete'), '1')
      assert.equal(
        session.exportSaves().some((file) => file.path.includes('>')),
        false,
      )
      assert.ok(session.exportSaves().some((file) => file.path === 'scenario/member.tjs'))
    } finally {
      await session.stop()
    }
  })
}
