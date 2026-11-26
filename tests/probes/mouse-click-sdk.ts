import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

assert.equal(process.env.GITHUB_ACTIONS, 'true')
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
assert.equal(process.env.RUNNER_OS, 'Windows')
const output = resolve('out/verification/native-eri/mouse-click'), game = resolve(output, 'game'),
  sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex'),
  save = (name: string, value: unknown) => writeFileSync(resolve(output, name), JSON.stringify(value, null, 2) + '\n'),
  startup = Buffer.from('\ufeff' + String.raw`
System.exitOnNoWindowStartup=false;System.exitOnWindowClose=false;
var mouseRows=[],mouseUps=0;
function mouseRecord(role,kind,x,y,button=-1,shift=0){
 global.mouseRows.add([role,kind,x,y,button,shift].join("|"));global.mouseRows.save("native-events.txt");
}
System.exceptionHandler=function(e){global.mouseRows.add("fatal|"+e.message);global.mouseRows.save("native-events.txt");System.exit();return true;};
var probeWindow=new Window();probeWindow.caption="KRKR original mouse input";probeWindow.setInnerSize(320,180);
var probeRoot=new Layer(probeWindow,null);probeWindow.add(probeRoot);probeRoot.setSize(320,180);probeRoot.holdAlpha=false;
probeRoot.fillRect(0,0,320,180,0xff102030);
class MouseReferenceLayer extends Layer {
 function MouseReferenceLayer(label,x){super.Layer(global.probeWindow,global.probeRoot);name=label;
  setSize(160,180);setPos(x,0);holdAlpha=false;fillRect(0,0,160,180,0xff306090);visible=true;}
 function onMouseDown(x,y,button,shift){global.mouseRecord(name,"down",x,y,button,shift);}
 function onMouseUp(x,y,button,shift){global.mouseRecord(name,"up",x,y,button,shift);}
 function onClick(x,y){global.mouseRecord(name,"click",x,y);}
 function onDoubleClick(x,y){global.mouseRecord(name,"double",x,y);}
}
var probeLeft=new MouseReferenceLayer("left",0),probeRight=new MouseReferenceLayer("right",160);
probeWindow.add(probeLeft);probeWindow.add(probeRight);
probeWindow.onMouseDown=function(x,y,button,shift){global.mouseRecord("window","down",x,y,button,shift);};
probeWindow.onMouseUp=function(x,y,button,shift){global.mouseRecord("window","up",x,y,button,shift);
 if(++global.mouseUps==4)global.mouseFinish.enabled=true;};
probeWindow.onClick=function(x,y){global.mouseRecord("window","click",x,y);};
probeWindow.onDoubleClick=function(x,y){global.mouseRecord("window","double",x,y);};
var mouseFinish=new Timer(function(){global.mouseFinish.enabled=false;global.mouseRows.add("done");
 global.mouseRows.save("native-events.txt");System.exit();},"");mouseFinish.enabled=false;mouseFinish.interval=100;
var mouseReady=new Timer(function(){global.mouseReady.enabled=false;global.probeWindow.bringToFront();
 global.probeRoot.setCursorPos(0,0);[global.probeWindow.HWND,global.probeRoot.cursorX,global.probeRoot.cursorY].save("native-ready.txt");},"");
mouseReady.enabled=false;mouseReady.interval=150;probeWindow.visible=true;mouseReady.enabled=true;
`, 'utf16le')

