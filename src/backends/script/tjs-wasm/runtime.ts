import {
  isScriptObject,
  ScriptError,
  type HostContext,
  type HostHandler,
  type ConsoleHandler,
  type HostReply,
  type ScriptObject,
  type ScriptWeakObject,
  type ScriptObjectIdentity,
  type ScriptDependent,
  type ScriptRuntime,
  type ScriptValue,
  scriptRecord,
  scriptList,
  type ScriptRecord,
  type ScriptList,
} from '../../../engine/script/runtime.ts'
import { ExecutionControl } from '../../../engine/scheduler/control.ts'
import type { ModuleFactory, ModuleOptions, NativeModule } from './module.ts'

let nextRuntime = 1

export class TjsWasmRuntime implements ScriptRuntime {
  private module!: NativeModule
  private vm = 0
  private readonly identity = nextRuntime++
  private busy = false
  private disposed = false
  private disposing = false
  private pendingWrites: { name: string; mode: string; value: string | Uint8Array }[] = []
  private flushing?: Promise<void>
  private consoleOutput: ConsoleHandler | null = null
  private readonly owners = new Map<number, () => void>()
  private readonly objectIdentities = new Set<number>()
  private ownerFailure?: Error

  private constructor(
    private readonly handler: HostHandler,
    private readonly control: ExecutionControl,
    private readonly variant: string,
  ) {}

  static async create(
    factory: ModuleFactory,
    handler: HostHandler,
    options: {
      variant?: string
      control?: ExecutionControl
      locateFile?: ModuleOptions['locateFile']
      wasmBinary?: Uint8Array
      debugMode?: boolean
    } = {},
  ): Promise<TjsWasmRuntime> {
    const runtime = new TjsWasmRuntime(
      handler,
      options.control ?? new ExecutionControl(),
      options.variant ?? 'asyncify',
    )
    runtime.module = await factory({
      locateFile: options.locateFile,
      wasmBinary: options.wasmBinary,
      randomBits: (destination, length) => {
        if (runtime.disposed || length !== 16 || !Number.isSafeInteger(destination) ||
            destination < 0 || destination > runtime.module.HEAPU8.length - length)
          throw new Error('Invalid native entropy destination')
        const crypto = globalThis.crypto
        if (!crypto || typeof crypto.getRandomValues !== 'function')
          throw new Error('Native entropy requires crypto.getRandomValues')
        // Fill private storage first: a throwing provider cannot partially
        // publish seed bytes, nor retain a view into the native stack.
        const bytes = new Uint8Array(16)
        if (crypto.getRandomValues(bytes) !== bytes)
          throw new Error('Native entropy provider returned an invalid buffer')
        runtime.module.HEAPU8.set(bytes, destination)
      },
      hostCall: (...args) => runtime.hostCall(...args),
      shouldCancel: () => runtime.control.cancelled,
      onYield: () => runtime.control.wait(),
      objectInvalidated: (vm, token) => runtime.objectInvalidated(vm, token),
      objectDestroyed: (vm, token) => runtime.objectDestroyed(vm, token),
      queueWrite: (name, nameLength, mode, modeLength, data, length, text) => {
        runtime.pendingWrites.push({
          name: runtime.readText(name, nameLength),
          mode: runtime.readText(mode, modeLength),
          value: text
            ? runtime.readText(data, length / 2)
            : runtime.module.HEAPU8.slice(data, data + length),
        })
      },
    })
    if (runtime.call('krkr_abi_version') !== 5) throw new Error('TJS WASM ABI mismatch')
    if (typeof runtime.module._krkr_release_draining !== 'function')
      throw new Error('TJS WASM is missing native release-state support')
    for (const name of [
      'krkr_identity_observe', 'krkr_identity_observe_owner', 'krkr_identity_observe_failed',
      'krkr_identity_alive', 'krkr_identity_upgrade', 'krkr_identity_upgrade_failed',
      'krkr_value_set_identity', 'krkr_identity_unobserve', 'krkr_identity_count',
    ])
      if (typeof runtime.module[`_${name}`] !== 'function')
        throw new Error(`TJS WASM is missing destruction-only object identity support: ${name}`)
    if (typeof runtime.module._krkr_random_source_version !== 'function' ||
        runtime.call('krkr_random_source_version') !== 1)
      throw new Error('TJS WASM is missing native random entropy support')
    runtime.vm = runtime.call('krkr_create', Number(options.debugMode === true))
    if (!runtime.vm) throw new Error('TJS VM initialization failed')
    return runtime
  }

