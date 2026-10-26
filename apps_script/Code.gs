/* Entry points for a NEW test Apps Script project first. No triggers installed
 * by this file. LIVE_EMAIL is false unless explicitly configured at cutover.
 */
function clinicalConfig_() {
  const p=PropertiesService.getScriptProperties().getProperties();
  if(!['TEST','PRODUCTION'].includes(p.RUN_MODE)) throw Error('Set RUN_MODE explicitly');
  if(!p.SPREADSHEET_ID||!p.PRODUCTION_SPREADSHEET_ID) throw Error('Set explicit SPREADSHEET_ID and PRODUCTION_SPREADSHEET_ID');
  if(p.RUN_MODE==='TEST'&&p.SPREADSHEET_ID===p.PRODUCTION_SPREADSHEET_ID) throw Error('Test jobs cannot use the production workbook');
  if(p.RUN_MODE==='PRODUCTION'&&p.PRODUCTION_CUTOVER_APPROVED!=='true') throw Error('Production cutover is not approved/configured');
  if(p.RUN_MODE==='TEST'&&p.LIVE_EMAIL==='true') throw Error('Real email is forbidden in TEST mode');
  if(!p.PARSER_URL||!p.PARSER_API_TOKEN||!p.ARCHIVE_FOLDER_ID||!Number.isFinite(Date.parse(p.NOTIFICATIONS_FROM))) throw Error('Set parser URL/token, archive folder ID, and an explicit NOTIFICATIONS_FROM cutover timestamp');
  if(!/^https:\/\//.test(p.PARSER_URL)) throw Error('Parser URL must use HTTPS');
  if(p.RUN_MODE==='TEST'&&p.PARSER_URL==='https://clinical-calander.onrender.com/parse-calendar') throw Error('Test jobs require a separate parser service');
  const to=(p.NOTIFICATION_TO||'').split(',').map(v=>v.trim()).filter(Boolean);
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.OWNER_EMAIL||'')||!to.length||to.some(v=>! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))) throw Error('Set verified OWNER_EMAIL and comma-separated NOTIFICATION_TO');
  return {sheet:p.SPREADSHEET_ID,url:p.PARSER_URL,token:p.PARSER_API_TOKEN,folder:p.ARCHIVE_FOLDER_ID,
    liveEmail:p.LIVE_EMAIL==='true',activationAt:Date.parse(p.NOTIFICATIONS_FROM),gmailQuery:'label:platinum-planner newer_than:180d',timezone:'America/New_York',owner:p.OWNER_EMAIL,
    to:to,
    expectedSites:['Brewster Ambulance Service Lee County','Brewster Ambulance Service Collier']};
}
function clinicalHash_(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,value).map(b=>('0'+((b+256)%256).toString(16)).slice(-2)).join('');
}
function clinicalSession_(fn) {
  const config=clinicalConfig_(),lock=LockService.getScriptLock();
  if(!lock.tryLock(5000)) {Logger.log('Another clinical job holds the lock; next scheduled execution will retry.');return;}
  try {
    const ss=SpreadsheetApp.openById(config.sheet);
    if(ss.getSpreadsheetTimeZone()!=='America/New_York'||Session.getScriptTimeZone()!=='America/New_York') throw Error('Workbook and script must use America/New_York');
    const store=new ClinicalLedger(ss,clinicalHash_),state=store.load();
    const deadline=Date.now()+240000;
    const env=Object.assign({},config,{now:Date.now(),hash:clinicalHash_,reviewLink:id=>store.reviewLink(id),shouldStop:()=>Date.now()>deadline,
      dayKey:now=>Utilities.formatDate(new Date(now),'America/New_York','yyyy-MM-dd')});
    try {fn(state,env,store,ss);}
    finally {store.save(state);store.project(state);}
  } catch(error) {clinicalFallbackAlert_(config,error);throw error;}
  finally {lock.releaseLock();}
}
function clinicalFallbackAlert_(config,error) {
  // Separate small failure ledger when the Sheets ledger itself is unavailable.
  // No student email can be sent through this path. Ambiguous sends stay held.
  const reason=String(error).slice(0,1800),id=clinicalHash_(reason),key='RR_FATAL_'+id;
  const properties=PropertiesService.getScriptProperties();
  let entry;
  try {entry=JSON.parse(properties.getProperty(key)||'null');}catch(_e){entry=null;}
  if(entry&&['API_ACCEPTED','UNCERTAIN','PREPARING','SENDING'].includes(entry.status)) return;
  entry={id,category:'LEDGER_OR_DISPATCH_FAILURE',reason,status:config.liveEmail?'PREPARING':'DRY_RUN',at:new Date().toISOString()};
  properties.setProperty(key,JSON.stringify(entry));
  if(!config.liveEmail) return;
  try {
    const subject='Clinical scheduling ledger failure [RR-FATAL:'+id+']';
    const body='Category: '+entry.category+'\nStudent/PDF: scheduler ledger\nAffected date: '+entry.at+'\nReason: '+reason+
      '\nAffected workbook: https://docs.google.com/spreadsheets/d/'+config.sheet+'/edit\nFailure record: Script Properties '+key+
      '\nResolve: Inspect the RR_V2_Head pointer and committed chunks. Restore a verified snapshot; inspect Sent mail before retrying any uncertain notification. Then review the trigger execution failure.';
    const draft=GmailApp.createDraft(config.owner,subject,body);
    entry.draft_id=draft.getId();entry.status='SENDING';properties.setProperty(key,JSON.stringify(entry));
    entry.message_id=draft.send().getId();entry.status='API_ACCEPTED';properties.setProperty(key,JSON.stringify(entry));
  }catch(sendError){entry.status='UNCERTAIN';entry.send_error=String(sendError).slice(0,500);properties.setProperty(key,JSON.stringify(entry));}
}
function clinicalRoster_(ss,state,env) {
  const rows=[];
  for(const tab of ['Students','Archive']) {
    const sheet=ss.getSheetByName(tab);if(!sheet) throw Error('Missing roster tab '+tab);
    const values=sheet.getDataRange().getValues(),headers=values[0].map(String);
    const idx={};for(const name of ['First Name','Last Name','Email','Cohort/Class #']) {
      const matches=headers.map((h,i)=>h.trim()===name?i:-1).filter(i=>i>=0);
      if(matches.length!==1) throw Error('Expected one explicit header '+name+' in '+tab);idx[name]=matches[0];
    }
    const idCol=headers.indexOf('Student ID');
    values.slice(1).forEach((r,i)=>{
      if(r.every(v=>v==='')) return;
      rows.push({first_name:String(r[idx['First Name']]||'').trim(),last_name:String(r[idx['Last Name']]||'').trim(),email:String(r[idx.Email]||'').trim(),
        cohort:String(r[idx['Cohort/Class #']]||''),student_id:idCol>=0?String(r[idCol]||'').trim():'',source_tab:tab,source_row:i+2,status:tab==='Archive'?'ARCHIVED':'ACTIVE'});
    });
  }
  const roster=ClinicalEngine.buildRoster(rows,state.students,env);
  roster.issues.forEach(issue=>ClinicalEngine.review(state,env,issue));
  return roster;
}
function ingestClinicalCalendars() {
  clinicalSession_((state,env,store,ss)=>{
    const started=Date.now(),run={id:Utilities.getUuid(),type:'INGEST',started_at:new Date().toISOString(),status:'RUNNING'};
    state.runs.push(run);store.save(state);
    try {
      const roster=clinicalRoster_(ss,state,env);
      let offset=state.gmail_offset||0,finished=false;
      while(Date.now()-started<220000) {
        const threads=GmailApp.search(env.gmailQuery,offset,20);
        if(!threads.length) {finished=true;break;}
        // Complete a thread page before advancing the checkpoint. Replay is safe.
        for(const thread of threads) for(const message of thread.getMessages()) {
          if(!/Calendar.*Brewster/i.test(message.getSubject())||!String(message.getFrom()).includes('donotreply@platinumed.com')) continue;
          const attachments=message.getAttachments({includeInlineImages:false});let calendars=0;
          for(let index=0;index<attachments.length;index++) {
            const attachment=attachments[index],name=attachment.getName();
            if(!/^Calendar-RickyRescue-Brewster.*\.pdf$/i.test(name)) continue;
            calendars++;
            const sha=clinicalHash_(attachment.getBytes());
            const source={message_id:message.getId(),attachment_id:index+':'+name,sha256:sha,filename:name,received_at:message.getDate().toISOString()};
            const id=clinicalHash_(JSON.stringify([source.message_id,source.attachment_id,sha]));
            if(state.sources.some(s=>s.id===id&&s.status==='APPLIED')) continue;
            try {
              const response=UrlFetchApp.fetch(env.url,{method:'post',payload:{file:attachment.copyBlob()},headers:{Authorization:'Bearer '+env.token},muteHttpExceptions:true});
              let parsed;
              try {parsed=JSON.parse(response.getContentText());} catch(_e) {throw Error('Parser returned invalid JSON (HTTP '+response.getResponseCode()+')');}
              if(![200,422].includes(response.getResponseCode())) throw Error('Parser HTTP '+response.getResponseCode());
              if(!parsed.source_sha256||!Array.isArray(parsed.coverage)) throw Error('Parser rejected PDF: '+JSON.stringify(parsed.errors||[]));
              const folder=DriveApp.getFolderById(env.folder),archiveName=sha+'-'+name;
              const existing=folder.getFilesByName(archiveName);
              source.archive_file_id=existing.hasNext()?existing.next().getId():folder.createFile(attachment.copyBlob().setName(archiveName)).getId();
              ClinicalEngine.ingest(state,env,source,parsed,roster);store.save(state);
            } catch(error) {
              if(!state.sources.some(s=>s.id===id)) state.sources.push(Object.assign({},source,{id,status:'FAILED',complete:false,coverage:[]}));
              ClinicalEngine.review(state,env,{category:'PARSER_FAILURE',source_id:id,reason:String(error),instructions:'Inspect this email attachment and parser service. Fix the failure, then rerun ingestion; prior verified shifts are preserved.'});store.save(state);
            }
          }
          if(!calendars) ClinicalEngine.review(state,env,{category:'MISSING_ATTACHMENT',source_id:message.getId(),reason:'Calendar email has no recognized Brewster PDF attachment'});
        }
        offset+=threads.length;state.gmail_offset=offset;store.save(state);
        if(threads.length<20) {finished=true;break;}
      }
      if(finished) state.gmail_offset=0;
      run.status=finished?'COMPLETED':'CONTINUATION';run.ended_at=new Date().toISOString();
    } catch(e) {run.status='FAILED';run.ended_at=new Date().toISOString();ClinicalEngine.review(state,env,{category:'INGEST_FAILURE',source_id:run.id,reason:String(e)});}
  });
}
function clinicalTransport_() {
  return {
    prepare(mail) {return GmailApp.createDraft(mail.to.join(','),mail.subject,mail.body,mail.cc?{cc:mail.cc}:{}).getId();},
    sendPrepared(id) {return GmailApp.getDraft(id).send().getId();},
    findAccepted(id) {
      const marker='[RR:'+id+']';
      const owner=Session.getEffectiveUser().getEmail();
      for(const t of GmailApp.search('in:sent from:me "'+marker+'"',0,20)) for(const m of t.getMessages()) if(m.getSubject().includes(marker)&&m.getFrom().includes(owner)) return m.getId();
      return null;
    }
  };
}
function dispatchClinicalNotifications() {
  clinicalSession_((state,env,store)=>{store.project(state);ClinicalEngine.dispatch(state,env,clinicalTransport_(),s=>store.save(s));});
}
function checkClinicalHealth() {
  clinicalSession_((state,env,store)=>{
    ClinicalEngine.monitor(state,env);store.save(state);store.project(state);
    // Independent watchdog can deliver owner alerts even if the ordinary shift
    // dispatcher is absent; it never sends student scheduling notifications.
    ClinicalEngine.dispatch(state,Object.assign({},env,{ownerOnly:true}),clinicalTransport_(),s=>store.save(s));
  });
}
function applyClinicalReviewActions() {
  clinicalSession_((state,env,store,ss)=>{
    const sheet=store.sheet('RR_V2_Actions',['Record ID','Action','Evidence / resolution','Processed at','Student ID']);
    const values=sheet.getDataRange().getValues();state.actions=state.actions||[];
    values.slice(1).forEach((row,index)=>{
      if(!row[0]||row[3]) return;
      const [id,action,evidence]=row;
      if(String(evidence||'').trim().length<10) throw Error('Provide evidence/resolution for each review action');
      const actionId=clinicalHash_(JSON.stringify([id,action,evidence]));
      if(!state.actions.includes(actionId)) {
        const r=state.reviews.find(r=>r.id===id),n=state.notifications.find(n=>n.id===id);
        if(action==='APPROVE_ALIAS'&&r&&r.student_name) {
          const roster=clinicalRoster_(ss,state,env),target=roster.filter(s=>s.id===String(row[4]||''));
          if(target.length!==1) throw Error('Alias must target one unique Student ID');
          state.aliases=state.aliases||[];
          state.aliases=state.aliases.filter(a=>a.normalized!==ClinicalEngine.norm(r.student_name));
          state.aliases.push({normalized:ClinicalEngine.norm(r.student_name),student_id:target[0].id,approved_at:new Date().toISOString(),evidence:String(evidence)});
        }
        else if(action==='RESOLVE_REVIEW'&&r) {r.status='RESOLVED';r.resolution=String(evidence);r.resolved_at=new Date().toISOString();}
        else if(action==='REPROCESS_SOURCE'&&state.sources.some(s=>s.id===id)) {state.sources.find(s=>s.id===id).status='REVIEW';}
        else if(n&&['UNCERTAIN','LEGACY_REVIEW'].includes(n.status)&&action==='CONFIRM_ACCEPTED') {n.status='API_ACCEPTED';n.accepted_at=new Date().toISOString();n.manual_evidence=String(evidence);}
        else if(n&&['UNCERTAIN','LEGACY_REVIEW'].includes(n.status)&&action==='CONFIRM_NOT_SENT') {n.status='RETRY';n.next_retry_at=new Date().toISOString();n.manual_evidence=String(evidence);}
        else throw Error('Invalid action or record state: '+action);
        if(n&&['CONFIRM_ACCEPTED','CONFIRM_NOT_SENT'].includes(action)) state.reviews.filter(r=>r.status==='OPEN'&&r.reason.includes(n.id)).forEach(r=>{r.status='RESOLVED';r.resolution=String(evidence);r.resolved_at=new Date().toISOString();});
        state.actions.push(actionId);store.save(state);
      }
      sheet.getRange(index+2,4).setValue(new Date().toISOString());
    });
  });
}
function stageClinicalLegacyHistory() {
  clinicalSession_((state,env,_store,ss)=>{
    if(state.shifts.length) throw Error('Stage legacy history before the first import; use a reviewed migration for an existing v2 ledger');
    state.legacy=state.legacy||[];
    for(const tab of ['Clinical_Log','Manual_Email_Queue']) {
      const sheet=ss.getSheetByName(tab);if(!sheet) continue;
      const rows=sheet.getDataRange().getValues(),headers=rows[0].map(String);
      rows.slice(1).forEach((row,i)=>{
        if(row.every(v=>v==='')) return;
        const id=clinicalHash_(JSON.stringify([tab,i+2,row]));if(state.legacy.some(r=>r.id===id))return;
        const value=name=>row[headers.indexOf(name)],rawDate=value('Shift Date');let day='';
        if(rawDate instanceof Date) day=Utilities.formatDate(rawDate,'America/New_York','yyyy-MM-dd');
        else {
          const m=String(rawDate||'').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
          if(m){const d=new Date(Date.UTC(Number(m[3]),Number(m[1])-1,Number(m[2])));if(d.getUTCMonth()===Number(m[1])-1&&d.getUTCDate()===Number(m[2]))day=d.toISOString().slice(0,10);}
        }
        const location=value('Location'),canonical=location==='Lee County'?'Brewster Ambulance Service Lee County':location==='Collier County'?'Brewster Ambulance Service Collier':'';
        const recorded=tab==='Clinical_Log'||String(value('Status'))==='SENT';
        state.legacy.push({id,source_tab:tab,source_row:i+2,raw_headers:headers,raw_row:row,date:recorded?day:'',location:canonical,
          name_normalized:ClinicalEngine.norm(value('Student Name')),state:recorded?'LEGACY_SEND_RECORDED':'LEGACY_REVIEW_ONLY'});
        if(!day||!canonical||!recorded) ClinicalEngine.review(state,env,{category:'LEGACY_MIGRATION_REVIEW',source_id:tab+':'+(i+2),student_name:String(value('Student Name')||''),date:day,
          reason:'Historical record requires review; it will not be treated as verified send/shift authority',blocking:false});
      });
    }
  });
}
