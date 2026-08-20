#!/usr/bin/env python3
"""Create a sanitized aggregate summary from a Chrome DevTools trace.

The input trace remains private. The output intentionally excludes request bodies,
full URLs, absolute timestamps, IDs, cookies, and source text.
"""
from __future__ import annotations

import bisect
import gzip
import json
import math
import os
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable

TRACE_PATH = Path(
    os.environ.get(
        "CHATGPT_PERF_TRACE",
        ".private/captures/trace-20260820T171134.json.gz",
    )
)
OUTPUT_PATH = Path(
    os.environ.get(
        "CHATGPT_PERF_TRACE_OUTPUT",
        "analysis/output/trace-summary.json",
    )
)
PRIVATE_DETAIL_PATH = Path(
    os.environ.get(
        "CHATGPT_PERF_TRACE_PRIVATE_OUTPUT",
        ".private/analysis/new-session/trace-detail.json",
    )
)

UUID_RE = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
    re.I,
)
LONG_ID_RE = re.compile(r"[A-Za-z0-9_-]{20,}")


def load_trace(path: Path) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rt", encoding="utf-8", errors="replace") as handle:
        data = json.load(handle)
    if isinstance(data, list):
        return data, {}
    if not isinstance(data, dict):
        raise ValueError("Unsupported trace root")
    events = data.get("traceEvents") or data.get("trace_events") or []
    if not isinstance(events, list):
        raise ValueError("traceEvents is not an array")
    metadata = data.get("metadata") if isinstance(data.get("metadata"), dict) else {}
    return events, metadata


def nested_data(event: dict[str, Any]) -> dict[str, Any]:
    args = event.get("args")
    if not isinstance(args, dict):
        return {}
    data = args.get("data")
    return data if isinstance(data, dict) else args


def sanitize_url(raw: Any) -> str | None:
    if not isinstance(raw, str) or not raw:
        return None
    value = raw.split("#", 1)[0].split("?", 1)[0]
    value = UUID_RE.sub(":id", value)
    value = re.sub(r"/g/[^/]+", "/g/:id", value)
    value = re.sub(r"/c/[^/]+", "/c/:id", value)
    if "/assets/" in value or "/cdn/" in value:
        return value.rsplit("/", 1)[-1]
    if "/backend-api/conversations/" in value:
        if value.endswith("/messages"):
            return "/backend-api/conversations/:id/messages"
        return "/backend-api/conversations/:id"
    if "/backend-api/conversation/" in value:
        return "/backend-api/conversation/:id"
    if "/backend-api/" in value:
        suffix = value.split("/backend-api/", 1)[1]
        suffix = UUID_RE.sub(":id", suffix)
        suffix = LONG_ID_RE.sub(":id", suffix)
        return "/backend-api/" + suffix[:160]
    if value.startswith("chrome-extension://"):
        return "chrome-extension://:extension"
    if value.startswith("blob:"):
        return "blob:"
    if value.startswith("data:"):
        return "data:"
    if "://" in value:
        try:
            after = value.split("://", 1)[1]
            host, _, path = after.partition("/")
            if host.endswith("chatgpt.com"):
                return "https://chatgpt.com/" + UUID_RE.sub(":id", path)[:160]
            return value.split("://", 1)[0] + "://" + host
        except Exception:
            return "external-url"
    return UUID_RE.sub(":id", value.rsplit("/", 1)[-1])[:160]


def event_url(event: dict[str, Any]) -> str | None:
    data = nested_data(event)
    for key in ("url", "scriptName", "script_name", "sourceURL", "fileName"):
        result = sanitize_url(data.get(key))
        if result:
            return result
    begin = event.get("args", {}).get("beginData") if isinstance(event.get("args"), dict) else None
    if isinstance(begin, dict):
        for key in ("url", "scriptName"):
            result = sanitize_url(begin.get(key))
            if result:
                return result
    return None


def round_ms(value_us: float | int | None) -> float:
    return round(float(value_us or 0) / 1000.0, 3)


def duration_us(event: dict[str, Any]) -> float:
    value = event.get("dur")
    return float(value) if isinstance(value, (int, float)) else 0.0


