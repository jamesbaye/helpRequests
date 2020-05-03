function done(uniqueid, channelid, userid){
  ///// COMMAND: /CANCEL
    
  
  /// define variables
  var globvar = globalVariables();
  var mod_userid = globvar['MOD_USERID'];
  var mention_requestCoord = globvar['MENTION_REQUESTCOORD'];
  
  var log_sheetname = globvar['LOG_SHEETNAME'];
  var tracking_sheetname = globvar['TRACKING_SHEETNAME'];
  
  var webhook_chatPostMessage = globvar['WEBHOOK_CHATPOSTMESSAGE'];
  var access_token = PropertiesService.getScriptProperties().getProperty('ACCESS_TOKEN'); // confidential Slack API authentication token
  
  var tracking_sheet_col_order = globvar['SHEET_COL_ORDER'];
  var tracking_sheet_ncol = tracking_sheet_col_order.length;
  var tracking_sheet_col_index = indexedObjectFromArray(tracking_sheet_col_order); // make associative object to easily get colindex from colname  
  
  var UNIQUEID_START_VAL = globvar['UNIQUEID_START_VAL'];
  var UNIQUEID_START_ROWINDEX = globvar['UNIQUEID_START_ROWINDEX'];
  
  var colindex_uniqueid = tracking_sheet_col_index['uniqueid'];
  var colindex_channelid = tracking_sheet_col_index['channelid']; 
  var colindex_phone = tracking_sheet_col_index['requesterContact'];
  var colindex_status = tracking_sheet_col_index['requestStatus']; 
  var colindex_volunteerName = tracking_sheet_col_index['slackVolunteerName']; 
  var colindex_volunteerID = tracking_sheet_col_index['slackVolunteerID']; 
  var colindex_slackts = tracking_sheet_col_index['slackTS']; 
  var colindex_slacktsurl = tracking_sheet_col_index['slackURL'];
  var colindex_channel = tracking_sheet_col_index['channel']; 
  var colindex_requestername = tracking_sheet_col_index['requesterName'];
  var colindex_address = tracking_sheet_col_index['requesterAddr'];
  
  
  // check that request uniqueid has been specified
  if (uniqueid == ''){
    return ContentService.createTextOutput('error: You must provide the request number present in the help request message (example: `/done 9999`). '+
                                           'You appear to have not typed any number. If the issue persists, contact ' + mention_requestCoord + '.');
  }
  
  // check that uniqueid does indeed match a 4-digit string
  if (!checkUniqueID(uniqueid)){
    return ContentService.createTextOutput('error: The request number `'+uniqueid+'` does not appear to be a 4-digit number as expected. '+
                                           'Please specify a correct request number. Example: `/volunteer 1000`.');
  }
  
  
  // load sheet
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = spreadsheet.getSheetByName(tracking_sheetname);
  
  // find requested row in sheet  
  var row = getRowByUniqueID(uniqueid, UNIQUEID_START_VAL, UNIQUEID_START_ROWINDEX);
  var rowvalues = sheet.getRange(row, 1, 1, tracking_sheet_ncol).getValues()[0];
  if (rowvalues[colindex_uniqueid] != uniqueid){
    if (rowvalues[colindex_uniqueid] == ''){ // uniqueid points to empty row --> suggests wrong number was entered
      return ContentService.createTextOutput('error: I couldn\'t find the request number `' + uniqueid + '`. Did you type the right number? '+
                                             'Type `/listmine` to list the requests you are currently volunteering for in this channel. If the issue persists, contact ' + mention_requestCoord + '.');
  } else { // uniqueid points to non-empty row but mismatch --> this is a spreadsheet issue. suggests rows are not sorted by uniqueid.
    return ContentService.createTextOutput(row +' '+ rowvalues[colindex_uniqueid-1] + ' error: Request number lookup failed on server end. Please notify ' + mention_requestCoord);
    }
  }
  
  // store fields as separate variables
  var channelid_true = rowvalues[colindex_channelid]; 
  var requesterName = rowvalues[colindex_requestername];
  var address = rowvalues[colindex_address];
  var slackurl = rowvalues[colindex_slacktsurl];
  var status = rowvalues[colindex_status]; 
  var volunteerID = rowvalues[colindex_volunteerID];
  var slack_ts = rowvalues[colindex_slackts];
  
  
  // check that request belongs to the channel from which /done message was sent
  if (channelid != channelid_true) {
    return ContentService.createTextOutput('error: The request ' + uniqueid + ' does not appear to belong to the channel you are writing from. '+
                                           'Type `/listmine` to list the requests you are currently volunteering for in this channel.  If the issue persists, contact ' + mention_requestCoord + '.');
  }
  
  // check that request belongs to user and is still ongoing
  if (volunteerID == '') {
    return ContentService.createTextOutput('error: You cannot complete <' + slackurl + '|request ' + uniqueid + '> (' + requesterName + ', ' + address + ') because it is yet to be assigned. '+
                                           'Type `/listmine` to list the requests you are currently volunteering for in this channel. If you think there is a mistake, contact ' + mention_requestCoord + '.');
  } else if (volunteerID != '' && volunteerID != userid && userid!=mod_userid) {
    return ContentService.createTextOutput('error: You cannot complete <' + slackurl + '|request ' + uniqueid + '> (' + requesterName + ', ' + address + ') because it is taken by someone else (<@' + volunteerID + '>). '+
                                           'Type `/listmine` to list the requests you are currently volunteering for in this channel. If you think there is a mistake, contact ' + mention_requestCoord + '.');
  } else if ((volunteerID == userid || userid==mod_userid) && (status != "Assigned" && status != "Ongoing")){
    return ContentService.createTextOutput('<' + slackurl + '|Request ' + uniqueid + '> (' + requesterName + ', ' + address + '), is already marked as closed. '+
                                           'Type `/listmine` to list the requests you are currently volunteering for in this channel. If you think there is a mistake, contact ' + mention_requestCoord + '.');
  }
    
    
  // reply to slack thread to confirm volunteer sign-up (chat.postMessage method)
  var out_message = 'The help request is now closed. Thanks <@' + volunteerID + '>! :nerd_face:';
  var options = {
    method: "post",
    contentType: 'application/json; charset=utf-8',
    headers: {Authorization: 'Bearer ' + access_token},
    payload: JSON.stringify({text: out_message,
                             thread_ts: slack_ts,
                             channel: channelid})
  };
  // Send post request to Slack chat.postMessage API   
  var return_message = UrlFetchApp.fetch(webhook_chatPostMessage, options);
  
  // if post request was unsuccesful, do not update tracking sheet and return error
  var return_params = JSON.parse(return_message.getContentText());
  if (return_params.ok !== true){ // message was not successfully posted to channel
    // update log sheet
    var sheet_log = spreadsheet.getSheetByName(log_sheetname);
    var row_log = sheet_log.getLastRow();
    sheet_log.getRange(row_log+1,1,1,5).setValues([[new Date(), uniqueid,'admin','confirmDone',return_message]]);
    
    // return error to user
    return ContentService.createTextOutput('error: Due to a technical incident, I was unable to process your command. Can you please ask ' + mention_requestCoord + ' to close the request manually?');
  }
  
  // set status to "Closed"
  sheet.getRange(row, colindex_status+1).setValue('Closed');
  
  // update log sheet
  var sheet_log = spreadsheet.getSheetByName(log_sheetname);
  var row_log = sheet_log.getLastRow();
  sheet_log.getRange(row_log+1,1,2,5).setValues([[new Date(), uniqueid,userid,'slackCommand','done'],
                                                [new Date(), uniqueid,'admin','confirmDone',return_message]]);
  
  return ContentService.createTextOutput('You have confirmed completing <' + slackurl + '|request ' + uniqueid + '> (' + requesterName + ', ' + address + '). '+
                                         'I\'ve notified the channel in the help request thread. If you wish to make this help request active again, contact ' + mention_requestCoord + '.');
  
}