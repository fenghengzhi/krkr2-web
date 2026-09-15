/** Each nested invocation returns before its caller resumes; no second VM entry. */
export const modalBridge = String.raw`
function __krkrModalPump(token) {
  var result;
  try {
    while(__host("Modal.wait",token)) __host("Modal.dispatch",token);
    result=__host("Modal.result",token);
  } catch(error) {
    try { __host("Modal.end",token); } catch(cleanupError) {}
    throw error;
  }
  __host("Modal.end",token);
  return result;
}
__host("Modal.bind",__krkrModalPump);
delete global.__krkrModalPump;
`
