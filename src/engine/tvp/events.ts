export const eventClasses = String.raw`
class Timer {
  var __eventId, __action, __actionName;
  function Timer(action, actionName="action") {
    __action = action; __actionName = actionName;
    __eventId = __host("Events.create", "timer", function() { this.onTimer(); } incontextof this);
  }
  function onTimer() { if(__actionName == "") return __action(); return __action[__actionName](); }
  function finalize() { __host("Events.destroy", __eventId); }
  ${['interval', 'enabled', 'capacity', 'mode']
    .map(
      (property) => `property ${property} {
    getter() { return __host("Events.get", __eventId, "${property}"); }
    setter(value) { __host("Events.set", __eventId, "${property}", value); }
  }`,
    )
    .join('\n')}
}
class AsyncTrigger {
  var __eventId, __action, __actionName;
  function AsyncTrigger(action, actionName="action") {
    __action = action; __actionName = actionName;
    __eventId = __host("Events.create", "trigger", function() { this.onFire(); } incontextof this);
  }
  function onFire() { if(__actionName == "") return __action(); return __action[__actionName](); }
  function trigger() { __host("Events.trigger", __eventId); }
  function cancel() { __host("Events.cancel", __eventId); }
  function finalize() { __host("Events.destroy", __eventId); }
  ${['cached', 'mode']
    .map(
      (property) => `property ${property} {
    getter() { return __host("Events.get", __eventId, "${property}"); }
    setter(value) { __host("Events.set", __eventId, "${property}", value); }
  }`,
    )
    .join('\n')}
}
`
