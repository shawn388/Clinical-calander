import io
import json
import os
import sys
import unittest
from datetime import date,timedelta
from pathlib import Path
from reportlab.pdfgen import canvas
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from calendar_parser import parse_pdf,ParseFailure
from main import app

def fixture(start=date(2026,10,25),events=None,weeks=2,heading='October - November, 2026',mutate_day=None,footer=True,pages=1):
    stream=io.BytesIO();c=canvas.Canvas(stream,pagesize=(612,792))
    for page in range(pages):
        c.setFont('Helvetica',10);c.drawString(40,750,'Ricky Rescue - Brewster Ambulance Service Lee County')
        c.drawString(40,728,heading)
        for col,day in enumerate(['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']):
            c.drawCentredString(75+col*76,705,day)
        for week in range(weeks):
            y=680-week*180
            for col in range(7):
                dt=start+timedelta(days=week*7+col)
                label=dt.strftime('%B ')+str(dt.day) if dt.day==1 or week==col==0 else str(dt.day)
                if mutate_day and (week,col)==mutate_day[0]:label=mutate_day[1]
                c.drawCentredString(75+col*76,y,label)
        for event in events or []:
            week,col=event.get('week',0),event.get('col',0);y=660-week*180-event.get('slot',0)*65;x=43+col*76
            c.setFillColorRGB(1,.96,.64);c.rect(x-3,y-49,74,60,fill=1,stroke=0);c.setFillColorRGB(0,0,0)
            c.setFont('Helvetica',8)
            c.drawString(x,y,event.get('time','08:00 - 20:00'))
            c.drawString(x,y-12,'Brewster Ambulance Service')
            for i,line in enumerate(event.get('student_lines',['Student: Example Student (EMT)'])):c.drawString(x,y-24-10*i,line)
        c.setFont('Helvetica',8)
        if footer:c.drawString(40,40,'Calendar generated on 10/24/2026 at 1:49 AM.')
        c.showPage()
    c.save();return stream.getvalue()