if (process.argv[2] === 'prepare') {
  mkdirSync(game, { recursive: true })
  writeFileSync(resolve(game, 'startup.tjs'), startup)
  save('inputs.json', { commit: process.env.GITHUB_SHA, startupSha256: sha(startup),
    driverSha256: sha(readFileSync('tests/probes/original-mouse-click.ps1')),
    cases: [{ first: [40, 30], second: [40, 30], release: [240, 90] },
      { first: [40, 30], second: [41, 31], release: [240, 90] }],
    scope: 'Owned original SDK Window, controlled normal User32 input. Record VCL event order and both down positions; no plugin or script-posted mouse event.' })
} else {
  assert.equal(process.argv[2], 'compare')
  const decode = (bytes: Buffer) => bytes.toString(bytes[0] === 255 && bytes[1] === 254 ? 'utf16le' : 'utf8').replace(/^\ufeff/, ''),
    inputs = JSON.parse(readFileSync(resolve(output, 'inputs.json'), 'utf8')),
    sdk = JSON.parse(decode(readFileSync(resolve(output, 'sdk-process.json')))),
    driver = JSON.parse(decode(readFileSync(resolve(output, 'input-observation.json')))),
    path = resolve(game, 'native-events.txt'), bytes = existsSync(path) ? readFileSync(path) : Buffer.alloc(0),
    lines = decode(bytes).trimEnd().split(/\r?\n/),
    events = lines.filter(line => line !== 'done').map(line => {
      const [role, kind, x, y, button, shift] = line.split('|')
      return { role, kind, x: Number(x), y: Number(y), button: Number(button), shift: Number(shift), raw: line }
    }), windows = events.filter(event => event.role === 'window'),
    downs = windows.filter(event => event.kind === 'down'), ups = windows.filter(event => event.kind === 'up'),
    doubles = windows.filter(event => event.kind === 'double'), layerDoubles = events.filter(event => event.role !== 'window' && event.kind === 'double'),
    points = (items: typeof events) => items.map(event => [event.x, event.y]),
    exact = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
  const complete = inputs.commit === process.env.GITHUB_SHA && inputs.startupSha256 === sha(startup) &&
    inputs.driverSha256 === sha(readFileSync('tests/probes/original-mouse-click.ps1')) &&
    readFileSync(resolve(game, 'startup.tjs')).equals(startup) && sdk.commit === process.env.GITHUB_SHA && sdk.state === 'observed' && sdk.exitCode === 0 &&
    sdk.timedOut === false && driver.complete === true && driver.commit === process.env.GITHUB_SHA &&
    driver.controlledSendInput === true && driver.physicalHardwareClaim === false && driver.pid === sdk.pid &&
    Array.isArray(driver.events) && driver.events.length === 14 &&
    driver.events.filter((event: { kind: string; sent?: number }) => event.kind === 'down' || event.kind === 'up')
      .every((event: { sent: number }) => event.sent === 1) &&
    lines.at(-1) === 'done' && lines.filter(line => line === 'done').length === 1 &&
    events.every(event => ['window', 'left', 'right'].includes(event.role ?? '') &&
      ['down', 'up', 'click', 'double'].includes(event.kind ?? '') &&
      [event.x, event.y, event.button, event.shift].every(Number.isInteger)) &&
    exact(points(downs), [[40, 30], [40, 30], [40, 30], [41, 31]]) &&
    exact(points(ups), [[40, 30], [240, 90], [40, 30], [240, 90]]) &&
    doubles.length === 2 && exact(points(doubles)[0], [40, 30]) &&
    (exact(points(doubles)[1], [40, 30]) || exact(points(doubles)[1], [41, 31])) &&
    layerDoubles.length === 2 && layerDoubles.every(event => event.role === 'left') &&
    exact(points(layerDoubles), points(doubles))
  save('comparison.json', { commit: process.env.GITHUB_SHA, complete, sdk, driver,
    events, rawSha256: sha(bytes), samePressDouble: points(doubles)[0], differentPressDouble: points(doubles)[1],
    scope: 'Complete normal SDK observation with exact equal-press DoubleClick coordinates. The different-press coordinate and callback order are recorded, not predetermined. No claim of physical hardware input or of Web double-click ordering equivalence.' })
  assert(complete, 'Original mouse input observation incomplete or equal-press coordinate differs; preserve raw evidence')
}
