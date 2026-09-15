export const transitionBridge = String.raw`
function __krkrTransitionState(state,mode,destination=void,source=void){
  if(mode==0){
    // Native transitions hold canonical Layer owners, not a supplied bound context.
    state.destination=destination;state.source=source;return;
  }
  if(mode==1)return state.callback;
  if(mode==2 && destination){
    var dest=state.destination;state.destination=void;
    var src=state.source;state.source=void;
    try{
      // Input invokes this unbound helper from a step Dictionary. Its receiver
      // is not the global object, so the global class must be named explicitly.
      if(!global.System.eventDisabled && (isvalid dest) && (isvalid src))
        dest.onTransitionCompleted(dest,src);
    }catch(error){
      src=void;dest=void;
      state.callback=void;
      throw error;
    }
    // Native event parameter storage dies before the retained tick closure.
    src=void;dest=void;
  }else{
    state.destination=void;state.source=void;
  }
  state.callback=void;
}
__host("Transition.bind",__krkrTransitionState incontextof null);
delete global.__krkrTransitionState;
`