  private call(name: string, ...args: (number | bigint)[]): number {
    return Number(this.module[`_${name}`]!(...args))
  }
  get languageVersion(): string | undefined {
    this.assertAlive()
    if (typeof this.module._krkr_tjs_version !== 'function') return undefined
    const version = this.call('krkr_tjs_version') >>> 0
    return `${version >>> 24}.${(version >>> 16) & 0xff}.${version & 0xffff}`
  }
  private assertAlive(allowDisposing = false): void {
    if (this.disposed || (this.disposing && !allowDisposing))
      throw new Error('TJS runtime is disposed')
  }
  private allocate(bytes: Uint8Array): number {
    const pointer = this.call('malloc', Math.max(1, bytes.length))
    if (!pointer) throw new Error('WASM allocation failed')
    this.module.HEAPU8.set(bytes, pointer)
    return pointer
  }
  private textPointer(text: string): number {
    const bytes = new Uint8Array((text.length + 1) * 2)
    const view = new DataView(bytes.buffer)
    for (let i = 0; i < text.length; i++) view.setUint16(i * 2, text.charCodeAt(i), true)
    return this.allocate(bytes)
  }
  private readText(pointer: number, length?: number): string {
    if (!pointer) return ''
    const start = pointer >>> 1
    let end = length === undefined ? start : start + length
    if (length === undefined) while (this.module.HEAPU16[end]) end++
    let text = ''
    for (let offset = start; offset < end; offset += 4096)
      text += String.fromCharCode(
        ...this.module.HEAPU16.subarray(offset, Math.min(offset + 4096, end)),
      )
    return text
  }
  private readValue(pointer: number, temporary?: ScriptObject[]): ScriptValue {
    switch (this.call('krkr_value_type', pointer)) {
      case 0:
        return undefined
      case 1: {
        if (this.call('krkr_value_is_null', pointer)) return null
        const value: ScriptObject = {
          type: 'object',
          id: this.call('krkr_value_pin', this.vm, pointer),
          runtime: this.identity,
        }
        temporary?.push(value)
        return value
      }
      case 2:
        return this.readText(
          this.call('krkr_value_data', pointer),
          this.call('krkr_value_length', pointer),
        )
      case 3: {
        const start = this.call('krkr_value_data', pointer)
        return this.module.HEAPU8.slice(start, start + this.call('krkr_value_length', pointer))
      }
      case 4:
        return BigInt(this.module._krkr_value_integer!(pointer))
      case 5:
        return this.call('krkr_value_real', pointer)
      default:
        throw new Error('Unknown TJS value type')
    }
  }
  private writeValue(pointer: number, value: ScriptValue): void {
    if (value === undefined) return
    if (value === null) {
      this.call('krkr_value_set_null', pointer)
      return
    }
    if (typeof value === 'bigint') {
      if (value !== BigInt.asIntN(64, value)) throw new RangeError('TJS integer exceeds int64')
      this.call('krkr_value_set_integer', pointer, value)
    } else if (typeof value === 'number') this.call('krkr_value_set_real', pointer, value)
    else if (typeof value === 'string') {
      const text = this.textPointer(value)
      try {
        this.call('krkr_value_set_text', pointer, text, value.length)
      } finally {
        this.call('free', text)
      }
    } else if (value instanceof Uint8Array) {
      const bytes = this.allocate(value)
      try {
        this.call('krkr_value_set_bytes', pointer, bytes, value.length)
      } finally {
        this.call('free', bytes)
      }
    } else if (value.type === 'native-method') {
      if (value.name !== 'getTraceString') throw new Error('Unknown native method')
      this.call('krkr_value_set_trace_function', pointer)
    } else if (value.type === 'native-class') {
      if (value.name !== 'Scripts') throw new Error('Unknown native class')
      this.call('krkr_value_set_scripts_class', this.vm, pointer)
    } else if (value.type === 'proxy' || value.type === 'class') {
      if (
        !value.namespace ||
        value.namespace.includes('\0') ||
        !value.className ||
        value.className.includes('\0')
      )
        throw new Error('Invalid native class identity')
      if (
        value.type === 'class' &&
        (value.properties.length > 64 ||
          value.properties.some((p) => !p.name || p.name.includes('\0')))
      )
        throw new Error('Invalid native class properties')
      if (value.type === 'class' && value.namespace === 'Pad') {
        if (
          value.id !== 0 ||
          value.className !== 'Pad' ||
          value.properties.length !== 0 ||
          value.systemMethods ||
          value.systemProperties
        )
          throw new Error('Invalid Pad class factory')
        if (
          typeof this.module._krkr_native_pad_version !== 'function' ||
          this.call('krkr_native_pad_version') !== 1
        )
          throw new Error('TJS WASM is missing native Pad support')
      }
      if (value.type === 'class' && value.namespace === 'PhaseVocoder') {
        if (
          value.id !== 0 ||
          value.className !== 'PhaseVocoder' ||
          value.properties.length !== 0 ||
          value.systemMethods ||
          value.systemProperties
        )
          throw new Error('Invalid PhaseVocoder class factory')
        this.requirePhaseVocoder()
      }
      if (value.type === 'class' && (value.systemMethods || value.systemProperties)) {
        if (
          value.namespace !== 'System' ||
          value.id !== 0 ||
          value.className !== 'System' ||
          (value.systemMethods?.length ?? 0) > 14 ||
      (value.systemProperties?.length ?? 0) > 5
        )
          throw new Error('Invalid System class delegates')
        if (
          typeof this.module._krkr_class_system_method !== 'function' ||
          typeof this.module._krkr_class_system_property !== 'function' ||
          typeof this.module._krkr_tjs_version !== 'function'
        )
          throw new Error('TJS WASM is missing native System support')
      }
      const namespace = this.textPointer(value.namespace),
        name = this.textPointer(value.className)
      try {
        this.call(
          value.type === 'class' ? 'krkr_value_set_class' : 'krkr_value_set_proxy',
          this.vm,
          pointer,
          namespace,
          value.id,
          name,
        )
        if (value.type === 'proxy' && value.owner) {
          this.assertObject(value.owner)
          if (!this.call('krkr_proxy_bind_owner', this.vm, pointer, value.owner.id))
            throw new Error('Cannot bind a proxy to a released or invalid TJS owner')
        }
        if (value.type === 'class')
          for (const property of value.properties) {
            const key = this.textPointer(property.name)
            try {
              this.call(
                'krkr_class_property',
                this.vm,
                pointer,
                namespace,
                value.id,
                key,
                Number(property.writable) |
                  (Number(property.static) << 1) |
                  (Number(property.boolean) << 2),
              )
            } finally {
              this.call('free', key)
            }
          }
        if (value.type === 'class') {
          for (const method of value.systemMethods ?? []) {
            if (!method.name || method.name.includes('\0') || !Number.isInteger(method.policy))
              throw new Error('Invalid System method delegate')
            this.assertObject(method.callback)
            const key = this.textPointer(method.name)
            try {
              if (
                !this.call(
                  'krkr_class_system_method',
                  this.vm,
                  pointer,
                  key,
                  method.callback.id,
                  method.policy,
                )
              )
                throw new Error(`Cannot bind System.${method.name}`)
            } finally {
              this.call('free', key)
            }
          }
          for (const property of value.systemProperties ?? []) {
            if (!property.name || property.name.includes('\0'))
              throw new Error('Invalid System property delegate')
            this.assertObject(property.callback)
            const key = this.textPointer(property.name)
            try {
              if (
                !this.call(
                  'krkr_class_system_property',
                  this.vm,
                  pointer,
                  key,
                  property.callback.id,
                )
              )
                throw new Error(`Cannot bind System.${property.name}`)
            } finally {
              this.call('free', key)
            }
          }
        }
      } finally {
        this.call('free', namespace)
        this.call('free', name)
      }
    } else if (value.type === 'weak-object') {
      this.assertAlive()
      this.assertWeakOwner(value)
      this.call('krkr_value_set_owner', this.vm, pointer, value.id)
    } else if (value.type === 'object-identity') {
      this.assertAlive()
      this.assertIdentity(value)
      this.call('krkr_value_set_identity', this.vm, pointer, value.id)
    } else if (value.type === 'array' || value.type === 'dictionary') {
      this.call('krkr_value_set_container', pointer, Number(value.type === 'array'))
      const entries = value.type === 'array' ? value.items.entries() : Object.entries(value.entries)
      for (const [key, child] of entries) {
        const temporary = this.call('krkr_reply_new', 0)
        const name = typeof key === 'string' ? this.textPointer(key) : 0
        try {
          const item = this.call('krkr_reply_value', temporary)
          this.writeValue(item, child)
          this.call('krkr_data_put', pointer, name, typeof key === 'number' ? key : 0, item)
        } finally {
          if (name) this.call('free', name)
          this.call('krkr_reply_delete', temporary)
        }
      }
    } else {
      this.assertObject(value)
      if (!this.call('krkr_value_set_handle', this.vm, pointer, value.id))
        throw new Error('Released TJS object handle')
    }
  }
  private assertObject(object: ScriptObject): void {
    this.assertAlive()
    if (object.runtime !== this.identity)
      throw new Error('Object belongs to a different TJS runtime')
  }
  retain(object: ScriptObject): ScriptObject {
    this.assertObject(object)
    const id = this.call('krkr_handle_retain', this.vm, object.id)
    if (!id) throw new Error('Released TJS object handle')
    return { type: 'object', id, runtime: this.identity }
  }
  release(object: ScriptObject): void {
    this.assertAlive(true)
    if (object.runtime !== this.identity)
      throw new Error('Object belongs to a different TJS runtime')
    this.call('krkr_handle_release', this.vm, object.id)
  }
  observe(owner: ScriptObject, invalidated: () => void): ScriptWeakObject {
    this.assertObject(owner)
    const id = this.call('krkr_owner_observe', this.vm, owner.id)
    if (!id) throw new Error('Cannot observe a released, invalid or non-instance TJS owner')
    try {
      this.owners.set(id, invalidated)
    } catch (error) {
      this.call('krkr_owner_unobserve', this.vm, id)
      throw error
    }
    return { type: 'weak-object', id, runtime: this.identity }
  }
  upgrade(owner: ScriptWeakObject): ScriptObject | undefined {
    this.assertWeakOwner(owner)
    if (this.disposed || this.disposing || !this.owners.has(owner.id)) return undefined
    const id = this.call('krkr_owner_upgrade', this.vm, owner.id)
    if (!id && this.call('krkr_owner_upgrade_failed', this.vm))
      throw new Error('TJS owner upgrade allocation failed')
    return id ? { type: 'object', id, runtime: this.identity } : undefined
  }
  unobserve(owner: ScriptWeakObject): void {
    this.assertWeakOwner(owner)
    if (this.disposed) return
    this.owners.delete(owner.id)
    this.call('krkr_owner_unobserve', this.vm, owner.id)
  }
  observeIdentity(owner: ScriptObject | ScriptWeakObject): ScriptObjectIdentity | undefined {
    this.assertAlive()
    if (owner.type === 'weak-object') {
      this.assertWeakOwner(owner)
      if (!this.owners.has(owner.id)) return undefined
    } else this.assertObject(owner)
    const id = this.call(
      owner.type === 'weak-object' ? 'krkr_identity_observe_owner' : 'krkr_identity_observe',
      this.vm, owner.id,
    )
    if (!id) {
      if (this.call('krkr_identity_observe_failed', this.vm))
        throw new Error('TJS object identity observation allocation or token budget failed')
      return undefined
    }
    try {
      this.objectIdentities.add(id)
    } catch (error) {
      this.call('krkr_identity_unobserve', this.vm, id)
      throw error
    }
    return { type: 'object-identity', id, runtime: this.identity }
  }
  identityAlive(identity: ScriptObjectIdentity): boolean {
    this.assertIdentity(identity)
    return !this.disposed && !this.disposing && this.objectIdentities.has(identity.id) &&
      this.call('krkr_identity_alive', this.vm, identity.id) !== 0
  }
  upgradeIdentity(identity: ScriptObjectIdentity): ScriptObject | undefined {
    this.assertIdentity(identity)
    if (this.disposed || this.disposing || !this.objectIdentities.has(identity.id)) return undefined
    const id = this.call('krkr_identity_upgrade', this.vm, identity.id)
    if (!id && this.call('krkr_identity_upgrade_failed', this.vm))
      throw new Error('TJS object identity upgrade allocation failed')
    return id ? { type: 'object', id, runtime: this.identity } : undefined
  }
  unobserveIdentity(identity: ScriptObjectIdentity): void {
    this.assertIdentity(identity)
    if (this.disposed) return
    this.objectIdentities.delete(identity.id)
    this.call('krkr_identity_unobserve', this.vm, identity.id)
  }
  private assertIdentity(identity: ScriptObjectIdentity): void {
    if (identity.runtime !== this.identity)
      throw new Error('Object identity belongs to a different TJS runtime')
  }
  private objectDestroyed(vm: number, token: number): void {
    // No user callback, release or script execution at this native noexcept
    // boundary. Deletion was already committed before the first signal.
    try {
      if (vm !== this.vm) throw new Error('Object destruction VM identity mismatch')
      this.objectIdentities.delete(token)
      this.call('krkr_identity_unobserve', vm, token)
    } catch (error) {
      this.ownerFailure ??= error instanceof Error ? error : new Error(String(error))
    }
  }
  registerNativeLifetime(
    owner: ScriptObject,
    operation: string,
    identifier: number,
    state?: ScriptObject,
  ): void {
    this.assertObject(owner)
    if (state) this.assertObject(state)
    if (
      !/^[A-Za-z][A-Za-z0-9_.]{0,127}$/.test(operation) ||
      !Number.isSafeInteger(identifier) ||
      identifier < 0 ||
      identifier > 0xffffffff
    )
      throw new Error('Invalid native lifetime operation or identifier')
    const name = this.textPointer(operation)
    try {
      if (
        !this.call(
          'krkr_owner_register_native',
          this.vm,
          owner.id,
          name,
          operation.length,
          identifier,
          state?.id ?? 0,
        )
      )
        throw new Error('Cannot register a native lifetime on this TJS instance')
    } finally {
      this.call('free', name)
    }
  }
  nativeLifetimeIdentifier(owner: ScriptObject, operation: string): number | undefined {
    this.assertObject(owner)
    if (!/^[A-Za-z][A-Za-z0-9_.]{0,127}$/.test(operation))
      throw new Error('Invalid native lifetime operation')
    const name = this.textPointer(operation)
    try {
      const id = this.call(
        'krkr_owner_native_identifier',
        this.vm,
        owner.id,
        name,
        operation.length,
      )
      return id < 0 ? undefined : id
    } finally {
      this.call('free', name)
    }
  }
  private requirePhaseVocoder(): void {
    if (
      typeof this.module._krkr_native_phase_vocoder_version !== 'function' ||
      this.call('krkr_native_phase_vocoder_version') !== 1
    )
      throw new Error('TJS WASM is missing native PhaseVocoder support')
  }
  nativePhaseVocoderIdentifier(owner: ScriptObject): number | undefined {
    this.assertObject(owner)
    this.requirePhaseVocoder()
    const id = this.call('krkr_phase_vocoder_identifier', this.vm, owner.id)
    return id < 0 ? undefined : id
  }
  snapshotPhaseVocoderFilters(array: ScriptObject): ScriptObject[] {
    this.assertObject(array)
    this.requirePhaseVocoder()
    const reply = this.call('krkr_data_entries', this.vm, array.id)
    const leases: ScriptObject[] = []
    try {
      const kind = this.call('krkr_reply_kind', reply)
      if (kind === 1) throw new Error(String(this.readValue(this.call('krkr_reply_value', reply))))
      if (kind !== 6) throw new Error('WaveSoundBuffer filters must be an Array')
      const count = this.call('krkr_reply_arg_count', reply)
      if (count > 16) throw new Error('WaveSoundBuffer filter chain budget exceeded')
      for (let i = 0; i < count; i++) {
        const value = this.readValue(this.call('krkr_reply_arg_at', reply, i), leases)
        if (!isScriptObject(value) || !(this.nativePhaseVocoderIdentifier(value)! > 0))
          throw new Error('WaveSoundBuffer filters require live native PhaseVocoder instances')
      }
      return leases
    } catch (error) {
      for (const lease of leases) this.release(lease)
      throw error
    } finally {
      this.call('krkr_reply_delete', reply)
    }
  }
  bindPhaseVocoderClass(owner: ScriptObject): void {
    this.assertObject(owner)
    this.requirePhaseVocoder()
    if (!this.call('krkr_bind_phase_vocoder_class', this.vm, owner.id))
      throw new Error('PhaseVocoder requires a live script class')
  }
  bindDependent(owner: ScriptObject, dependent: ScriptObject): ScriptDependent {
    this.assertObject(owner)
    this.assertObject(dependent)
    const id = this.call('krkr_owner_bind_dependent', this.vm, owner.id, dependent.id) >>> 0
    if (!id) throw new Error('Cannot bind a released, invalid or unavailable TJS dependent')
    return { type: 'dependent', id, runtime: this.identity }
  }
  unbindDependent(binding: ScriptDependent): void {
    if (binding.runtime !== this.identity)
      throw new Error('Dependent belongs to a different TJS runtime')
    if (this.disposed) return
    this.call('krkr_owner_unbind_dependent', this.vm, binding.id)
  }
  private assertWeakOwner(owner: ScriptWeakObject): void {
    if (owner.runtime !== this.identity) throw new Error('Owner belongs to a different TJS runtime')
  }
  private objectInvalidated(vm: number, token: number): void {
    // Called from native invalidation/destruction. Revoke before notifying so
    // resource cleanup cannot upgrade the same token or deliver another event.
    // Never throw across the native noexcept observer notification.
    try {
      if (vm !== this.vm) throw new Error('Owner invalidation VM identity mismatch')
      const invalidated = this.owners.get(token)
      this.owners.delete(token)
      this.call('krkr_owner_unobserve', vm, token)
      invalidated?.()
    } catch (error) {
      this.ownerFailure ??= error instanceof Error ? error : new Error(String(error))
    }
  }
  private checkOwnerFailure(): void {
    const failure = this.ownerFailure
    this.ownerFailure = undefined
    if (failure) throw failure
  }
  objectIdentity(object: ScriptObject): string {
    this.assertObject(object)
    const identity = this.module._krkr_closure_identity!(this.vm, object.id)
    if (identity === 0n) throw new Error('Released TJS object handle')
    return `${this.identity}:${identity}`
  }
  snapshot(object: ScriptObject): ScriptRecord | ScriptList {
    this.assertObject(object)
    const ancestors = new Set<number>()
    let budget = 100000
    const visit = (object: ScriptObject, depth: number): ScriptRecord | ScriptList => {
      if (depth > 64) throw new Error('Data snapshot exceeds depth budget')
      const identity = this.call('krkr_data_identity', this.vm, object.id)
      if (ancestors.has(identity)) throw new Error('Cyclic data cannot be snapshotted')
      ancestors.add(identity)
      const reply = this.call('krkr_data_entries', this.vm, object.id)
      const temporary: ScriptObject[] = []
      try {
        const kind = this.call('krkr_reply_kind', reply)
        if (kind === 1)
          throw new Error(String(this.readValue(this.call('krkr_reply_value', reply))))
        const count = this.call('krkr_reply_arg_count', reply)
        if ((budget -= count) < 0) throw new Error('Data snapshot exceeds member budget')
        const read = (index: number): ScriptValue => {
          const value = this.readValue(this.call('krkr_reply_arg_at', reply, index), temporary)
          return isScriptObject(value) ? visit(value, depth + 1) : value
        }
        if (kind === 6) return scriptList(Array.from({ length: count }, (_, i) => read(i)))
        const entries: Record<string, ScriptValue> = Object.create(null)
        for (let i = 0; i < count; i += 2) entries[String(read(i))] = read(i + 1)
        return scriptRecord(entries)
      } finally {
        for (const value of temporary) this.release(value)
        this.call('krkr_reply_delete', reply)
        ancestors.delete(identity)
      }
    }
    return visit(object, 0)
  }
  private buildReply(reply: HostReply): number {
    if (reply.kind === 'dump') return this.call('krkr_reply_new', 8)
    if (reply.kind === 'invoke' && reply.statusOnly && reply.ignoreStatus)
      throw new Error('Cannot both return and ignore a native call status')
    if (
      reply.kind === 'script' &&
      typeof reply.source !== 'string' &&
      reply.source.length > 64 * 1024 * 1024
    )
      throw new ScriptError('Binary script exceeds 64 MiB budget', reply.name)
    const kind =
      reply.kind === 'value'
        ? 0
        : reply.kind === 'invoke'
          ? reply.statusOnly
            ? 7
            : reply.ignoreStatus
              ? 9
              : 2
          : typeof reply.source === 'string'
            ? 3
            : 4
    const pointer = this.call('krkr_reply_new', kind)
    try {
      this.writeValue(
        this.call('krkr_reply_value', pointer),
        reply.kind === 'value'
          ? reply.value
          : reply.kind === 'invoke'
            ? reply.callback
            : reply.source,
      )
      if (reply.kind === 'invoke') {
        for (const arg of reply.args) this.writeValue(this.call('krkr_reply_arg', pointer), arg)
        if (reply.member !== undefined) {
          if (!reply.member || reply.member.includes('\0'))
            throw new Error('Invalid TJS callback member')
          const member = this.textPointer(reply.member)
          try {
            this.call('krkr_reply_name', pointer, member)
          } finally {
            this.call('free', member)
          }
        }
      }
      if (reply.kind === 'script') {
        this.writeValue(this.call('krkr_reply_context', pointer), reply.context)
        this.call(
          'krkr_reply_script_options',
          pointer,
          Number(reply.expression ?? false),
          reply.lineOffset ?? 0,
        )
        const name = this.textPointer(reply.name)
        try {
          this.call('krkr_reply_name', pointer, name)
        } finally {
          this.call('free', name)
        }
      }
      return pointer
    } catch (error) {
      this.call('krkr_reply_delete', pointer)
      throw error
    }
  }
  private async hostCall(
    vm: number,
    name: number,
    length: number,
    count: number,
    args: number,
  ): Promise<number> {
    const temporary: ScriptObject[] = []
    try {
      if (vm !== this.vm) throw new Error('VM identity mismatch')
      const operation = this.readText(name, length)
      const context: HostContext = {
        retain: (object) => this.retain(object),
        release: (object) => this.release(object),
        snapshot: (object) => this.snapshot(object),
        observeIdentity: (owner) => this.observeIdentity(owner),
        identityAlive: (identity) => this.identityAlive(identity),
        unobserveIdentity: (identity) => this.unobserveIdentity(identity),
      }
      if (operation === 'Storages.selectFileAbort') {
        // Native may need to revoke a selector whose continuation never entered.
        // Only this primitive, exact-id cleanup may precede the ordinary host
        // entry gates. Reading an object here could pin it or invoke conversions.
        const argument = count === 1 ? this.module.HEAPU32[args >>> 2]! : 0
        if (!argument || this.call('krkr_value_type', argument) !== 4)
          throw new Error('Invalid Storages.selectFileAbort identity')
        const identity = BigInt(this.module._krkr_value_integer!(argument))
        if (identity <= 0n || identity > BigInt(Number.MAX_SAFE_INTEGER))
          throw new Error('Invalid Storages.selectFileAbort identity')
        const reply = await this.handler(operation, [identity], context)
        // Keep writes and owner failures for the existing execution boundary;
        // cleanup itself must not initiate I/O or consume either pending error.
        // Paused script still cannot resume, including through catch/finally.
        await this.control.wait()
        this.control.check()
        return this.buildReply(reply)
      }
      this.checkOwnerFailure()
      await this.flush()
      await this.control.wait()
      this.control.check()
      const values = Array.from({ length: count }, (_, i) =>
        this.readValue(this.module.HEAPU32[(args >>> 2) + i]!, temporary),
      )
      const reply =
        operation === 'Runtime.console'
          ? await (this.consoleOutput?.(String(values[0])) ?? { kind: 'value', value: undefined })
          : await this.handler(operation, values, context)
      // An I/O completion must not reenter native script execution while paused.
      await this.control.wait()
      this.control.check()
      return this.buildReply(reply)
    } catch (error) {
      // Errors resume TJS catch/finally blocks too; cancellation releases this wait.
      await this.control.wait()
      const pointer = this.call('krkr_reply_new', 1)
      this.writeValue(
        this.call('krkr_reply_value', pointer),
        error instanceof Error ? error.message : String(error),
      )
      return pointer
    } finally {
      for (const object of temporary) this.release(object)
    }
  }
  private consumeReply(pointer: number): ScriptValue {
    try {
      if (this.call('krkr_reply_kind', pointer) === 1) {
        throw new ScriptError(
          String(this.readValue(this.call('krkr_reply_value', pointer))),
          this.readText(this.call('krkr_reply_source', pointer)),
          this.call('krkr_reply_line', pointer),
          this.readText(this.call('krkr_reply_trace', pointer)),
        )
      }
      return this.readValue(this.call('krkr_reply_value', pointer))
    } finally {
      this.call('krkr_reply_delete', pointer)
    }
  }
  private async run(name: string, args: number[]): Promise<ScriptValue> {
    this.assertAlive()
    if (this.busy)
      throw new Error(
        'Concurrent TJS execution is not allowed; return a host continuation for nested calls',
      )
    this.control.check()
    this.busy = true
    let result: ScriptValue
    try {
      await this.control.wait()
      this.control.check()
      const pointer = await this.module.ccall(
        name,
        'number',
        args.map(() => 'number'),
        args,
        { async: true },
      )
      try {
        result = this.consumeReply(pointer)
      } catch (primary) {
        try {
          await this.flush()
        } catch (write) {
          throw new AggregateError(
            [primary, write],
            primary instanceof Error ? primary.message : String(primary),
            { cause: primary },
          )
        }
        throw primary
      }
      // A successful reply still needs durable writes; its returned handle is
      // released by the outer catch if this flush fails.
      await this.flush()
      this.checkOwnerFailure()
      if (this.control.cancelled) {
        this.control.check()
      }
      return result
    } catch (error) {
      this.ownerFailure = undefined // retain the primary execution/host error
      if (isScriptObject(result)) this.release(result)
      this.control.check()
      throw error
    } finally {
      this.busy = false
    }
  }
  async execute(
    source: string | Uint8Array,
    name = 'script.tjs',
    expression = false,
  ): Promise<ScriptValue> {
    this.assertAlive()
    if (typeof source === 'string' && source.includes('\0'))
      throw new Error('Script source contains NUL')
    if (typeof source !== 'string' && source.length > 64 * 1024 * 1024)
      throw new ScriptError('Binary script exceeds 64 MiB budget', name)
    const input = typeof source === 'string' ? this.textPointer(source) : this.allocate(source)
    const label = this.textPointer(name)
    try {
      return await this.run('krkr_execute', [
        this.vm,
        input,
        source.length,
        label,
        typeof source !== 'string' ? 2 : expression ? 1 : 0,
      ])
    } finally {
      this.call('free', input)
      this.call('free', label)
    }
  }
  async compile(source: string, name = 'script.tjs', expression = false): Promise<Uint8Array> {
    this.assertAlive()
    if (this.busy) throw new Error('Cannot compile while TJS is running')
    if (source.includes('\0')) throw new Error('Script source contains NUL')
    const input = this.textPointer(source)
    const label = this.textPointer(name)
    try {
      const result = await this.run('krkr_compile', [this.vm, input, label, Number(expression)])
      if (!(result instanceof Uint8Array)) throw new Error('Compiler returned invalid bytecode')
      return result
    } finally {
      this.call('free', input)
      this.call('free', label)
    }
  }
  setConsoleOutput(handler: ConsoleHandler | null): void {
    this.assertAlive()
    if (this.busy) throw new Error('Cannot replace console output while TJS is running')
    this.consoleOutput = handler
    this.call('krkr_set_console', this.vm, Number(!!handler))
  }
  async invoke(
    callback: ScriptObject,
    args: ScriptValue[] = [],
    member?: string,
  ): Promise<ScriptValue> {
    this.assertObject(callback)
    const reply = this.buildReply({ kind: 'invoke', callback, args, member })
    try {
      return await this.run('krkr_invoke', [this.vm, callback.id, reply])
    } finally {
      this.call('krkr_reply_delete', reply)
    }
  }
  async collect(): Promise<void> {
    this.assertAlive()
    await this.run('krkr_collect', [this.vm])
  }
  inspect() {
    this.assertAlive(true)
    return {
      handles: this.call('krkr_handle_count', this.vm),
      memoryBytes: this.module.HEAPU8.byteLength,
      backend: this.variant,
      weakOwners: this.call('krkr_owner_count', this.vm),
      objectIdentities: this.call('krkr_identity_count', this.vm),
      scriptObjects: this.call('krkr_native_lifetime_stat', 4),
      pendingHandles: this.call('krkr_pending_handle_count', this.vm),
      drainingReleased: this.call('krkr_release_draining', this.vm) !== 0,
      dependents: this.call('krkr_dependent_count', this.vm),
      pendingInvalidations: this.call('krkr_pending_invalidation_count', this.vm),
    }
  }
  flush(): Promise<void> {
    if (this.flushing) return this.flushing
    this.flushing = (async () => {
      while (this.pendingWrites.length) {
        const write = this.pendingWrites[0]!
        await this.handler(
          typeof write.value === 'string' ? 'Storage.writeText' : 'Storage.writeBinary',
          [write.name, write.mode, write.value],
          this,
        )
        this.pendingWrites.shift()
      }
    })().finally(() => {
      this.flushing = undefined
    })
    return this.flushing
  }
  dispose(): void {
    if (this.disposed || this.disposing) return
    if (this.busy) throw new Error('Cancel and await execution before disposing the VM')
    this.disposing = true
    try {
      this.call('krkr_destroy', this.vm)
    } finally {
      this.owners.clear()
      this.objectIdentities.clear()
      this.consoleOutput = null
      this.vm = 0
      this.disposed = true
      this.disposing = false
    }
    this.checkOwnerFailure()
  }
}
