/* Offline comparison and dispatch simulation. No external-service adapters. */
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const E=require('../apps_script/Engine.gs');
const fixtures=path.resolve(process.argv[2]),output=path.resolve(process.argv[3]);
const read=file=>JSON.parse(fs.readFileSync(path.join(fixtures,file),'utf8'));
const hash=s=>crypto.createHash('sha256').update(String(s)).digest('hex');
const rows=[],tables={};
for(const tab of ['Students','Archive']) {
 const data=read('full-roster-'+tab+'.json').values;tables[tab]=data;const h=data[0];
 data.slice(1).filter(r=>r.some(v=>v!=='')).forEach((r,i)=>rows.push({first_name:r[h.indexOf('First Name')],last_name:r[h.indexOf('Last Name')],email:r[h.indexOf('Email')],cohort:r[h.indexOf('Cohort/Class #')],source_tab:tab,source_row:i+2,status:tab==='Archive'?'ARCHIVED':'ACTIVE'}));
}
tables.Manual_Email_Queue=read('Manual_Email_Queue.json').values;
const ss={getSheetByName(tab){const values=tables[tab];return {getDataRange:()=>({getValues:()=>values}),getLastRow:()=>values.length,getRange:(row,col,count,width)=>({getValues:()=>values.slice(row-1,row-1+count).map(r=>r.slice(col-1,col-1+width))})};}};
let current;
const old=vm.createContext({Date,Logger:{log(){}},Session:{getScriptTimeZone:()=> 'America/New_York'},Utilities:{formatDate:(d,tz)=>new Intl.DateTimeFormat('en-US',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).format(d)},
 UrlFetchApp:{fetch:()=>({getResponseCode:()=>200,getContentText:()=>JSON.stringify(current)})}});
vm.runInContext(fs.readFileSync(path.resolve(fixtures,'../baseline/Code.gs'),'utf8'),old);
const db=old.loadStudentDatabase_(ss),truth=read('verified-corpus.json'),baseline=[];
const env={hash,now:Date.parse('2026-10-24T06:00:00Z'),activationAt:Date.parse('2026-10-24T04:00:00Z'),timezone:'America/New_York',owner:'owner@example.test',to:['scheduling@example.test'],liveEmail:true,expectedSites:[],reviewLink:id=>'https://example.test/'+id};
const registry=[],roster=E.buildRoster(rows,registry,env);let rosterMatched=0,total=0,unmatched=0,surfaced=0;
for(const [filename,expected] of Object.entries(truth.fixtures)) {
 current=read(filename.replace('.pdf','-baseline.json'));
 const info=old.parseCalendarAttachmentInfo_('Calendar-RickyRescue-BrewsterAmbulanceService'+(filename.startsWith('collier')?'Collie':'LeeCou')+'-202610-202611.pdf');
 const r=old.parseShiftsFromPythonEngine_({copyBlob:()=> 'mock'},db,filename,info);
 baseline.push({fixture:filename,emitted:r.shifts.length,expected:expected.length});
 const parsed=JSON.parse(fs.readFileSync(path.join(output,filename+'.json')));
 const isolated=E.init({});E.ingest(isolated,env,{message_id:filename,attachment_id:'0',sha256:parsed.source_sha256,received_at:parsed.generated_at},parsed,roster);
 for(const shift of parsed.shifts){total++;if(E.match(shift.student_name,roster).status==='MATCHED')rosterMatched++;
 else {unmatched++;if(isolated.reviews.some(r=>r.category==='UNMATCHED_STUDENT'&&r.student_name===shift.student_name&&r.date===shift.date))surfaced++;}}
}
const state=E.init({students:registry});
const parsed=JSON.parse(fs.readFileSync(path.join(output,'lee_current.pdf.json')));
E.ingest(state,env,{message_id:'simulation',attachment_id:'0:lee.pdf',sha256:parsed.source_sha256,filename:'lee.pdf',received_at:'2026-10-24T05:49:58Z'},parsed,roster);
const sent=[];const transport={prepare:(_mail,id)=>id,sendPrepared(id){sent.push({id,at:env.now});return id;},findAccepted:()=>null};
for(let now=env.now;now<Date.parse('2026-11-09T23:00:00Z');now+=300000){env.now=now;E.dispatch(state,env,transport,()=>{});E.dispatch(state,env,transport,()=>{});}
const due=state.notifications.filter(n=>n.type==='SCHEDULED'&&n.status!=='HISTORICAL');
const summary={baseline,baseline_expected:baseline.reduce((a,r)=>a+r.expected,0),baseline_emitted:baseline.reduce((a,r)=>a+r.emitted,0),
 roster_exact_unique_matches:rosterMatched,roster_expected:total,auto_match_coverage:rosterMatched/total,unmatched_observations:unmatched,unmatched_surfaced:surfaced,invalid_roster_rows_surfaced:roster.issues.length,
 notification_simulation:{expected:due.length,accepted:sent.length,missed:due.filter(n=>n.status!=='API_ACCEPTED').length,duplicates:sent.length-new Set(sent.map(s=>s.id)).size,
 max_delay_ms:Math.max(...sent.map(s=>s.at-Date.parse(due.find(n=>n.id===s.id).due_at)))},
 scope:'Local simulation only, six upcoming reference shifts; one historical shift suppressed at cutover. No real email or spreadsheet calls.'};
fs.writeFileSync(path.join(output,'comparison.json'),JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify(summary,null,2));
if(rosterMatched/total<.9||surfaced!==unmatched||sent.length!==6||summary.notification_simulation.missed||summary.notification_simulation.duplicates)process.exit(1);
