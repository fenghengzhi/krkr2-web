export const inputBridge = String.raw`
function __krkrInputPump(token){
  try{
    while(true){
      var step=__host("Input.resume",token);
      if(step.done)return step.value;
      if(!System.eventDisabled){
        if(isvalid step.target)step.target[step.method](step.args*);
      }
    }
  }catch(error){__host("Input.abort",token);throw error;}
}
__host("Input.bind",__krkrInputPump);
`
