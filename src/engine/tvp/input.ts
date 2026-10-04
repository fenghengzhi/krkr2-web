export const inputBridge = String.raw`
function __krkrInputClearStep(step){
  var failure=void;
  try{if(!step.ownership)step.args=void;}catch(error){failure=error;}
  try{step.target=void;}catch(error){if(failure===void)failure=error;}
  if(failure!==void)throw failure;
}
function __krkrInputApplyStep(step,ownership){
  if(step.ownership){
    if(step.sourceKey!==void){
      var source=ownership[step.sourceKey];
      if(source===void)throw new global.Exception("Input ownership source has ended");
      ownership[step.key]=source;
    }
    else if(step.target===null)delete ownership[step.key];
    else ownership[step.key]=step.target;
    return step.acquire ? (step.target!==null ? 1 : 0) : void;
  }
  if(step.direct){step.target(step.args*);return;}
  if(!System.eventDisabled){
    if(isvalid step.target)step.target[step.method](step.args*);
  }
}
function __krkrInputUnwind(token,ownership){
  // A cleanup callback can throw too. Keep advancing the generator so its
  // remaining ownership/finally steps run, then preserve the original error.
  for(var guard=0;guard<4096;guard++){
    var step=void;
    try{
      step=__host("Input.unwind",token);
      if(step.done)return;
      __krkrInputApplyStep(step,ownership);
    }catch(cleanupError){}
    if(step!==void){try{__krkrInputClearStep(step);}catch(cleanupError){}}
    step=void;
  }
}
function __krkrInputPump(token,ownership){
  var step=void,acknowledgement=void;
  try{
    while(true){
      step=__host("Input.resume",token,acknowledgement);
      acknowledgement=void;
      if(step.done)return step.value;
      acknowledgement=__krkrInputApplyStep(step,ownership);
      // Native immediate-event temporaries end before the manager resumes.
      // In particular, do not keep the previous target alive across __host.
      __krkrInputClearStep(step);
      step=void;
    }
  }catch(error){
    if(step!==void){try{__krkrInputClearStep(step);}catch(cleanupError){}}
    step=void;
    __krkrInputUnwind(token,ownership);
    throw error;
  }
}
__host("Input.bind",__krkrInputPump,%[]);
`
