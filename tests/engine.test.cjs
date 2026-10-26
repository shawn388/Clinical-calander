const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const vm=require('node:vm');
const E=require('../apps_script/Engine.gs');
const hash=s=>crypto.createHash('sha256').update(String(s)).digest('hex');
function setup(){
 const env={hash,now:Date.parse('2026-10-17T12:00:00Z'),timezone:'America/New_York',liveEmail:true,
   owner:'owner@example.test',to:['scheduling@example.test'],expectedSites:['Brewster Ambulance Service Lee County'],reviewLink:id=>'https://example.test/review/'+id};
 const state=E.init({}),roster=E.buildRoster([{student_id:'s1',first_name:'Example',last_name:'Student',email:'student@example.test',status:'ACTIVE',source_tab:'Students',source_row:2}],state.students,env);
 return {env,state,roster};
}
function shift(date='2026-10-18',name='Example Student',time='08:00'){
 return {date,student_name:name,location:'Brewster Ambulance Service Lee County',start_time:time,end_time:'20:00',
   start_at:date+'T'+time+':00-04:00',end_at:date+'T20:00:00-04:00',timezone:'America/New_York',confidence:{level:'verified'},source_page:1,bbox:[1,2,3,4],raw_text:name};
}
function feed(f,shifts=[shift()],version='2026-10-10T10:00:00Z',tag='a',overrides={}){
 const source={message_id:tag,attachment_id:'0:same.pdf',sha256:hash(tag),filename:'same.pdf',received_at:version};
 const result=Object.assign({schema_version:2,parser_version:'2',source_sha256:source.sha256,generated_at:version,status:'complete',coverage_complete:true,
   coverage:[{location:shift().location,start:'2026-10-18',end:'2026-11-21'}],shifts,errors:[],unresolved_blocks:[]},overrides);
 return E.ingest(f.state,f.env,source,result,f.roster);
}
function transport(){const t={prepared:[],sent:[],prepare(mail,id){this.prepared.push({mail,id});return id;},sendPrepared(id){this.sent.push(id);return 'message-'+id;},findAccepted(id){return this.sent.includes(id)?'message-'+id:null;}};return t;}
function flush(f,t=transport()){let persisted=0;E.dispatch(f.state,f.env,t,()=>persisted++);return {t,persisted};}

