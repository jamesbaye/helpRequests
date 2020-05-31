/**
 *  Return the appropriate Command subclass instance based on the specified slackCmdString and args parameters.
 * @param {*} slackCmdString
 * @param {*} args
 */
var createCommandClassInstance = function(slackCmdString, args){
  
  var SUBCLASS_FROM_SLACKCMD = globalVariables().SUBCLASS_FROM_SLACKCMD;
  
  if (!SUBCLASS_FROM_SLACKCMD.hasOwnProperty(slackCmdString)){ // if no key is found for slackCmdString, return error
    throw new Error(commandNotSupportedMessage(slackCmdString));
  }
  if (typeof SUBCLASS_FROM_SLACKCMD[slackCmdString] !== 'function'){
    throw new Error(commandNotConnectedMessage(slackCmdString));
  }
  if (typeof args !== 'object' || args === null){
    throw new Error(commandArgumentsAreCorruptedMessage());
  }
  
  return new SUBCLASS_FROM_SLACKCMD[slackCmdString](args);
}


class CommandArgs {
  constructor(args){
    this.uniqueid = args.uniqueid;
    this.channelid = args.channelid;
    this.userid = args.userid;
    this.username = args.username;
    this.mention = args.mention; // object with expected property "str"
    this.more = args.more;
    
    this.response_url = args.response_url;
    this.trigger_id = args.trigger_id;
    
    this.mod_userid = globalVariables()['MOD_USERID'];
    this.mention_mod = globalVariables()['MENTION_REQUESTCOORD'];
  }
  
  parseUniqueID(){
    var regexpToMatch = "^[0-9]{4}$";
    var msg_empty_str = uniqueIDnotProvidedMessage();
    var msg_nomatch_str = uniqueIDsyntaxIsIncorrectMessage(this);
    extractMatchOrThrowError(this.uniqueid, regexpToMatch, msg_empty_str, msg_nomatch_str);
  }
  
  parseMentionString(){
    var regexpToMatch = "<@(U[A-Z0-9]+)\\|?(.*)>";
    var msg_empty_str = userMentionNotProvidedMessage();
    var msg_nomatch_str = userMentionSyntaxIsIncorrectMessage(this);
    var re_match = extractMatchOrThrowError(this.mention.str, regexpToMatch, msg_empty_str, msg_nomatch_str);
    this.mention.userid = re_match[1];
    this.mention.username = re_match[2];
  }
  
  matchUserID(str_to_match){
    return (this.userid === str_to_match);
  }
}


/**
 *  The Command class is a parent class inherited by all the ConcreteCommand subclasses
 */
class Command {
  constructor(args){
    this.args = new CommandArgs(args);
    this.immediateReturnMessage = commandPendingMessage();
  }
  
  parse(){}
  
  getSheetData(){}
  checkCommandValidity(){}
  updateState(){}
  notify(){}
  nextCommand(){
    // Default behaviour is that no further command is executed. 
    // However, some {command,arg} combinations lead to chained commands 
    // example: {DoneCommand,this.requestNextStatus='keepOpenNew'}' triggers CancelCommand.
  }
  
  execute(){
    this.tracking_sheet = new TrackingSheetWrapper();
    this.log_sheet = new LogSheetWrapper(); //do not instantiate these in constructor because they take ~300ms and would compromise immediate response
    this.getSheetData();
    this.checkCommandValidity();
    this.updateState();
    var returnMessage = this.notify();
    this.nextCommand();
    return returnMessage;
  }
}

/**
 *  Handler for a "do nothing" command
 */
class VoidCommand extends Command {
}

/**
 *  Manage a StatusLog command from super user
 */
class StatusLogCommand extends Command {
  notify(){
    // command logger
    var newStatus = this.args.more;
    this.log_sheet.appendRow([new Date(), this.args.uniqueid,'admin','statusManualEdit',newStatus]);
  }
}


/**
 *  Manage a PostRequest command from super user
 */

class PostRequestCommand extends Command {
  
  getSheetData(){
    this.row = this.tracking_sheet.getRowByUniqueID(this.args.uniqueid);
  }
  