def timestamp_us(event: dict[str, Any]) -> float:
    value = event.get("ts")
    return float(value) if isinstance(value, (int, float)) else 0.0


def percentile(values: list[float], ratio: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, math.ceil(len(ordered) * ratio) - 1))
    return ordered[index]


def choose_renderer_main(events: list[dict[str, Any]]) -> tuple[int, int, str]:
    thread_names: dict[tuple[int, int], str] = {}
    process_names: dict[int, str] = {}
    for event in events:
        if event.get("ph") != "M":
            continue
        pid = int(event.get("pid", -1))
        tid = int(event.get("tid", -1))
        args = event.get("args")
        name = args.get("name") if isinstance(args, dict) else None
        if event.get("name") == "thread_name" and isinstance(name, str):
            thread_names[(pid, tid)] = name
        elif event.get("name") == "process_name" and isinstance(name, str):
            process_names[pid] = name

    candidates: list[tuple[float, int, int, str]] = []
    for (pid, tid), name in thread_names.items():
        lname = name.lower()
        if "crrenderermain" not in lname and "renderermain" not in lname and name != "MainThread":
            continue
        score = 0.0
        for event in events:
            if int(event.get("pid", -2)) != pid or int(event.get("tid", -2)) != tid:
                continue
            if event.get("ph") != "X":
                continue
            event_name = str(event.get("name", ""))
            dur = duration_us(event)
            if "RunTask" in event_name:
                score += dur * 5
            elif event_name in {"FunctionCall", "EvaluateScript", "UpdateLayoutTree", "Layout", "Paint"}:
                score += dur
        process_bonus = 1e12 if "renderer" in process_names.get(pid, "").lower() else 0
        candidates.append((score + process_bonus, pid, tid, name))

    if candidates:
        _, pid, tid, name = max(candidates)
        return pid, tid, name

    # Fallback: thread with the most complete-event duration.
    totals: defaultdict[tuple[int, int], float] = defaultdict(float)
    for event in events:
        if event.get("ph") == "X":
            totals[(int(event.get("pid", -1)), int(event.get("tid", -1)))] += duration_us(event)
    (pid, tid), _ = max(totals.items(), key=lambda item: item[1])
    return pid, tid, thread_names.get((pid, tid), "unknown")


