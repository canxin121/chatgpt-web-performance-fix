#!/usr/bin/env python3
from __future__ import annotations
import json
from pathlib import Path

trace=json.loads(Path('analysis/output/trace-summary.json').read_text())
net=json.loads(Path('analysis/output/session-network-summary.json').read_text())

def event(name: str):
    return next((row for row in trace.get('topMainThreadEvents',[]) if row.get('name')==name), None)

def total(names):
    return sum((event(name) or {}).get('inclusiveMs',0) or 0 for name in names)

worst=trace.get('worstLongTasks',[])
max_task=trace.get('taskDurationMs',{}).get('max',0) or 0
layout=trace.get('layoutPaintInclusiveMs',0) or 0
gc=trace.get('gcInclusiveMs',0) or 0
script=total(['FunctionCall','EvaluateScript','RunMicrotasks','V8.Execute','v8.run'])
layout_core=total(['UpdateLayoutTree','Layout','PrePaint','Paint','CompositeLayers'])

conversation=net.get('conversationRequests',[])
legacy=[row for row in conversation if row.get('kind')=='legacy-full']
initial=[row for row in conversation if row.get('kind')=='paginated-initial']
history=[row for row in conversation if row.get('kind')=='paginated-messages']
oversized=[row for row in conversation if (row.get('response') or {}).get('messages',0) and (row['response']['messages'] or 0)>20]
hidden_heavy=[row for row in conversation if (row.get('response') or {}).get('messages',0) and (row['response']['messages'] or 0)>max(10, ((row['response'].get('users') or 0)+(row['response'].get('assistantVisible') or 0))*3)]

script_sources={}
for task in worst:
    for row in task.get('topScripts',[]):
        script_sources[row['source']]=script_sources.get(row['source'],0)+(row.get('inclusiveMs') or 0)
top_scripts=sorted(script_sources.items(), key=lambda item:item[1], reverse=True)[:12]
userscript_attributed=any('user' in src.lower() or 'performance-fix' in src.lower() or 'tamper' in src.lower() for src,_ in top_scripts)

findings=[]
findings.append({
 'id':'main-thread-freeze',
 'severity':'critical' if max_task>=1000 else ('high' if max_task>=300 else 'medium'),
 'evidence':{'maxTaskMs':max_task,'longTaskCount':trace.get('longTaskCount'),'longTaskTotalMs':trace.get('longTaskDurationMs',{}).get('total')},
 'summary':'The freezes are main-thread stalls, so unrelated UI such as the sidebar cannot respond while they run.'
})
if layout_core>250 or layout>500:
 findings.append({
  'id':'layout-paint-pressure','severity':'high',
  'evidence':{'layoutCoreInclusiveMs':round(layout_core,3),'layoutPaintInclusiveMs':layout},
  'summary':'Style, layout, pre-paint, and paint form a material part of the blocked windows.'
 })
if script>500:
 findings.append({
  'id':'script-pressure','severity':'high',
  'evidence':{'scriptInclusiveMs':round(script,3),'topScripts':[{'source':s,'inclusiveMs':round(ms,3)} for s,ms in top_scripts]},
  'summary':'JavaScript execution is a major contributor, not just network latency.'
 })
if gc>100:
 findings.append({'id':'gc-pressure','severity':'medium','evidence':{'gcInclusiveMs':gc},'summary':'Garbage collection adds visible pauses and suggests large temporary allocations.'})
if oversized:
 findings.append({
  'id':'oversized-pagination-payload','severity':'high',
  'evidence':{'count':len(oversized),'maxMessages':max((row['response'].get('messages') or 0) for row in oversized),'maxBodyBytes':max((row['response'].get('bodyBytes') or 0) for row in oversized)},
  'summary':'A UI page that ultimately shows very few transcript items still arrives with many internal messages.'
 })
if hidden_heavy:
 findings.append({
  'id':'hidden-tool-amplification','severity':'high',
  'evidence':{'count':len(hidden_heavy),'maxToolMessages':max((row['response'].get('toolMessages') or 0) for row in hidden_heavy)},
  'summary':'Hidden tool/reasoning nodes amplify parsing and filtering before the two visible messages are rendered.'
 })
if legacy:
 findings.append({'id':'legacy-full-request','severity':'high','evidence':{'count':len(legacy),'maxBodyBytes':max((row['response'].get('bodyBytes') or 0) for row in legacy)},'summary':'The capture still contains legacy full-conversation traffic.'})
if len(history)>2:
 findings.append({'id':'history-request-amplification','severity':'high','evidence':{'requestCount':len(history),'queryWindows':[row.get('query',{}).get('numTurns') for row in history]},'summary':'One visible history action expands into several cursor/window requests.'})
if userscript_attributed:
 findings.append({'id':'userscript-attribution','severity':'high','evidence':{'topScripts':[{'source':s,'inclusiveMs':round(ms,3)} for s,ms in top_scripts]},'summary':'Some of the slow work is attributed to userscript execution itself.'})

recommended=[
 {'id':'remove-global-scroll-geometry-scan','reason':'The current rich-text warmer listens to every captured scroll, including sidebar scrolling, and reads all cold-node geometry.'},
 {'id':'use-browser-managed-richtext-observation','reason':'Use IntersectionObserver and idle queues instead of getBoundingClientRect loops on scroll.'},
 {'id':'offload-large-json-work','reason':'Parse, merge, filter, and stringify paginated payloads in a Worker so the sidebar remains responsive.'},
 {'id':'bound-cursor-completion','reason':'Reuse completed semantic-turn pages and avoid repeated exponential cursor probes for one manual click.'},
 {'id':'instrument-fix-overhead','reason':'Add diagnostics for optimizer worker time, main-thread handoff, mutation scans, and rich-block activations.'},
]

report={
 'summary':{
  'traceDurationMs':trace.get('traceDurationMs'),
  'maxMainThreadTaskMs':max_task,
  'longTaskCount':trace.get('longTaskCount'),
  'conversationInitialRequests':len(initial),
  'conversationHistoryRequests':len(history),
  'legacyFullRequests':len(legacy),
 },
 'findings':findings,
 'recommendedChanges':recommended,
 'worstLongTasks':worst[:8],
}
Path('analysis/output/diagnosis.json').write_text(json.dumps(report,indent=2,ensure_ascii=False)+'\n')

lines=['# New capture diagnosis (before fixes)','',
      'This report contains only aggregate, redacted measurements.','',
      '## Summary','',
      f"- Trace duration: `{report['summary']['traceDurationMs']} ms`",
      f"- Worst main-thread task: `{max_task} ms`",
      f"- Long tasks: `{trace.get('longTaskCount')}`",
      f"- Initial conversation requests: `{len(initial)}`",
      f"- History requests: `{len(history)}`",
      f"- Legacy full requests: `{len(legacy)}`",'',
      '## Findings','']
for finding in findings:
    lines += [f"### {finding['id']} ({finding['severity']})",'',finding['summary'],'',f"```json\n{json.dumps(finding['evidence'],indent=2,ensure_ascii=False)}\n```",'']
lines += ['## Recommended changes','']
for item in recommended:
    lines += [f"- **{item['id']}** — {item['reason']}"]
Path('analysis/output/diagnosis.md').write_text('\n'.join(lines)+'\n')