  notify(){
    
    // slack channel messenger
    var out_message_notification = postRequestNotificationMessage();
    var out_message = postRequestMessage(this.row);
    var payload =  JSON.stringify({blocks: out_message,
                                   text: out_message_notification,
                                   channel: this.row.channelid,
                                   as_user: true});
    var return_message = postToSlackChannel(payload, "as_user");
    
    // message sending logger
    this.log_sheet.appendRow([new Date(), this.row.uniqueid,'admin','messageChannel',return_message]);
  
    // tracking sheet writer
    var return_params = JSON.parse(return_message);
    this.row.slackVolunteerID = '';
    this.row.slackVolunteerName = '';
    if (return_params.ok === true){ // message was succesfully posted to channel
      this.row.slackTS = return_params.ts;
      this.row.requestStatus = 'Sent';
    } else{
      this.row.slackTS = '';
      this.row.requestStatus = 'FailSend';
    }
    this.tracking_sheet.writeRow(this.row);
    
    // command logger
    this.log_sheet.appendRow([new Date(), this.row.uniqueid,'admin','sheetCommand','postRequest',
                         JSON.stringify({channelid:this.row.channelid,
                                         slackThreadID:this.row.slackTS})
                        ]);
  }
  
}


/**
 *  Manage an assignment command from moderator
 */
class AssignCommand extends Command {
  
  parse(){
    // check userid is a moderator
    var mod_userid = globalVariables()['MOD_USERID'];
    if(!this.args.matchUserID(mod_userid)){
      throw new Error(commandAvailableOnlyToModeratorMessage("assign"));
    }
    
    this.args.parseUniqueID();
    this.args.parseMentionString();
  }
  
  updateState(){
    this.args.userid = this.args.mention.userid;
    this.args.username = this.args.mention.username;
  }
  
  notify(){
    return assignPendingMessage();
  }
  
  nextCommand(){  
    processFunctionAsync('/volunteer', this.args); // todo: clean up string call
  }
}


/**
 *  Manage a volunteering command from user
 */
class VolunteerCommand extends Command {
  
  parse(){
    this.args.parseUniqueID();
  }
  
  getSheetData(){
    this.row = this.tracking_sheet.getRowByUniqueID(this.args.uniqueid);
  }
  
  checkCommandValidity(){
    checkUniqueIDexists(this.row, this.args);
    checkUniqueIDconsistency(this.row, this.args);
    checkChannelIDconsistency(this.row, this.args);
    checkRowIsVolunteerable(this.row, this.args);
  }
  
  updateState(){
    this.row.slackVolunteerID = this.args.userid;
    this.row.slackVolunteerName = this.args.username;
    this.row.requestStatus = "Assigned";
  }
  
  notify(){
    
    // slack channel messenger
    var out_message = volunteerChannelMessage(this.row);
    var payload = JSON.stringify({
      text: out_message,
      thread_ts: this.row.slackTS,
      channel: this.row.channelid,
    });
    var return_message = postToSlackChannel(payload);
    
    // message sending logger
    this.log_sheet.appendRow([new Date(), this.row.uniqueid,'admin','messageChannel',return_message]);
    
    if (JSON.parse(return_message).ok !== true){ // message was not successfully sent
      throw new Error(postToSlackChannelErrorMessage());
    }
    
    // tracking sheet writer
    this.tracking_sheet.writeRow(this.row);
    
    // command logger
    this.log_sheet.appendRow([new Date(), this.args.uniqueid, this.args.userid,'slackCommand','volunteer']);
    
    // user return message printer
    return volunteerSuccessMessage(this.row);
  }
}


/**
 *  Manage a cancel command from user or moderator
 */
class CancelCommand extends Command {
  
  parse(){
    this.args.parseUniqueID();
  }
  
  getSheetData(){
    this.row = this.tracking_sheet.getRowByUniqueID(this.args.uniqueid);
  }
  
  checkCommandValidity(){
    checkUniqueIDexists(this.row, this.args);
    checkUniqueIDconsistency(this.row, this.args);
    checkChannelIDconsistency(this.row, this.args);
    checkRowIsCancellable(this.row, this.args);
  }
  
