import assert from 'node:assert/strict'

function combinations(rows, expected, key) {
  assert.deepEqual(rows.map(key).sort(), [...expected].sort())
}
const fields = [
  'handles',
  'scriptObjects',
  'weakOwners',
  'dependents',
  'pendingInvalidations',
  'pendingHandles',
]
function baseline(after, before) {
  for (const field of fields) assert.equal(after[field], before[field], field)
}
function variants(rows, names, backend) {
  combinations(
    rows,
    names.flatMap((name) =>
      [false, true].flatMap((debug) => [false, true].map((binary) => `${name}/${debug}/${binary}`)),
    ),
    (row) => `${row.name}/${row.debugMode}/${row.binary}`,
  )
  for (const row of rows) assert.equal(row.variant, backend)
}

/** Validate saved hosted observations; never launches a VM or browser. */
export function windowLifetimeEvidence(runtime) {
  variants(
    runtime.dependentRevocations,
    [
      'preserve-instance',
      'last-reference',
      'last-reference-error',
      'after-owner-expired',
      'during-invalidation',
      'rebind',
      'independent-bindings',
      'foreign-token',
      'dispose-pending',
    ],
    runtime.backend,
  )
  for (const row of runtime.dependentRevocations) {
    if (row.name === 'dispose-pending') {
      assert.deepEqual(row.disposed, { scriptObjects: 0, marks: [] })
      continue
    }
    baseline(row.after, row.baseline)
    assert.deepEqual(
      row.marks,
      ['last-reference', 'last-reference-error'].includes(row.name)
        ? ['child', 'owner']
        : row.name === 'independent-bindings'
          ? ['owner', 'owner', 'child']
          : ['owner', 'child'],
    )
  }

  variants(
    runtime.nativeLifetimes,
    [
      'implicit',
      'explicit',
      'direct-finalize',
      'script-retry',
      'native-retry',
      'reverse-slots',
      'invalid-registrations',
      'reentrant-invalidation',
      'paused-resume',
      'paused-cancel',
      'vm-dispose',
    ],
    runtime.backend,
  )
  for (const row of runtime.nativeLifetimes) {
    const slots = row.name === 'reverse-slots' ? 4 : 1
    assert.equal(row.registered.hooks, slots)
    if (row.name === 'vm-dispose') {
      assert.deepEqual(row.disposed, { hooks: 0, scriptObjects: 0 })
      assert.deepEqual(row.nativeCalls, [])
      assert.deepEqual(row.seen, [])
      assert.deepEqual(row.events, ['observe'])
      continue
    }
    if (row.name === 'paused-cancel')
      assert.deepEqual(row.cancelledDispose, { hooks: 0, scriptObjects: 0 })
    else baseline(row.after, row.baseline)
    if (row.name.startsWith('paused-')) {
      assert.equal(row.control.heldMs, 25)
      assert.equal(row.control.error, row.name === 'paused-cancel' ? 'AbortError' : null)
    }
    assert.deepEqual(
      row.nativeCalls,
      slots === 4 ? [4, 3, 2, 1] : row.name === 'native-retry' ? [1, 1] : [1],
    )
    assert.equal(row.seen.length, row.name === 'paused-cancel' ? 0 : slots)
    for (const seen of row.seen) {
      assert.equal(seen.marker, 42)
      assert.equal(seen.valid, 1)
    }
    assert.equal(row.events.filter((event) => event === 'observe').length, 1)
    assert(row.events.indexOf('observe') > row.events.lastIndexOf('seen:1'))
    assert.equal(
      row.events.filter((event) => event === 'script').length,
      ['direct-finalize', 'script-retry', 'native-retry'].includes(row.name) ? 2 : 1,
    )
  }

  combinations(runtime.windowOwnership, ['false', 'true'], (row) => String(row.binary))
  const expected = {
    'implicit-window': 'released',
    'returned-window': '[TJS object]',
    'native-members-before-clear': 'original:42:1,1,1,0',
    'managed-error-continues': null,
    'managed-registration-lock': '0,1,2',
    'finalizer-retry': 'retried',
    'closure-registration': 'distinct-contexts',
    'lazy-menu-action-owner': 'released',
    'weak-queued-input': 'cancelled',
    'resize-last-reference': 'released',
    'replacement-during-retirement': 'original,replacement,1',
    'independent-primary-layer': 'separate-layer',
    'video-before-managed': 'media-first',
  }
  for (const row of runtime.windowOwnership) {
    assert.equal(row.variant, runtime.backend)
    assert.equal(row.baseline.windowSources, 0)
    assert.equal(row.baseline.closingWindows, 0)
    combinations(row.cases, Object.keys(expected), (item) => item.name)
    for (const item of row.cases) {
      if (item.name === 'managed-error-continues') {
        assert(item.result.startsWith('1,0,2; '))
        assert(item.result.includes('managed-finalizer'))
      } else assert.equal(item.result, expected[item.name])
      assert.deepEqual(item.retired, row.baseline)
      if (!['returned-window', 'resize-last-reference'].includes(item.name))
        assert.equal(item.observed.windowSources, 1)
      if (item.name === 'video-before-managed') {
        assert.equal(item.observed.closingWindows, 1)
        assert.equal(item.observed.movies, 1)
      }
    }
    assert.deepEqual(Object.keys(row.stopped).sort(), Object.keys(row.baseline).sort())
    for (const value of Object.values(row.stopped)) assert.equal(value, 0)
    assert.equal(row.rendererCloses, 1)
  }
}
