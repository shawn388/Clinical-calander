const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const crypto=require('node:crypto');
const E=require('../apps_script/Engine.gs');
const sha=s=>crypto.createHash('sha256').update(String(s)).digest('hex');
class Sheet {
 constructor(name,ss){this.name=name;this.ss=ss;this.data=[];this.max=1000;this.gid=ss.sheets.size+1;}
 getRange(row,col,height=1,width=1){const sheet=this;return {
  setValues(values){assert.equal(values.length,height);assert.ok(values.every(r=>r.length===width));if(sheet.ss.fault)sheet.ss.fault(sheet.name,row,col,values);
   sheet.ss.writes++;values.forEach((r,i)=>r.forEach((v,j)=>{sheet.data[row+i-1]??=[];sheet.data[row+i-1][col+j-1]=v;}));return this;},
  getValues(){return Array.from({length:height},(_,i)=>Array.from({length:width},(_,j)=>sheet.data[row+i-1]?.[col+j-1]??''));},
  setValue(v){return this.setValues([[v]]);}
 };}
 getDataRange(){return this.getRange(1,1,this.getLastRow(),Math.max(...this.data.map(r=>r.length),1));}
 getLastRow(){return this.data.length;}
 getMaxRows(){return this.max;}
 insertRowsAfter(_row,count){this.max+=count;}
 setFrozenRows(){}
 clearContents(){this.ss.writes++;this.data=[];}
 getSheetId(){return this.gid;}
}
class Spreadsheet{
 constructor(){this.sheets=new Map();this.fault=null;this.writes=0;}
 getSheetByName(n){return this.sheets.get(n)||null;}
 insertSheet(n){const s=new Sheet(n,this);this.sheets.set(n,s);return s;}
 getUrl(){return 'https://docs.google.com/spreadsheets/d/TEST/edit';}
 getSpreadsheetTimeZone(){return 'America/New_York';}
}
function ledger(){
 const ctx=vm.createContext({ClinicalEngine:E,SpreadsheetApp:{flush(){}}});vm.runInContext(fs.readFileSync(__dirname+'/../apps_script/Ledger.gs','utf8')+'\nthis.Store=ClinicalLedger;',ctx);
 const ss=new Spreadsheet();return {ss,make:(options)=>new ctx.Store(ss,sha,options)};
}
test('ledger commits multi-cell snapshots and verifies checksums',()=>{
 const f=ledger(),s=E.init({}),store=f.make();s.large='😀'.repeat(40000);store.load();store.save(s);
 const restored=f.make().load();assert.equal(restored.large,s.large);assert.ok(f.ss.getSheetByName('RR_V2_Chunks_A').getLastRow()>2);
});
test('failure before head commit leaves previous snapshot authoritative',()=>{
 const f=ledger(),store=f.make(),s=store.load();store.save(s);s.marker='new';
 f.ss.fault=(name,row)=>{if(name==='RR_V2_Head'&&row===2)throw Error('power loss');};assert.throws(()=>store.save(s));f.ss.fault=null;
 assert.equal(f.make().load().marker,undefined);
});
test('corrupted committed ledger is rejected before notifications can run',()=>{
 const f=ledger(),store=f.make(),s=store.load();store.save(s);f.ss.getSheetByName('RR_V2_Chunks_A').data[1][2]='J:tampered';assert.throws(()=>f.make().load(),/checksum/);
});
test('projection provides a direct review-row link and escapes formulas',()=>{
 const f=ledger(),store=f.make(),s=store.load();s.reviews.push({id:'r1',status:'OPEN',category:'UNKNOWN',reason:'=HYPERLINK("bad")',instructions:'Fix source'});store.project(s);
 assert.match(store.reviewLink('r1'),/#gid=\d+&range=A2:J2$/);assert.ok(f.ss.getSheetByName('RR_V2_Reviews').data[1][5].startsWith("'="));
});

function appContext(options={}){
 const state=options.state||E.init({});let released=0,fetches=0,locked=0;const fallback={};
 const ss=new Spreadsheet();
 for(const tab of ['Students','Archive'])ss.insertSheet(tab).getRange(1,1,tab==='Students'?2:1,4).setValues(tab==='Students'?
  [['First Name','Last Name','Email','Cohort/Class #'],['Example','Student','student@example.test','Class1']]:[['First Name','Last Name','Email','Cohort/Class #']]);
 const props={RUN_MODE:'TEST',SPREADSHEET_ID:'TEST',PRODUCTION_SPREADSHEET_ID:'synthetic-production',OWNER_EMAIL:'owner@example.test',NOTIFICATION_TO:'scheduling@example.test',PARSER_URL:'https://staging.example.test/parse-calendar',PARSER_API_TOKEN:'fake-test-token',ARCHIVE_FOLDER_ID:'TEST_FOLDER',NOTIFICATIONS_FROM:'2026-10-01T00:00:00Z'};
 const blob={getName:()=> 'Calendar-RickyRescue-BrewsterLeeCou-202610-202611.pdf',getBytes:()=>[1,2,3],getContentType:()=> 'application/pdf',copyBlob(){return this;},setName(){return this;}};
 const message={getId:()=> 'message1',getFrom:()=> 'donotreply@platinumed.com',getSubject:()=> 'Calendar - Brewster Lee County',getDate:()=>new Date('2026-10-17T12:00:00Z'),getAttachments:()=>options.missingAttachment?[]:[blob]};
 class Store {
  constructor(_ss,_hash,options={}){this.projectionHashes=options.projectionHashes||{};}
  load(){if(options.storageFailure)throw Error('Sheets unavailable');return state;}save(){if(options.commitFailure)throw Error('Commit unavailable');}project(){}reviewLink(id){return 'https://example.test/'+id;}
 }
 const ctx=vm.createContext({ClinicalEngine:E,ClinicalLedger:Store,console,
  PropertiesService:{getScriptProperties:()=>({getProperties:()=>props,getProperty:k=>fallback[k],setProperty:(k,v)=>{fallback[k]=v;}})},Logger:{log(){}},
  LockService:{getScriptLock:()=>({tryLock(){locked++;return !options.busy;},releaseLock(){released++;}}),getUserLock:()=>({tryLock:()=>!options.healthBusy,releaseLock(){}})},
  SpreadsheetApp:{openById(id){assert.equal(id,'TEST');return ss;}},
  Session:{getScriptTimeZone:()=> 'America/New_York',getEffectiveUser:()=>({getEmail:()=> 'owner@example.test'})},
  Utilities:{sleep(){},getUuid:()=>crypto.randomUUID(),DigestAlgorithm:{SHA_256:'sha256'},Charset:{UTF_8:'UTF-8'},computeDigest(_alg,value,charset){return [...crypto.createHash('sha256').update(typeof value==='string'?(charset==='UTF-8'?value:value.replace(/[^\x00-\x7F]/g,'?')):Buffer.from(value)).digest()];}},
  GmailApp:{search(q,start){if(q.includes('marked themselves absent')) {if(options.cancellationOutage)throw Error('Gmail unavailable');return start===0&&options.cancellationMessage?[{getMessages:()=>[options.cancellationMessage]}]:[];}return start===0?[{getMessages:()=>[message]}]:[];},createDraft(){throw Error('REAL MAIL FORBIDDEN');}},
  DriveApp:{getFolderById(id){assert.equal(id,'TEST_FOLDER');return {getFilesByName:()=>({hasNext:()=>false}),createFile:()=>({getId:()=> 'archive1'})};}},
  UrlFetchApp:{fetch(){fetches++;if(options.outage)throw Error('Render outage');return {getResponseCode:()=>options.http||200,getContentText:()=>options.invalidJSON?'{broken':JSON.stringify({schema_version:2,parser_version:'2',source_sha256:crypto.createHash('sha256').update(Buffer.from([1,2,3])).digest('hex'),
   generated_at:'2026-10-17T08:00:00-04:00',coverage:[{location:'Brewster Ambulance Service Lee County',start:'2026-10-18',end:'2026-11-21'}],coverage_complete:true,status:'complete',shifts:[],errors:[],unresolved_blocks:[]})};}}
 });
 vm.runInContext(fs.readFileSync(__dirname+'/../apps_script/Code.gs','utf8'),ctx);
 return {ctx,state,ss,fallback,stats:()=>({released,fetches,locked})};
}
test('approved production test requires explicit date and disabled ordinary delivery',()=>{
 const f=appContext(),p=f.ctx.PropertiesService.getScriptProperties().getProperties();
 assert.throws(()=>f.ctx.dispatchClinicalApprovedTest(),/approved production test date/);
 p.RUN_MODE='PRODUCTION';p.APPROVED_LIVE_TEST_DATE='2026-10-27';p.LIVE_EMAIL='true';
 assert.throws(()=>f.ctx.dispatchClinicalApprovedTest(),/ordinary live delivery/);
 p.LIVE_EMAIL='false';p.APPROVED_LIVE_TEST_DATE='2026-02-30';
 assert.throws(()=>f.ctx.dispatchClinicalApprovedTest());
 p.APPROVED_LIVE_TEST_DATE='2026-10-27';let observed;
 f.ctx.clinicalSession_=fn=>fn(f.state,{liveEmail:false},{project(){},save(){}});
 f.ctx.ClinicalEngine=Object.assign({},E,{dispatch(_s,env){observed=env;}});
 f.ctx.dispatchClinicalApprovedTest();assert.equal(observed.liveEmail,true);assert.equal(observed.approvedTestDate,'2026-10-27');
});
test('Apps Script ingestion catches HTTP errors, invalid JSON and Render outages as owner reviews',()=>{
 for(const options of [{http:503},{invalidJSON:true},{outage:true}]){
  const f=appContext(options);f.ctx.ingestClinicalCalendars();assert.ok(f.state.reviews.some(r=>r.category==='PARSER_FAILURE'));
  assert.equal(f.state.sources[0].status,'FAILED');assert.equal(f.stats().released,1);
 }
});
test('missing Gmail attachments produce an actionable exception',()=>{
 const f=appContext({missingAttachment:true});f.ctx.ingestClinicalCalendars();assert.ok(f.state.reviews.some(r=>r.category==='MISSING_ATTACHMENT'));assert.equal(f.stats().fetches,0);
});
test('overlapping trigger executions cannot reach ingestion or email services',()=>{
 const f=appContext({busy:true});f.ctx.ingestClinicalCalendars();assert.equal(f.stats().fetches,0);assert.equal(f.state.runs.length,0);assert.equal(f.stats().released,0);
});
test('successful ingestion commits a run but never invokes dispatcher',()=>{
 const f=appContext();f.ctx.ingestClinicalCalendars();assert.equal(f.state.runs[0].status,'COMPLETED');assert.equal(f.state.sources[0].status,'APPLIED');assert.equal(f.state.notifications.length,0);
});
test('unchecked template checkboxes do not create student errors, but partial identities still do',()=>{
 const f=appContext();
 f.ss.getSheetByName('Students').getRange(3,1,2,5).setValues([['','','','',false],['Partial','','partial@example.test','Class1',false]]);
 f.state.reviews.push({id:'old-template-error',category:'INVALID_ROSTER_ROW',source_id:'Students:3',status:'OPEN'});
 f.ctx.ingestClinicalCalendars();
 assert.equal(f.state.reviews.find(r=>r.id==='old-template-error').status,'RESOLVED');
 const active=f.state.reviews.filter(r=>r.category==='INVALID_ROSTER_ROW'&&r.status==='OPEN');
 assert.equal(active.length,1);assert.equal(active[0].source_id,'Students:4');assert.equal(f.state.students.length,1);
});
test('Google adapter hashes Unicode strings as UTF-8 and preserves binary PDF hashes',()=>{
 const f=appContext();
 assert.equal(f.ctx.clinicalHash_('李明'),sha('李明'));
 assert.notEqual(f.ctx.clinicalHash_('李明'),f.ctx.clinicalHash_('王红'));
 assert.equal(f.ctx.clinicalHash_([0,127,-1]),crypto.createHash('sha256').update(Buffer.from([0,127,255])).digest('hex'));
});
test('Sheets failure is recorded in the separate failure ledger without test email',()=>{
 const f=appContext({storageFailure:true});assert.throws(()=>f.ctx.ingestClinicalCalendars(),/Sheets unavailable/);
 const failures=Object.entries(f.fallback).filter(([k])=>k.startsWith('RR_FATAL_')).map(([,v])=>JSON.parse(v));assert.equal(failures.length,1);assert.equal(failures[0].status,'DRY_RUN');assert.equal(f.stats().released,1);
});
test('legacy migration preserves raw rows and does not promote pending queue items',()=>{
 const f=appContext();f.ss.insertSheet('Clinical_Log').getRange(1,1,2,5).setValues([['UniqueKey','Shift Date','Student Name','Location','Email Sent Date'],['old','10/18/2026','Example Student','Lee County','10/17/2026']]);
 f.ss.insertSheet('Manual_Email_Queue').getRange(1,1,2,5).setValues([['Status','Shift Date','Student Name','Location','Email'],['APPROVED','10/19/2026','Example Student','Lee County','student@example.test']]);
 f.ctx.stageClinicalLegacyHistory();assert.equal(f.state.legacy.length,2);assert.equal(f.state.legacy[1].state,'LEGACY_REVIEW_ONLY');assert.equal(f.state.shifts.length,0);
 assert.equal(f.state.legacy[0].date,'2026-10-18');assert.equal(f.state.legacy[1].date,'');
});

test('cancellation authentication trusts Google aligned results and exact provider sender',()=>{
 const f=appContext(),auth='Authentication-Results: mx.google.com; dkim=pass header.i=@platinumed.com;\r\n dmarc=pass header.from=platinumed.com\r\n\r\nBody';
 assert.equal(f.ctx.clinicalCancellationAuthenticated_(auth,'Platinum Planner <donotreply@platinumed.com>'),true);
 for(const [raw,from] of [[auth,'fake-donotreply@platinumed.com'],[auth.replace('dmarc=pass','dmarc=fail'),'donotreply@platinumed.com'],[auth.replace('mx.google.com','untrusted.example'),'donotreply@platinumed.com'],['Subject: test\r\n\r\n'+auth,'donotreply@platinumed.com']]) assert.equal(f.ctx.clinicalCancellationAuthenticated_(raw,from),false);
});
test('regular dispatcher checks cancellation messages first under the same lock',()=>{
 const message={getId:()=> 'absence1',getFrom:()=> 'Platinum Planner <donotreply@platinumed.com>',getDate:()=>new Date('2026-10-26T12:00:00Z'),getPlainBody:()=>"Example Student (Student) has marked themselves absent for 'Brewster Ambulance Service: Lee County Station' on 10/28/2099 from 07:00 until 19:00 CDT. Comments: private",getRawContent:()=> 'Authentication-Results: mx.google.com; dkim=pass header.i=@platinumed.com; dmarc=pass header.from=platinumed.com\r\n\r\nbody'};
 const f=appContext({cancellationMessage:message});let called=false;
 f.ctx.ClinicalEngine={...E,dispatch(state,env){called=true;assert.equal(state.cancellations[0].status,'WAITING_FOR_CALENDAR');assert.equal(env.ownerOnly,undefined);assert.equal(f.stats().released,0);}};
 f.ctx.dispatchClinicalNotifications();assert.equal(called,true);assert.equal(f.stats().released,1);assert.ok(f.state.runs.some(r=>r.type==='CANCELLATION_WATCHDOG'&&r.status==='COMPLETED'));
});
test('Gmail cancellation scan failure holds ride mail and leaves an actionable failure',()=>{
 const f=appContext({cancellationOutage:true});let called=false;
 f.ctx.ClinicalEngine={...E,dispatch(state,env){called=true;assert.equal(env.ownerOnly,true);assert.ok(state.reviews.some(r=>r.category==='CANCELLATION_WATCHDOG_FAILURE'));}};
 f.ctx.dispatchClinicalNotifications();assert.equal(called,true);assert.ok(f.state.runs.some(r=>r.status==='FAILED'));assert.equal(f.stats().released,1);
});

test('unchanged projections and unchanged ledger require no writes across executions',()=>{
 const f=ledger(),store=f.make(),state=store.load();store.save(state);store.project(state);
 const hashes={...store.projectionHashes},reopened=f.make({projectionHashes:hashes});reopened.load();const writes=f.ss.writes;
 assert.equal(reopened.save(state),false);reopened.project(state);assert.equal(f.ss.writes,writes);
 state.shifts.push({id:'new-shift',date:'2026-10-18'});reopened.project(state);
 assert.ok(f.ss.writes>writes);assert.equal(hashes.RR_V2_Reviews,store.projectionHashes.RR_V2_Reviews);
 const after=f.ss.writes;reopened.project(state,true);assert.ok(f.ss.writes>after);
});
test('projection cache is committed only after a successful rebuild and repairs on retry',()=>{
 const f=ledger(),store=f.make(),state=store.load();store.project(state);
 const committed={...store.projectionHashes};state.reviews.push({id:'r1',status:'OPEN'});
 f.ss.fault=(name)=>{if(name==='RR_V2_Reviews')throw Error('View write failed');};
 const broken=f.make({projectionHashes:{...committed}});assert.throws(()=>broken.project(state));
 f.ss.fault=null;const retry=f.make({projectionHashes:{...committed}});retry.project(state);
 assert.equal(f.ss.getSheetByName('RR_V2_Reviews').data[1][0],'r1');
});
test('read retries are bounded and never retry permanent errors',()=>{
 const f=appContext(),waits=[];f.ctx.Utilities.sleep=ms=>waits.push(ms);let reads=0;
 assert.equal(f.ctx.clinicalRead_('READ',()=>{reads++;if(reads<3)throw Error('Temporary server error');return 'ok';}), 'ok');
 assert.equal(reads,3);assert.deepEqual(waits,[250,750]);
 reads=0;assert.throws(()=>f.ctx.clinicalRead_('READ',()=>{reads++;throw Error('Permission denied');}));assert.equal(reads,1);
 reads=0;assert.throws(()=>f.ctx.clinicalRead_('READ',()=>{reads++;throw Error('Server error');}));assert.equal(reads,3);
});
test('diagnostics preserve the failed read phase and the previous successful heartbeat',()=>{
 const f=appContext();f.fallback.RR_DIAG_DISPATCH=JSON.stringify({last_success_at:'2026-10-30T12:00:00Z'});
 assert.throws(()=>f.ctx.clinicalSession_((_s,env)=>env.read('GMAIL_READ',()=>{throw Error('Permission denied');}),'DISPATCH'));
 const d=JSON.parse(f.fallback.RR_DIAG_DISPATCH);assert.equal(d.failed_stage,'GMAIL_READ');assert.equal(d.status,'FAILED');assert.equal(d.last_success_at,'2026-10-30T12:00:00Z');
 assert.equal(f.stats().released,1);
});
test('successful diagnostics record dispatch and next due time without storing student data',()=>{
 const f=appContext();f.state.notifications.push({type:'SCHEDULED',status:'PENDING',due_at:'2099-10-31T12:00:00Z'});
 f.ctx.dispatchClinicalNotifications();const d=JSON.parse(f.fallback.RR_DIAG_DISPATCH);
 assert.equal(d.status,'COMPLETED');assert.ok(d.last_success_at);assert.equal(d.next_due_at,'2099-10-31T12:00:00Z');assert.ok(!JSON.stringify(d).includes('student@example'));
});
test('incremental scans use overlap, skip unchanged journals, and reconcile the full window daily',()=>{
 const f=appContext(),queries=[],search=f.ctx.GmailApp.search;f.ctx.GmailApp.search=(q,...args)=>{queries.push(q);return search(q,...args);};
 f.ctx.dispatchClinicalNotifications();const count=f.state.runs.length,first=JSON.parse(f.fallback.RR_CANCEL_CURSOR);
 assert.ok(queries[0].includes('newer_than:180d'));
 queries.length=0;f.ctx.dispatchClinicalNotifications();assert.ok(queries[0].includes('after:'));assert.equal(f.state.runs.length,count);
 const second=JSON.parse(f.fallback.RR_CANCEL_CURSOR);assert.equal(second.scans,2);assert.equal(second.last_full_at,first.last_full_at);
 second.last_full_at=new Date(Date.now()-25*3600000).toISOString();f.fallback.RR_CANCEL_CURSOR=JSON.stringify(second);
 queries.length=0;f.ctx.dispatchClinicalNotifications();assert.ok(queries[0].includes('newer_than:180d'));assert.equal(f.state.runs.length,count+1);
});
test('failed scans and failed durable commits never advance the cursor',()=>{
 const f=appContext({cancellationOutage:true}),cursor=JSON.stringify({last_full_at:new Date().toISOString(),last_success_at:new Date().toISOString(),seen_ids:['prior']});
 f.fallback.RR_CANCEL_CURSOR=cursor;f.ctx.dispatchClinicalNotifications();assert.equal(f.fallback.RR_CANCEL_CURSOR,cursor);assert.equal(JSON.parse(f.fallback.RR_DIAG_DISPATCH).status,'HELD');
 const g=appContext({commitFailure:true});g.fallback.RR_CANCEL_CURSOR=cursor;
 assert.throws(()=>g.ctx.dispatchClinicalNotifications());assert.equal(g.fallback.RR_CANCEL_CURSOR,cursor);
});
test('ignored cancellation-message IDs are cached without retaining their body',()=>{
 let bodies=0;const message={getId:()=> 'other-program',getFrom:()=> 'donotreply@platinumed.com',getPlainBody(){bodies++;return 'Other Hospital marked themselves absent. Private text';}};
 const f=appContext({cancellationMessage:message});f.ctx.dispatchClinicalNotifications();f.ctx.dispatchClinicalNotifications();
 assert.equal(bodies,1);assert.ok(!f.fallback.RR_CANCEL_CURSOR.includes('Private text'));assert.ok(f.fallback.RR_CANCEL_CURSOR.includes('other-program'));
});
function seedHealthy(f,now=Date.now()) {
 f.fallback.RR_DIAG_DISPATCH=JSON.stringify({last_success_at:new Date(now).toISOString(),stage:'COMPLETED'});
 f.fallback.RR_CANCEL_CURSOR=JSON.stringify({last_success_at:new Date(now).toISOString()});
 f.fallback.RR_SCHEDULE_HEALTH=JSON.stringify({ingest_success_at:new Date(now).toISOString(),sites:['Brewster Ambulance Service Lee County','Brewster Ambulance Service Collier'].map(site=>({site,published_at:new Date(now).toISOString()}))});
}
test('independent health check needs no Sheets access and stays silent when healthy',()=>{
 const f=appContext({storageFailure:true});seedHealthy(f);f.ctx.SpreadsheetApp.openById=()=>{throw Error('Health must not load Sheets');};
 assert.equal(f.ctx.checkClinicalDeliveryHealth().status,'HEALTHY');assert.equal(f.fallback.RR_DELIVERY_HEALTH,undefined);
});
test('stale dispatch, stale scan and overdue work are detected independently',()=>{
 const f=appContext(),now=Date.now(),config=f.ctx.clinicalConfig_(),props=f.ctx.PropertiesService.getScriptProperties();
 seedHealthy(f,now-16*60000);assert.equal(f.ctx.clinicalDeliveryHealth_(config,props,now).issues.length,2);
 seedHealthy(f,now);const d=JSON.parse(f.fallback.RR_DIAG_DISPATCH);d.next_due_at=new Date(now-11*60000).toISOString();f.fallback.RR_DIAG_DISPATCH=JSON.stringify(d);
 const result=f.ctx.clinicalDeliveryHealth_(config,props,now);assert.equal(result.issues.length,1);assert.match(result.issues[0],/overdue/);
});
test('health incidents deduplicate, recover silently, and alert once for a new incident',()=>{
 const f=appContext(),p=f.ctx.PropertiesService.getScriptProperties().getProperties();p.RUN_MODE='PRODUCTION';p.PRODUCTION_CUTOVER_APPROVED='true';p.LIVE_EMAIL='true';
 let sent=0;f.ctx.GmailApp.createDraft=(to,subject)=>{assert.equal(to,p.OWNER_EMAIL);assert.match(subject,/RR-HEALTH/);return {getId:()=> 'draft',send(){assert.equal(JSON.parse(f.fallback.RR_DELIVERY_HEALTH).status,'SENDING');sent++;return {getId:()=> 'message'+sent};}};};
 f.ctx.checkClinicalDeliveryHealth();f.ctx.checkClinicalDeliveryHealth();assert.equal(sent,1);
 seedHealthy(f);f.ctx.checkClinicalDeliveryHealth();assert.equal(sent,1);assert.equal(JSON.parse(f.fallback.RR_DELIVERY_HEALTH).status,'RESOLVED');
 f.fallback.RR_DIAG_DISPATCH='{}';f.ctx.checkClinicalDeliveryHealth();assert.equal(sent,2);assert.equal(JSON.parse(f.fallback.RR_DELIVERY_HEALTH).cycle,2);
});
test('uncertain health sends never retry automatically and maintenance stays quiet',()=>{
 const f=appContext(),p=f.ctx.PropertiesService.getScriptProperties().getProperties();p.RUN_MODE='PRODUCTION';p.PRODUCTION_CUTOVER_APPROVED='true';p.LIVE_EMAIL='true';
 let drafts=0;f.ctx.GmailApp.createDraft=()=>{drafts++;return {getId:()=> 'draft',send(){throw Error('Unknown outcome');}};};
 assert.throws(()=>f.ctx.checkClinicalDeliveryHealth());f.ctx.checkClinicalDeliveryHealth();assert.equal(drafts,1);assert.equal(JSON.parse(f.fallback.RR_DELIVERY_HEALTH).status,'UNCERTAIN');
 const g=appContext(),q=g.ctx.PropertiesService.getScriptProperties().getProperties();q.RUN_MODE='PRODUCTION';q.PRODUCTION_CUTOVER_APPROVED='true';q.LIVE_EMAIL='false';
 g.ctx.checkClinicalDeliveryHealth();assert.equal(g.fallback.RR_DELIVERY_HEALTH,undefined);
});
test('delivery health remains independent of a dispatcher holding the script lock',()=>{
 const f=appContext({busy:true});assert.equal(f.ctx.checkClinicalDeliveryHealth().status,'ATTENTION');
 assert.equal(JSON.parse(f.fallback.RR_DELIVERY_HEALTH).status,'DRY_RUN');
 const g=appContext({healthBusy:true});assert.equal(g.ctx.checkClinicalDeliveryHealth().status,'SKIPPED_LOCK');assert.equal(g.fallback.RR_DELIVERY_HEALTH,undefined);
});
test('invalid or future cancellation cursors force a safe full reconciliation',()=>{
 for(const cursor of [{last_success_at:'broken',last_full_at:'broken'},{last_success_at:'2099-01-01T00:00:00Z',last_full_at:new Date().toISOString()}]) {
  const f=appContext(),queries=[];f.fallback.RR_CANCEL_CURSOR=JSON.stringify(cursor);f.ctx.GmailApp.search=q=>{queries.push(q);return [];};
  f.ctx.dispatchClinicalNotifications();assert.ok(queries[0].includes('newer_than:180d'));
 }
});
test('lightweight health preserves missing-ingestion and weekly-calendar monitoring',()=>{
 const f=appContext(),now=Date.now();seedHealthy(f,now);
 const summary=JSON.parse(f.fallback.RR_SCHEDULE_HEALTH);summary.ingest_success_at=new Date(now-27*3600000).toISOString();summary.sites[0].published_at=new Date(now-10*86400000).toISOString();f.fallback.RR_SCHEDULE_HEALTH=JSON.stringify(summary);
 const result=f.ctx.checkClinicalDeliveryHealth();assert.ok(result.issues.some(i=>i.includes('ingestion')));assert.ok(result.issues.some(i=>i.includes('Lee County')));
});
test('session rebuilds views once and diagnostic health never advances failed dispatch success',()=>{
 const f=appContext({cancellationOutage:true});let projects=0;f.ctx.ClinicalLedger.prototype.project=()=>projects++;
 f.ctx.dispatchClinicalNotifications();assert.equal(projects,1);const d=JSON.parse(f.fallback.RR_DIAG_DISPATCH);assert.equal(d.status,'HELD');assert.equal(d.last_success_at,undefined);
});
test('changed projection hashes persist even when the ledger mutates the cached map',()=>{
 const f=appContext(),now=new Date().toISOString();f.fallback.RR_VIEW_HASHES=JSON.stringify({at:now,full_at:now,hashes:{TEST:'before'}});
 f.ctx.ClinicalLedger.prototype.project=function(){this.projectionHashes.TEST='after';};
 f.ctx.clinicalSession_(()=>{});assert.equal(JSON.parse(f.fallback.RR_VIEW_HASHES).hashes.TEST,'after');
});
test('daily full view repair is not postponed by frequent incremental view changes',()=>{
 const f=appContext();f.fallback.RR_VIEW_HASHES=JSON.stringify({at:new Date().toISOString(),full_at:new Date(Date.now()-25*3600000).toISOString(),hashes:{}});
 let forced;f.ctx.ClinicalLedger.prototype.project=(_state,force)=>{forced=force;};f.ctx.clinicalSession_(()=>{});assert.equal(forced,true);
});