  updateState(){
    this.slackVolunteerID_old = this.row.slackVolunteerID; // store this for channel messenger in notify()
    this.row.slackVolunteerID = '';
    this.row.slackVolunteerName = '';
    this.row.requestStatus = 'Sent';
  }
  
  notify(){
    
    // slack channel messenger
    var out_message = cancelChannelMessage(this.row,this.slackVolunteerID_old);                                                                                                           
    var payload = JSON.stringify({
    text: out_message,
      thread_ts: this.row.slackTS,
      reply_broadcast: true,
      channel: this.row.channelid});
    var return_message = postToSlackChannel(payload);
    
    // message sending logger
    this.log_sheet.appendRow([new Date(), this.row.uniqueid,'admin','messageChannel',return_message]);
    
    if (JSON.parse(return_message).ok !== true){ // message was not successfully sent
      throw new Error(postToSlackChannelErrorMessage());
    }
    
    // tracking sheet writer
    this.tracking_sheet.writeRow(this.row);
    
    // command logger
    this.log_sheet.appendRow([new Date(), this.args.uniqueid, this.args.userid, 'slackCommand','cancel']);
    
    // user return message printer
    return cancelSuccessMessage(this.row,true);
  }
}

/**
 *  Manage a done modal request from user or moderator
 */
class DoneSendModalCommand extends Command { //todo: make this an async command so that it can pass back row information in modal
  
  parse(){
    this.args.parseUniqueID();
  }
  
  notify(){
    
    // Send post request to Slack views.open API to open a modal for user
    var cmd_metadata = JSON.stringify({
      uniqueid: this.args.uniqueid,
      channelid: this.args.channelid,
      response_url: this.args.response_url
    }); // data passed as metadata in modal, to follow up on command request once modal user submission is received
    var out_message = doneModalMessage(this.args.uniqueid, this.args.userid, cmd_metadata);
    var payload = JSON.stringify({
      trigger_id: this.args.trigger_id,
      view: out_message});
    var return_message = postToSlackModal(payload);
    
    // Message sending logger
    this.log_sheet.appendRow([new Date(), this.args.uniqueid,'admin','messageUserModal',return_message]);
  
    if (JSON.parse(return_message).ok !== true){ // message was not successfully sent
      throw new Error(postToSlackModalErrorMessage(return_message));
    }
    
    // user return message printer
    return doneSendModalSuccessMessage(this.args);
  }
}


/**
 *  Manage a done command from user or moderator
 */
class DoneCommand extends Command {
  constructor(args){
    super(args);
    
    this.immediateReturnMessage = null; // modal requires a blank HTTP 200 OK immediate response to close
    
    // done modal responses
    var modalResponseVals = args.more;
    this.requestNextStatus = modalResponseVals.requestNextStatus.requestNextStatusVal.selected_option.value;
    this.completionLastDetails = modalResponseVals.completionLastDetails.completionLastDetailsVal.value;
    if (!this.completionLastDetails){
      this.completionLastDetails=''; // replace undefined with ''
    }
  }
  
  parse(){
    this.args.parseUniqueID();
  }
  
  getSheetData(){
    this.row = this.tracking_sheet.getRowByUniqueID(this.args.uniqueid);
  }
  
  updateState(){
    if ((this.requestNextStatus === '') || (this.requestNextStatus === 'unsure') || (this.requestNextStatus === 'toClose')){
      this.row.requestStatus = 'ToClose?';
    } else if (this.requestNextStatus === 'keepOpenAssigned'){
      this.row.requestStatus = "Assigned";
    }
    this.row.completionCount = +this.row.completionCount +1;
    this.row.completionLastDetails = this.completionLastDetails;
    this.row.completionLastTimestamp = new Date();
  }
  
  checkCommandValidity(){
    checkUniqueIDexists(this.row, this.args);
    checkUniqueIDconsistency(this.row, this.args);
    checkChannelIDconsistency(this.row, this.args);
    checkRowAcceptsDone(this.row, this.args);
  }
  
