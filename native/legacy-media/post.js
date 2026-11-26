// One process invocation per dedicated Worker. EXITSTATUS is Emscripten's
// actual C exit status, including exit() paths caught internally by callMain.
Module['runLegacy'] = function(args) {
  var result = callMain(args);
  return typeof result === 'number' ? result : EXITSTATUS;
};
