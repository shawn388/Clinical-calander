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
  return {mode:p.RUN_MODE,sheet:p.SPREADSHEET_ID,url:p.PARSER_URL,token:p.PARSER_API_TOKEN,folder:p.ARCHIVE_FOLDER_ID,
    liveEmail:p.LIVE_EMAIL==='true',activationAt:Date.parse(p.NOTIFICATIONS_FROM),gmailQuery:'label:platinum-planner newer_than:180d',timezone:'America/New_York',owner:p.OWNER_EMAIL,
    to:to,
    expectedSites:['Brewster Ambulance Service Lee County','Brewster Ambulance Service Collier']};
}
function clinicalHash_(value) {
  const digest=typeof value==='string'?Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,value,Utilities.Charset.UTF_8):Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,value);
  return digest.map(b=>('0'+((b+256)%256).toString(16)).slice(-2)).join('');
}
function clinicalJSON_(text,fallback) {
  try {const value=JSON.parse(text||'null');return value&&typeof value==='object'?value:fallback;} catch(_e) {return fallback;}
}
// Read retries only. Never wrap ledger commits, draft creation or email sending.
function clinicalRead_(label,fn,context) {
  for(let attempt=0;;attempt++) {
    if(context&&context.stage)context.stage(label);
    try {return fn();} catch(error) {
      if(attempt>=2||!/(server error|temporar|internal error|unavailable|timed out|timeout|\b(?:429|502|503)\b)/i.test(String(error))||
        (context&&context.shouldStop&&context.shouldStop())) throw error;
      if(context&&context.retry)context.retry(label);
      Utilities.sleep(attempt?750:250);
    }
  }
}
function clinicalSession_(fn,kind='GENERAL') {
  const props=PropertiesService.getScriptProperties(),diagKey='RR_DIAG_'+kind;
  const prior=clinicalJSON_(props.getProperty(diagKey),{}),started=Date.now(),deadline=started+240000;
  const diag=Object.assign({},prior,{run_id:Utilities.getUuid(),started_at:new Date(started).toISOString(),stage:'CONFIG',status:'RUNNING',read_retries:0});
  const stage=value=>{diag.stage=value;diag.stage_at=new Date().toISOString();props.setProperty(diagKey,JSON.stringify(diag));};
  const context={stage,shouldStop:()=>Date.now()>deadline,retry:()=>{diag.read_retries++;}};
  let config,lock,acquired=false;
  try {
    stage('CONFIG');config=clinicalConfig_();lock=LockService.getScriptLock();stage('LOCK');
    if(!lock.tryLock(5000)) {diag.status='SKIPPED_LOCK';stage('SKIPPED_LOCK');return;}
    acquired=true;
    const ss=clinicalRead_('WORKBOOK_OPEN',()=>SpreadsheetApp.openById(config.sheet),context);
    if(ss.getSpreadsheetTimeZone()!=='America/New_York'||Session.getScriptTimeZone()!=='America/New_York') throw Error('Workbook and script must use America/New_York');
    const cache=clinicalJSON_(props.getProperty('RR_VIEW_HASHES'),{});
    const priorHashes=JSON.stringify(cache.hashes||{});
    const store=new ClinicalLedger(ss,clinicalHash_,{projectionHashes:cache.hashes||{},stage,read:(label,read)=>clinicalRead_(label,read,context)});
    stage('LEDGER_LOAD');const state=store.load();
    const env=Object.assign({},config,context,{props,now:Date.now(),hash:clinicalHash_,
      read:(label,read)=>clinicalRead_(label,read,context),reviewLink:id=>store.reviewLink(id,state),
      dayKey:now=>Utilities.formatDate(new Date(now),'America/New_York','yyyy-MM-dd')});
    let outcome,processingError;
    try {stage('PROCESS');outcome=fn(state,env,store,ss);}
    catch(error) {processingError=error;diag.failed_stage=diag.stage;}
    try {
      store.save(state);stage('VIEWS');
      const fullAt=Date.parse(cache.full_at||cache.at||'');
      const force=env.forceViews||!Number.isFinite(fullAt)||Date.now()-fullAt>=86400000;
      store.project(state,force);
      const nextHashes=JSON.stringify(store.projectionHashes||{});
      if(force||nextHashes!==priorHashes) props.setProperty('RR_VIEW_HASHES',JSON.stringify({at:new Date().toISOString(),full_at:force?new Date().toISOString():(cache.full_at||cache.at),hashes:store.projectionHashes||{}}));
    } catch(error) {if(processingError){diag.finalization_error=String(error).slice(0,1000);throw processingError;}throw error;}
    if(processingError)throw processingError;
    diag.status=outcome===false?'HELD':'COMPLETED';diag.ended_at=new Date().toISOString();
    if(outcome!==false) {diag.last_success_at=diag.ended_at;diag.consecutive_failures=0;delete diag.error;delete diag.failed_stage;delete diag.finalization_error;}
    else diag.consecutive_failures=(prior.consecutive_failures||0)+1;
    if(kind==='DISPATCH') {
      const pending=state.notifications.filter(n=>['PENDING','RETRY','DRY_RUN'].includes(n.status)&&n.type==='SCHEDULED');
      diag.next_due_at=pending.length?pending.map(n=>n.next_retry_at||n.due_at).sort()[0]:null;
      diag.uncertain_count=state.notifications.filter(n=>['UNCERTAIN','SENDING','PREPARING'].includes(n.status)).length;
    }
    const completedImports=state.runs.filter(r=>r.type==='INGEST'&&r.status==='COMPLETED').map(r=>r.ended_at).filter(Boolean).sort();
    const scheduleHealth={ingest_success_at:completedImports.slice(-1)[0]||null,sites:config.expectedSites.map(site=>({site,
      published_at:state.sources.filter(s=>s.status==='APPLIED'&&s.coverage.some(c=>c.location===site)).map(s=>s.version_at).filter(Boolean).sort().slice(-1)[0]||null}))};
    const healthText=JSON.stringify(scheduleHealth);
    if(props.getProperty('RR_SCHEDULE_HEALTH')!==healthText)props.setProperty('RR_SCHEDULE_HEALTH',healthText);
    stage(diag.status);
  } catch(error) {
    diag.status='FAILED';diag.failed_stage=diag.failed_stage||diag.stage;diag.error=String(error).slice(0,1000);diag.ended_at=new Date().toISOString();
    diag.consecutive_failures=(prior.consecutive_failures||0)+1;stage('FAILED');
    if(config)clinicalFallbackAlert_(config,error);throw error;
  } finally {if(acquired)lock.releaseLock();}
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
    const sheet=env.read?env.read('ROSTER_LOOKUP',()=>ss.getSheetByName(tab)):ss.getSheetByName(tab);if(!sheet) throw Error('Missing roster tab '+tab);
    const values=env.read?env.read('ROSTER_READ',()=>sheet.getDataRange().getValues()):sheet.getDataRange().getValues(),headers=values[0].map(String);
    const idx={};for(const name of ['First Name','Last Name','Email','Cohort/Class #']) {
      const matches=headers.map((h,i)=>h.trim()===name?i:-1).filter(i=>i>=0);
      if(matches.length!==1) throw Error('Expected one explicit header '+name+' in '+tab);idx[name]=matches[0];
    }
    const idCol=headers.indexOf('Student ID');
    values.slice(1).forEach((r,i)=>{
      if(r.every(v=>v===''||v===false)) {
        // Google returns unchecked template checkboxes as false, not blank.
        state.reviews.filter(review=>review.category==='INVALID_ROSTER_ROW'&&review.source_id===tab+':'+(i+2)&&review.status==='OPEN').forEach(review=>{
          review.status='RESOLVED';review.resolution='Verified empty template row: only blank values and unchecked checkboxes';review.resolved_at=new Date().toISOString();
        });
        return;
      }
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
        const threads=env.read('CALENDAR_SEARCH',()=>GmailApp.search(env.gmailQuery,offset,20));
        if(!threads.length) {finished=true;break;}
        // Complete a thread page before advancing the checkpoint. Replay is safe.
        for(const thread of threads) for(const message of env.read('CALENDAR_THREAD',()=>thread.getMessages())) {
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
    return run.status==='COMPLETED';
  },'INGEST');
}
function clinicalTransport_(env) {
  return {
    prepare(mail) {if(env&&env.stage)env.stage('EMAIL_DRAFT_PREPARE');return GmailApp.createDraft(mail.to.join(','),mail.subject,mail.body,mail.cc?{cc:mail.cc}:{}).getId();},
    sendPrepared(id) {
      const draft=env&&env.read?env.read('EMAIL_DRAFT_READ',()=>GmailApp.getDraft(id)):GmailApp.getDraft(id);
      if(env&&env.stage)env.stage('EMAIL_SEND');return draft.send().getId();
    },
    findAccepted(id) {
      const marker='[RR:'+id+']';
      const owner=Session.getEffectiveUser().getEmail();
      for(const t of (env&&env.read?env.read('SENT_EVIDENCE',()=>GmailApp.search('in:sent from:me "'+marker+'"',0,20)):GmailApp.search('in:sent from:me "'+marker+'"',0,20))) for(const m of t.getMessages()) if(m.getSubject().includes(marker)&&m.getFrom().includes(owner)) return m.getId();
      return null;
    }
  };
}
function clinicalCancellationAuthenticated_(raw,from) {
  if(!/^(?:"?Platinum Planner"?\s*<)?donotreply@platinumed\.com>?$/i.test(String(from).trim())) return false;
  const headers=String(raw).split(/\r?\n\r?\n/,1)[0].replace(/\r?\n[ \t]+/g,' ');
  const trusted=headers.split(/\r?\n/).find(line=>/^Authentication-Results:\s*mx\.google\.com;/i.test(line));
  return Boolean(trusted&&/\bdkim=pass\b/i.test(trusted)&&/\bheader\.i=@platinumed\.com\b/i.test(trusted)&&/\bdmarc=pass\b/i.test(trusted)&&/\bheader\.from=platinumed\.com\b/i.test(trusted));
}
function clinicalCancellationScan_(state,env,store,ss) {
  const props=env.props||PropertiesService.getScriptProperties(),cursor=clinicalJSON_(props.getProperty('RR_CANCEL_CURSOR'),{});
  const now=Date.now(),since=Date.parse(cursor.last_success_at||''),lastFull=Date.parse(cursor.last_full_at||'');
  const full=!Number.isFinite(since)||since>now||!Number.isFinite(lastFull)||lastFull>now||now-lastFull>=86400000;
  const window=full||!Number.isFinite(since)?'newer_than:180d':'after:'+Math.floor((since-48*3600000)/1000);
  const query='from:donotreply@platinumed.com '+window+' {"marked themselves absent" "clinical cancelled" "clinical canceled" "shift cancelled" "shift canceled" "has been cancelled" "has been canceled"}';
  const before=env.hash(JSON.stringify(state)),roster=clinicalRoster_(ss,state,env);
  const run={id:Utilities.getUuid(),type:'CANCELLATION_WATCHDOG',started_at:new Date(now).toISOString(),scan_mode:full?'FULL':'RECENT',status:'RUNNING'};
  const seen=new Set(Array.isArray(cursor.seen_ids)?cursor.seen_ids.filter(id=>typeof id==='string'):[]),read=env.read||((_label,fn)=>fn());
  try {
    for(let offset=0;;offset+=20) {
      if(env.shouldStop()) throw Error('Cancellation scan exceeded execution budget; reminders held until a full scan completes');
      const threads=read('CANCELLATION_SEARCH',()=>GmailApp.search(query,offset,20));
      if(!threads.length) break;
      for(const thread of threads) for(const message of read('CANCELLATION_THREAD',()=>thread.getMessages())) {
        if(env.shouldStop()) throw Error('Cancellation scan exceeded execution budget; reminders held until a full scan completes');
        const id=message.getId(),known=state.cancellations.find(c=>c.message_id===id);
        if(known&&known.status!=='REVIEW') continue;
        if(!known&&seen.has(id)) continue;
        if(!String(message.getFrom()).toLowerCase().includes('donotreply@platinumed.com')) {seen.add(id);continue;}
        const body=read('CANCELLATION_BODY',()=>message.getPlainBody());
        if(!/Brewster Ambulance Service/i.test(body)||!/(?:marked themselves absent|clinical cancel(?:led|ed)|shift cancel(?:led|ed)|has been cancel(?:led|ed))/i.test(body)) {seen.add(id);continue;}
        ClinicalEngine.ingestCancellation(state,env,{id,received_at:message.getDate().toISOString(),body,
          authenticated:clinicalCancellationAuthenticated_(read('CANCELLATION_AUTH',()=>message.getRawContent()),message.getFrom())},roster);
      }
    }
    run.status='COMPLETED';run.ended_at=new Date().toISOString();
    state.reviews.filter(r=>r.category==='CANCELLATION_WATCHDOG_FAILURE'&&r.status==='OPEN').forEach(r=>{r.status='RESOLVED';r.resolved_at=run.ended_at;});
    if(full||env.hash(JSON.stringify(state))!==before) {
      let retained=0;state.runs=state.runs.slice().reverse().filter(r=>r.type!=='CANCELLATION_WATCHDOG'||++retained<100).reverse();
      state.runs.push(run);state.cancellation_scan_at=run.ended_at;
    }
    // Advance only after all business changes are durably committed. Failed
    // scans retain the previous cursor and seen set, so retries cannot skip mail.
    store.save(state);
    props.setProperty('RR_CANCEL_CURSOR',JSON.stringify({last_success_at:run.ended_at,last_full_at:full?run.ended_at:cursor.last_full_at,
      scans:(cursor.scans||0)+1,seen_ids:Array.from(seen).slice(-200)}));
    return true;
  } catch(error) {
    run.status='FAILED';run.ended_at=new Date().toISOString();run.error=String(error);
    let retained=0;state.runs=state.runs.slice().reverse().filter(r=>r.type!=='CANCELLATION_WATCHDOG'||++retained<100).reverse();state.runs.push(run);
    ClinicalEngine.review(state,env,{category:'CANCELLATION_WATCHDOG_FAILURE',dedupe_key:'cancellation_watchdog_failure',reason:'Cannot complete Platinum cancellation check; upcoming reminders are held. '+String(error),instructions:'Inspect Gmail access and Apps Script executions. Restore the cancellation scan and verify its RR_CANCEL_CURSOR and RR_DIAG_DISPATCH success timestamps before releasing reminders.'});
    store.save(state);return false;
  }
}
function watchClinicalCancellations() {
  clinicalSession_((state,env,store,ss)=>{clinicalCancellationScan_(state,env,store,ss);
    ClinicalEngine.dispatch(state,Object.assign({},env,{ownerOnly:true}),clinicalTransport_(env),s=>store.save(s));},'CANCELLATIONS');
}
function dispatchClinicalNotifications() {
  clinicalSession_((state,env,store,ss)=>{
    const complete=clinicalCancellationScan_(state,env,store,ss);
    env.now=Date.now();
    ClinicalEngine.dispatch(state,complete?env:Object.assign({},env,{ownerOnly:true}),clinicalTransport_(env),s=>store.save(s));
    return complete;
  },'DISPATCH');
}
// A separately approved live test, while normal delivery remains disabled.
// The engine applies the date scope before recovery, previews, or provider calls.
function dispatchClinicalApprovedTest() {
  const p=PropertiesService.getScriptProperties().getProperties();
  const date=p.APPROVED_LIVE_TEST_DATE||'';
  if(p.RUN_MODE!=='PRODUCTION'||p.LIVE_EMAIL!=='false'||!/^\d{4}-\d{2}-\d{2}$/.test(date)||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date) throw Error('Set one explicitly approved production test date; ordinary live delivery must remain disabled');
  clinicalSession_((state,env,store)=>{
    const scoped=Object.assign({},env,{liveEmail:true,approvedTestDate:date});
    ClinicalEngine.dispatch(state,scoped,clinicalTransport_(),s=>store.save(s));
  });
}
function checkClinicalHealth() {
  clinicalSession_((state,env,store)=>{
    ClinicalEngine.monitor(state,env);store.save(state);
    // Independent watchdog can deliver owner alerts even if the ordinary shift
    // dispatcher is absent; it never sends student scheduling notifications.
    ClinicalEngine.dispatch(state,Object.assign({},env,{ownerOnly:true}),clinicalTransport_(env),s=>store.save(s));
  },'HEALTH');
}
// Separate trigger: reads only small Script Properties heartbeats. It remains
// useful when dispatch or Sheets fails; Google-wide outages still need Google's
// native failure notifications. Never sends student mail or retries a send.
function checkClinicalDeliveryHealth() {
  // A distinct lock lets monitoring run even if dispatch holds the script lock.
  const lock=LockService.getUserLock();if(!lock.tryLock(1000))return {status:'SKIPPED_LOCK'};
  try {return clinicalDeliveryHealth_(clinicalConfig_(),PropertiesService.getScriptProperties(),Date.now());}
  finally {lock.releaseLock();}
}
function clinicalDeliveryHealth_(config,props,now) {
  const dispatch=clinicalJSON_(props.getProperty('RR_DIAG_DISPATCH'),{}),scan=clinicalJSON_(props.getProperty('RR_CANCEL_CURSOR'),{});
  const schedule=clinicalJSON_(props.getProperty('RR_SCHEDULE_HEALTH'),{});
  const old=clinicalJSON_(props.getProperty('RR_DELIVERY_HEALTH'),{});
  const age=value=>{const t=Date.parse(value||'');return Number.isFinite(t)?now-t:Infinity;};
  const issues=[];
  if(age(dispatch.last_success_at)>15*60000) issues.push('No successful reminder dispatcher within 15 minutes');
  if(age(scan.last_success_at)>15*60000) issues.push('No successful cancellation check within 15 minutes');
  if(dispatch.next_due_at&&age(dispatch.next_due_at)>10*60000) issues.push('A pending reminder is more than 10 minutes overdue');
  if(age(schedule.ingest_success_at)>26*3600000)issues.push('No completed calendar ingestion within 26 hours');
  for(const site of config.expectedSites) {
    const source=(schedule.sites||[]).find(s=>s.site===site);
    if(!source||age(source.published_at)>9*86400000)issues.push('No accepted calendar within nine days for '+site);
  }
  const diagnostic={checked_at:new Date(now).toISOString(),status:issues.length?'ATTENTION':'HEALTHY',issues,
    dispatch_success_at:dispatch.last_success_at||null,cancellation_success_at:scan.last_success_at||null,dispatch_stage:dispatch.failed_stage||dispatch.stage||'NO_HEARTBEAT'};
  props.setProperty('RR_DIAG_DELIVERY_HEALTH',JSON.stringify(diagnostic));
  if(!issues.length) {
    if(old.status&&old.status!=='RESOLVED') props.setProperty('RR_DELIVERY_HEALTH',JSON.stringify(Object.assign({},old,{status:'RESOLVED',resolved_at:diagnostic.checked_at})));
    return diagnostic;
  }
  // A deliberate production maintenance pause is quiet; TEST still records a
  // dry-run incident so the complete alert path can be rehearsed safely.
  if(config.mode==='PRODUCTION'&&!config.liveEmail) return diagnostic;
  if(['PREPARING','SENDING','API_ACCEPTED','UNCERTAIN'].includes(old.status)||(old.status==='DRY_RUN'&&!config.liveEmail)) return diagnostic;
  const cycle=(old.cycle||0)+1,id=clinicalHash_('delivery-health:'+cycle+':'+diagnostic.checked_at);
  const record={id,cycle,status:config.liveEmail?'PREPARING':'DRY_RUN',opened_at:diagnostic.checked_at,issues,
    previous_message_id:old.message_id||old.previous_message_id||null};
  props.setProperty('RR_DELIVERY_HEALTH',JSON.stringify(record));
  if(!config.liveEmail)return diagnostic;
  try {
    const subject='Clinical scheduler needs attention [RR-HEALTH:'+id+']';
    const body=['Clinical scheduling requires attention.','',...issues,
      'Last successful dispatcher: '+(diagnostic.dispatch_success_at||'None recorded'),
      'Last successful cancellation scan: '+(diagnostic.cancellation_success_at||'None recorded'),
      'Latest dispatcher stage: '+diagnostic.dispatch_stage,
      'Workbook: https://docs.google.com/spreadsheets/d/'+config.sheet+'/edit',
      'Resolve: Inspect Apps Script executions and RR_DIAG_DISPATCH / RR_CANCEL_CURSOR. Restore the failing job and verify the next due reminder. Inspect Sent mail before releasing uncertain notifications.'].join('\n');
    const draft=GmailApp.createDraft(config.owner,subject,body);record.draft_id=draft.getId();record.status='SENDING';
    props.setProperty('RR_DELIVERY_HEALTH',JSON.stringify(record));
    record.message_id=draft.send().getId();record.status='API_ACCEPTED';props.setProperty('RR_DELIVERY_HEALTH',JSON.stringify(record));
  } catch(error) {record.status='UNCERTAIN';record.error=String(error).slice(0,1000);props.setProperty('RR_DELIVERY_HEALTH',JSON.stringify(record));throw error;}
  return diagnostic;
}
function refreshClinicalViews() {
  clinicalSession_((_state,env)=>{env.forceViews=true;},'VIEWS');
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
        else if(action==='DISMISS_CANCELLATION'&&state.cancellations.some(c=>c.id===id)) {
          const c=state.cancellations.find(c=>c.id===id);
          if(c.status==='APPLIED') throw Error('An applied cancellation requires an explicitly verified reinstatement; dismissal cannot reactivate it');
          c.status='DISMISSED';c.resolution=String(evidence);c.resolved_at=new Date().toISOString();
          state.reviews.filter(r=>r.source_id===id&&r.status==='OPEN').forEach(r=>{r.status='RESOLVED';r.resolution=String(evidence);r.resolved_at=c.resolved_at;});
        }
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
