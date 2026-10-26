"""Evaluate private, independently verified fixtures; never add their data to Git."""
import argparse
import collections
import json
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from calendar_parser import parse_pdf

def identity(s):
    return (s['date'],s['student_name'].casefold(),s['start_time'],s['end_time'],s['location'])

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('fixtures',type=Path);parser.add_argument('output',type=Path);args=parser.parse_args()
    truth=json.loads((args.fixtures/'verified-corpus.json').read_text())
    args.output.mkdir(parents=True,exist_ok=True);results=[]
    for filename,expected in truth['fixtures'].items():
        result=parse_pdf((args.fixtures/filename).read_bytes())
        (args.output/(filename+'.json')).write_text(json.dumps(result,indent=2))
        predicted=collections.Counter(map(identity,result['shifts']));actual=collections.Counter(map(identity,expected))
        correct=sum((predicted&actual).values())
        results.append(dict(fixture=filename,expected=len(expected),predicted=len(result['shifts']),correct=correct,
                            complete=result['coverage_complete'],precision=correct/len(result['shifts']) if result['shifts'] else None,recall=correct/len(expected)))
    total=sum(r['expected'] for r in results);count=sum(r['predicted'] for r in results);correct=sum(r['correct'] for r in results)
    summary=dict(fixtures=results,expected=total,predicted=count,correct=correct,precision=correct/count if count else None,recall=correct/total,
                 scope='Four manually verified PDFs; includes repeated observations across source versions. Does not establish generalization to all historical layouts.')
    (args.output/'benchmark.json').write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps(summary,indent=2))
    if correct!=total or count!=total or not all(r['complete'] for r in results):sys.exit(1)
