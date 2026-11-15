/* STAGING ONLY. Manual runners; never install in production. No new scopes or
 * triggers. Core source remains the pinned PR #8 candidate. Fault injection
 * changes invocation-local functions only and always restores them in finally.
 */
function stagingPR8Guard_() {
  const p=PropertiesService.getScriptProperties();
  if(p.getProperty('RUN_MODE')!=='TEST'||p.getProperty('LIVE_EMAIL')!=='false'||
     p.getProperty('SPREADSHEET_ID')!=='1Sht9j8u06FE-S1s2DGDBExoM9AVX0aQ_zupDkJb8l3Y'||
     CLINICAL_RELEASE_!=='ledger-budget-recovery-v1')throw Error('STAGING_ONLY');
  return p;
}
function stagingPR8Assert_(ok,label) {if(!ok)throw Error('STAGING_ASSERT:'+label);}
function stagingPR8Ledger_() {
  const p=stagingPR8Guard_(),ss=SpreadsheetApp.openById(p.getProperty('SPREADSHEET_ID'));
  const store=new ClinicalLedger(ss,clinicalHash_);
  return {state:store.load(),head:JSON.stringify(ss.getSheetByName('RR_V2_Head').getRange(2,1,1,4).getValues())};
}
function stagingPR8Drafts_() {return clinicalHash_(JSON.stringify(GmailApp.getDrafts().map(d=>d.getId()).sort()));}
function stagingPR8NormalRun() {
  const p=stagingPR8Guard_(),before=stagingPR8Ledger_(),drafts=stagingPR8Drafts_();
  const original=clinicalTransport_;let forbidden=0;
  clinicalTransport_=env=>Object.assign({},original(env),{
    prepare(){forbidden++;throw Error('STAGING_REAL_MAIL_FORBIDDEN');},
    sendPrepared(){forbidden++;throw Error('STAGING_REAL_MAIL_FORBIDDEN');}
  });
  try {
    ingestClinicalCalendars();
    stagingPR8Assert_(clinicalJSON_(p.getProperty('RR_DIAG_INGEST'),{}).status==='COMPLETED','normal_ingest');
    dispatchClinicalNotifications();
    stagingPR8Assert_(clinicalJSON_(p.getProperty('RR_DIAG_DISPATCH'),{}).status==='COMPLETED','normal_dispatch');
    const health=checkClinicalDeliveryHealth();
    stagingPR8Assert_(['HEALTHY','ATTENTION'].includes(health.status),'health_executed');
    const after=stagingPR8Ledger_();
    stagingPR8Assert_(JSON.stringify(after.state.attempts)===JSON.stringify(before.state.attempts),'no_send_attempt');
    stagingPR8Assert_(forbidden===0&&drafts===stagingPR8Drafts_(),'no_mail_or_draft');
    console.info(JSON.stringify({test:'PR8_NORMAL',result:'PASS',release:CLINICAL_RELEASE_,
      ingest:'COMPLETED',dispatch:'COMPLETED',health:health.status,health_issues:health.issues,
      forbidden_transport_calls:forbidden,attempts_unchanged:true,drafts_unchanged:true,
      ledger_verified:true,mode:'TEST',live_email:false}));
  } finally {clinicalTransport_=original;}
}
function stagingPR8BudgetSuite() {
  const p=stagingPR8Guard_(),before=stagingPR8Ledger_(),drafts=stagingPR8Drafts_();
  const prior=clinicalJSON_(p.getProperty('RR_DIAG_DISPATCH'),{}),cursor=p.getProperty('RR_CANCEL_CURSOR');
  const fatalKeys=()=>p.getKeys().filter(k=>k.startsWith('RR_FATAL_')).sort().join(',');
  const fatalBefore=fatalKeys(),originalRead=clinicalRead_;let processed=false,readPrevented=false;
  try {
    clinicalRead_=(label,fn,context)=>originalRead(label,fn,label==='LEDGER_HEAD_READ'?
      Object.assign({},context,{shouldStop:()=>true}):context);
    const outcome=clinicalSession_(()=>{processed=true;},'DISPATCH');
    const deferred=clinicalJSON_(p.getProperty('RR_DIAG_DISPATCH'),{});
    stagingPR8Assert_(outcome===false&&!processed&&deferred.status==='DEFERRED','preload_deferred');
    stagingPR8Assert_(deferred.last_success_at===prior.last_success_at,'old_success_retained');
    stagingPR8Assert_(deferred.next_due_at===prior.next_due_at&&deferred.uncertain_count===prior.uncertain_count,'delivery_evidence_retained');
    stagingPR8Assert_(p.getProperty('RR_CANCEL_CURSOR')===cursor&&fatalKeys()===fatalBefore,'no_cursor_or_fatal_change');
    const retained=clinicalJSON_(p.getProperty('RR_EXEC_'+deferred.run_id),{});
    stagingPR8Assert_(retained.status==='DEFERRED','retained_execution');
    clinicalRead_=originalRead;
    stagingPR8Assert_(stagingPR8Ledger_().head===before.head,'deferred_head_unchanged');
    try {originalRead('STAGING_EXPIRED_READ',()=>{readPrevented=true;},{shouldStop:()=>true});}
    catch(error){stagingPR8Assert_(error.code==='CLINICAL_EXECUTION_BUDGET','typed_deadline');}
    stagingPR8Assert_(!readPrevented,'expired_read_not_called');
    console.info(JSON.stringify({test:'PR8_PRELOAD_DEFER',result:'PASS',run_id:deferred.run_id,
      old_success_retained:true,head_unchanged:true,cursor_unchanged:true,no_fatal_alert:true,retained_execution:true}));
  } finally {clinicalRead_=originalRead;}

  // Existing core health logic, fictional small-properties adapter only.
  const now=Date.now(),memory={};
  const fake={getProperty:k=>memory[k]||null,setProperty:(k,v)=>{memory[k]=v;}};
  memory.RR_DIAG_DISPATCH=JSON.stringify({last_success_at:new Date(now-16*60000).toISOString(),next_due_at:new Date(now-11*60000).toISOString()});
  memory.RR_CANCEL_CURSOR=JSON.stringify({last_success_at:new Date(now-16*60000).toISOString()});
  const config=clinicalConfig_();
  memory.RR_SCHEDULE_HEALTH=JSON.stringify({ingest_success_at:new Date(now).toISOString(),sites:config.expectedSites.map(site=>({site,published_at:new Date(now).toISOString()}))});
  const attention=clinicalDeliveryHealth_(config,fake,now);
  stagingPR8Assert_(attention.status==='ATTENTION'&&attention.issues.some(x=>/dispatcher/.test(x))&&attention.issues.some(x=>/overdue/.test(x)),'persistent_outage_detected');
  stagingPR8Assert_(JSON.parse(memory.RR_DELIVERY_HEALTH).status==='DRY_RUN','health_no_mail');
  memory.RR_DIAG_DISPATCH=JSON.stringify({last_success_at:new Date(now).toISOString()});
  memory.RR_CANCEL_CURSOR=JSON.stringify({last_success_at:new Date(now).toISOString()});
  stagingPR8Assert_(clinicalDeliveryHealth_(config,fake,now).status==='HEALTHY'&&JSON.parse(memory.RR_DELIVERY_HEALTH).status==='RESOLVED','silent_health_recovery');
  console.info(JSON.stringify({test:'PR8_HEALTH_FAULT',result:'PASS',stale_and_overdue_detected:true,dry_run:true,silent_recovery:true}));

  // No actual committed cell is corrupted. Real ledger validation receives a
  // fictional sheet adapter, then real post-load/ingestion error paths run
  // against the isolated staging workbook with email disabled.
  for(const kind of ['partial','checksum']) {
    const rows=kind==='partial'?['bad','','','']:['0'.repeat(64),'RR_V2_Chunks_A',2,1];
    const head={getRange:()=>({getValues:()=>[rows]})};
    const chunks={getRange:()=>({getValues:()=>[['0'.repeat(64),0,'J:{}']]})};
    let rejected=false;
    try {new ClinicalLedger({getSheetByName:name=>name==='RR_V2_Head'?head:chunks},clinicalHash_).load();}
    catch(error){rejected=kind==='partial'?/Invalid ledger commit pointer/.test(String(error)):/checksum mismatch/.test(String(error));}
    stagingPR8Assert_(rejected,'integrity_'+kind);
  }
  for(const kind of ['DISPATCH','INGEST']) {
    let failed=false;
    try {clinicalSession_(()=>originalRead('STAGING_POSTLOAD_DEADLINE',()=>{}, {shouldStop:()=>true}),kind);}
    catch(error){failed=error.code==='CLINICAL_EXECUTION_BUDGET';}
    stagingPR8Assert_(failed&&clinicalJSON_(p.getProperty('RR_DIAG_'+kind),{}).status==='FAILED','postload_'+kind);
    const id=clinicalHash_('Error: Execution budget exhausted before STAGING_POSTLOAD_DEADLINE');
    const record=clinicalJSON_(p.getProperty('RR_FATAL_'+id),{});
    stagingPR8Assert_(record.status==='DRY_RUN'&&record.category==='EXECUTION_BUDGET_EXHAUSTED','actionable_failure_dry_run');
  }
  console.info(JSON.stringify({test:'PR8_FAIL_CLOSED',result:'PASS',partial_pointer_rejected:true,checksum_rejected:true,postload_and_ingest_failed:true,owner_record:'DRY_RUN'}));
  dispatchClinicalNotifications();
  stagingPR8Assert_(clinicalJSON_(p.getProperty('RR_DIAG_DISPATCH'),{}).status==='COMPLETED','dispatch_recovers');
  const after=stagingPR8Ledger_();
  stagingPR8Assert_(JSON.stringify(after.state.attempts)===JSON.stringify(before.state.attempts),'no_attempts_after_faults');
  stagingPR8Assert_(drafts===stagingPR8Drafts_(),'no_drafts_after_faults');
  console.info(JSON.stringify({test:'PR8_BUDGET_SUITE',result:'PASS',release:CLINICAL_RELEASE_,ledger_verified:true,
    dispatch_recovered:true,attempts_unchanged:true,drafts_unchanged:true,mode:'TEST',live_email:false}));
}
