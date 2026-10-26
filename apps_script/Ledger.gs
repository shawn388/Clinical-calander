/* Two-bank chunk snapshots. One head update commits a whole state version.
 * Interrupted writes touch only the inactive bank. Every logical historical
 * record is retained; superseded full-state copies are overwritten, not history.
 * RR_V2_* sheets are new; legacy tracker/log/queue tabs are never rewritten.
 */
var ClinicalLedger = class {
  constructor(spreadsheet,hash) {this.ss=spreadsheet;this.hash=hash;this.digest=null;this.bank=null;this.reviewRows={};}
  sheet(name,headers) {
    let sheet=this.ss.getSheetByName(name);
    if (!sheet) {sheet=this.ss.insertSheet(name);sheet.getRange(1,1,1,headers.length).setValues([headers]);sheet.setFrozenRows(1);}
    return sheet;
  }
  ensure(sheet,last) {if(last>sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(),last-sheet.getMaxRows());}
  load() {
    const head=this.sheet('RR_V2_Head',['SHA256','Bank','First chunk row','Chunk count']);
    if(head.getLastRow()<2) return ClinicalEngine.init({});
    const [digest,bank,start,count]=head.getRange(2,1,1,4).getValues()[0];
    if(!digest || !['RR_V2_Chunks_A','RR_V2_Chunks_B'].includes(bank)||!Number.isInteger(start)||!Number.isInteger(count)||start!==2||count<1) throw Error('Invalid ledger commit pointer');
    const chunks=this.sheet(bank,['Snapshot SHA256','Index','JSON fragment']).getRange(start,1,count,3).getValues();
    if(chunks.some((r,i)=>r[0]!==digest||r[1]!==i)) throw Error('Incomplete ledger snapshot');
    if(chunks.some(r=>!String(r[2]).startsWith('J:'))) throw Error('Invalid ledger fragment encoding');
    const serialized=chunks.map(r=>r[2].slice(2)).join('');
    if(this.hash(serialized)!==digest) throw Error('Ledger snapshot checksum mismatch');
    this.digest=digest;this.bank=bank;
    return ClinicalEngine.init(JSON.parse(serialized));
  }
  save(state) {
    const serialized=JSON.stringify(state),digest=this.hash(serialized);
    if(digest===this.digest) return;
    const chunks=[];
    for(let i=0;i<serialized.length;) {
      let end=Math.min(serialized.length,i+35000);
      if(end<serialized.length&&/[\uD800-\uDBFF]/.test(serialized[end-1])) end--;
      chunks.push([digest,chunks.length,'J:'+serialized.slice(i,end)]);i=end;
    }
    const bank=this.bank==='RR_V2_Chunks_A'?'RR_V2_Chunks_B':'RR_V2_Chunks_A';
    const sheet=this.sheet(bank,['Snapshot SHA256','Index','JSON fragment']);
    sheet.clearContents();sheet.getRange(1,1,1,3).setValues([['Snapshot SHA256','Index','JSON fragment']]);
    const start=2;
    this.ensure(sheet,start+chunks.length-1);
    sheet.getRange(start,1,chunks.length,3).setValues(chunks);
    SpreadsheetApp.flush();
    this.sheet('RR_V2_Head',['SHA256','Bank','First chunk row','Chunk count']).getRange(2,1,1,4).setValues([[digest,bank,start,chunks.length]]);
    SpreadsheetApp.flush();
    this.digest=digest;this.bank=bank;
  }
  projection(name,headers,rows) {
    const sheet=this.sheet(name,headers);
    const safe=rows.map(row=>row.map(v=>{
      const s=String(v==null?'':v);return /^[=+@-]/.test(s)?"'"+s:s;
    }));
    this.ensure(sheet,safe.length+1);
    sheet.clearContents();sheet.getRange(1,1,1,headers.length).setValues([headers]);
    if(safe.length) sheet.getRange(2,1,safe.length,headers.length).setValues(safe);
    return sheet;
  }
  project(state) {
    const r=this.projection('RR_V2_Reviews',['Review ID','Status','Category','Student/PDF','Shift date','Reason','Resolve','Blocking','Created','Last seen'],
      state.reviews.map(r=>[r.id,r.status,r.category,r.student_name||r.source_pdf||r.source_id,r.date,r.reason,r.instructions,r.blocking,r.created_at,r.last_seen]));
    state.reviews.forEach((v,i)=>{this.reviewRows[v.id]=i+2;});this.reviewGid=r.getSheetId();
    this.projection('RR_V2_Shifts',['Shift ID','Revision','Status','Student ID','Student','Roster status','Email','Date','Start','End','Timezone','Location','Source ID'],
      state.shifts.map(s=>[s.id,s.revision,s.status,s.student_id,s.student_name,s.roster_status,s.student_email,s.date,s.start_time,s.end_time,s.timezone,s.location,s.source_id]));
    for(const name of ['sources','extracted','history','notifications','attempts','runs','students']) {
      this.projection('RR_V2_'+name[0].toUpperCase()+name.slice(1),['Record ID','JSON view (full data in committed ledger)'],
        state[name].map(r=>{const json=JSON.stringify(r);return [r.id,json.length>44000?json.slice(0,44000)+' [VIEW TRUNCATED; full record in active RR_V2_Chunks bank]':json];}));
    }
    // One row per date across every accepted month, including empty dates.
    const dates=new Set();state.sources.filter(s=>s.status==='APPLIED').forEach(s=>s.coverage.forEach(c=>{
      for(let t=Date.parse(c.start+'T12:00:00Z');t<=Date.parse(c.end+'T12:00:00Z');t+=86400000) dates.add(new Date(t).toISOString().slice(0,10));
    }));
    this.projection('RR_V2_Visual_Calendar',['Month','Date','Verified shifts'],Array.from(dates).sort().map(d=>[d.slice(0,7),d,
      state.shifts.filter(s=>s.date===d&&s.status==='ACTIVE').map(s=>s.start_time+'-'+s.end_time+' '+s.student_name+' ['+s.location+']').join('\n')||'(No verified shifts)']));
  }
  reviewLink(id) {
    if(!this.reviewRows[id]) throw Error('Review projection missing for '+id);
    return this.ss.getUrl()+'#gid='+this.reviewGid+'&range=A'+this.reviewRows[id]+':J'+this.reviewRows[id];
  }
};
if(typeof module!=='undefined') module.exports=ClinicalLedger;
