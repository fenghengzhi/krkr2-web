// Native observations: original SDK 2.32.2.426, GitHub Actions run 35017080903,
// windows-2022 and windows-2025. Palette-dependent results use deliberately
// distinct RGB sentinels instead of assuming either runner's Windows theme.
export const systemColorPalette: readonly number[] = Object.freeze([
  0x132435, 0x243546, 0x354657, 0x465768, 0x576879, 0x68798a, 0x798a9b, 0x8a9bac, 0x9bacbd,
  0xacbdce, 0xbdcedf, 0xcedfe1, 0xdfe123, 0xe12345, 0x123456, 0x234567, 0x345678, 0x456789,
  0x56789a, 0x6789ab, 0x789abc, 0x89abcd, 0x9abcde, 0xabcdef, 0xbcdef1, 0, 0xcdef12, 0xdef123,
  0xef1234, 0xf12345, 0x214365,
])

export const systemColorConstantNames = [
  'clScrollBar',
  'clBackground',
  'clActiveCaption',
  'clInactiveCaption',
  'clMenu',
  'clWindow',
  'clWindowFrame',
  'clMenuText',
  'clWindowText',
  'clCaptionText',
  'clActiveBorder',
  'clInactiveBorder',
  'clAppWorkSpace',
  'clHighlight',
  'clHighlightText',
  'clBtnFace',
  'clBtnShadow',
  'clGrayText',
  'clBtnText',
  'clInactiveCaptionText',
  'clBtnHighlight',
  'cl3DDkShadow',
  'cl3DLight',
  'clInfoText',
  'clInfoBk',
] as const

interface ColorValueCase {
  id: string
  expression: string
  expected: number
}

export function systemColorValueCases(
  palette: readonly number[] = systemColorPalette,
): ColorValueCase[] {
  const observed: [string, string, number][] = [
    ['rgb-zero', '0', 0],
    ['rgb-one', '1', 1],
    ['rgb-123456', '0x123456', 0x123456],
    ['rgb-abcdef', '0xabcdef', 0xabcdef],
    ['rgb-white', '0xffffff', 0xffffff],
    ['rgb-red', '0xff0000', 0xff0000],
    ['rgb-green', '0x00ff00', 0x00ff00],
    ['rgb-blue', '0x0000ff', 0x0000ff],
    ['high-byte-01010203', '0x01010203', 0x030201],
    ['high-byte-02010203', '0x02010203', 0x030201],
    ['high-byte-03010203', '0x03010203', 0x030201],
    ['high-byte-04010203', '0x04010203', 0x030201],
    ['high-byte-7f010203', '0x7f010203', 0x030201],
    ['high-byte-81000005', '0x81000005', palette[5]!],
    ['high-byte-ff000005', '0xff000005', palette[5]!],
    ['high-byte-ffffffff', '0xffffffff', 0],
    ['high-byte-80000105', '0x80000105', palette[5]!],
    ['high-byte-80010005', '0x80010005', palette[5]!],
    ['high-byte-80800005', '0x80800005', palette[5]!],
    ['high-byte-c0000005', '0xc0000005', palette[5]!],
    ['high-byte-80000019', '0x80000019', 0],
    ['high-byte-8000001a', '0x8000001a', palette[26]!],
    ['high-byte-8000001e', '0x8000001e', palette[30]!],
    ['high-byte-8000001f', '0x8000001f', 0],
    ['high-byte-800000ff', '0x800000ff', 0],
    ['high-byte-80000100', '0x80000100', palette[0]!],
    ['high-byte-8000ffff', '0x8000ffff', 0],
    ['image-marker-none', 'clNone', 0xffffff],
    ['image-marker-adapt', 'clAdapt', 0xffffff],
    ['image-marker-palette-18', 'clPalIdx+0x12', 0x120000],
    ['image-marker-alpha-mat-123456', 'clAlphaMat+0x123456', 0x563412],
    ['integer-width-signed-window', '-2147483643', palette[5]!],
    ['integer-width-signed-min32', '-2147483648', palette[0]!],
    ['integer-width-minus-one', '-1', 0],
    ['integer-width-exact32', '0x100000000', 0],
    ['integer-width-above32-rgb', '0x100123456', 0x123456],
    ['integer-width-above32-window', '0x180000005', palette[5]!],
    ['integer-width-negative32-rgb', '(-0x100000000+0x123456)', 0x123456],
    ['integer-width-above-safe-odd', '9007199254740993', 1],
    ['integer-width-above-safe-window', '9007201402224645', palette[5]!],
    ['integer-width-negative-safe-odd', '-9007199254740993', 0],
    ['integer-width-wide-rgb', '0x1000000000123456', 0x123456],
    ['integer-width-wide-window', '0x1000000080000005', palette[5]!],
    ['integer-width-max-int64', '0x7fffffffffffffff', 0],
    ['integer-width-min-int64', '(-9223372036854775807-1)', 0],
    ['coercion-void', 'void', 0],
    ['coercion-numeric-string', '"1193046"', 0x123456],
    ['coercion-fraction', '1193046.75', 0x123456],
  ]
  return [
    ...systemColorConstantNames.map((name, index) => ({
      id: `constant-${name}`,
      expression: name,
      expected: palette[index]!,
    })),
    ...observed.map(([id, expression, expected]) => ({ id, expression, expected })),
    // Cover every role and every undefined low-byte index, including 25 and
    // 26..30, so a truncated 25-entry table cannot accidentally pass.
    ...Array.from({ length: 256 }, (_, index) => ({
      id: `system-index-${index}`,
      expression: `0x${(0x80000000 + index).toString(16)}`,
      expected: index < 31 ? palette[index]! : 0,
    })),
  ]
}