test('joins explicit roster fields; punctuation, whitespace, case, reversed names',()=>{
 const f=setup();assert.equal(E.match(' STUDENT, example ',f.roster).status,'MATCHED');assert.equal(E.match('student example',f.roster).status,'MATCHED');
 assert.equal(E.match('Example',f.roster).status,'UNMATCHED');
 const roster=E.buildRoster([{first_name:'Anne-Marie',last_name:"O’Neil",email:'a@example.test',status:'ACTIVE'}],[],f.env);
 assert.equal(E.match('Anne Marie ONeil',roster).status,'MATCHED');
});
test('duplicate names across active/archive never overwrite one another',()=>{
 const f=setup();f.roster.push({...f.roster[0],id:'s2',status:'ARCHIVED'});
 assert.equal(E.match('Example Student',f.roster).status,'AMBIGUOUS');feed(f);
 assert.equal(f.state.shifts.length,0);assert.ok(f.state.reviews.some(r=>r.category==='AMBIGUOUS_STUDENT'));
});
test('confident archived match stays eligible and flags owner',()=>{
 const f=setup();f.roster[0].status='ARCHIVED';feed(f);assert.equal(f.state.shifts.length,1);
 assert.ok(f.state.reviews.some(r=>r.category==='ARCHIVED_STUDENT'&&!r.blocking));
});
test('unmatched and missing-email entries persist with actionable owner events',()=>{
 const f=setup();feed(f,[shift('2026-10-18','Unknown Person')]);assert.equal(f.state.extracted.length,1);
 assert.equal(f.state.shifts.length,0);assert.ok(f.state.notifications.some(n=>n.type==='OWNER_EXCEPTION'));
 const g=setup();g.roster[0].email='';feed(g);assert.ok(g.state.reviews.some(r=>r.category==='MISSING_STUDENT_EMAIL'));
});
test('approved aliases target unique immutable student IDs',()=>{
 const f=setup();f.state.aliases=[{normalized:E.norm('Nickname Person'),student_id:'s1',approved_at:'2026-10-16'}];
 feed(f,[shift('2026-10-18','Nickname Person')]);assert.equal(f.state.shifts[0].student_id,'s1');
});
test('unresolved import can reprocess successfully after roster correction',()=>{
 const f=setup();feed(f,[shift('2026-10-18','Unknown Person')]);f.state.aliases=[{normalized:'unknown person',student_id:'s1',approved_at:'2026-10-16'}];
 assert.equal(feed(f,[shift('2026-10-18','Unknown Person')]).status,'APPLIED');assert.equal(f.state.shifts.length,1);
 assert.ok(f.state.reviews.filter(r=>r.blocking).every(r=>r.status==='RESOLVED'));
});
test('repeat imports do not duplicate shifts or notifications',()=>{
 const f=setup();feed(f);assert.equal(feed(f).status,'DUPLICATE');assert.equal(f.state.shifts.length,1);assert.equal(f.state.notifications.length,1);
});
test('same filename with changed hash is a distinct revision',()=>{
 const f=setup();feed(f);feed(f,[shift('2026-10-19')],'2026-10-16T10:00:00Z','b');
 assert.equal(f.state.sources.length,2);assert.equal(f.state.shifts.length,1);assert.equal(f.state.shifts[0].date,'2026-10-19');assert.equal(f.state.shifts[0].revision,2);
});
test('older calendar cannot add or cancel over a newer empty authoritative window',()=>{
 const f=setup();feed(f,[],'2026-10-16T10:00:00Z','new');feed(f,[shift()],'2026-10-10T10:00:00Z','old');assert.equal(f.state.shifts.length,0);
});
test('equal-generation different content requires review',()=>{
 const f=setup();feed(f);feed(f,[],'2026-10-10T10:00:00Z','conflict');
 assert.equal(f.state.shifts[0].status,'ACTIVE');assert.ok(f.state.reviews.some(r=>r.category==='SOURCE_CONFLICT'));
});
test('complete absence cancels; partial or low-confidence absence cannot cancel',()=>{
 for(const complete of [true,false]){
  const f=setup();feed(f);feed(f,[],'2026-10-16T10:00:00Z','b',{coverage_complete:complete,status:complete?'complete':'needs_review',errors:complete?[]:[{category:'LOW_CONFIDENCE',reason:'Missing page'}]});
  assert.equal(f.state.shifts[0].status,complete?'CANCELLED':'ACTIVE');
 }
});
test('dates outside rolling coverage remain unchanged',()=>{
 const f=setup();feed(f);feed(f,[],'2026-10-16T10:00:00Z','b',{coverage:[{location:shift().location,start:'2026-10-25',end:'2026-11-21'}]});assert.equal(f.state.shifts[0].status,'ACTIVE');
});
test('multiple shifts on the same day remain separate',()=>{
 const f=setup();feed(f,[shift(),{...shift('2026-10-18','Example Student','21:00'),end_time:'23:00',end_at:'2026-10-18T23:00:00-04:00'}]);assert.equal(f.state.shifts.length,2);
});
test('ambiguous many-to-many reschedules leave the entire prior schedule intact',()=>{
 const f=setup();feed(f,[shift('2026-10-18'),shift('2026-10-19')]);feed(f,[shift('2026-10-20'),shift('2026-10-21')],'2026-10-16T10:00:00Z','b');
 assert.deepEqual(f.state.shifts.map(s=>s.date),['2026-10-18','2026-10-19']);assert.ok(f.state.reviews.some(r=>r.category==='AMBIGUOUS_RESCHEDULE'));
});
test('dispatcher runs from persisted shifts without fetching Gmail or PDFs',()=>{
 const f=setup();feed(f);const t=transport();flush(f,t);flush(f,t);assert.equal(t.sent.length,1);assert.equal(f.state.attempts[0].status,'API_ACCEPTED');
 assert.equal(f.state.notifications[0].status,'API_ACCEPTED');assert.ok(!('delivered_at' in f.state.notifications[0]));
});
test('notification is due exactly 24 elapsed hours before start, not tomorrow-only',()=>{
 const f=setup();feed(f);f.env.now=Date.parse('2026-10-17T11:59:59Z');const t=transport();flush(f,t);assert.equal(t.sent.length,0);
 f.env.now+=1000;flush(f,t);assert.equal(t.sent.length,1);
});
test('24-hour calculation handles daylight-saving transition',()=>{
 const f=setup();feed(f,[{...shift('2026-11-01'),start_at:'2026-11-01T08:00:00-05:00',end_at:'2026-11-01T20:00:00-05:00'}]);
 assert.equal(f.state.notifications[0].due_at,'2026-10-31T13:00:00.000Z');
});
test('previously notified reschedule issues one correction and supersedes old due events',()=>{
 const f=setup();feed(f);const t=transport();flush(f,t);feed(f,[shift('2026-10-19')],'2026-10-17T11:00:00Z','b');flush(f,t);flush(f,t);
 assert.equal(t.sent.length,2);assert.equal(f.state.notifications.filter(n=>n.type==='RESCHEDULED').length,1);
 assert.match(t.prepared[1].mail.body,/Previously: 2026-10-18/);
});
test('previously notified cancellation issues correction; unnotified cancellation sends nothing',()=>{
 const f=setup();feed(f);const t=transport();flush(f,t);feed(f,[],'2026-10-17T11:00:00Z','b');flush(f,t);
 assert.equal(t.sent.length,2);assert.match(t.prepared[1].mail.body,/cancelled/);
 const g=setup();feed(g);feed(g,[],'2026-10-17T11:00:00Z','b');assert.equal(flush(g).t.sent.length,0);
});
test('missed shift never sends a stale schedule email and creates exception',()=>{
 const f=setup();feed(f);f.env.now=Date.parse('2026-10-18T13:00:00Z');const {t}=flush(f);assert.equal(t.sent.length,0);
 assert.ok(f.state.reviews.some(r=>r.category==='MISSED_NOTIFICATION'));
});
test('dry run never prepares drafts or sends mail',()=>{
 const f=setup();feed(f);f.env.liveEmail=false;const {t}=flush(f);assert.equal(t.sent.length,0);assert.equal(t.prepared.length,0);assert.equal(f.state.notifications[0].status,'DRY_RUN');
});
test('safe pre-send failures retry with durable attempts and backoff',()=>{
 const f=setup();feed(f);const t=transport();let first=true;const prepare=t.prepare;t.prepare=function(...args){if(first){first=false;throw Error('quota');}return prepare.apply(this,args);};
 flush(f,t);assert.equal(f.state.notifications[0].status,'RETRY');assert.equal(t.sent.length,0);
 f.env.now+=180000;flush(f,t);assert.equal(f.state.notifications[0].status,'API_ACCEPTED');assert.equal(f.state.attempts.filter(a=>a.event_id===f.state.notifications[0].id).length,2);
});
test('uncertain send outcome never automatically retries',()=>{
 const f=setup();feed(f);const t=transport();t.sendPrepared=()=>{throw Error('connection lost');};flush(f,t);assert.equal(f.state.notifications[0].status,'UNCERTAIN');
 const count=t.prepared.length;f.env.liveEmail=false;flush(f,t);assert.equal(t.prepared.length,count);
 assert.ok(f.state.reviews.some(r=>r.category==='NOTIFICATION_UNCERTAIN'));
});
test('crash after acceptance before persistence recovers from durable sent evidence',()=>{
 const f=setup();feed(f);const t=transport();let disk;
 assert.throws(()=>E.dispatch(f.state,f.env,t,s=>{if(s.notifications[0].status==='API_ACCEPTED')throw Error('power loss');disk=JSON.parse(JSON.stringify(s));}));
 assert.equal(disk.notifications[0].status,'SENDING');f.state=disk;flush(f,t);assert.equal(t.sent.length,1);assert.equal(f.state.notifications[0].status,'API_ACCEPTED');
});
test('send is never attempted if the durable claim cannot be saved',()=>{
 const f=setup();feed(f);const t=transport();assert.throws(()=>E.dispatch(f.state,f.env,t,()=>{throw Error('storage down');}));assert.equal(t.sent.length,0);
});
test('owner alerts include category, identity, date, link, and resolution',()=>{
 const f=setup();feed(f,[shift('2026-10-18','Unknown Person')]);const {t}=flush(f);
 assert.ok(t.sent.length>0);const mail=t.prepared[0].mail;for(const text of ['Category:','Student/PDF:','Shift date:','Reason:','Review record: https://','Resolve:']) assert.ok(mail.body.includes(text));
 assert.deepEqual(mail.to,['owner@example.test']);
});
test('watchdog deduplicates recurring alerts and creates one daily summary',()=>{
 const f=setup();E.monitor(f.state,f.env);const alerts=f.state.notifications.length;E.monitor(f.state,f.env);assert.equal(f.state.notifications.length,alerts);
 f.env.now+=86400000;E.monitor(f.state,f.env);assert.equal(f.state.notifications.filter(n=>n.type==='OWNER_EXCEPTION').length,2);assert.equal(f.state.notifications.filter(n=>n.type==='OWNER_SUMMARY').length,2);
});
test('watchdog can send owner alerts independently without sending shift notices',()=>{
 const f=setup();feed(f);E.monitor(f.state,f.env);f.env.ownerOnly=true;const {t}=flush(f);assert.ok(t.sent.length>0);assert.equal(f.state.notifications[0].status,'PENDING');
});
test('all detected parser errors and unresolved blocks have persistent reviews',()=>{
 const f=setup();const categories=['INVALID_DATE','LOW_CONFIDENCE','TEXTLESS_PAGE','EVENT_GEOMETRY'];
 feed(f,[],'2026-10-10T10:00:00Z','bad',{status:'needs_review',coverage_complete:false,errors:categories.map(category=>({category,reason:'injected '+category}))});
 for(const category of categories)assert.ok(f.state.reviews.some(r=>r.category===category));
 assert.ok(f.state.reviews.every(r=>f.state.notifications.some(n=>n.review_id===r.id)));
});
test('invalid dates, hashes and low-confidence shift contracts fail closed',()=>{
 const f=setup();feed(f,[{...shift(),date:'2026-02-30',start_at:'2026-02-30T08:00:00-04:00'}]);assert.equal(f.state.shifts.length,0);
 const g=setup();feed(g,[{...shift(),confidence:{level:'low'}}]);assert.equal(g.state.shifts.length,0);
 assert.throws(()=>feed(setup(),[shift()],'2026-10-10T10:00:00Z','bad',{source_sha256:'forged'}));
});
test('real tracker snapshot matches names via explicit fields in local-only integration',t=>{
 const p=process.env.RR_PRIVATE_FIXTURES||require('node:path').resolve(__dirname,'../../review/evidence');
 if(!fs.existsSync(p+'/full-roster-Students.json'))return t.skip('Private fixtures not installed');
 const f=setup(),rows=[];
 for(const tab of ['Students','Archive']){
  const values=JSON.parse(fs.readFileSync(p+'/full-roster-'+tab+'.json')).values,h=values[0];
  values.slice(1).forEach((r,i)=>rows.push({first_name:r[h.indexOf('First Name')],last_name:r[h.indexOf('Last Name')],email:r[h.indexOf('Email')],cohort:r[h.indexOf('Cohort/Class #')],source_tab:tab,source_row:i+2,status:tab==='Archive'?'ARCHIVED':'ACTIVE'}));
 }
 const roster=E.buildRoster(rows,[],f.env),expected=JSON.parse(fs.readFileSync(p+'/lee-current-expected.json')).entries;
 for(const entry of expected)assert.equal(E.match(entry.student_name,roster).status,'MATCHED');
});

