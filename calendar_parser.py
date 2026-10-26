"""Geometry-based Platinum Planner extraction; ambiguous layouts fail closed."""
import hashlib
import io
import re
import statistics
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo
import pdfplumber

PARSER_VERSION = '2.0.0'
WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
MONTHS = {datetime(2000, m, 1).strftime('%B').lower(): m for m in range(1, 13)}
TIME = re.compile(r'^\d{1,2}:\d{2}$')
DATE_CELL = re.compile(r'^(?:([A-Za-z]+)\s+)?(\d{1,2})$')
ZONE = ZoneInfo('America/New_York')

class ParseFailure(Exception):
    def __init__(self, category, reason, **context):
        super().__init__(reason)
        self.category, self.reason, self.context = category, reason, context

    def as_dict(self):
        return dict(category=self.category, reason=self.reason, **self.context)

def box(words):
    return [round(min(w['x0'] for w in words), 3), round(min(w['top'] for w in words), 3),
            round(max(w['x1'] for w in words), 3), round(max(w['bottom'] for w in words), 3)]

def lines(words, tolerance=2):
    groups = []
    for word in sorted(words, key=lambda w: (w['top'], w['x0'])):
        if not groups or abs(word['top'] - groups[-1][0]['top']) > tolerance:
            groups.append([word])
        else:
            groups[-1].append(word)
    return [sorted(g, key=lambda w: w['x0']) for g in groups]

def text(words):
    return '\n'.join(' '.join(w['text'] for w in group) for group in lines(words))

def column(x, bounds):
    for i in range(7):
        if bounds[i] - 1 <= x < bounds[i + 1]:
            return i
    return None