const entryCases: readonly [string, string, string, string, number][] = [
  ['entry-missing-used', 'return System.toActualColor();', 'error', '', 0],
  ['entry-missing-discarded', 'System.toActualColor();return "returned";', 'error', '', 0],
  ['entry-octet-used', 'return System.toActualColor(systemColorBadValue);', 'error', '', 1],
  [
    'entry-octet-discarded',
    'System.toActualColor(systemColorBadValue);return "returned";',
    'returned',
    'returned',
    1,
  ],
  ['entry-object-used', 'return System.toActualColor(%[]);', 'error', '', 0],
  [
    'entry-object-discarded',
    'System.toActualColor(%[]);return "returned";',
    'returned',
    'returned',
    0,
  ],
  [
    'entry-extra-argument',
    'return System.toActualColor(0x123456,systemColorBadValue);',
    'returned',
    '1193046',
    1,
  ],
  [
    'entry-borrowed-receiver',
    'var receiver=%[sentinel:17,__host:function(){throw "wrong receiver";}];var method=System.toActualColor incontextof receiver;var result=method(0x123456);if(receiver.sentinel!=17)throw "changed receiver";return result;',
    'returned',
    '1193046',
    0,
  ],
  // Both original hosted Windows runners returned normally with a null context.
  [
    'entry-null-receiver',
    'var method=System.toActualColor incontextof null;return method(0x123456);',
    'returned',
    '1193046',
    0,
  ],
]

function layerCases(palette: readonly number[]): readonly [string, string, string][] {
  const rgb = palette[5]!
  return [
    [
      'layer-fill-opaque-hold',
      'layer.face=dfOpaque;layer.holdAlpha=true;layer.fillRect(0,0,1,1,clWindow);',
      `${rgb},87,0`,
    ],
    [
      'layer-fill-opaque-replace',
      'layer.face=dfOpaque;layer.holdAlpha=false;layer.fillRect(0,0,1,1,clWindow);',
      '5,128,0',
    ],
    ['layer-fill-alpha', 'layer.face=dfAlpha;layer.fillRect(0,0,1,1,clWindow);', '5,128,0'],
    ['layer-fill-addalpha', 'layer.face=dfAddAlpha;layer.fillRect(0,0,1,1,clWindow);', '5,128,0'],
    ['layer-set-main-window', 'layer.setMainPixel(0,0,clWindow);', `${rgb},87,0`],
    ['layer-set-main-high01', 'layer.setMainPixel(0,0,0x01010203);', '197121,87,0'],
    [
      'layer-color-alpha',
      'layer.face=dfAlpha;layer.colorRect(0,0,1,1,clWindow,255);',
      `${rgb},255,0`,
    ],
    [
      'layer-color-alpha-zero',
      'layer.face=dfAlpha;layer.colorRect(0,0,1,1,clWindow,0);',
      '1122867,87,0',
    ],
    [
      'layer-color-alpha-negative',
      'layer.face=dfAlpha;layer.colorRect(0,0,1,1,clWindow,-255);',
      '1122867,0,0',
    ],
    [
      'layer-color-opaque',
      'layer.face=dfOpaque;layer.colorRect(0,0,1,1,clWindow,255);',
      `${rgb},87,0`,
    ],
    [
      'layer-color-addalpha-zero',
      'layer.face=dfAddAlpha;layer.colorRect(0,0,1,1,clWindow,0);',
      '1122867,87,0',
    ],
    ['layer-fill-mask', 'layer.face=dfMask;layer.fillRect(0,0,1,1,clWindow);', '1122867,5,0'],
    [
      'layer-fill-province',
      'layer.face=dfProvince;layer.fillRect(0,0,1,1,clWindow);',
      '1122867,87,5',
    ],
    ['layer-set-province', 'layer.setProvincePixel(0,0,clWindow);', '1122867,87,5'],
    // The original layer-color-mask observation is retained in run 35017080903.
    // Its independent mask arithmetic difference is outside this color change.
    ['layer-set-mask', 'layer.setMaskPixel(0,0,clWindow);', '1122867,5,0'],
    [
      'layer-fill-opaque-high01',
      'layer.face=dfOpaque;layer.holdAlpha=true;layer.fillRect(0,0,1,1,0x01010203);',
      '197121,87,0',
    ],
    [
      'layer-color-high01',
      'layer.face=dfAlpha;layer.colorRect(0,0,1,1,0x01010203,255);',
      '197121,255,0',
    ],
    ['layer-set-main-wide', 'layer.setMainPixel(0,0,0x1000000080000005);', `${rgb},87,0`],
    [
      'layer-fill-opaque-wide',
      'layer.face=dfOpaque;layer.holdAlpha=true;layer.fillRect(0,0,1,1,0x1000000080000005);',
      `${rgb},87,0`,
    ],
    [
      'layer-color-wide',
      'layer.face=dfAlpha;layer.colorRect(0,0,1,1,0x1000000080000005,255);',
      `${rgb},255,0`,
    ],
    [
      'layer-fill-alpha-wide',
      'layer.face=dfAlpha;layer.fillRect(0,0,1,1,0x1000000080000005);',
      '5,128,0',
    ],
  ]
}

