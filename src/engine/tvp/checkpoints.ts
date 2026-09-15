/** Every callback below is entered through a native HostReply continuation.
 * A host Promise settling is never treated as a completed native release. */
export const checkpointBridge = String.raw`
function __krkrCheckpointCommit(id) {
  return __host("Checkpoint.commit",id);
}
function __krkrCheckpointPublish(id) {
  if(__host("Checkpoint.publish",id))__host("Checkpoint.fence",id,2);
}
function __krkrCheckpointPump(id) {
  try {
    if(!__host("Checkpoint.enter",id))return;
    __host("Checkpoint.ownership",id);
    __host("Checkpoint.paint",id);
    __host("Checkpoint.afterPaint",id);
    __host("Checkpoint.ownership",id);
    __host("Checkpoint.cleanup",id);
    __host("Checkpoint.fence",id,1);
  } catch(error) {
    var message="Native checkpoint failed";
    try{message=typeof error=="Object" && error!==null && error.message!==void ? string(error.message) : string(error);}catch(ignored){}
    __host("Checkpoint.abort",id,message);
    throw error;
  }
}
__host("Checkpoint.bind",__krkrCheckpointPump,__krkrCheckpointPublish,__krkrCheckpointCommit);
delete global.__krkrCheckpointPump;
delete global.__krkrCheckpointPublish;
delete global.__krkrCheckpointCommit;
`