def page_calendar(page, number, filename):
    words = page.extract_words(x_tolerance=2, y_tolerance=2)
    if not words:
        raise ParseFailure('TEXTLESS_PAGE', 'No words; OCR/manual review required', page=number)
    rows = lines(words)
    headers = [r for r in rows if [w['text'] for w in r] == WEEKDAYS]
    if len(headers) != 1:
        raise ParseFailure('CALENDAR_GEOMETRY', 'Expected one complete weekday header', page=number)
    header = headers[0]
    centers = [(w['x0'] + w['x1']) / 2 for w in header]
    pitch = statistics.median(b - a for a, b in zip(centers, centers[1:]))
    if pitch <= 0 or any(abs((b-a)-pitch) > pitch*.2 for a,b in zip(centers, centers[1:])):
        raise ParseFailure('CALENDAR_GEOMETRY', 'Irregular seven-column grid', page=number)
    bounds = [centers[0] - pitch/2] + [(a+b)/2 for a,b in zip(centers, centers[1:])] + [centers[-1]+pitch/2]
    heading = text([w for w in words if w['top'] < header[0]['top']])
    years = re.findall(r'\b(20\d{2})\b', heading)
    if len(set(years)) != 1:
        raise ParseFailure('INVALID_DATE', 'Heading must identify one year', page=number)
    year = int(years[0])
    heading_months = [MONTHS[m.lower()] for m in re.findall(r'\b('+'|'.join(MONTHS)+r')\b', heading, re.I)]
    if not heading_months or len(heading_months) > 2:
        raise ParseFailure('INVALID_DATE', 'No unambiguous printed month window', page=number)
    first_month,final_month = heading_months[0],heading_months[-1]
    first_allowed = date(year, first_month, 1)
    final_year = year + (final_month < first_month)
    after_allowed = date(final_year + (final_month == 12), final_month % 12 + 1, 1)
    name_window = re.search(r'-(20\d{2})(\d{2})-(20\d{2})(\d{2})\.pdf$', filename, re.I)
    if name_window and tuple(map(int,name_window.groups())) != (year,first_month,final_year,final_month):
        raise ParseFailure('INVALID_DATE', 'Filename and printed window disagree', page=number)
    location = next((r for r in heading.splitlines() if re.search(r'Ricky Rescue\s*-',r,re.I)), '')
    location = re.sub(r'^.*?Ricky Rescue\s*-\s*', '', location, flags=re.I)
    if not re.fullmatch(r'Brewster Ambulance Service (Lee County|Collier)', location, re.I):
        raise ParseFailure('UNKNOWN_LOCATION', 'Unrecognized printed site', page=number)
    weeks, grid_rows, previous = [], [], None
    for row in rows:
        if row[0]['top'] <= header[0]['top'] + 2:
            continue
        cells = [[] for _ in range(7)]
        for word in row:
            c = column((word['x0'] + word['x1'])/2, bounds)
            if c is not None:
                cells[c].append(word)
        strings = [' '.join(w['text'] for w in cell) for cell in cells]
        matches = [DATE_CELL.fullmatch(s) for s in strings]
        if sum(m is not None for m in matches) < 4:
            continue
        if not all(matches):
            raise ParseFailure('INVALID_DATE', 'Incomplete date row', page=number, raw_text=' | '.join(strings))
        dates = []
        for c,m in enumerate(matches):
            day = int(m[2])
            explicit = MONTHS.get((m[1] or '').lower())
            if m[1] and explicit is None:
                raise ParseFailure('INVALID_DATE', 'Unknown month', page=number)
            if previous:
                candidate = previous + timedelta(days=1)
                if candidate.day != day or (explicit and candidate.month != explicit):
                    raise ParseFailure('INVALID_DATE', 'Broken date sequence', page=number, raw_text=strings[c])
            else:
                month = explicit or first_month
                try:
                    candidate = date(year + (month < first_month), month, day)
                except ValueError as exc:
                    raise ParseFailure('INVALID_DATE', str(exc), page=number)
            if candidate.weekday() != (c + 6) % 7 or not first_allowed <= candidate < after_allowed:
                raise ParseFailure('INVALID_DATE', 'Date conflicts with weekday/window', page=number, raw_text=strings[c])
            dates.append(candidate)
            previous = candidate
        weeks.append({'top': row[0]['top'], 'bottom':max(w['bottom'] for w in row), 'dates':dates})
    if not weeks:
        raise ParseFailure('INVALID_DATE', 'No validated week rows', page=number)
    footer = min([w['top'] for w in words if w['text'] == 'generated'] or [page.height])
    anchors = []
    for row in rows:
        for i,w in enumerate(row):
            if TIME.fullmatch(w['text']) and i+2 < len(row) and row[i+1]['text'] in ('-','–','—') and TIME.fullmatch(row[i+2]['text']):
                week = next((k for k,v in enumerate(weeks) if v['bottom'] < w['top'] < (weeks[k+1]['top'] if k+1 < len(weeks) else footer)),None)
                c = column(w['x0'],bounds)
                if week is None or c is None:
                    raise ParseFailure('EVENT_GEOMETRY','Time outside calendar',page=number)
                anchors.append({'x':w['x0'],'top':w['top'],'col':c,'week':week,'start':w['text'],'end':row[i+2]['text'],'words':[]})
    # Platinum Planner encodes card backgrounds as filled paths (not PDF
    # rectangles). Count visible colored cards independently of text extraction.
    cards=[]
    for shape in getattr(page,'curves',[]) + getattr(page,'rects',[]):
        color=shape.get('non_stroking_color')
        if (shape.get('fill') and isinstance(color,(tuple,list)) and len(color)==3
                and max(color)-min(color)>.1 and shape['top']>weeks[0]['bottom']
                and pitch*.6<shape['x1']-shape['x0']<pitch*1.4 and shape['bottom']-shape['top']>20):
            cards.append(shape)
    for card in cards:
        owners=[a for a in anchors if card['x0']-2<=a['x']<=card['x1'] and card['top']-2<=a['top']<=card['bottom']]
        if len(owners)!=1:
            raise ParseFailure('EVENT_GEOMETRY','Visible event card has missing/ambiguous time text',page=number,
                               bbox=[card['x0'],card['top'],card['x1'],card['bottom']])
    # Group contiguous words into text runs first. Entire words and runs can
    # extend beyond a day boundary without being reassigned to the next day.
    unowned = []
    for row in rows:
        if row[0]['top'] <= weeks[0]['bottom'] or row[0]['top'] >= footer:
            continue
        if any(abs(row[0]['top']-week['top']) < 2 for week in weeks):
            continue
        runs = []
        for word in row:
            if not runs or word['x0'] - runs[-1][-1]['x1'] > max(8, word['bottom']-word['top']):
                runs.append([word])
            else:
                runs[-1].append(word)
        for run in runs:
            y,x = run[0]['top'],run[0]['x0']
            week = next((k for k,v in enumerate(weeks) if v['bottom'] < y < (weeks[k+1]['top'] if k+1 < len(weeks) else footer)),None)
            candidates=[a for a in anchors if a['week']==week and a['top'] <= y+2 and abs(a['x']-x)<pitch*.25]
            if candidates:
                max(candidates,key=lambda a:a['top'])['words'].extend(run)
            else:
                unowned.append(run)
    shifts, errors, unresolved = [], [], []
    for run in unowned:
        errors.append(dict(category='UNOWNED_TEXT',reason='Text has no event owner',page=number,bbox=box(run),raw_text=text(run)))
        unresolved.append(errors[-1])
    for anchor in anchors:
        block=anchor['words']
        raw=text(block)
        try:
            labels=list(re.finditer(r'\bStudents?\s*:', raw,re.I))
            if len(labels)!=1 or len(re.findall(r'\b\d{1,2}:\d{2}\s*[-–—]\s*\d{1,2}:\d{2}\b',raw))!=1:
                raise ValueError('Event needs one student label and one time range')
            names_text=re.sub(r'\s+',' ',raw[labels[0].end():]).strip()
            names=re.findall(r'(.*?)\(\s*EMT\s*\)',names_text,re.I)
            residue=re.sub(r'.*?\(\s*EMT\s*\)','',names_text,flags=re.I).strip(' ,;')
            if not names or residue:
                raise ValueError('Incomplete student list; expected EMT delimiters')
            names=[n.strip(' ,;') for n in names]
            if any(not n or not re.fullmatch(r"[\w\s,.'’\-]+",n) or re.search(r'\d',n) for n in names):
                raise ValueError('Invalid student name')
            shift_date=weeks[anchor['week']]['dates'][anchor['col']]
            start_clock=datetime.strptime(anchor['start'],'%H:%M').time()
            end_clock=datetime.strptime(anchor['end'],'%H:%M').time()
            if start_clock == end_clock:
                raise ValueError('Equal times are ambiguous')
            start=datetime.combine(shift_date,start_clock,ZONE)
            end=datetime.combine(shift_date + timedelta(days=end_clock<start_clock),end_clock,ZONE)
            for instant in (start,end):
                if instant.replace(fold=1).utcoffset()!=instant.replace(fold=0).utcoffset():
                    raise ValueError('Ambiguous/nonexistent daylight-saving time')
            for name in names:
                shifts.append(dict(date=shift_date.isoformat(),start_time=start.strftime('%H:%M'),end_time=end.strftime('%H:%M'),
                                   start_at=start.isoformat(),end_at=end.isoformat(),timezone=str(ZONE),student_name=name,
                                   location=location,source_page=number,bbox=box(block),raw_text=raw,
                                   source_words=[{k:w[k] for k in ('text','x0','x1','top','bottom')} for w in block],
                                   confidence={'level':'verified','reasons':['validated_dates','time_anchor','owned_text_run','complete_student_list']}))
        except ValueError as exc:
            issue=dict(category='LOW_CONFIDENCE',reason=str(exc),page=number,raw_text=raw,
                       date=weeks[anchor['week']]['dates'][anchor['col']].isoformat())
            errors.append(issue);unresolved.append(issue)
    for row in rows:
        cols=['']*7
        for w in row:
            c=column(w['x0'],bounds)
            if c is not None:
                cols[c]+=(' ' if cols[c] else '')+w['text']
        grid_rows.append(cols)
    return shifts,errors,unresolved,dict(page=number,start=weeks[0]['dates'][0].isoformat(),end=weeks[-1]['dates'][-1].isoformat(),
                                       location=location,column_bounds=bounds,event_card_count=len(cards)),grid_rows

