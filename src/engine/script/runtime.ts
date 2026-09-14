export interface ScriptObject {
  readonly type: 'object'
  readonly id: number
  readonly runtime: number
}

export interface ScriptRecord {
  readonly type: 'dictionary'
  readonly entries: Record<string, ScriptValue>
}
export interface ScriptList {
  readonly type: 'array'
  readonly items: ScriptValue[]
}
export interface ScriptProxy {
  readonly type: 'proxy'
  readonly namespace: string
  readonly id: number
  readonly className: string
}
export interface ScriptClass {
  readonly type: 'class'
  readonly namespace: string
  readonly id: number
  readonly className: string
  readonly properties: readonly {
    name: string
    writable: boolean
    static: boolean
    boolean: boolean
  }[]
}
export type ScriptValue =
  | { readonly type: 'native-method'; readonly name: 'getTraceString' }
  | { readonly type: 'native-class'; readonly name: 'Scripts' }
  | undefined
  | null
  | string
  | bigint
  | number
  | Uint8Array
  | ScriptObject
  | ScriptRecord
  | ScriptList
  | ScriptProxy
  | ScriptClass
export const scriptRecord = (entries: Record<string, ScriptValue>): ScriptRecord => ({
  type: 'dictionary',
  entries,
})
export const scriptList = (items: ScriptValue[]): ScriptList => ({ type: 'array', items })
export type HostReply =
  | { kind: 'dump' }
  | { kind: 'value'; value: ScriptValue }
  | { kind: 'invoke'; callback: ScriptObject; args: ScriptValue[]; statusOnly?: boolean }
  | {
      kind: 'script'
      source: string | Uint8Array
      name: string
      context?: ScriptObject
      expression?: boolean
      lineOffset?: number
    }

export interface HostContext {
  retain(object: ScriptObject): ScriptObject
  release(object: ScriptObject): void
  /** Explicit, bounded copy of native Array/Dictionary data, without invoking properties.
   * Arbitrary script objects and cyclic data are rejected; normal values retain identity. */
  snapshot(object: ScriptObject): ScriptRecord | ScriptList
}

export type HostHandler = (
  operation: string,
  args: ScriptValue[],
  context: HostContext,
) => HostReply | Promise<HostReply>
export type ConsoleHandler = (text: string) => HostReply | Promise<HostReply>

export interface ScriptRuntime extends HostContext {
  /** Exact function/object plus bound context identity, stable while retained. */
  objectIdentity(object: ScriptObject): string
  execute(source: string | Uint8Array, name?: string, expression?: boolean): Promise<ScriptValue>
  compile(source: string, name?: string, expression?: boolean): Promise<Uint8Array>
  setConsoleOutput(handler: ConsoleHandler | null): void
  invoke(callback: ScriptObject, args?: ScriptValue[]): Promise<ScriptValue>
  inspect(): { handles: number; memoryBytes: number; backend: string }
  flush(): Promise<void>
  dispose(): void
}

export class ScriptError extends Error {
  override readonly name = 'ScriptError'
  constructor(
    message: string,
    readonly source = '',
    readonly line = 0,
    readonly trace = '',
  ) {
    super(message)
  }
}

export function isScriptObject(value: ScriptValue): value is ScriptObject {
  return (
    typeof value === 'object' &&
    value !== null &&
    !(value instanceof Uint8Array) &&
    value.type === 'object'
  )
}
