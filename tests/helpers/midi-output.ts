/** Actual TJS octets: these calls are shared by the VM and real Worker tests.
 * No JavaScript parser is used to manufacture their expected output. */
export const midiOutputSource = String.raw`
System.exitOnNoWindowStartup=false;
var midiOutputBuffer=new MIDISoundBuffer(null);
var midiExtraEvaluated=0;
function midiOutputBasics() {
  MIDISoundBuffer.midiOut(<% c0 05 d0 20 f1 18 19 f2 01 02 f3 03 f6 f8 f7 ff 01 %>);
  midiOutputBuffer.midiOut(<% b0 07 7f 0a 40 %>);
  MIDISoundBuffer.midiOut(void);
  MIDISoundBuffer.midiOut(<% %>);
  MIDISoundBuffer.midiOut(<% b0 0b 7f %>, ++midiExtraEvaluated);
  return "ready";
}
function midiOutputMissing() {
  try { MIDISoundBuffer.midiOut(); } catch(error) { return error.message; }
  return "unexpected-success";
}
function midiOutputWrongType(value) {
  try { MIDISoundBuffer.midiOut(value); } catch(error) { return error.message; }
  return "unexpected-success";
}
function midiOutputPartial() {
  try { MIDISoundBuffer.midiOut(<% 90 45 64 80 45 %>); }
  catch(error) { return error.message; }
  return "unexpected-success";
}
function midiOutputMalformedRunning() {
  try { MIDISoundBuffer.midiOut(<% 45 64 %>); }
  catch(error) { return error.message; }
  return "unexpected-success";
}
function midiOutputSilence() {
  MIDISoundBuffer.midiOut(<% b0 78 00 %>);
  return "silent";
}
function midiOutputDelayPair() {
  MIDISoundBuffer.midiOut(<% b0 07 7f %>);
  MIDISoundBuffer.midiOut(<% ff 00 %>);
  MIDISoundBuffer.midiOut(<% 90 45 64 %>);
  return "delivered";
}
`