  notify(){
    
    // slack channel messenger
    var out_message = doneChannelMessage(this.row);
    var payload = JSON.stringify({
      text: out_message,
      thread_ts: this.row.slackTS,
      channel: this.row.channelid});
    var return_message = postToSlackChannel(payload);
    
    // message sending logger
    this.log_sheet.appendRow([new Date(), this.row.uniqueid,'admin','messageChannel',return_message]);
    
    if (JSON.parse(return_message).ok !== true){ // message was not successfully sent
      throw new Error(postToSlackChannelErrorMessage());
    }
    
    // tracking sheet writer
    this.tracking_sheet.writeRow(this.row);
    
    // command logger
    this.log_sheet.appendRow([new Date(), this.args.uniqueid, this.args.userid,'slackCommand','done', this.row.completionLastDetails]);
    
    // user return message printer
    return doneSuccessMessage(this.row,true);
  }
  
  nextCommand(){
    if (this.requestNextStatus === 'keepOpenNew'){
      processFunctionAsync('/cancel', this.args); //todo:clean up string call
    }
  }
}


/**
 *  Manage a list command from user or moderator
 */
class ListCommand extends Command {
  
  getSheetData(){
    this.rows = this.tracking_sheet.getAllRows();
  }
  
  notify(){
    var message_out_header = listHeaderMessage('list');
    
    var message_out_body = this.rows
    .filter(
      row => isVarInArray(row.requestStatus,['','Sent']) &&
      row.channelid === this.args.channelid
      )
      .map(row => listLineMessage(row))
      .join('');

    var message_out = message_out_header + message_out_body;
    
    return textToJsonBlocks(message_out);
  }
}


/**
 *  Manage a listactive command from user or moderator
 */
class ListActiveCommand extends Command {
  
  getSheetData(){
    this.rows = this.tracking_sheet.getAllRows();
  }
  
  notify(){
    var message_out_header = listHeaderMessage('listactive');
    
    var message_out_body = this.rows
    .filter(
      // non-closed status and correct channel
      row => isVarInArray(row.requestStatus,['','Sent','Assigned','Ongoing']) &&
      row.channelid === this.args.channelid
      )
      .map(row => listLineMessage(row,true,true))
      .join('');

    var message_out = message_out_header + message_out_body;
    
    return textToJsonBlocks(message_out);
  }
}


/**
 *  Manage a listall command from user or moderator
 */
class ListAllCommand extends Command {
  
  getSheetData(){
    this.rows = this.tracking_sheet.getAllRows();
  }
  
  notify(){    
    var message_out_header = listHeaderMessage('listall');
    
    var message_out_body = this.rows
    .filter(
      // correct channel
      row => row.channelid === this.args.channelid
      )
      .map(row => listLineMessage(row,true,true))
      .join('');

    var message_out = message_out_header + message_out_body;
    
    return textToJsonBlocks(message_out);
  }
}


/**
 *  Manage a listmine command from user or moderator
 */
class ListMineCommand extends Command {
  
  getSheetData(){
    this.rows = this.tracking_sheet.getAllRows();
  }
  
  notify(){
    var message_out_header = listHeaderMessage('listmine');
    
    var message_out_body = this.rows
    .filter(
      // non-closed status, belongs to user and correct channel
      row => isVarInArray(row.requestStatus,['Assigned','Ongoing']) &&
      row.slackVolunteerID === this.args.userid &&
      row.channelid === this.args.channelid
      )
      .map(row => listLineMessage(row,false,false))
      .join('');

    var message_out = message_out_header + message_out_body;

    return textToJsonBlocks(message_out);
  }
}


/**
 *  Manage a listallmine command from user or moderator
 */
class ListAllMineCommand extends Command {
  
  getSheetData(){
    this.rows = this.tracking_sheet.getAllRows();
  }
  
  notify(){    
    var message_out_header = listHeaderMessage('listallmine');
    
    var message_out_body = this.rows
    .filter(
      //  belongs to user and correct channel
      row => row.slackVolunteerID === this.args.userid &&
      row.channelid === this.args.channelid
      )
      .map(row => listLineMessage(row,true,false))
      .join('');

    var message_out = message_out_header + message_out_body;
    
    return textToJsonBlocks(message_out);
  }
}