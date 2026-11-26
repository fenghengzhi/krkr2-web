// The same TJS reads the stock SDK and the browser runtime. No decoder or
// graphics driver is needed to observe a VideoOverlay with its graph closed.
export const closedVideoColorCases = ['brightness', 'contrast', 'hue', 'saturation'].map((name) => ({
  id: 'closed-video-' + name, name, expected: 'Real,-1|Real,-1|Real,-1|Real,-1|Real,-1|readonly|conversion',
}))
export const closedVideoColorSource = `
function observeClosedVideoControl(movie,name){
 movie[name]=0.5;
 var fields=["","RangeMin","RangeMax","DefaultValue","StepSize"],out=[];
 for(var i=0;i<fields.count;i++){
  var value=movie[name+fields[i]];out.add((typeof value)+","+int(value));
 }
 try{movie[name+"RangeMin"]=1;out.add("writable");}catch(e){out.add("readonly");}
 try{movie[name]=%[];out.add("accepted");}catch(e){out.add("conversion");}
 return out.join("|");
}`
