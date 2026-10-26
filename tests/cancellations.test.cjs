const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const E=require('../apps_script/Engine.gs');
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const location='Brewster Ambulance Service Lee County';
const body=(name='Example Student',date='10/28/2026',clock='07:00 until 19:00 CDT',site='Brewster Ambulance Service: Lee County Station')=>`${name} (Student) has marked themselves absent for '${site}' on ${date} from ${clock}. Comments: Private comments must not be retained`;
function fixture(){
 const state=E.init({}),env={hash,now:Date.parse('2026-10-27T13:00:00Z'),activationAt:Date.parse('2026-10-26T04:00:00Z'),timezone:'America/New_York',owner:'owner@example.test',to:['scheduling@example.test'],liveEmail:true,reviewLink:id=>'https://example.test/'+id};
 const roster=[{id:'s1',name:'Example Student',normalized:'example student',email:'student@example.test',status:'ACTIVE'}];
 const shift={id:'ride1',student_id:'s1',student_name:'Example Student',student_email:'student@example.test',location,date:'2026-10-28',start_time:'08:00',end_time:'20:00',start_at:'2026-10-28T08:00:00-04:00',end_at:'2026-10-28T20:00:00-04:00',timezone:'America/New_York',confidence:{level:'verified'},revision:1,status:'ACTIVE'};
 state.shifts.push(shift);state.notifications.push({id:'notice1',shift_id:shift.id,revision:1,type:'SCHEDULED',status:'PENDING',shift:{...shift},due_at:'2026-10-27T12:00:00Z',to:env.to,cc:shift.student_email});
 const message={id:'mail1',received_at:'2026-10-27T12:30:00Z',authenticated:true,body:body()};
 const sent=[],transport={prepare(mail,id){return {mail,id};},sendPrepared(draft){sent.push(draft);return 'provider-'+draft.id;},findAccepted(){return null;}};
 return {state,env,roster,shift,message,sent,transport,cancel(){return E.ingestCancellation(state,env,message,roster);},flush(){E.dispatch(state,env,transport,()=>{});}};
}
test('Platinum absence converts explicit Central time to the same Eastern ride instant',()=>{
 const parsed=E.parseCancellation('Platinum Planner\nStudent Marked Absent\n\n'+body());
 assert.equal(parsed.start_at,'2026-10-28T12:00:00.000Z');assert.equal(parsed.end_at,'2026-10-29T00:00:00.000Z');assert.equal(parsed.date,'2026-10-28');
 assert.equal(E.parseCancellation(body('Example Student','11/8/2026','07:00 until 19:00 CST')).start_at,'2026-11-08T13:00:00.000Z');
});
test('unsupported time zones, impossible dates and multiple statements never guess',()=>{
 for(const text of [body().replace('CDT','PDT'),body().replace('10/28/2026','2/30/2026'),body()+'\n'+body()]) assert.throws(()=>E.parseCancellation(text));
 assert.deepEqual(E.parseCancellation(body('Example Student','10/28/2026','07:00 until 19:00 CDT','Other Hospital')),{ignored:true});
});
test('cancellation before reminder suppresses it without sending a cancellation email',()=>{
 const f=fixture();assert.equal(f.cancel().status,'APPLIED');f.flush();f.cancel();f.flush();
 assert.equal(f.shift.status,'CANCELLED');assert.equal(f.sent.length,0);assert.equal(f.state.cancellations.length,1);assert.equal(f.state.history.length,1);
 assert.ok(!JSON.stringify(f.state.cancellations).includes('Private comments'));
});
test('already notified cancellation sends exactly one professional correction before start',()=>{
 const f=fixture();f.state.notifications[0].status='API_ACCEPTED';f.cancel();f.flush();f.cancel();f.flush();
 assert.equal(f.sent.length,1);assert.match(f.sent[0].mail.subject,/Clinical Ride Cancellation/);assert.equal(f.sent[0].mail.cc,'student@example.test');
});
test('after-start absence remains historical and sends nothing',()=>{
 const f=fixture();f.state.notifications[0].status='API_ACCEPTED';f.env.now=Date.parse('2026-10-28T12:00:00Z');
 assert.equal(f.cancel().status,'HISTORICAL');f.flush();assert.equal(f.sent.length,0);
});
test('wrong student, site or time cannot cancel another ride',()=>{
 for(const text of [body('Unknown Student'),body().replace('07:00','06:00'),body('Example Student','10/28/2026','07:00 until 19:00 CDT','Brewster Ambulance Service: Collier')]) {
  const f=fixture();f.message.body=text;f.cancel();assert.equal(f.shift.status,'ACTIVE');
 }
});
test('unauthenticated or ambiguous upcoming messages hold reminders and alert owner',()=>{
 for(const kind of ['sender','identity','format']) {
  const f=fixture();if(kind==='sender')f.message.authenticated=false;
  if(kind==='identity')f.roster.push({...f.roster[0],id:'s2'});
  if(kind==='format')f.message.body='Brewster Ambulance Service: shift cancelled. Details unavailable';
  assert.equal(f.cancel().status,'REVIEW');f.flush();
  assert.ok(f.sent.length>0);assert.ok(f.sent.every(d=>d.mail.to[0]==='owner@example.test'));assert.equal(f.state.notifications[0].status,'PENDING');
 }
});
test('cancellation before a calendar arrives blocks that exact slot in later weekly PDFs',()=>{
 const f=fixture();f.state.shifts=[];f.state.notifications=[];
 assert.equal(f.cancel().status,'WAITING_FOR_CALENDAR');
 for(const [id,version] of [['week1','2026-10-26T12:00:00Z'],['week2','2026-10-27T12:00:00Z']]) {
  const source={message_id:id,attachment_id:'calendar',sha256:hash(id),received_at:version};
  E.ingest(f.state,f.env,source,{schema_version:2,source_sha256:source.sha256,parser_version:'2',generated_at:version,status:'complete',coverage_complete:true,errors:[],coverage:[{location,start:'2026-10-28',end:'2026-11-03'}],shifts:[{...f.shift}]},f.roster);
 }
 assert.equal(f.state.shifts.filter(s=>s.status==='ACTIVE').length,0);assert.equal(f.state.extracted.length,2);f.flush();assert.equal(f.sent.length,0);
});
test('stale weekly PDF cannot restore a ride cancelled from a message',()=>{
 const f=fixture();f.cancel();
 const source={message_id:'weekly',attachment_id:'calendar',sha256:hash('weekly'),received_at:'2026-10-27T12:00:00Z'};
 E.ingest(f.state,f.env,source,{schema_version:2,source_sha256:source.sha256,generated_at:source.received_at,status:'complete',coverage_complete:true,errors:[],coverage:[{location,start:'2026-10-28',end:'2026-11-03'}],shifts:[{...f.shift}]},f.roster);
 assert.equal(f.state.shifts.length,1);assert.equal(f.shift.status,'CANCELLED');f.flush();assert.equal(f.sent.length,0);
});
test('an approved alias can resolve a held cancellation without duplicate correction',()=>{
 const f=fixture();f.message.body=body('Approved Nickname');assert.equal(f.cancel().status,'REVIEW');
 f.state.aliases=[{normalized:'approved nickname',student_id:'s1',approved_at:'2026-10-26'}];assert.equal(f.cancel().status,'APPLIED');f.flush();
 assert.equal(f.sent.length,0);assert.ok(f.state.reviews.every(r=>r.status==='RESOLVED'));assert.equal(f.state.cancellations.length,1);
});
test('same student and date with conflicting times holds mail for review',()=>{
 const f=fixture();f.message.body=body().replace('07:00','06:00');assert.equal(f.cancel().status,'REVIEW');f.flush();
 assert.equal(f.shift.status,'ACTIVE');assert.ok(f.sent.every(d=>d.mail.to[0]==='owner@example.test'));assert.equal(f.state.notifications[0].status,'PENDING');
});
