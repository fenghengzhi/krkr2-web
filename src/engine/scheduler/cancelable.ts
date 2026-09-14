import { ExecutionCancelled, type ExecutionControl } from './control.ts'

/** Detach settled cancellation listeners instead of retaining completed results. */
export function cancelable<T>(work: Promise<T>, control: ExecutionControl): Promise<T> {
  return new Promise((resolve, reject) => {
    let pending = true,
      off = () => {}
    const take = () => {
      if (!pending) return false
      pending = false
      off()
      return true
    }
    off = control.onCancel(() => {
      if (take()) reject(new ExecutionCancelled())
    })
    void work.then(
      (value) => {
        if (take()) resolve(value)
      },
      (error) => {
        if (take()) reject(error)
      },
    )
  })
}