class ParserTests(unittest.TestCase):
    def test_multiple_students_and_separate_cards_same_day(self):
        result=parse_pdf(fixture(events=[{'student_lines':['Students: Example Student (EMT),','Second Person (EMT)']},{'slot':1,'time':'21:00 - 23:00'}]))
        self.assertTrue(result['coverage_complete'],result['errors'])
        self.assertEqual(len(result['shifts']),3)
        self.assertEqual([s['start_time'] for s in result['shifts']],['08:00','08:00','21:00'])
        self.assertTrue(all(s['source_words'] and len(s['bbox'])==4 for s in result['shifts']))

    def test_cross_month_empty_days_and_weeks(self):
        result=parse_pdf(fixture(events=[{'week':1}]))
        self.assertTrue(result['coverage_complete'],result['errors'])
        self.assertEqual(result['shifts'][0]['date'],'2026-11-01')
        self.assertEqual(result['coverage'][0]['end'],'2026-11-07')

    def test_cross_year_explicit_january_midweek(self):
        result=parse_pdf(fixture(start=date(2026,12,27),heading='December - January, 2026',events=[{'col':5}]))
        self.assertTrue(result['coverage_complete'],result['errors'])
        self.assertEqual(result['shifts'][0]['date'],'2027-01-01')

    def test_empty_calendar_is_only_complete_with_valid_geometry(self):
        self.assertTrue(parse_pdf(fixture())['coverage_complete'])
        stream=io.BytesIO();c=canvas.Canvas(stream);c.showPage();c.save()
        self.assertFalse(parse_pdf(stream.getvalue())['coverage_complete'])

    def test_invalid_date_does_not_normalize_to_next_month(self):
        result=parse_pdf(fixture(mutate_day=((0,3),'32')))
        self.assertFalse(result['coverage_complete']);self.assertEqual(result['errors'][0]['category'],'INVALID_DATE')

    def test_overflowing_name_stays_with_left_event(self):
        r=parse_pdf(fixture(events=[{'student_lines':['Student: Alexanderson Longlastname (EMT)']}]))
        self.assertTrue(r['coverage_complete'],r['errors'])
        self.assertEqual(r['shifts'][0]['student_name'],'Alexanderson Longlastname')
        self.assertEqual(r['shifts'][0]['date'],'2026-10-25')

    def test_unknown_text_and_incomplete_names_are_reviewed(self):
        for body in ['Student: No Terminator','Student: Bad123 (EMT)','No student label']:
            r=parse_pdf(fixture(events=[{'student_lines':[body]}]))
            self.assertFalse(r['coverage_complete']);self.assertTrue(r['unresolved_blocks'])

    def test_visible_event_without_time_is_not_an_empty_calendar(self):
        r=parse_pdf(fixture(events=[{'time':'Time missing'}]))
        self.assertFalse(r['coverage_complete']);self.assertEqual(r['errors'][0]['category'],'EVENT_GEOMETRY')

    def test_overnight_interval(self):
        r=parse_pdf(fixture(events=[{'time':'20:00 - 08:00'}]))
        self.assertTrue(r['coverage_complete'],r['errors'])
        self.assertTrue(r['shifts'][0]['end_at'].startswith('2026-10-26T08:00'))

    def test_ambiguous_dst_time_is_held(self):
        r=parse_pdf(fixture(start=date(2026,11,1),heading='November, 2026',events=[{'time':'01:30 - 03:30'}]))
        self.assertFalse(r['coverage_complete'])

    def test_missing_version_and_filename_disagreement(self):
        self.assertFalse(parse_pdf(fixture(footer=False))['coverage_complete'])
        self.assertFalse(parse_pdf(fixture(),'Calendar-X-202609-202610.pdf')['coverage_complete'])

    def test_repeated_pages_and_page_limit(self):
        self.assertFalse(parse_pdf(fixture(events=[{}],pages=2))['coverage_complete'])
        with self.assertRaises(ParseFailure):parse_pdf(fixture(pages=11))

    def test_http_contract_and_authentication(self):
        app.config.update(TESTING=True,PARSER_API_TOKEN='test-secret',ALLOW_UNAUTHENTICATED=False)
        client=app.test_client();headers={'Authorization':'Bearer test-secret'}
        self.assertEqual(client.get('/health').status_code,200)
        self.assertEqual(client.post('/parse-calendar').status_code,401)
        self.assertEqual(client.post('/parse-calendar',headers=headers).status_code,400)
        for data in [b'',b'not PDF',b'%PDF-broken']:
            r=client.post('/parse-calendar',headers=headers,data={'file':(io.BytesIO(data),'bad.pdf')})
            self.assertEqual(r.status_code,422);self.assertTrue(r.is_json);self.assertFalse(r.json['coverage_complete'])
        r=client.post('/parse-calendar',headers=headers,data={'file':(io.BytesIO(fixture(events=[{}])),'sample.pdf')})
        self.assertEqual(r.status_code,200);self.assertEqual(r.json['schema_version'],2);self.assertIn('grid_rows',r.json)
        app.config['MAX_CONTENT_LENGTH']=50
        r=client.post('/parse-calendar',headers=headers,data={'file':(io.BytesIO(fixture()),'large.pdf')})
        self.assertEqual(r.status_code,413);app.config['MAX_CONTENT_LENGTH']=8*1024*1024

    def test_owner_verified_private_fixture(self):
        directory=Path(os.getenv('RR_PRIVATE_FIXTURES',str(Path(__file__).resolve().parents[2]/'review/evidence')))
        if not (directory/'lee_current.pdf').exists():self.skipTest('Private review fixtures not installed')
        expected=json.loads((directory/'lee-current-expected.json').read_text())['entries']
        r=parse_pdf((directory/'lee_current.pdf').read_bytes())
        self.assertTrue(r['coverage_complete'],r['errors'])
        self.assertEqual([(s['date'],s['student_name'],s['start_time'],s['end_time']) for s in r['shifts']],
                         [(s['date'],s['student_name'],s['start_time'],s['end_time']) for s in expected])

if __name__=='__main__':unittest.main()