def summarize(events: list[dict[str, Any]], metadata: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    complete = [event for event in events if event.get("ph") == "X" and duration_us(event) > 0]
    timestamps = [timestamp_us(event) for event in events if isinstance(event.get("ts"), (int, float))]
    trace_start = min(timestamps) if timestamps else 0.0
    trace_end = max(
        (timestamp_us(event) + duration_us(event) for event in events if isinstance(event.get("ts"), (int, float))),
        default=trace_start,
    )
    pid, tid, thread_name = choose_renderer_main(events)
    main = [event for event in complete if int(event.get("pid", -1)) == pid and int(event.get("tid", -1)) == tid]
    main.sort(key=lambda event: (timestamp_us(event), -duration_us(event)))
    starts = [timestamp_us(event) for event in main]

    task_names = {
        "RunTask",
        "ThreadControllerImpl::RunTask",
        "ThreadControllerImpl::RunTaskImpl",
        "Scheduler::Task",
    }
    tasks = [
        event
        for event in main
        if str(event.get("name", "")) in task_names or str(event.get("name", "")).endswith("::RunTask")
    ]
    if not tasks:
        tasks = [event for event in main if "RunTask" in str(event.get("name", ""))]
    long_tasks = [event for event in tasks if duration_us(event) >= 50_000]

    layout_names = {
        "UpdateLayoutTree",
        "Layout",
        "PrePaint",
        "Paint",
        "PaintImage",
        "CompositeLayers",
        "Commit",
        "HitTest",
    }
    script_names = {
        "FunctionCall",
        "EvaluateScript",
        "RunMicrotasks",
        "EventDispatch",
        "TimerFire",
        "FireAnimationFrame",
        "V8.Execute",
        "v8.run",
    }
    gc_pattern = re.compile(r"(?:^|\.)(?:MinorGC|MajorGC|GC|CollectGarbage)|BlinkGC|V8\.GC", re.I)

    long_task_details: list[dict[str, Any]] = []
    for task in sorted(long_tasks, key=duration_us, reverse=True)[:40]:
        start = timestamp_us(task)
        end = start + duration_us(task)
        left = bisect.bisect_left(starts, start)
        right = bisect.bisect_right(starts, end)
        children = [
            event
            for event in main[left:right]
            if event is not task
            and timestamp_us(event) >= start
            and timestamp_us(event) + duration_us(event) <= end + 1
        ]
        names = Counter()
        layout_total = 0.0
        script_total = 0.0
        gc_total = 0.0
        scripts = Counter()
        inputs: list[str] = []
        for child in children:
            name = str(child.get("name", "unknown"))
            names[name] += duration_us(child)
            if name in layout_names:
                layout_total += duration_us(child)
            if name in script_names or event_url(child):
                script_total += duration_us(child)
            if gc_pattern.search(name):
                gc_total += duration_us(child)
            url = event_url(child)
            if url:
                scripts[url] += duration_us(child)
            if name == "EventDispatch":
                dtype = nested_data(child).get("type")
                if isinstance(dtype, str) and dtype not in inputs:
                    inputs.append(dtype)
        long_task_details.append(
            {
                "startMs": round((start - trace_start) / 1000.0, 3),
                "durationMs": round_ms(duration_us(task)),
                "layoutPaintInclusiveMs": round_ms(layout_total),
                "scriptInclusiveMs": round_ms(script_total),
                "gcInclusiveMs": round_ms(gc_total),
                "inputs": inputs[:8],
                "topEvents": [
                    {"name": name, "inclusiveMs": round_ms(total)}
                    for name, total in names.most_common(10)
                ],
                "topScripts": [
                    {"source": source, "inclusiveMs": round_ms(total)}
                    for source, total in scripts.most_common(8)
                ],
            }
        )

    event_totals = Counter()
    event_max = Counter()
    event_counts = Counter()
    for event in main:
        name = str(event.get("name", "unknown"))
        dur = duration_us(event)
        event_totals[name] += dur
        event_counts[name] += 1
        if dur > event_max[name]:
            event_max[name] = dur

    input_events: list[dict[str, Any]] = []
    for event in main:
        if event.get("name") != "EventDispatch":
            continue
        dtype = nested_data(event).get("type")
        if not isinstance(dtype, str):
            continue
        input_events.append(
            {
                "type": dtype,
                "startMs": round((timestamp_us(event) - trace_start) / 1000.0, 3),
                "durationMs": round_ms(duration_us(event)),
            }
        )

    # Network timings from trace resource events. IDs stay private and are never emitted.
    requests: dict[str, dict[str, Any]] = {}
    for event in events:
        name = str(event.get("name", ""))
        data = nested_data(event)
        request_id = data.get("requestId") or data.get("request_id")
        if request_id is None:
            continue
        key = str(request_id)
        if name in {"ResourceSendRequest", "ResourceWillSendRequest", "Network.requestWillBeSent"}:
            entry = requests.setdefault(key, {})
            entry["start"] = timestamp_us(event)
            entry["url"] = sanitize_url(data.get("url"))
            entry["method"] = data.get("requestMethod") or data.get("method")
        elif name in {"ResourceReceiveResponse", "Network.responseReceived"}:
            entry = requests.setdefault(key, {})
            entry["response"] = timestamp_us(event)
            entry["status"] = data.get("statusCode") or data.get("status")
        elif name in {"ResourceFinish", "Network.loadingFinished"}:
            entry = requests.setdefault(key, {})
            entry["finish"] = timestamp_us(event)
            entry["bytes"] = data.get("encodedDataLength") or data.get("decodedBodyLength")

    user_timing_rows: list[dict[str, Any]] = []
    for event in complete:
        name = str(event.get("name", ""))
        if not name.startswith("chatgpt-perf:"):
            continue
        user_timing_rows.append(
            {
                "name": name,
                "startMs": round((timestamp_us(event) - trace_start) / 1000.0, 3),
                "durationMs": round_ms(duration_us(event)),
            }
        )

    network_rows: list[dict[str, Any]] = []
    for request in requests.values():
        start = request.get("start")
        finish = request.get("finish")
        if not isinstance(start, (int, float)):
            continue
        row: dict[str, Any] = {
            "resource": request.get("url") or "unknown",
            "method": request.get("method"),
            "status": request.get("status"),
            "startMs": round((start - trace_start) / 1000.0, 3),
        }
        if isinstance(request.get("response"), (int, float)):
            row["ttfbMs"] = round((request["response"] - start) / 1000.0, 3)
        if isinstance(finish, (int, float)):
            row["durationMs"] = round((finish - start) / 1000.0, 3)
        if isinstance(request.get("bytes"), (int, float)):
            row["encodedBytes"] = int(request["bytes"])
        network_rows.append(row)

    network_groups: defaultdict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in network_rows:
        network_groups[str(row["resource"])].append(row)
    network_summary = []
    for resource, rows in sorted(network_groups.items(), key=lambda item: len(item[1]), reverse=True):
        durations = [float(row["durationMs"]) for row in rows if isinstance(row.get("durationMs"), (int, float))]
        bytes_values = [int(row["encodedBytes"]) for row in rows if isinstance(row.get("encodedBytes"), int)]
        network_summary.append(
            {
                "resource": resource,
                "count": len(rows),
                "maxDurationMs": round(max(durations), 3) if durations else None,
                "totalEncodedBytes": sum(bytes_values) if bytes_values else None,
            }
        )

    top_events = [
        {
            "name": name,
            "count": event_counts[name],
            "inclusiveMs": round_ms(total),
            "maxMs": round_ms(event_max[name]),
        }
        for name, total in event_totals.most_common(50)
    ]
    task_durations = [duration_us(event) / 1000.0 for event in tasks]
    long_durations = [duration_us(event) / 1000.0 for event in long_tasks]
    layout_total = sum(duration_us(event) for event in main if str(event.get("name", "")) in layout_names)
    gc_total = sum(duration_us(event) for event in main if gc_pattern.search(str(event.get("name", ""))))

    safe_summary = {
        "traceDurationMs": round((trace_end - trace_start) / 1000.0, 3),
        "eventCount": len(events),
        "rendererMainThread": thread_name,
        "mainThreadCompleteEventCount": len(main),
        "taskCount": len(tasks),
        "longTaskCount": len(long_tasks),
        "taskDurationMs": {
            "p50": round(percentile(task_durations, 0.50), 3),
            "p95": round(percentile(task_durations, 0.95), 3),
            "p99": round(percentile(task_durations, 0.99), 3),
            "max": round(max(task_durations), 3) if task_durations else 0,
        },
        "longTaskDurationMs": {
            "total": round(sum(long_durations), 3),
            "max": round(max(long_durations), 3) if long_durations else 0,
        },
        "layoutPaintInclusiveMs": round_ms(layout_total),
        "gcInclusiveMs": round_ms(gc_total),
        "topMainThreadEvents": top_events,
        "worstLongTasks": long_task_details[:15],
        "inputEventCounts": dict(Counter(row["type"] for row in input_events)),
        "slowInputEvents": sorted(input_events, key=lambda row: row["durationMs"], reverse=True)[:20],
        "networkGroups": network_summary[:60],
        "userscriptTimings": sorted(
            user_timing_rows,
            key=lambda row: row["durationMs"],
            reverse=True,
        )[:100],
    }

    private_detail = {
        **safe_summary,
        "allLongTasks": long_task_details,
        "networkRequests": sorted(network_rows, key=lambda row: row.get("startMs", 0)),
        "metadataKeys": sorted(metadata.keys()),
    }
    return safe_summary, private_detail


def main() -> None:
    if not TRACE_PATH.exists():
        raise SystemExit(f"Trace not found: {TRACE_PATH}")
    events, metadata = load_trace(TRACE_PATH)
    safe, private = summarize(events, metadata)
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    PRIVATE_DETAIL_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(safe, indent=2, ensure_ascii=False) + "\n")
    PRIVATE_DETAIL_PATH.write_text(json.dumps(private, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps(safe, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
