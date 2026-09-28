import { encodeBmp } from '../../src/formats/image/bmp.ts'
import { imageFixture } from './image-fixtures.ts'

interface KeyRow {
  label: string
  file: string
  /** TJS source, so integer literals never pass through a JavaScript Number. */
  key?: string
  pixels: readonly [number, number, number, number, number, number]
  display: readonly [readonly number[], readonly number[]]
}
export interface ImageKeyScenario {
  name: string
  rows: KeyRow[]
}

const black = [0, 0, 0, 255],
  red = [255, 0, 0, 255],
  original = [0xc86432, 64, 0xc96533, 128, 0, 0] as const,
  originalDisplay = [
    [50, 25, 13, 255],
    [101, 51, 26, 255],
  ] as const,
  companion = [0xc86432, 0, 0xc96533, 128, 0, 1] as const,
  companionDisplay = [black, originalDisplay[1]] as const,
  keyed = [0xc86432, 0, 0xc96533, 255, 0, 0] as const,
  keyedDisplay = [black, [201, 101, 51, 255]] as const,
  palette = [0xff0000, 255, 0xff0000, 0, 0, 0] as const,
  paletteDisplay = [red, black] as const,
  matted = [0xffffff, 255, 0xe4b299, 255, 0, 1] as const,
  mattedDisplay = [
    [255, 255, 255, 255],
    [228, 178, 153, 255],
  ] as const

export const imageKeyScenarios: ImageKeyScenario[] = [
  {
    name: 'unknown high bytes preserve decoded alpha and still load companions',
    rows: [
      ...[
        '0x80000005',
        '0x80c86432',
        '0x01000000',
        '0x01fffffe',
        '0x02000005',
        '0x05000005',
        '0x7fc86432',
        '0xffc86432',
        '-1',
      ].map((key) => ({
        label: key,
        file: 'plain.png',
        key,
        pixels: original,
        display: originalDisplay,
      })),
      {
        label: 'unknown-palette',
        file: 'palette.png',
        key: '0x80000005',
        pixels: [0xff0000, 0, 0xff0000, 255, 0, 0],
        display: [black, red],
      },
      ...['0x80000005', '0x80c86432'].map((key) => ({
        label: 'companions-' + key,
        file: 'hero.png',
        key,
        pixels: companion,
        display: companionDisplay,
      })),
    ],
  },
  {
    name: 'TJS integer keys retain their low 32 bits before Number conversion',
    rows: [
      ...(
        [
          ['wide-even', '0x20000000c86432', false],
          ['wide-odd', '0x20000000c86433', true],
          ['wide-negative-even', '0x20000000c86432-0x60000000000000', false],
          ['wide-negative-odd', '0x20000000c86433-0x60000000000000', true],
          ['near-int64-max', '0x7fffffff00c86433', true],
          ['wrap-positive', '0x100c86432', false],
          ['wrap-negative', '0xc86433-0x100000000', true],
        ] as const
      ).map(([label, key, second]) => ({
        label,
        file: 'adjacent.bmp',
        key,
        pixels: [0xc86432, second ? 255 : 0, 0xc86433, second ? 0 : 255, 0, 0] as const,
        display: second
          ? ([[200, 100, 50, 255], black] as const)
          : ([black, [200, 100, 51, 255]] as const),
      })),
      {
        label: 'wide-system-encoding',
        file: 'plain.png',
        key: '0x20000080000005',
        pixels: original,
        display: originalDisplay,
      },
      {
        label: 'wide-unknown-companions',
        file: 'hero.png',
        key: '0x20000080c86432',
        pixels: companion,
        display: companionDisplay,
      },
    ],
  },
  {
    name: 'recognized keys retain defaults and RGB then mask then matte then province behavior',
    rows: [
      ...[undefined, 'void', 'clNone', '0x2000001fffffff'].map((key) => ({
        label: 'none-' + (key ?? 'omitted'),
        file: 'plain.png',
        ...(key === undefined ? {} : { key }),
        pixels: original,
        display: originalDisplay,
      })),
      ...['0xc86432', 'clAdapt', '0x20000001ffffff'].map((key) => ({
        label: 'rgb-or-adapt-' + key,
        file: 'plain.png',
        key,
        pixels: keyed,
        display: keyedDisplay,
      })),
      {
        label: 'mask-replaces-both-key-alpha-values',
        file: 'hero.png',
        key: '0xc96533',
        pixels: companion,
        display: companionDisplay,
      },
      ...['clPalIdx+1', '0x20000003000001'].map((key) => ({
        label: 'palette-' + key,
        file: 'palette.png',
        key,
        pixels: palette,
        display: paletteDisplay,
      })),
      {
        label: 'palette-key-without-indices',
        file: 'plain.png',
        key: 'clPalIdx+1',
        pixels: original,
        display: originalDisplay,
      },
      ...['clAlphaMat+0xffffff', '0x20000004ffffff'].map((key) => ({
        label: 'matte-after-mask-' + key,
        file: 'hero.png',
        key,
        pixels: matted,
        display: mattedDisplay,
      })),
      {
        label: 'matte-decoded-alpha',
        file: 'plain.png',
        key: 'clAlphaMat+0xffffff',
        pixels: [0xf1d8cb, 255, 0xe4b299, 255, 0, 0],
        display: [
          [241, 216, 203, 255],
          [228, 178, 153, 255],
        ],
      },
    ],
  },
]

export function imageKeyFiles(): Record<string, Uint8Array> {
  return {
    'plain.png': imageFixture('main.png'),
    'hero.png': imageFixture('main.png'),
    'hero_m.png': imageFixture('mask.png'),
    'hero_p.png': imageFixture('palette-2x1.png'),
    'palette.png': imageFixture('palette-2x1.png'),
    'adjacent.bmp': encodeBmp({
      width: 2,
      height: 1,
      data: new Uint8Array([200, 100, 50, 64, 200, 100, 51, 128]),
    }),
  }
}

export function imageKeySource(scenario: ImageKeyScenario): string {
  return String.raw`
System.exitOnWindowClose=false;
var win=new Window();win.setInnerSize(2,${scenario.rows.length});win.visible=true;
var root=new Layer(win,null);root.setSize(2,${scenario.rows.length});root.fillRect(0,0,2,${scenario.rows.length},0xff000000);
var imageKeyRows=[],imageKeyMetadata=[],imageKeyLayers=[];
${scenario.rows
  .map(
    (row, index) => String.raw`
var layer=new Layer(win,root);
var tags=layer.loadImages(${JSON.stringify(row.file)}${row.key === undefined ? '' : ',' + row.key});
layer.setSize(2,1);layer.setPos(0,${index});layer.visible=true;imageKeyLayers.add(layer);
imageKeyRows.add(${JSON.stringify(row.label)}+"="+[layer.getMainPixel(0,0),layer.getMaskPixel(0,0),layer.getMainPixel(1,0),layer.getMaskPixel(1,0),layer.getProvincePixel(0,0),layer.getProvincePixel(1,0)].join(","));
${row.file === 'plain.png' || row.file === 'hero.png' ? 'imageKeyMetadata.add(int(tags.offs_x=="12" && tags.offs_y=="-7"));' : ''}
`,
  )
  .join('\n')}
Debug.message("image-key-ready");
`
}

export function imageKeyExpected(scenario: ImageKeyScenario): string {
  return scenario.rows.map((row) => row.label + '=' + row.pixels.join(',')).join('|')
}
