/* Install only in the isolated staging project, never in production. No new
 * scopes or triggers. Manually verify the staging Triggers page is empty.
 */
function stagingDiagnosticsGuard_() {
  const p=PropertiesService.getScriptProperties();
  if(p.getProperty('RUN_MODE')!=='TEST'||p.getProperty('LIVE_EMAIL')!=='false'||
     p.getProperty('SPREADSHEET_ID')!=='1Sht9j8u06FE-S1s2DGDBExoM9AVX0aQ_zupDkJb8l3Y')throw Error('STAGING_ONLY');
}
function stagingDiagnosticsFailure() {
  stagingDiagnosticsGuard_();
  clinicalSession_((_state,env)=>env.op('STAGING_INJECTED_FAILURE',()=>{throw Error('STAGING_DIAGNOSTIC_FAILURE');}),'DISPATCH');
}
function stagingDiagnosticsRecovery() {
  stagingDiagnosticsGuard_();dispatchClinicalNotifications();
}
function stagingDiagnosticsEvidence() {
  stagingDiagnosticsGuard_();const p=PropertiesService.getScriptProperties();
  const heartbeat=clinicalJSON_(p.getProperty('RR_DIAG_DISPATCH'),{});
  const keys=p.getKeys().filter(k=>/^RR_EXEC_[a-z0-9-]+$/.test(k));
  const evidence=keys.map(k=>clinicalJSON_(p.getProperty(k),{}));
  console.info(JSON.stringify({release:CLINICAL_RELEASE_,mode:p.getProperty('RUN_MODE'),live_email:p.getProperty('LIVE_EMAIL'),
    heartbeat,executions:evidence}));
}