test('configuration refuses production workbook or live email in TEST mode',()=>{
 const text=fs.readFileSync(require('node:path').resolve(__dirname,'../apps_script/Code.gs'),'utf8');
 const p={RUN_MODE:'TEST',SPREADSHEET_ID:'synthetic-production',PRODUCTION_SPREADSHEET_ID:'synthetic-production'};
 const ctx=vm.createContext({PropertiesService:{getScriptProperties:()=>({getProperties:()=>p})}});vm.runInContext(text,ctx);
 assert.throws(()=>ctx.clinicalConfig_(),/production workbook/);p.SPREADSHEET_ID='test';p.LIVE_EMAIL='true';assert.throws(()=>ctx.clinicalConfig_(),/forbidden/);
});
test('malformed roster rows surface issues without destroying valid records',()=>{
 const f=setup();const r=E.buildRoster([{first_name:'Missing',last_name:'',source_tab:'Archive',source_row:9},{first_name:'Valid',last_name:'Person',email:'v@example.test',status:'ACTIVE'}],[],f.env);
 assert.equal(r.length,1);assert.equal(r.issues[0].category,'INVALID_ROSTER_ROW');
});
test('email changes cannot silently create a new identity without an immutable ID',()=>{
 const f=setup(),registry=[];const row={first_name:'Valid',last_name:'Person',email:'v@example.test',cohort:'C1'};
 E.buildRoster([row],registry,f.env);const changed=E.buildRoster([{...row,email:'new@example.test'}],registry,f.env);
 assert.equal(changed.length,0);assert.equal(changed.issues[0].category,'STUDENT_ID_REVIEW');
});
test('cutover suppresses historical backfill and holds uncertain legacy send identity',()=>{
 const f=setup();f.env.activationAt=Date.parse('2026-10-19T00:00:00Z');feed(f);assert.equal(f.state.notifications[0].status,'HISTORICAL');assert.equal(flush(f).t.sent.length,0);
 const g=setup();g.state.legacy=[{name_normalized:'example student',date:'2026-10-18',location:shift().location}];feed(g);assert.equal(g.state.notifications[0].status,'LEGACY_REVIEW');assert.ok(flush(g).t.prepared.every(p=>p.mail.to[0]==='owner@example.test'));
});
test('explicit stable identity retains a corrected email on an unchanged future shift',()=>{
 const f=setup();feed(f);f.roster[0].email='updated@example.test';feed(f,[shift()],'2026-10-16T11:00:00Z','updated');
 const {t}=flush(f);assert.equal(t.sent.length,1);assert.equal(t.prepared[0].mail.cc,'updated@example.test');
});
test('cross-site change with exact student/time evidence retains identity and sends a correction',()=>{
 const f=setup();feed(f);const oldId=f.state.shifts[0].id,t=transport();flush(f,t);
 feed(f,[],'2026-10-17T09:00:00Z','cancel');
 const destination='Brewster Ambulance Service Collier';
 feed(f,[{...shift(),location:destination}],'2026-10-17T10:00:00Z','new-site',{coverage:[{location:destination,start:'2026-10-18',end:'2026-11-21'}]});
 assert.equal(f.state.shifts.find(s=>s.id===oldId).location,destination);
 assert.equal(f.state.shifts.filter(s=>s.status==='ACTIVE').length,1);
 flush(f,t);assert.equal(t.sent.length,2);assert.match(t.prepared[1].mail.body,/rescheduled/);assert.match(t.prepared[1].mail.body,/Previously:.*Lee County/);
});
test('Unicode names retain their identity instead of collapsing to an empty key',()=>{
 const f=setup(),roster=E.buildRoster([{first_name:'李',last_name:'王',email:'s@example.test',status:'ACTIVE'}],[],f.env);
 assert.equal(E.match('李 王',roster).status,'MATCHED');assert.equal(E.match('張 趙',roster).status,'UNMATCHED');
});
test('reused Student ID with different names cannot silently merge two people',()=>{
 const f=setup(),roster=E.buildRoster([{student_id:'duplicate',first_name:'One',last_name:'Person',email:'one@example.test'},{student_id:'duplicate',first_name:'Two',last_name:'Person',email:'two@example.test'}],[],f.env);
 assert.equal(E.match('One Person',roster).status,'AMBIGUOUS');assert.ok(roster.issues.some(r=>r.category==='DUPLICATE_STUDENT_ID'));
});
test('reschedule corrections wait for resolution of a prior uncertain send',()=>{
 const f=setup();feed(f);const t=transport();t.sendPrepared=()=>{throw Error('unknown outcome');};flush(f,t);
 feed(f,[shift('2026-10-19')],'2026-10-17T11:00:00Z','changed');
 const correction=f.state.notifications.find(n=>n.type==='RESCHEDULED');assert.ok(correction);
 const next=transport();flush(f,next);assert.ok(next.prepared.every(p=>p.mail.to[0]==='owner@example.test'));assert.equal(correction.status,'PENDING');
});
test('a verified correction to a previously notified shift is not discarded after its date',()=>{
 const f=setup();feed(f);const t=transport();flush(f,t);f.env.now=Date.parse('2026-10-20T12:00:00Z');
 feed(f,[shift('2026-10-19')],'2026-10-20T10:00:00Z','late-correction');flush(f,t);
 assert.equal(t.sent.length,2);assert.equal(f.state.notifications.find(n=>n.type==='RESCHEDULED').status,'API_ACCEPTED');
});