export const systemColorsScript = String.raw`
var systemColorRows=[],systemColorErrors=[],systemColorEffects=0;
function systemColorRecord(id,outcome,result){
  systemColorRows.add(id+"|"+outcome+"|"+result+"|"+systemColorEffects);
}
function systemColorValue(id,value){
  systemColorEffects=0;
  try{
    var result=System.toActualColor(value);
    if(typeof result!="Integer")throw new Exception("Color result must be Integer");
    systemColorRecord(id,"returned",string(result));
  }catch(error){systemColorErrors.add(id+":"+error.message);systemColorRecord(id,"error","");}
}
function systemColorEntry(id,action){
  systemColorEffects=0;
  try{var result=action();systemColorRecord(id,"returned",string(result));}
  catch(error){systemColorErrors.add(id+":"+error.message);systemColorRecord(id,"error","");}
}
property systemColorBadValue {getter(){systemColorEffects++;return <% 01 02 %>;}}
${systemColorValueCases()
  .map(({ id, expression }) => `systemColorValue("${id}",${expression});`)
  .join('\n')}
${entryCases.map(([id, source]) => `systemColorEntry("${id}",function(){${source}});`).join('\n')}
${systemColorConstantNames.map((name) => `systemColorEntry("encoding-${name}",function(){return ${name};});`).join('\n')}

var systemColorWindow=new Window();systemColorWindow.visible=false;
var systemColorLayer=new Layer(systemColorWindow,null);
systemColorLayer.type=ltAlpha;
systemColorLayer.setSize(2,2);systemColorLayer.setImageSize(2,2);
systemColorLayer.setClip(0,0,2,2);
function systemColorLayerCase(id,action){
  systemColorEffects=0;
  var layer=systemColorLayer;
  layer.face=dfAlpha;layer.holdAlpha=false;
  layer.fillRect(0,0,2,2,0x57112233);layer.setProvincePixel(0,0,0);
  try{
    action(layer);
    if(layer.getMainPixel(1,1)!=0x112233||layer.getMaskPixel(1,1)!=87||layer.getProvincePixel(1,1)!=0)
      throw new Exception("Color operation changed an untouched pixel");
    systemColorRecord(id,"returned",layer.getMainPixel(0,0)+","+layer.getMaskPixel(0,0)+","+layer.getProvincePixel(0,0));
  }catch(error){systemColorErrors.add(id+":"+error.message);systemColorRecord(id,"error","");}
}
${layerCases(systemColorPalette)
  .map(([id, source]) => `systemColorLayerCase("${id}",function(layer){${source}});`)
  .join('\n')}
systemColorEntry("layer-neutral-raw",function(){systemColorLayer.neutralColor=clWindow;return systemColorLayer.neutralColor;});
`

export function systemColorExpectedRows(palette: readonly number[] = systemColorPalette): string[] {
  return [
    ...systemColorValueCases(palette).map(({ id, expected }) => `${id}|returned|${expected}|0`),
    ...entryCases.map(([id, , outcome, value, effects]) => `${id}|${outcome}|${value}|${effects}`),
    ...systemColorConstantNames.map(
      (name, index) => `encoding-${name}|returned|${0x80000000 + index}|0`,
    ),
    ...layerCases(palette).map(([id, , value]) => `${id}|returned|${value}|0`),
    'layer-neutral-raw|returned|2147483653|0',
  ]
}
