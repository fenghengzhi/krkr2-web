/** Application focus is distinct from Window focus and page-control ownership. */
export interface ApplicationActivation { readonly sequence: number; readonly active: boolean }
export const initialApplicationActivation = (): ApplicationActivation => ({ sequence: 0, active: true })
export function validateApplicationActivation(value: ApplicationActivation): void {
  if (!value || !Number.isSafeInteger(value.sequence) || value.sequence < 0 || typeof value.active !== 'boolean')
    throw new Error('Invalid application activation')
}
