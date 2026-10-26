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
   values.forEach((r,i)=>r.forEach((v,j)=>{sheet.data[row+i-1]??=[];sheet.data[row+i-1][col+j-1]=v;}));return this;},
  getValues(){return Array.from({length:height},(_,i)=>Array.from({length:width},(_,j)=>sheet.data[row+i-1]?.[col+j-1]??''));},
  setValue(v){return this.setValues([[v]]);}
 };}
 getDataRange(){return this.getRange(1,1,this.getLastRow(),Math.max(...this.data.map(r=>r.length),1));}
 getLastRow(){return this.data.length;}
 getMaxRows(){return this.max;}
 insertRowsAfter(_row,count){this.max+=count;}
 setFrozenRows(){}
 clearContents(){this.data=[];}
 getSheetId(){return this.gid;}
}
class Spreadsheet{
 constructor(){this.sheets=new Map();this.fault=null;}
 getSheetByName(n){return this.sheets.get(n)||null;}
 insertSheet(n){const s=new Sheet(n,this);this.sheets.set(n,s);return s;}
 getUrl(){return 'https://docs.google.com/spreadsheets/d/TEST/edit';}
 getSpreadsheetTimeZone(){return 'America/New_York';}
}
function ledger(){
 const ctx=vm.createContext({ClinicalEngine:E,SpreadsheetApp:{flush(){}}});vm.runInContext(fs.readFileSync(__dirname+'/../apps_script/Ledger.gs','utf8')+'\nthis.Store=ClinicalLedger;',ctx);
 const ss=new Spreadsheet();return {ss,make:()=>new ctx.Store(ss,sha)};
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
  load(){if(options.storageFailure)throw Error('Sheets unavailable');return state;}save(){}project(){}reviewLink(id){return 'https://example.test/'+id;}
 }
 const ctx=vm.createContext({ClinicalEngine:E,ClinicalLedger:Store,console,
  PropertiesService:{getScriptProperties:()=>({getProperties:()=>props,getProperty:k=>fallback[k],setProperty:(k,v)=>{fallback[k]=v;}})},Logger:{log(){}},
  LockService:{getScriptLock:()=>({tryLock(){locked++;return !options.busy;},releaseLock(){released++;}})},
  SpreadsheetApp:{openById(id){assert.equal(id,'TEST');return ss;}},
  Session:{getScriptTimeZone:()=> 'America/New_York',getEffectiveUser:()=>({getEmail:()=> 'owner@example.test'})},
  Utilities:{getUuid:()=>crypto.randomUUID(),DigestAlgorithm:{SHA_256:'sha256'},Charset:{UTF_8:'UTF-8'},computeDigest(_alg,value,charset){return [...crypto.createHash('sha256').update(typeof value==='string'?(charset==='UTF-8'?value:value.replace(/[^\x00-\x7F]/g,'?')):Buffer.from(value)).digest()];}},
  GmailApp:{search(_q,start){return start===0?[{getMessages:()=>[message]}]:[];},createDraft(){throw Error('REAL MAIL FORBIDDEN');}},
  DriveApp:{getFolderById(id){assert.equal(id,'TEST_FOLDER');return {getFilesByName:()=>({hasNext:()=>false}),createFile:()=>({getId:()=> 'archive1'})};}},
  UrlFetchApp:{fetch(){fetches++;if(options.outage)throw Error('Render outage');return {getResponseCode:()=>options.http||200,getContentText:()=>options.invalidJSON?'{broken':JSON.stringify({schema_version:2,parser_version:'2',source_sha256:crypto.createHash('sha256').update(Buffer.from([1,2,3])).digest('hex'),
   generated_at:'2026-10-17T08:00:00-04:00',coverage:[{location:'Brewster Ambulance Service Lee County',start:'2026-10-18',end:'2026-11-21'}],coverage_complete:true,status:'complete',shifts:[],errors:[],unresolved_blocks:[]})};}}
 });
 vm.runInContext(fs.readFileSync(__dirname+'/../apps_script/Code.gs','utf8'),ctx);
 return {ctx,state,ss,fallback,stats:()=>({released,fetches,locked})};
}
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
 const failures=Object.values(f.fallback).map(JSON.parse);assert.equal(failures.length,1);assert.equal(failures[0].status,'DRY_RUN');assert.equal(f.stats().released,1);
});
test('legacy migration preserves raw rows and does not promote pending queue items',()=>{
 const f=appContext();f.ss.insertSheet('Clinical_Log').getRange(1,1,2,5).setValues([['UniqueKey','Shift Date','Student Name','Location','Email Sent Date'],['old','10/18/2026','Example Student','Lee County','10/17/2026']]);
 f.ss.insertSheet('Manual_Email_Queue').getRange(1,1,2,5).setValues([['Status','Shift Date','Student Name','Location','Email'],['APPROVED','10/19/2026','Example Student','Lee County','student@example.test']]);
 f.ctx.stageClinicalLegacyHistory();assert.equal(f.state.legacy.length,2);assert.equal(f.state.legacy[1].state,'LEGACY_REVIEW_ONLY');assert.equal(f.state.shifts.length,0);
 assert.equal(f.state.legacy[0].date,'2026-10-18');assert.equal(f.state.legacy[1].date,'');
});
