import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { headless } from '../helpers/headless.ts'

const oracle = JSON.parse(
  readFileSync(new URL('../fixtures/system-events/events.json', import.meta.url), 'utf8'),
) as { cases: Record<string, string[]> }
const trigger = (name: string, body: string, mode = 'atmNormal') =>
  `var ${name}=new AsyncTrigger(function(){${body}},"");${name}.mode=${mode};`
const windowScript = 'var w=new Window();w.visible=true;'
const scripts: Record<string, string> = {
  groups:
    windowScript +
    trigger('N', 'order.add("N");') +
    trigger('I', 'order.add("I");', 'atmAtIdle') +
    trigger('E', 'order.add("E");', 'atmExclusive') +
    `
w.onKeyDown=function(key,shift){order.add("K");};
function C(tick){order.add("C");}System.addContinuousHandler(C);
N.trigger();w.postInputEvent("onKeyDown",%[key:65,shift:0]);I.trigger();E.trigger();`,
  'input-exclusive':
    windowScript +
    trigger('X', 'order.add("X");', 'atmExclusive') +
    `
w.onKeyDown=function(key,shift){if(key==65){order.add("A");X.trigger();}else order.add("B");};
w.postInputEvent("onKeyDown",%[key:65,shift:0]);w.postInputEvent("onKeyDown",%[key:66,shift:0]);`,
  'nested-generation':
    trigger('X', 'order.add("X");', 'atmExclusive') +
    trigger('M', 'order.add("M");') +
    trigger(
      'A',
      'order.add("A");X.trigger();System.eventDisabled=false;order.add("a");M.trigger();',
    ) +
    trigger('B', 'order.add("B");') +
    'A.trigger();B.trigger();',
  'live-continuous': `
function C(tick){order.add("C");System.removeContinuousHandler(C);}
function B(tick){order.add("B");}
function A(tick){order.add("A");System.removeContinuousHandler(B);System.addContinuousHandler(C);System.removeContinuousHandler(A);}
System.addContinuousHandler(A);System.addContinuousHandler(A);System.addContinuousHandler(B);`,
  'continuous-reentry': `
function A(tick){order.add("A");Scripts.evalStorage("pulse.tjs");System.eventDisabled=false;order.add("a");}
function B(tick){order.add("B");}
System.addContinuousHandler(A);System.addContinuousHandler(B);`,
  'idle-before-continuous':
    trigger('X', 'order.add("X");', 'atmExclusive') +
    trigger('I', 'order.add("I");X.trigger();', 'atmAtIdle') +
    `
function A(tick){order.add("A");}function B(tick){order.add("B");}
System.addContinuousHandler(A);System.addContinuousHandler(B);I.trigger();`,
  'disabled-posting':
    windowScript +
    trigger('N', 'order.add("N");') +
    `
var timer=new Timer(function(){order.add("T");},"");timer.interval=1;timer.enabled=true;
var menu=new MenuItem(w,"M");w.menu.add(menu);menu.onClick=function(){order.add("M");};N.trigger();`,
}
for (const [name, mode] of [
  ['normal', 'atmNormal'],
  ['exclusive', 'atmExclusive'],
  ['idle', 'atmAtIdle'],
])
  scripts[`${name}-exclusive`] =
    trigger('X', 'order.add("X");', 'atmExclusive') +
    trigger('A', 'order.add("A");X.trigger();', mode) +
    trigger('B', 'order.add("B");', mode) +
    'A.trigger();B.trigger();'

for (const [name, expected] of Object.entries(oracle.cases))
  test(`reference event trace: ${name}`, async () => {
    let now = 17
    const tasks = new Set<{ at: number; callback(): void }>()
    const advance = (ms: number) => {
      now += ms
      for (const task of [...tasks]) if (task.at <= now && tasks.delete(task)) task.callback()
    }
    assert(scripts[name], `Missing executable case for ${name}`)
    const { session } = await headless(
      {
        'startup.tjs': 'var order=[];System.eventDisabled=true;' + scripts[name],
        'pulse.tjs': 'pulse',
      },
      {
        now: () => now,
        schedule(callback, delay) {
          const task = { callback, at: now + delay }
          tasks.add(task)
          return () => {
            tasks.delete(task)
          }
        },
        decodeScript(bytes) {
          const source = new TextDecoder().decode(bytes)
          if (source === 'pulse') {
            advance(1)
            return '0'
          }
          return source
        },
      },
    )
    try {
      await session.start()
      if (name === 'disabled-posting')
        await session.menuClick(Number(await session.evaluate('menu.__menuId')))
      advance(name === 'disabled-posting' ? 1 : 0)
      await session.evaluate(
        name === 'disabled-posting'
          ? '(function(){order.add("P");System.eventDisabled=false;})()'
          : expected.includes('P')
            ? '(function(){System.eventDisabled=false;order.add("P");})()'
            : 'System.eventDisabled=false',
      )
      await session.idle()
      assert.equal(await session.evaluate('order.join(",")'), expected.join(','))
      assert.equal(session.snapshot().eventDisabled, false)
    } finally {
      await session.stop()
    }
  })
