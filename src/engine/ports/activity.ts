export type PageActivity = 'visible' | 'hidden' | 'frozen' | 'away'
export interface ActivityState {
  sequence: number
  state: PageActivity
  pauseWhenHidden: boolean
}
export const initialActivity = (): ActivityState => ({
  sequence: 0,
  state: 'visible',
  pauseWhenHidden: true,
})
export const activityPaused = (activity: ActivityState): boolean =>
  activity.state === 'frozen' ||
  activity.state === 'away' ||
  (activity.state === 'hidden' && activity.pauseWhenHidden)
export function validateActivity(activity: ActivityState): void {
  if (
    !Number.isSafeInteger(activity.sequence) ||
    activity.sequence < 0 ||
    !['visible', 'hidden', 'frozen', 'away'].includes(activity.state) ||
    typeof activity.pauseWhenHidden !== 'boolean'
  )
    throw new Error('Invalid page activity state')
}
