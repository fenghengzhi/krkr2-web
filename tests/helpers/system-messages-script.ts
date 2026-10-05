/** These functions enter the actual native message mapper; no host log or
 * exception replacement stands in for the compiler/runtime's own messages. */
export const systemMessagesSource = String.raw`
class MessageObject {}
function missingMessage(){var object=new global.MessageObject();try{return object.missing;}catch(error){return error.message;}}
function translatedMessage(){
 var accepted=System.assignMessage("TJSMemberNotFound","找不到『%1』 雪 😀");
 return accepted+"|"+missingMessage();
}
function messageValues(){
 var absent=[System.assignMessage("NoRegisteredMessage","unused"),
  System.assignMessage("tjsmembernotfound","unused"),System.assignMessage(void,"unused"),
  System.assignMessage(42,17)].join(",");
 var template="Copied %1";System.assignMessage("TJSMemberNotFound",template);template="changed";
 var copied=missingMessage();
 System.assignMessage("TJSMemberNotFound",void);var empty=missingMessage();
 System.assignMessage("TJSMemberNotFound",9007199254740993);var integer=missingMessage();
 var hooks=0,object=%[toString:function(){hooks++;throw "unexpected hook";}],expected=string(object);
 System.assignMessage("TJSMemberNotFound",object);
 return absent+"|"+copied+"|"+empty.length+"|"+integer+"|"+hooks+"|"+int(missingMessage()==expected);
}
function messageCalls(){
 var rejected=0,extra=0;
 try{System.assignMessage();}catch(error){rejected++;}
 try{System.assignMessage("TJSMemberNotFound");}catch(error){rejected++;}
 System.assignMessage("TJSMemberNotFound","kept %1");
 try{System.assignMessage("TJSMemberNotFound",<% 01 %>);}catch(error){rejected++;}
 try{System.assignMessage("NoRegisteredMessage",<% 01 %>);}catch(error){rejected++;}
 try{System.assignMessage(<% 02 %>,"ignored");}catch(error){rejected++;}
 var kept=missingMessage();
 // The expression result is deliberately discarded, but assignment must run.
 System.assignMessage("TJSMemberNotFound","discarded %1",++extra,<% 03 %>);
 var discarded=missingMessage(),call=System.assignMessage;
 var bound=(call incontextof %[receiver:"other"])("TJSMemberNotFound","bound %1");
 return [rejected,kept,discarded,extra,bound,missingMessage(),
  int(System.assignMessage instanceof "Function")].join("|");
}
function compilerMessages(){
 var accepted=System.assignMessage("TJSSubstitutionInBooleanContext","translated assignment warning");
 Scripts.compileStorage("warning.tjs","savedata/warning.cjs",false,true,false);
 accepted+=System.assignMessage("TJSSyntaxError","translated parser: %1");
 var errorMessage="";try{Scripts.exec("var = ;","bad-message-script.tjs");}catch(error){errorMessage=error.message;}
 return accepted+"|"+int(errorMessage.indexOf("translated parser:")==0);
}
`