def parse_pdf(data, filename=''):
    if not data or not data.startswith(b'%PDF-'):
        raise ParseFailure('INVALID_PDF','File is empty or not a PDF')
    try:
        pdf=pdfplumber.open(io.BytesIO(data))
    except Exception as exc:
        raise ParseFailure('INVALID_PDF','PDF cannot be opened') from exc
    shifts,errors,unresolved,coverage,grid,generated=[],[],[],[],[],[]
    with pdf:
        if not 0 < len(pdf.pages) <= 10:
            raise ParseFailure('PAGE_LIMIT','Calendar must contain 1-10 pages')
        for number,page in enumerate(pdf.pages,1):
            try:
                stamp=re.search(r'Calendar generated on (\d{1,2}/\d{1,2}/\d{4}) at (\d{1,2}:\d{2} [AP]M)',page.extract_text() or '')
                if not stamp:
                    raise ParseFailure('SOURCE_VERSION','Missing printed generation timestamp',page=number)
                try:
                    published=datetime.strptime(stamp[1]+' '+stamp[2],'%m/%d/%Y %I:%M %p').replace(tzinfo=ZONE)
                except ValueError as exc:
                    raise ParseFailure('SOURCE_VERSION','Invalid publication date/time',page=number) from exc
                if published.replace(fold=1).utcoffset()!=published.replace(fold=0).utcoffset():
                    raise ParseFailure('SOURCE_VERSION','Ambiguous/nonexistent publication clock time',page=number)
                generated.append(published.isoformat())
                s,e,u,c,g=page_calendar(page,number,filename)
                shifts.extend(s);errors.extend(e);unresolved.extend(u);coverage.append(c);grid.extend(g)
            except ParseFailure as exc:
                errors.append(exc.as_dict());unresolved.append(exc.as_dict())
        page_count=len(pdf.pages)
    identities=set()
    if len(set(generated))!=1:
        errors.append(dict(category='SOURCE_VERSION',reason='Pages disagree on generation timestamp'))
    for s in shifts:
        key=(s['student_name'].casefold(),s['start_at'],s['end_at'],s['location'])
        if key in identities:
            errors.append(dict(category='DUPLICATE_SOURCE_SHIFT',reason='Repeated student/time/site',date=s['date']))
        identities.add(key)
    complete=bool(coverage) and not errors and len(coverage)==page_count
    return dict(schema_version=2,parser_version=PARSER_VERSION,source_sha256=hashlib.sha256(data).hexdigest(),
                status='complete' if complete else 'needs_review',page_count=page_count,shifts=shifts,
                generated_at=generated[0] if generated else None,
                coverage=coverage,coverage_complete=complete,errors=errors,unresolved_blocks=unresolved,grid_rows=grid)
