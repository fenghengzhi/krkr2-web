// The expectations use exact dyadics, independently specified binary64 values,
// and IEEE limits. No application decimal parser supplies an expected value.
export const decimalCases = [
  { id: 'wave-x', token: '0.100000001490116119384765625', value: 13421773 / 134217728 },
  { id: 'wave-z', token: '-0.20000000298023223876953125', value: -13421773 / 67108864 },
  { id: 'float-third', token: '0.3333333432674407958984375', value: 11184811 / 33554432 },
  { id: 'tenth', token: '0.1000000000000000000000000000000000000000', value: 0.1 },
  { id: 'small-fraction', token: '0.0000000000009094947017729282379150390625', value: 2 ** -40 },
  { id: 'unit-successor', token: '1.0000000000000002220446049250313080847263336181640625', value: 1 + 2 ** -52 },
  { id: 'half-even-low', token: '9007199254740993.0', value: 2 ** 53 },
  { id: 'half-even-high', token: '9007199254740995.0', value: 2 ** 53 + 4 },
  { id: 'negative-large', token: '-9007199254740995.00000', value: -(2 ** 53 + 4) },
  { id: 'scaled-mantissa', token: '125' + '0'.repeat(34) + '.0e-36', value: 1.25 },
  { id: 'exponent-spaces', token: '125e - 2', value: 1.25 },
  { id: 'numeric-prefix', token: '0.125000000000000000000', text: '0.125000000000000000000px', value: 1 / 8 },
  { id: 'unfinished-string-exponent', token: '12.5', text: '12.5e+', value: 12.5 },
  { id: 'zero', token: '0.00000000000000000000000000', value: 0 },
  { id: 'negative-zero', token: '-0.00000000000000000000000000', value: -0 },
  { id: 'smallest-normal', token: '2.2250738585072014e-308', value: 2 ** -1022 },
  { id: 'largest-finite', token: '1.7976931348623157e308', value: Number.MAX_VALUE },
  { id: 'overflow', token: '1.0e400', value: Infinity },
  { id: 'negative-overflow', token: '-1.0e400', value: -Infinity },
  { id: 'underflow', token: '1.0e-400', value: 0 },
  { id: 'negative-underflow', token: '-1.0e-400', value: -0 },
] as const

export function doubleBits(value: number): string {
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, value)
  return view.getBigUint64(0).toString(16).padStart(16, '0')
}

// Stock Array.saveStruct writes a hex significand/exponent and a separate
// decimal display comment. Its 13 hex digits preserve all 52 fraction bits.
export function savedRealBits(source: string): string[] {
  const array = /^\s*\(const\)\s*\[([^\]]*)\]\s*$/.exec(source.replace(/\/\*[\s\S]*?\*\//g, ''))
  if (!array) throw new Error('Expected a stock saved array of real numbers')
  return array[1]!.split(',').map((part) => {
    const token = part.trim()
    if (/^[+-]?0\.0$/.test(token) || /^[+-]?Infinity$/.test(token)) return doubleBits(Number(token))
    const real = /^(-?)0x1\.([0-9a-f]{13})p([+-]?\d+)$/i.exec(token)
    if (!real) throw new Error('Expected an exact saved real: ' + token)
    const exponent = Number(real[3]) + 1023
    if (exponent < 0 || exponent > 2046) throw new Error('Invalid binary64 exponent')
    const bits = (real[1] ? 1n << 63n : 0n) | (BigInt(exponent) << 52n) | BigInt('0x' + real[2])
    return bits.toString(16).padStart(16, '0')
  })
}

export const decimalPaths = ['literal', 'converted', 'restored'] as const
export const decimalPoolExpected = '1,NaN,1,-0.0,+0.0'
export const decimalSource = `
System.exitOnNoWindowStartup=false;
function decimalPoolControl(){
  var a=[1.25,NaN,0.5,-0.0,+0.0];
  return [int(a[0]==5.0/4),string(a[1]),int(a[2]==1.0/2),string(a[3]),string(a[4])].join(",");
}
function decimalObserve(prefix){
  var literals=[${decimalCases.map((r) => r.token).join(',')}];
  var strings=[${decimalCases.map((r) => JSON.stringify('text' in r ? r.text : r.token)).join(',')}],converted=[];
  for(var i=0;i<strings.count;i++)converted.add(real(strings[i]));
  literals.saveStruct(prefix+"literal.tjs");
  converted.saveStruct(prefix+"converted.tjs");
  var restored=Scripts.evalStorage(prefix+"literal.tjs");
  restored.saveStruct(prefix+"restored.tjs");
  return literals.count;
}
`

export const decimalGameSource = decimalSource + `
var decimalsWindow=new Window();decimalsWindow.caption="Decimal layout";decimalsWindow.setInnerSize(80,12);
var decimalsRoot=new Layer(decimalsWindow,null);decimalsWindow.add(decimalsRoot);decimalsRoot.type=ltOpaque;
decimalsRoot.setSize(80,12);decimalsRoot.fillRect(0,0,80,12,0xff102030);
var point=new Layer(decimalsWindow,decimalsRoot);point.type=ltOpaque;point.setSize(3,2);
point.fillRect(0,0,3,2,0xffe0b040);
function decimalPosition(saved){
  point.setPos(int(saved[0]*640),int(-saved[1]*35));
  point.visible=true;return point.left+","+point.top;
}
decimalObserve(System.dataPath);
decimalPosition(Scripts.evalStorage(System.dataPath+"converted.tjs"));
decimalsWindow.visible=true;
`
