#!/usr/bin/env python3
from __future__ import annotations
import json
from pathlib import Path

source = json.loads(Path('analysis/output/browser-harness.json').read_text())
result = source.get('result', source)
keys = [
    'legacyFullGetsBeforeMutation',
    'lazyInitialVisibleRoles',
    'nativeOlderRoles',
    'nativeOlderAnswerChannel',
    'historyButtonExists',
    'paginationCallsAfterUserScroll',
    'paginationCallsAfterManualClick',
    'userTaskRanBeforeLocalHistory',
    'optimizerWorkerUsed',
    'jsonWorkerParses',
    'sidebarScrollTriggeredRichGeometry',
    'historyCacheHits',
    'richHistoryHasStaticMarkers',
    'richHistoryFenceCount',
    'staticCodeHydrated',
    'staticCodeReady',
    'staticCodeNoCodeMirror',
    'staticCodeHeightStable',
    'richMessageContentVisibility',
    'richSmoothedVisible',
    'richOverlayHidden',
    'skippedRichResizeObservers',
]
selected = {key: result.get(key) for key in keys}
checks = {
    'noLegacyFullLoad': selected.get('legacyFullGetsBeforeMutation') == 0,
    'initialHasUserAndAssistant': selected.get('lazyInitialVisibleRoles') == ['user', 'assistant'],
    'historyHasUserAndFinalAssistant': (
        selected.get('nativeOlderRoles') == ['user', 'assistant']
        and selected.get('nativeOlderAnswerChannel') == 'final'
    ),
    'historyIsManual': (
        selected.get('historyButtonExists') is True
        and selected.get('paginationCallsAfterUserScroll') == 0
        and selected.get('paginationCallsAfterManualClick') == 1
    ),
    'interactionRunsBeforeHistoryCommit': selected.get('userTaskRanBeforeLocalHistory') is True,
    'largeJsonUsesWorker': selected.get('optimizerWorkerUsed') is True,
    'sidebarScrollDoesNotScanConversation': selected.get('sidebarScrollTriggeredRichGeometry') is False,
    'historyCursorCacheWorks': (selected.get('historyCacheHits') or 0) >= 1,
    'heavyCodeUsesStaticRenderer': (
        selected.get('richHistoryHasStaticMarkers') is True
        and selected.get('richHistoryFenceCount') == 0
        and selected.get('staticCodeHydrated') is True
        and selected.get('staticCodeReady') is True
        and selected.get('staticCodeNoCodeMirror') is True
        and selected.get('staticCodeHeightStable') is True
    ),
}
report = {
    'allChecksPassed': all(checks.values()),
    'checks': checks,
    'evidence': selected,
}
Path('analysis/output/fix-validation.json').write_text(
    json.dumps(report, indent=2, ensure_ascii=False) + '\n'
)
if not report['allChecksPassed']:
    raise SystemExit('One or more fix-validation checks failed')
print(json.dumps(report, indent=2, ensure_ascii=False))
