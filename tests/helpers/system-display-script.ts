import type { SystemDisplayMetrics } from '../../src/engine/system/display.ts'

export const systemDisplayNames = [
  'screenWidth',
  'screenHeight',
  'desktopLeft',
  'desktopTop',
  'desktopWidth',
  'desktopHeight',
] as const

export const systemDisplayMetrics: SystemDisplayMetrics = {
  screenWidth: 2147483647,
  screenHeight: 1081,
  desktopLeft: -2147483648,
  desktopTop: -57,
  desktopWidth: 901,
  desktopHeight: 0,
}

export const otherSystemDisplayMetrics: SystemDisplayMetrics = {
  screenWidth: 1729,
  screenHeight: 977,
  desktopLeft: 2147483647,
  desktopTop: -2147483648,
  desktopWidth: 603,
  desktopHeight: 409,
}

export function systemDisplayExpected(metrics: SystemDisplayMetrics): string {
  return systemDisplayNames.map((name) => metrics[name]).join('|')
}

export const systemDisplayScript = `
var sdNames=${JSON.stringify(systemDisplayNames)};
function systemDisplayValues(){var values=[];for(var i=0;i<sdNames.count;i++)values.add(System[sdNames[i]]);return values.join("|");}
var sdProperties=0,sdIntegers=0,sdReadonly=0,sdReferenceReadonly=0,sdBorrowed=0;
var sdReceiver=%[sentinel:"untouched",__host:function(){throw "borrowed receiver host must not run";}];
var sdReference;
for(var sdIndex=0;sdIndex<sdNames.count;sdIndex++){
  var sdName=sdNames[sdIndex],sdBefore=System[sdName];
  if((&System[sdName]) instanceof "Property")sdProperties++;
  if((typeof System[sdName])==="Integer")sdIntegers++;
  try{System[sdName]=sdBefore+1;}catch(e){sdReadonly++;}
  if(System[sdName]!==sdBefore)throw "display property changed:"+sdName;
  &global.sdReference=(&System[sdName]) incontextof sdReceiver;
  if(*(&global.sdReference)===sdBefore)sdBorrowed++;
  try{*(&global.sdReference)=sdBefore+1;}catch(e){sdReferenceReadonly++;}
  if(System[sdName]!==sdBefore)throw "display reference changed:"+sdName;
}
var sdChecks=[sdProperties,sdIntegers,sdReadonly,sdReferenceReadonly,sdBorrowed].join("|");
var sdInitial=systemDisplayValues();
var sdWidthReference=&System.desktopWidth;
if(sdReceiver.sentinel!=="untouched")throw "borrowed receiver changed";
`

export function systemDisplayFiles(binary: boolean, source = systemDisplayScript) {
  return {
    'startup.tjs': binary
      ? 'Scripts.compileStorage("system-display.tjs","savedata/system-display.cjs",false,true,false);Scripts.execStorage("savedata/system-display.cjs");'
      : 'Scripts.execStorage("system-display.tjs");',
    'system-display.tjs': source,
  }
}
