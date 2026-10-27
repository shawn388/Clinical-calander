/* Pure scheduling logic. No Google services; all effects use injected adapters. */
var ClinicalEngine = (() => {
  'use strict';
  const tables = ['sources','extracted','shifts','history','notifications','attempts','reviews','runs','students','cancellations'];
  const clone = x => JSON.parse(JSON.stringify(x));
  const norm = x => String(x || '').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase()
    .replace(/[’']/g,'').replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');
  const emailOK = x => /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(String(x||''));
  const ms = x => { const value=Date.parse(x); if (!Number.isFinite(value)) throw Error('Invalid timestamp: '+x); return value; };
  const iso = x => new Date(x).toISOString();
  const init = state => { tables.forEach(t=>{ if (!state[t]) state[t]=[]; }); return state; };
  const key = (env,...parts) => env.hash(JSON.stringify(parts));
  const localDay = (now,tz) => new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));

  function silentReview(issue,env) {
    return issue.no_alert || ['ARCHIVED_STUDENT','LEGACY_MIGRATION_REVIEW'].includes(issue.category) ||
      (/^\d{4}-\d{2}-\d{2}$/.test(issue.date||'') && issue.date<localDay(Math.max(env.activationAt||-Infinity,env.now),env.timezone));
  }
  // A moved ride must be corrected before either the original or new start.
  const correctionCutoff = event => Math.min(ms(event.shift.start_at),event.previous?ms(event.previous.start_at):Infinity);

  function review(state,env,issue) {
    const id=key(env,'review',issue.dedupe_key||[issue.category,issue.source_id||'',issue.student_name||'',issue.shift_id||'',issue.date||'',issue.reason]);
    let item=state.reviews.find(r=>r.id===id);
    if (item) {
      item.last_seen=iso(env.now);item.occurrences++;
      if(item.status==='RESOLVED') {item.status='OPEN';item.cycle=(item.cycle||1)+1;
        if(!silentReview(issue,env)) state.notifications.push({id:key(env,'alert',id,item.cycle),type:'OWNER_EXCEPTION',review_id:id,status:'PENDING',due_at:iso(env.now),revision:item.cycle});}
      return item;
    }
    item=Object.assign({id,status:'OPEN',created_at:iso(env.now),last_seen:iso(env.now),occurrences:1,
      blocking:true,instructions:'Inspect the source PDF and roster, correct the source/identity, then reprocess. Resolve this review only after verifying the resulting shift.'},issue);
    const source=state.sources.find(s=>s.id===issue.source_id);
    if(source){item.source_pdf=source.filename;item.source_email_url='https://mail.google.com/mail/u/?authuser='+encodeURIComponent(env.owner)+'#all/'+source.message_id;
      if(source.archive_file_id)item.source_pdf_url='https://drive.google.com/file/d/'+source.archive_file_id+'/view';}
    state.reviews.push(item);
    if (!silentReview(issue,env)) state.notifications.push({id:key(env,'alert',id),type:'OWNER_EXCEPTION',review_id:id,status:'PENDING',due_at:iso(env.now),revision:1});
    return item;
  }

  function buildRoster(rows,registry,env) {
    const result=[];result.issues=[];const initialRegistry=registry.slice();
    rows.forEach(row=>{
      if (!norm(row.first_name) || !norm(row.last_name)) {result.issues.push({category:'INVALID_ROSTER_ROW',source_id:(row.source_tab||'Roster')+':'+row.source_row,reason:'Roster row lacks explicit First Name/Last Name'});return;}
      const full=norm(row.first_name+' '+row.last_name);
      const identity=JSON.stringify([full,norm(row.cohort),String(row.email||'').toLowerCase().trim()]);
      let known=registry.filter(r=>r.identity===identity);
      let id=row.student_id;
      if (!id && known.length===1) id=known[0].id;
      if(!id&&initialRegistry.some(r=>norm(r.initial_name)===full&&r.cohort===norm(row.cohort))) {
        result.issues.push({category:'STUDENT_ID_REVIEW',source_id:(row.source_tab||'Roster')+':'+row.source_row,student_name:row.first_name+' '+row.last_name,
          reason:'Name/cohort matches a registry identity but email changed. Assign the verified immutable Student ID before processing.'});return;
      }
      if (!id) id='student_'+key(env,identity);
      if (!registry.some(r=>r.id===id)) registry.push({id,identity,initial_name:row.first_name+' '+row.last_name,cohort:norm(row.cohort),created_at:iso(env.now)});
      result.push({id,name:row.first_name+' '+row.last_name,normalized:full,email:String(row.email||'').trim(),
        status:row.status,source_tab:row.source_tab,source_row:row.source_row,cohort:row.cohort||''});
    });
    for(const id of new Set(result.map(r=>r.id))) if(result.filter(r=>r.id===id).length>1) result.issues.push({category:'DUPLICATE_STUDENT_ID',source_id:id,reason:'One immutable Student ID appears in multiple roster records; identity requires review'});
    return result;
  }

  function match(name,roster,aliases=[]) {
    const approved=aliases.filter(a=>a.normalized===norm(name)&&a.approved_at);
    if(approved.length) {
      const targets=roster.filter(r=>approved.some(a=>a.student_id===r.id));
      if(approved.length!==1||targets.length!==1) return {status:'AMBIGUOUS',candidates:targets.map(r=>r.id)};
      return {status:'MATCHED',student:targets[0],candidates:[targets[0].id]};
    }
    let value=String(name||'').trim();
    if (value.includes(',')) {
      const parts=value.split(',');
      if (parts.length!==2) return {status:'UNMATCHED',candidates:[]};
      value=parts[1]+' '+parts[0];
    }
    const n=norm(value);
    if(!n) return {status:'UNMATCHED',candidates:[]};
    let candidates=roster.filter(r=>r.normalized===n);
    // Only an exact two-token reversal is permitted as a secondary alias.
    if (!candidates.length && n.split(' ').length===2) {
      const reversed=n.split(' ').reverse().join(' ');
      candidates=roster.filter(r=>r.normalized===reversed);
    }
    if(candidates.length===1&&roster.filter(r=>r.id===candidates[0].id).length!==1) return {status:'AMBIGUOUS',candidates:roster.filter(r=>r.id===candidates[0].id).map(r=>r.id)};
    if (candidates.length!==1) return {status:candidates.length?'AMBIGUOUS':'UNMATCHED',candidates:candidates.map(r=>r.id)};
    return {status:'MATCHED',student:candidates[0],candidates:[candidates[0].id]};
  }

  function validateShift(s) {
    if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s.date||'') || !s.student_name || !s.location || s.timezone!=='America/New_York') throw Error('Missing/invalid structured shift fields');
    if (!/^\d{2}:\d{2}$/.test(s.start_time||'') || !/^\d{2}:\d{2}$/.test(s.end_time||'')) throw Error('Missing shift clock times');
    const [year,month,day]=s.date.split('-').map(Number),check=new Date(Date.UTC(year,month-1,day));
    if (check.getUTCFullYear()!==year||check.getUTCMonth()!==month-1||check.getUTCDate()!==day) throw Error('Impossible date');
    if (ms(s.end_at)<=ms(s.start_at) || ms(s.end_at)-ms(s.start_at)>25*3600000 || !String(s.start_at).startsWith(s.date+'T'+s.start_time) || String(s.end_at).slice(11,16)!==s.end_time) throw Error('Invalid shift date/time interval');
    if (!s.confidence || s.confidence.level!=='verified') throw Error('Shift extraction requires review');
  }

  function covered(source,shift) {
    return source.coverage.some(c=>c.location===shift.location && c.start<=shift.date && shift.date<=c.end);
  }

  function notification(state,env,shift,type,old) {
    const id=key(env,'notice',shift.id,shift.revision,type,env.to,shift.student_email);
    if (state.notifications.some(n=>n.id===id)) return;
    const due=type==='SCHEDULED'?ms(shift.start_at)-24*3600000:env.now;
    const legacy=(state.legacy||[]).some(r=>r.name_normalized===norm(shift.student_name)&&r.date===shift.date&&r.location===shift.location);
    const historical=type==='SCHEDULED'?ms(shift.start_at)<(env.activationAt||-Infinity):correctionCutoff({shift,previous:old})<=env.now;
    const status=historical?'HISTORICAL':type==='SCHEDULED'&&legacy?'LEGACY_REVIEW':'PENDING';
    state.notifications.push({id,type,shift_id:shift.id,revision:shift.revision,status,due_at:iso(due),
      shift:clone(shift),previous:old?clone(old):null,to:env.to.slice(),cc:shift.student_email});
    if(status==='LEGACY_REVIEW') review(state,env,{category:'LEGACY_SEND_REVIEW',shift_id:shift.id,date:shift.date,student_name:shift.student_name,
      reason:'Legacy log records a notification on this date/site without a stable timed identity. Verify the prior message before releasing event '+id});
  }

  function previouslyNotified(state,id) {
    return state.notifications.some(n=>n.shift_id===id && n.status==='API_ACCEPTED' && !n.type.startsWith('OWNER'));
  }

  function suppress(state,id) {
    state.notifications.filter(n=>n.shift_id===id && ['PENDING','RETRY','DRY_RUN'].includes(n.status)).forEach(n=>n.status='SUPERSEDED');
  }

  function parseCancellation(body) {
    const text=String(body||'').replace(/\r\n?/g,'\n');
    const pattern=/(?:^|\n)([^\n]+?) \(Student\) has marked themselves absent for '([^'\n]+)' on (\d{1,2})\/(\d{1,2})\/(\d{4}) from (\d{2}:\d{2}) until (\d{2}:\d{2}) (EDT|EST|CDT|CST)\.(?=\s*(?:Comments:|$))/g;
    const matches=[...text.matchAll(pattern)];
    if(matches.length!==1) throw Error('Unsupported or multiple cancellation statements; verify the original Platinum message');
    const m=matches[0],sites={'Brewster Ambulance Service: Lee County Station':'Brewster Ambulance Service Lee County','Brewster Ambulance Service: Collier':'Brewster Ambulance Service Collier'};
    if(!sites[m[2]]) {if(!/^Brewster Ambulance Service/i.test(m[2])) return {ignored:true};throw Error('Unrecognized Brewster site');}
    const date=m[5]+'-'+m[3].padStart(2,'0')+'-'+m[4].padStart(2,'0'),check=new Date(date+'T00:00:00Z');
    if(!Number.isFinite(check.getTime())||check.toISOString().slice(0,10)!==date) throw Error('Invalid cancellation date');
    if(![m[6],m[7]].every(t=>/^([01]\d|2[0-3]):[0-5]\d$/.test(t))) throw Error('Invalid cancellation clock time');
    const offset={EDT:'-04:00',EST:'-05:00',CDT:'-05:00',CST:'-06:00'}[m[8]];
    const start=ms(date+'T'+m[6]+':00'+offset);
    let end=ms(date+'T'+m[7]+':00'+offset);if(end<=start) end+=86400000;
    // Preserve the explicit provider offset; compare instants, never clock labels.
    return {student_name:m[1].trim(),location:sites[m[2]],date:localDay(start,'America/New_York'),start_at:iso(start),end_at:iso(end),provider_timezone:m[8]};
  }
  const cancelledSlot = (state,shift) => state.cancellations.some(c=>c.student_id===shift.student_id&&c.location===shift.location&&
    ['APPLIED','WAITING_FOR_CALENDAR'].includes(c.status)&&ms(c.start_at)===ms(shift.start_at)&&ms(c.end_at)===ms(shift.end_at));

  function ingestCancellation(state,env,message,roster) {
    init(state);
    let record=state.cancellations.find(c=>c.message_id===message.id);
    if(record&&record.status!=='REVIEW') return record;
    const sourceUrl='https://mail.google.com/mail/u/?authuser='+encodeURIComponent(env.owner)+'#all/'+message.id;
    if(!record) {record={id:key(env,'cancellation',message.id),message_id:message.id,body_sha256:env.hash(message.body),received_at:message.received_at,source_email_url:sourceUrl,status:'REVIEW'};state.cancellations.push(record);}
    try {
      if(!message.authenticated) throw Error('Sender authentication could not be verified');
      const parsed=parseCancellation(message.body);
      if(parsed.ignored) {record.status='OUTSIDE_PROGRAM';return record;}
      Object.assign(record,parsed);
      // A post-start absence changes history only and cannot create an alert.
      if(ms(parsed.start_at)<=env.now) {
        record.status='HISTORICAL';
        state.reviews.filter(r=>r.source_id===record.id&&r.status==='OPEN').forEach(r=>{r.status='RESOLVED';r.resolved_at=iso(env.now);r.resolution='Ride already started; retained without notification';});
        return record;
      }
      const identity=match(parsed.student_name,roster,state.aliases||[]);
      if(identity.status!=='MATCHED') throw Error('Cancellation student identity is '+identity.status.toLowerCase());
      record.student_id=identity.student.id;
      const candidates=state.shifts.filter(s=>s.status==='ACTIVE'&&s.student_id===record.student_id&&s.location===parsed.location&&ms(s.start_at)===ms(parsed.start_at)&&ms(s.end_at)===ms(parsed.end_at));
      if(candidates.length>1) throw Error('Multiple active shifts match the cancellation');
      if(!candidates.length&&state.shifts.some(s=>s.status==='ACTIVE'&&s.student_id===record.student_id&&s.date===parsed.date)) throw Error('Student has a ride on this date but site or times differ; verify the exact cancelled slot');
      record.status=candidates.length?'APPLIED':'WAITING_FOR_CALENDAR';record.verified_at=iso(env.now);
      for(const shift of candidates) {
        const previous=clone(shift),sent=previouslyNotified(state,shift.id)||state.notifications.some(n=>n.shift_id===shift.id&&['UNCERTAIN','LEGACY_REVIEW','PREPARING','SENDING'].includes(n.status));
        suppress(state,shift.id);shift.status='CANCELLED';shift.revision++;shift.cancellation_id=record.id;
        state.history.push({id:key(env,'email-cancel',record.id,shift.id),shift_id:shift.id,type:'CANCELLED',previous,next:clone(shift),at:iso(env.now),cancellation_id:record.id});
        if(sent) notification(state,env,shift,'CANCELLED',previous);
      }
      state.reviews.filter(r=>r.source_id===record.id&&r.status==='OPEN').forEach(r=>{r.status='RESOLVED';r.resolved_at=iso(env.now);r.resolution='Verified cancellation matched deterministically';});
    } catch(error) {
      // Old unsupported messages are kept without flooding historical alerts.
      record.status=ms(message.received_at)<(env.activationAt||-Infinity)?'HISTORICAL_UNPARSED':'REVIEW';record.reason=String(error);
      if(record.status==='REVIEW') review(state,env,{category:'CANCELLATION_REVIEW',source_id:record.id,source_email_url:sourceUrl,
        student_name:record.student_name,date:record.date,reason:record.reason,instructions:'Inspect the original Platinum message. Correct an approved student alias and retry, or dismiss this cancellation with documented evidence. Upcoming reminders are held until unresolved cancellation reviews are cleared.'});
    }
    return record;
  }

  function reconcileSiteChanges(state,env) {
    // Exact student/start/end evidence can link a verified cancellation at one
    // site to an addition at another. Calendars must share a publication day.
    const active=state.shifts.filter(s=>s.status==='ACTIVE');
    for(const old of state.shifts.filter(s=>s.status==='CANCELLED')) {
      const cancelled=state.history.filter(h=>h.shift_id===old.id&&h.type==='CANCELLED').slice(-1)[0];
      const source=state.sources.find(s=>s.id===old.source_id&&s.status==='APPLIED');
      if(!cancelled||!source||old.cancellation_id) continue;
      const candidates=active.filter(s=>s.student_id===old.student_id&&s.start_at===old.start_at&&s.end_at===old.end_at&&s.location!==old.location&&
        state.sources.some(src=>src.id===s.source_id&&src.status==='APPLIED'&&src.version_at.slice(0,10)===source.version_at.slice(0,10)));
      if(candidates.length!==1) continue;
      const added=candidates[0];
      if(state.shifts.filter(s=>s.status==='CANCELLED'&&s.student_id===added.student_id&&s.start_at===added.start_at&&s.end_at===added.end_at).length!==1) continue;
      const previous=clone(cancelled.previous),wasSent=previouslyNotified(state,old.id)||state.notifications.some(n=>n.shift_id===old.id&&['UNCERTAIN','LEGACY_REVIEW','PREPARING','SENDING'].includes(n.status));
      suppress(state,old.id);suppress(state,added.id);
      const revision=old.revision+1;
      Object.assign(old,clone(added),{id:old.id,revision,status:'ACTIVE'});
      added.status='SUPERSEDED';added.superseded_by=old.id;
      state.history.push({id:key(env,'site-change',old.id,revision),shift_id:old.id,type:'RESCHEDULED',previous,next:clone(old),at:iso(env.now),source_id:old.source_id});
      notification(state,env,old,wasSent?'RESCHEDULED':'SCHEDULED',wasSent?previous:null);
    }
  }

  function ingest(state,env,source,result,roster) {
    init(state);
    if (!source.message_id || !source.attachment_id || !/^[a-f0-9]{64}$/.test(source.sha256||'')) throw Error('Source identity/hash required');
    const id=key(env,source.message_id,source.attachment_id,source.sha256);
    let prior=state.sources.find(s=>s.id===id);
    // Reprocess a previously unresolved source after an approved roster correction.
    if (prior && prior.status==='APPLIED') return {status:'DUPLICATE',source_id:id};
    if (result.schema_version!==2 || result.source_sha256!==source.sha256 || !Array.isArray(result.shifts) || !Array.isArray(result.coverage) || !Array.isArray(result.errors)) throw Error('Invalid parser v2 response/hash');
    const src=Object.assign({},source,{id,coverage:result.coverage,complete:result.coverage_complete===true && result.status==='complete' && result.errors.length===0,
      version_at:result.generated_at||source.received_at,parser_version:result.parser_version,status:'REVIEW',imported_at:iso(env.now)});
    ms(src.version_at);
    if (prior) Object.assign(prior,src); else state.sources.push(src);
    const current=prior||src;
    result.errors.forEach(e=>review(state,env,Object.assign({},e,{source_id:id})));
    (result.unresolved_blocks||[]).forEach(e=>review(state,env,Object.assign({},e,{category:e.category||'UNRESOLVED_BLOCK',source_id:id})));
    let safe=src.complete;
    if(!result.generated_at||ms(src.version_at)>env.now+3600000) {
      safe=false;review(state,env,{category:'SOURCE_VERSION',source_id:id,reason:'Missing or future generation timestamp'});
    }
    const matched=[];
    result.shifts.forEach((raw,index)=>{
      const extractedId=key(env,id,index);
      let m={status:'INVALID',candidates:[]};
      try {validateShift(raw); m=match(raw.student_name,roster,state.aliases||[]);}
      catch(e) {review(state,env,{category:'INVALID_SHIFT',source_id:id,date:raw.date,student_name:raw.student_name,reason:String(e)});safe=false;}
      const record={id:extractedId,source_id:id,raw:clone(raw),match_status:m.status,candidates:m.candidates};
      const existing=state.extracted.find(e=>e.id===extractedId);
      if (existing) Object.assign(existing,record); else state.extracted.push(record);
      if (m.status!=='MATCHED') {
        safe=false;
        review(state,env,{category:m.status+'_STUDENT',source_id:id,date:raw.date,student_name:raw.student_name,
          reason:'Student identity is '+m.status.toLowerCase(),candidate_ids:m.candidates});
        return;
      }
      const student=m.student;
      if (!emailOK(student.email)) {
        safe=false;review(state,env,{category:'MISSING_STUDENT_EMAIL',source_id:id,date:raw.date,student_name:raw.student_name,reason:'Matched student has no valid email'});
      }
      if (student.status==='ARCHIVED') review(state,env,{category:'ARCHIVED_STUDENT',source_id:id,date:raw.date,student_name:student.name,reason:'Confident match is archived; scheduling remains enabled',blocking:false});
      matched.push(Object.assign({},raw,{student_id:student.id,student_name:student.name,student_email:student.email,roster_status:student.status,source_id:id}));
    });
    if (!safe) {
      review(state,env,{category:'IMPORT_NOT_COMPLETE',source_id:id,reason:'Import has incomplete extraction or unresolved identities; prior schedule is preserved'});
      return {status:'REVIEW',source_id:id};
    }
    if (!src.coverage.length || src.coverage.some(c=>!c.location || !/^\d{4}-\d{2}-\d{2}$/.test(c.start)||!/^\d{4}-\d{2}-\d{2}$/.test(c.end)||c.start>c.end)) throw Error('Invalid coverage windows');
    if (matched.some(s=>!covered(src,s))) throw Error('Shift falls outside coverage');
    // Equal-version different content is a conflict; received-time order cannot
    // establish which of two conflicting published calendars is authoritative.
    const conflict=state.sources.find(s=>s.id!==id && s.complete && s.status==='APPLIED' && s.version_at===src.version_at && s.sha256!==src.sha256 && s.coverage.some(a=>src.coverage.some(b=>a.location===b.location&&a.start<=b.end&&b.start<=a.end)));
    if (conflict) {review(state,env,{category:'SOURCE_CONFLICT',source_id:id,reason:'Conflicting content has the same published version; owner must determine authority'});return {status:'REVIEW',source_id:id};}
    const authoritative = shift => !state.sources.some(s=>s.id!==id&&s.status==='APPLIED'&&s.complete&&ms(s.version_at)>ms(src.version_at)&&covered(s,shift));
    const old=state.shifts.filter(s=>s.status==='ACTIVE'&&covered(src,s)&&authoritative(s));
    const incoming=matched.filter(s=>authoritative(s)&&!cancelledSlot(state,s));
    const fingerprint=s=>key(env,s.student_id,s.location,s.start_at,s.end_at);
    const newKeys=new Set(incoming.map(fingerprint));
    if (newKeys.size!==incoming.length) {review(state,env,{category:'DUPLICATE_SHIFT',source_id:id,reason:'Duplicate student/time/site observations'});return {status:'REVIEW',source_id:id};}
    const oldKeys=new Set(old.map(fingerprint));
    const removed=old.filter(s=>!newKeys.has(fingerprint(s)));
    const added=incoming.filter(s=>!oldKeys.has(fingerprint(s)));
    const pairs=[];const held=new Set();
    const groups=new Set(removed.map(s=>s.student_id+'|'+s.location));
    groups.forEach(group=>{
      const a=removed.filter(s=>s.student_id+'|'+s.location===group),b=added.filter(s=>s.student_id+'|'+s.location===group);
      if (a.length===1&&b.length===1) pairs.push([a[0],b[0]]);
      else if (a.length&&b.length) {
        [...a,...b].forEach(s=>held.add(fingerprint(s)));
        review(state,env,{category:'AMBIGUOUS_RESCHEDULE',source_id:id,student_name:a[0].student_name,
          reason:'Multiple removed/new shifts require an explicit reschedule mapping'});
      }
    });
    if (held.size) return {status:'REVIEW',source_id:id};
    old.forEach(before=>{
      const observation=incoming.find(s=>fingerprint(s)===fingerprint(before));
      if(!observation) return;
      const metadataChanged=before.student_email!==observation.student_email||before.roster_status!==observation.roster_status||before.student_name!==observation.student_name;
      if(metadataChanged) {
        state.history.push({id:key(env,'metadata',before.id,id),shift_id:before.id,type:'ROSTER_METADATA',previous:clone(before),at:iso(env.now),source_id:id});
        const sent=previouslyNotified(state,before.id);
        if(!sent) {suppress(state,before.id);before.revision++;}
        Object.assign(before,{student_email:observation.student_email,student_name:observation.student_name,roster_status:observation.roster_status});
        if(!sent) notification(state,env,before,'SCHEDULED');
      }
      before.source_id=id;
    });
    const change=(before,after,type)=>{
      const historyId=key(env,before.id,before.revision,id,type);
      state.history.push({id:historyId,shift_id:before.id,source_id:id,type,previous:clone(before),next:clone(after),at:iso(env.now)});
      const sent=previouslyNotified(state,before.id),uncertain=state.notifications.some(n=>n.shift_id===before.id&&['UNCERTAIN','LEGACY_REVIEW','PREPARING','SENDING'].includes(n.status));suppress(state,before.id);Object.assign(before,after);
      if (sent||uncertain) notification(state,env,before,type,state.history[state.history.length-1].previous);
      else if (before.status==='ACTIVE') notification(state,env,before,'SCHEDULED');
    };
    pairs.forEach(([before,after])=>change(before,Object.assign({},after,{id:before.id,revision:before.revision+1,status:'ACTIVE'}),'RESCHEDULED'));
    removed.filter(s=>!pairs.some(p=>p[0]===s)&&!held.has(fingerprint(s))).forEach(s=>change(s,Object.assign({},s,{status:'CANCELLED',revision:s.revision+1,source_id:id}),'CANCELLED'));
    added.filter(s=>!pairs.some(p=>p[1]===s)&&!held.has(fingerprint(s))).forEach(s=>{
      const shift=Object.assign({},s,{id:key(env,'shift',id,fingerprint(s)),revision:1,status:'ACTIVE'});
      state.shifts.push(shift);state.history.push({id:key(env,'added',shift.id),shift_id:shift.id,type:'ADDED',next:clone(shift),at:iso(env.now),source_id:id});
      notification(state,env,shift,'SCHEDULED');
    });
    current.status=held.size?'REVIEW':'APPLIED';
    reconcileSiteChanges(state,env);
    // Reprocessing can clear old import/match issues only after full success.
    if (!held.size) state.reviews.filter(r=>r.source_id===id&&r.blocking&&r.status==='OPEN').forEach(r=>{r.status='RESOLVED';r.resolved_at=iso(env.now);r.resolution='Successful reprocessing';});
    return {status:current.status,source_id:id,added:added.length,removed:removed.length,rescheduled:pairs.length};
  }

  function payload(state,env,event) {
    const marker='[RR:'+event.id+']';
    if (event.type==='OWNER_EXCEPTION') {
      const r=state.reviews.find(r=>r.id===event.review_id);
      return {to:[env.owner],cc:'',subject:r.category+' '+marker,
        body:['Clinical scheduling exception', 'Category: '+r.category,'Student/PDF: '+(r.student_name||r.source_pdf||r.source_id||r.id),
          'Shift date: '+(r.date||'Unknown / see source'),'Reason: '+r.reason,'Review record: '+env.reviewLink(r.id),'Review ID: '+r.id,
          'Source email: '+(r.source_email_url||'See review record'),'Source PDF: '+(r.source_pdf_url||r.source_pdf||'See source email'),'Resolve: '+r.instructions].join('\n')};
    }
    if (event.type==='OWNER_SUMMARY') {
      const open=state.reviews.filter(r=>r.status==='OPEN');
      return {to:[env.owner],cc:'',subject:'Unresolved clinical scheduling exceptions '+marker,
        body:open.map(r=>r.category+' | '+(r.student_name||r.source_id||r.id)+' | '+(r.date||'Unknown date')+' | '+r.reason+'\n'+env.reviewLink(r.id)+'\nResolve: '+r.instructions).join('\n\n')};
    }
    const s=event.shift;
    const location=s.location.replace(/^Brewster Ambulance Service /,''),date=s.date.slice(5,7)+'/'+s.date.slice(8,10)+'/'+s.date.slice(0,4);
    const title=event.type==='CANCELLED'?'Cancellation':event.type==='RESCHEDULED'?'Update':'Notification';
    const introduction=event.type==='CANCELLED'?'a cancelled clinical ride-along':event.type==='RESCHEDULED'?'a rescheduled clinical ride-along':'an upcoming clinical ride-along';
    return {to:event.to,cc:event.cc,subject:'Clinical Ride '+title+' - '+s.student_name+' - '+date+' '+marker,
      body:['Hello Scheduling Team,','',
        'This is an automated notification regarding '+introduction+' at Brewster Ambulance Service ('+location+').','',
        'Student Name: '+s.student_name,'Date: '+date,'Shift Time: '+s.start_time+' - '+s.end_time+' ('+s.timezone+')',
        ...(event.previous?['','Previously: '+event.previous.date+' '+event.previous.start_time+' - '+event.previous.end_time+' at '+event.previous.location]:[]),
        '',"The student has been CC'd on this email. Please reply-all to confirm or coordinate arrival logistics directly.",
        '','Thank you,','Shawn','Ricky Rescue'].join('\n')};
  }

  function dispatch(state,env,transport,persist) {
    init(state);
    // The caller must hold the exclusive lock throughout this operation.
    for (const event of state.notifications.slice()) {
      if(env.shouldStop&&env.shouldStop()) break;
      if(env.approvedTestDate&&(!event.shift_id||!event.shift||event.shift.date!==env.approvedTestDate)) continue;
      if(env.ownerOnly&&!event.type.startsWith('OWNER')) continue;
      if (['PREPARING','SENDING'].includes(event.status)) {
        let evidence=null;
        try {evidence=transport.findAccepted(event.id);} catch(_e) { /* Remain uncertain when sent evidence cannot be read. */ }
        if (evidence) {event.status='API_ACCEPTED';event.provider_message_id=evidence;event.accepted_at=iso(env.now);}
        else {event.status='UNCERTAIN';review(state,env,{category:'NOTIFICATION_UNCERTAIN',shift_id:event.shift_id,no_alert:event.type.startsWith('OWNER'),reason:'Prior attempt may have been accepted. Inspect Sent mail before resolving event '+event.id});}
        const attempt=state.attempts.filter(a=>a.event_id===event.id&&['PREPARING','SENDING'].includes(a.status)).slice(-1)[0];
        if(attempt){attempt.status=event.status;attempt.recovered_at=iso(env.now);if(evidence)attempt.provider_message_id=evidence;}
        persist(state);
      }
      if (!['PENDING','RETRY','DRY_RUN'].includes(event.status)) continue;
      const ownerReview=event.type==='OWNER_EXCEPTION'?state.reviews.find(r=>r.id===event.review_id):null;
      if(event.type==='OWNER_SUMMARY'||(ownerReview&&silentReview(ownerReview,env))) {
        event.status='SILENT_RETAINED';event.silenced_at=iso(env.now);event.silence_reason='Owner policy: retain historical/informational records without email or summaries';delete event.preview;continue;
      }
      if(['CANCELLED','RESCHEDULED'].includes(event.type)&&correctionCutoff(event)<=env.now) {
        event.status='HISTORICAL';event.silenced_at=iso(env.now);delete event.preview;continue;
      }
      if(ms(event.next_retry_at||event.due_at)>env.now) continue;
      if (event.type==='OWNER_EXCEPTION' && state.reviews.find(r=>r.id===event.review_id).status!=='OPEN') {event.status='SUPERSEDED';continue;}
      if (event.shift_id) {
        const current=state.shifts.find(s=>s.id===event.shift_id);
        if (!current||current.revision!==event.revision || (event.type==='SCHEDULED'&&current.status!=='ACTIVE')) {event.status='SUPERSEDED';continue;}
        if(event.type==='SCHEDULED'&&state.cancellations.some(c=>c.status==='REVIEW')) continue;
        if(state.notifications.some(n=>n.id!==event.id&&n.shift_id===event.shift_id&&['UNCERTAIN','LEGACY_REVIEW','PREPARING','SENDING'].includes(n.status))) {
          review(state,env,{category:'PRIOR_NOTIFICATION_UNCERTAIN',shift_id:event.shift_id,date:event.shift.date,student_name:event.shift.student_name,
            reason:'Resolve prior uncertain notification evidence before releasing event '+event.id});continue;
        }
        if (event.type==='SCHEDULED'&&ms(event.shift.start_at)<=env.now) {event.status='EXPIRED';review(state,env,{category:'MISSED_NOTIFICATION',shift_id:event.shift_id,date:event.shift.date,student_name:event.shift.student_name,reason:'Shift began before notice was accepted'});continue;}
      }
      const mail=payload(state,env,event);
      if (!mail.to.length||mail.to.some(e=>!emailOK(e))||(event.shift_id&&!emailOK(mail.cc))) {
        event.status='BLOCKED';review(state,env,{category:'NOTIFICATION_RECIPIENT',shift_id:event.shift_id,no_alert:event.type.startsWith('OWNER'),reason:'Invalid To/CC addresses for event '+event.id});continue;
      }
      if (!env.liveEmail) {event.status='DRY_RUN';event.preview=mail;continue;}
      event.status='PREPARING';event.attempt_count=(event.attempt_count||0)+1;
      const attempt={id:key(env,event.id,event.attempt_count),event_id:event.id,started_at:iso(env.now),status:'PREPARING'};
      state.attempts.push(attempt);persist(state);
      let draft;
      try {draft=transport.prepare(mail,event.id);}
      catch(e) {
        attempt.status='FAILED_BEFORE_SEND';attempt.error=String(e);
        event.status=event.attempt_count<5?'RETRY':'FAILED';event.next_retry_at=iso(env.now+Math.min(3600000,60000*2**event.attempt_count));
        review(state,env,{category:'NOTIFICATION_FAILURE',shift_id:event.shift_id,no_alert:event.type.startsWith('OWNER'),reason:'Draft preparation failed for event '+event.id});persist(state);continue;
      }
      event.draft_id=draft;event.status='SENDING';attempt.status='SENDING';persist(state);
      try {
        const messageId=transport.sendPrepared(draft);
        event.status='API_ACCEPTED';event.accepted_at=iso(env.now);event.provider_message_id=messageId;
        attempt.status='API_ACCEPTED';attempt.provider_message_id=messageId;attempt.completed_at=iso(env.now);
        state.reviews.filter(r=>r.status==='OPEN'&&r.category==='NOTIFICATION_FAILURE'&&r.reason.includes(event.id)).forEach(r=>{r.status='RESOLVED';r.resolved_at=iso(env.now);});
      } catch(e) {
        event.status='UNCERTAIN';attempt.status='UNCERTAIN';attempt.error=String(e);
        review(state,env,{category:'NOTIFICATION_UNCERTAIN',shift_id:event.shift_id,no_alert:event.type.startsWith('OWNER'),reason:'Send outcome unknown for event '+event.id+'; inspect Sent mail. Do not resend automatically.'});
      }
      persist(state);
    }
    persist(state);
  }

  function monitor(state,env) {
    init(state);
    const today=env.dayKey?env.dayKey(env.now):localDay(env.now,env.timezone);
    const successful=state.runs.filter(r=>r.type==='INGEST'&&r.status==='COMPLETED').sort((a,b)=>ms(b.ended_at)-ms(a.ended_at));
    if (!successful.length||env.now-ms(successful[0].ended_at)>26*3600000) review(state,env,{category:'MISSING_DAILY_RUN',dedupe_key:'missing_daily_run',date:today,reason:'No completed ingestion run within 26 hours',instructions:'Inspect Apps Script triggers and executions. Restore the ingest job, then verify its run record.'});
    else state.reviews.filter(r=>r.category==='MISSING_DAILY_RUN'&&r.status==='OPEN').forEach(r=>{r.status='RESOLVED';r.resolved_at=iso(env.now);});
    env.expectedSites.forEach(site=>{
      const latest=state.sources.filter(s=>s.status==='APPLIED'&&s.coverage.some(c=>c.location===site)).sort((a,b)=>ms(b.version_at)-ms(a.version_at))[0];
      if (!latest||env.now-ms(latest.version_at)>9*86400000) review(state,env,{category:'MISSING_CALENDAR',dedupe_key:'missing_calendar_'+site,student_name:site,date:today,reason:'No accepted calendar published within nine days',instructions:'Check the weekly Platinum Planner email, label filter, attachments and failed imports; reprocess the latest verified source.'});
      else state.reviews.filter(r=>r.category==='MISSING_CALENDAR'&&r.student_name===site&&r.status==='OPEN').forEach(r=>{r.status='RESOLVED';r.resolved_at=iso(env.now);});
    });
  }
  return {init,norm,match,buildRoster,ingest,review,dispatch,monitor,tables,validateShift,parseCancellation,ingestCancellation};
})();
if (typeof module!=='undefined') module.exports=ClinicalEngine;
