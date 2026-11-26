import { xp3Fixture } from './xp3-fixtures.ts'

const wide = (source: string) => Buffer.from('\ufeff' + source, 'utf16le')
export function patchCaseFiles(): Record<string, Buffer> {
  return {
    'TaleBase/route.tjs': wide('"base"'),
    'TaleUpdate/Route.TJS': wide('"loose patch"'),
    'ScenePack.xp3': xp3Fixture({ 'TXT/ROUTE.TJS': wide('"archive patch"') }, { compressed: true }).bytes,
  }
}

export const patchCaseExpected = 'base|loose patch|archive patch|archive patch|archive patch|loose patch|base|archive patch|base'
export const patchCaseSource = String.raw`
function patchCaseTrace(){
 var result=[];
 Storages.addAutoPath("TaleBase/");
 result.add(Scripts.evalStorage("route.tjs"));
 Storages.addAutoPath("TaleUpdate/");
 result.add(Scripts.evalStorage("route.tjs"));
 Storages.addAutoPath("ScenePack.xp3>txt/");
 result.add(Scripts.evalStorage("route.tjs"));
 result.add(Scripts.evalStorage("other/Route.TJS"));
 Storages.addAutoPath("TALEupdate/");
 result.add(Scripts.evalStorage("Route.TJS"));
 Storages.removeAutoPath("scenepack.XP3>TXT/");
 result.add(Scripts.evalStorage("route.tjs"));
 Storages.removeAutoPath("TALEUPDATE/");
 result.add(Scripts.evalStorage("ROUTE.TJS"));
 result.add(Scripts.evalStorage("scenepack.XP3>txt/route.tjs"));
 result.add(Scripts.evalStorage("TaleBase/route.tjs"));
 Storages.removeAutoPath("talebase/");
 return result.join("|");
}
`
