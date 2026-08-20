#!/usr/bin/env python3
"""Stream a Chrome DevTools trace and emit a compact performance summary.

The parser intentionally avoids loading the full trace into memory. It extracts
traceEvents one object at a time and skips oversized profile chunks.
"""
from __future__ import annotations

import argparse
import collections
import gzip
import json
import math
import re
from pathlib import Path
from typing import Any, BinaryIO, Iterator
from urllib.parse import urlsplit

UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)
LONG_HEX_RE = re.compile(r"\b[0-9a-f]{24,}\b", re.I)


def sanitize_url(value: str) -> str:
    try:
        parts = urlsplit(value)
        if not parts.scheme or not parts.netloc:
            return UUID_RE.sub("<id>", LONG_HEX_RE.sub("<id>", value))[:500]
        path = UUID_RE.sub("<id>", LONG_HEX_RE.sub("<id>", parts.path))
        return f"{parts.scheme}://{parts.netloc}{path}"[:500]
    except Exception:
        return UUID_RE.sub("<id>", LONG_HEX_RE.sub("<id>", value))[:500]


def sanitize_text(value: str, limit: int = 500) -> str:
    value = UUID_RE.sub("<id>", LONG_HEX_RE.sub("<id>", value))
    return value[:limit]


def compact_args(args: Any) -> dict[str, Any]:
    if not isinstance(args, dict):
        return {}
    out: dict[str, Any] = {}
    direct_sources = [args]
    if isinstance(args.get("data"), dict):
        direct_sources.insert(0, args["data"])
    for source in direct_sources:
        for key in (
            "url", "requestId", "statusCode", "mimeType",
            "encodedDataLength", "decodedBodyLength", "transferSize",
            "requestMethod", "resourceType", "frame",
        ):
            value = source.get(key)
            if value is None or key in out:
                continue
            if isinstance(value, str):
                out[key] = sanitize_url(value) if key == "url" else sanitize_text(value)
            elif isinstance(value, (int, float, bool)):
                out[key] = value

    interesting = {
        "type", "functionName", "scriptName", "url", "requestId", "statusCode",
        "mimeType", "encodedDataLength", "decodedBodyLength", "transferSize",
        "frame", "frameTreeNodeId", "nodeId", "timerId", "id", "name",
        "message", "columnNumber", "lineNumber", "styleSheetUrl", "reason",
    }

    def walk(value: Any, depth: int = 0) -> None:
        if depth > 4:
            return
        if isinstance(value, dict):
            for key, child in value.items():
                if key in interesting and key not in out:
                    if isinstance(child, str):
                        out[key] = sanitize_url(child) if key in {"url", "scriptName", "styleSheetUrl"} else sanitize_text(child)
                    elif isinstance(child, (int, float, bool)) or child is None:
                        out[key] = child
                if key in {"data", "beginData", "endData", "stackTrace", "detail", "params"}:
                    walk(child, depth + 1)
        elif isinstance(value, list):
            for child in value[:8]:
                walk(child, depth + 1)

    walk(args)
    return out


def iter_trace_event_blobs(stream: BinaryIO, max_capture_bytes: int = 16 * 1024 * 1024) -> Iterator[tuple[bytes | None, int, bytes]]:
    needle = b'"traceEvents"'
    buffer = b""
    while True:
        chunk = stream.read(1024 * 1024)
        if not chunk:
            raise RuntimeError("traceEvents array not found")
        buffer += chunk
        index = buffer.find(needle)
        if index >= 0:
            buffer = buffer[index + len(needle):]
            break
        buffer = buffer[-len(needle):]

    while b"[" not in buffer:
        chunk = stream.read(1024 * 1024)
        if not chunk:
            raise RuntimeError("traceEvents opening bracket not found")
        buffer += chunk
    buffer = buffer[buffer.index(b"[") + 1:]

    in_string = False
    escaped = False
    brace_depth = 0
    collecting = False
    captured = bytearray()
    prefix = bytearray()
    total_size = 0
    oversized = False

    while True:
        if not buffer:
            buffer = stream.read(1024 * 1024)
            if not buffer:
                break
        pos = 0
        length = len(buffer)
        while pos < length:
            byte = buffer[pos]
            pos += 1
            if not collecting:
                if byte == 0x7B:  # {
                    collecting = True
                    brace_depth = 1
                    in_string = False
                    escaped = False
                    captured = bytearray(b"{")
                    prefix = bytearray(b"{")
                    total_size = 1
                    oversized = False
                elif byte == 0x5D:  # ]
                    return
                continue

            total_size += 1
            if len(prefix) < 4096:
                prefix.append(byte)
            if not oversized:
                if len(captured) < max_capture_bytes:
                    captured.append(byte)
                else:
                    oversized = True
                    captured = bytearray()

            if in_string:
                if escaped:
                    escaped = False
                elif byte == 0x5C:  # backslash
                    escaped = True
                elif byte == 0x22:  # quote
                    in_string = False
                continue

            if byte == 0x22:
                in_string = True
            elif byte == 0x7B:
                brace_depth += 1
            elif byte == 0x7D:
                brace_depth -= 1
                if brace_depth == 0:
                    yield (None if oversized else bytes(captured), total_size, bytes(prefix))
                    collecting = False
                    captured = bytearray()
                    prefix = bytearray()
                    total_size = 0
        buffer = b""


def add_duration_event(
    event: dict[str, Any],
    duration_us: float,
    durations: list[dict[str, Any]],
    stats: dict[tuple[int, int, str], list[float]],
    thread_domains: collections.Counter[tuple[int, int, str]],
) -> None:
    if duration_us < 0:
        return
    pid = int(event.get("pid", -1))
    tid = int(event.get("tid", -1))
    name = str(event.get("name", ""))
    key = (pid, tid, name)
    bucket = stats.setdefault(key, [0.0, 0.0, 0.0])
    bucket[0] += duration_us
    bucket[1] += 1
    bucket[2] = max(bucket[2], duration_us)

    args = compact_args(event.get("args"))
    for value in args.values():
        if isinstance(value, str) and value.startswith(("http://", "https://", "chrome-extension://")):
            domain = urlsplit(value).netloc or "unknown"
            thread_domains[(pid, tid, domain)] += 1

    if duration_us >= 1000:
        durations.append({
            "pid": pid,
            "tid": tid,
            "ts": float(event.get("ts", 0)),
            "dur": duration_us,
            "name": name,
            "cat": sanitize_text(str(event.get("cat", "")), 240),
            "args": args,
        })


def analyze(input_path: Path, output_path: Path) -> None:
    event_count = 0
    invalid_count = 0
    oversized_events: list[dict[str, Any]] = []
    names = collections.Counter()
    phases = collections.Counter()
    categories = collections.Counter()
    thread_names: dict[tuple[int, int], str] = {}
    process_names: dict[int, str] = {}
    process_labels: dict[int, str] = {}
    duration_stats: dict[tuple[int, int, str], list[float]] = {}
    duration_events: list[dict[str, Any]] = []
    thread_domains: collections.Counter[tuple[int, int, str]] = collections.Counter()
    begin_stacks: dict[tuple[int, int], list[dict[str, Any]]] = collections.defaultdict(list)
    networks: dict[str, dict[str, Any]] = {}
    console_events: list[dict[str, Any]] = []
    frames: list[dict[str, Any]] = []
    min_ts = math.inf
    max_ts = 0.0
    thread_ts_bounds: dict[tuple[int, int], list[float]] = {}

    with gzip.open(input_path, "rb") as stream:
        for blob, raw_size, prefix in iter_trace_event_blobs(stream):
            event_count += 1
            if blob is None:
                text = prefix.decode("utf-8", "replace")
                match = re.search(r'"name"\s*:\s*"([^"]+)"', text)
                oversized_events.append({"name": sanitize_text(match.group(1) if match else "unknown"), "bytes": raw_size})
                continue
            try:
                event = json.loads(blob)
            except Exception:
                invalid_count += 1
                continue
            if not isinstance(event, dict):
                continue
            name = str(event.get("name", ""))
            ph = str(event.get("ph", ""))
            cat = str(event.get("cat", ""))
            names[name] += 1
            phases[ph] += 1
            for item in cat.split(","):
                if item:
                    categories[item] += 1
            ts = event.get("ts")
            pid = int(event.get("pid", -1))
            tid = int(event.get("tid", -1))
            if isinstance(ts, (int, float)):
                event_start = float(ts)
                event_end = event_start + float(event.get("dur", 0) or 0)
                # Chrome metadata and clock-sync records may use zero or a
                # different clock domain. DevTools timeline timestamps in real
                # recordings are positive monotonic microseconds.
                if event_start > 1_000_000:
                    min_ts = min(min_ts, event_start)
                    max_ts = max(max_ts, event_end)
                    bounds = thread_ts_bounds.setdefault(
                        (pid, tid),
                        [event_start, event_end],
                    )
                    bounds[0] = min(bounds[0], event_start)
                    bounds[1] = max(bounds[1], event_end)

            args = event.get("args") if isinstance(event.get("args"), dict) else {}

            if ph == "M":
                data_name = args.get("name")
                if name == "thread_name" and isinstance(data_name, str):
                    thread_names[(pid, tid)] = sanitize_text(data_name, 160)
                elif name == "process_name" and isinstance(data_name, str):
                    process_names[pid] = sanitize_text(data_name, 160)
                elif name == "process_labels" and isinstance(args.get("labels"), str):
                    process_labels[pid] = sanitize_text(args["labels"], 240)
                continue

            if name == "TracingStartedInBrowser":
                data = args.get("data") if isinstance(args.get("data"), dict) else {}
                raw_frames = data.get("frames") if isinstance(data.get("frames"), list) else []
                for frame in raw_frames:
                    if not isinstance(frame, dict):
                        continue
                    frames.append({
                        "frame": sanitize_text(str(frame.get("frame", "")), 80),
                        "processId": frame.get("processId"),
                        "url": sanitize_url(str(frame.get("url", ""))),
                        "name": sanitize_text(str(frame.get("name", "")), 160),
                        "parent": sanitize_text(str(frame.get("parent", "")), 80),
                    })

            if ph == "X" and isinstance(event.get("dur"), (int, float)):
                add_duration_event(event, float(event["dur"]), duration_events, duration_stats, thread_domains)
            elif ph == "B":
                begin_stacks[(pid, tid)].append(event)
            elif ph == "E":
                stack = begin_stacks[(pid, tid)]
                if stack:
                    begin = stack.pop()
                    if isinstance(begin.get("ts"), (int, float)) and isinstance(event.get("ts"), (int, float)):
                        add_duration_event(begin, float(event["ts"]) - float(begin["ts"]), duration_events, duration_stats, thread_domains)

            compact = compact_args(args)
            request_id = compact.get("requestId")
            if request_id is not None:
                request_id = str(request_id)
                record = networks.setdefault(request_id, {"requestId": sanitize_text(request_id, 120)})
                if name in {"ResourceSendRequest", "ResourceWillSendRequest", "ResourceReceiveResponse", "ResourceFinish", "ResourceReceivedData"}:
                    record.setdefault("events", []).append({"name": name, "ts": event.get("ts"), "args": compact})
                    if "url" in compact:
                        record["url"] = compact["url"]
                    for key in ("statusCode", "mimeType", "encodedDataLength", "decodedBodyLength"):
                        if key in compact:
                            record[key] = compact[key]

            if "console" in cat.lower() or name in {"ConsoleMessage", "LogMessage"}:
                if len(console_events) < 1000:
                    console_events.append({
                        "ts": event.get("ts"), "pid": pid, "tid": tid,
                        "name": name, "cat": sanitize_text(cat, 200), "args": compact,
                    })

            if event_count % 250000 == 0:
                print(f"parsed {event_count:,} events", flush=True)

    # Pick the renderer main thread most strongly associated with chatgpt.com.
    main_candidates = [key for key, value in thread_names.items() if value == "CrRendererMain"]
    def main_score(key: tuple[int, int]) -> tuple[int, float]:
        pid, tid = key
        chatgpt_hits = thread_domains[(pid, tid, "chatgpt.com")]
        run_total = duration_stats.get((pid, tid, "RunTask"), [0.0])[0]
        return (chatgpt_hits, run_total)
    main_thread = max(main_candidates, key=main_score) if main_candidates else None

    main_duration_events = []
    top_names = []
    long_tasks = []
    if main_thread:
        mpid, mtid = main_thread
        main_duration_events = [event for event in duration_events if event["pid"] == mpid and event["tid"] == mtid]
        rows = []
        for (pid, tid, name), (total, count, maximum) in duration_stats.items():
            if (pid, tid) == main_thread:
                rows.append({"name": name, "totalMs": total / 1000, "count": int(count), "maxMs": maximum / 1000})
        top_names = sorted(rows, key=lambda row: row["totalMs"], reverse=True)[:120]
        long_tasks = sorted(
            [event for event in main_duration_events if event["name"] in {"RunTask", "ThreadControllerImpl::RunTask", "TaskQueueManager::ProcessTaskFromWorkQueue"} and event["dur"] >= 50000],
            key=lambda event: event["dur"], reverse=True,
        )[:100]
        if not long_tasks:
            long_tasks = sorted([event for event in main_duration_events if event["dur"] >= 50000], key=lambda event: event["dur"], reverse=True)[:100]

        # Add a compact child breakdown for the worst tasks.
        for task in long_tasks[:30]:
            start = task["ts"]
            end = start + task["dur"]
            contained = [
                event for event in main_duration_events
                if event is not task and event["ts"] >= start and event["ts"] + event["dur"] <= end and event["dur"] >= 500
            ]
            task["topChildren"] = [
                {**child, "durMs": child["dur"] / 1000}
                for child in sorted(contained, key=lambda event: event["dur"], reverse=True)[:30]
            ]
            task["durMs"] = task["dur"] / 1000

    network_rows = []
    for record in networks.values():
        events = sorted(record.get("events", []), key=lambda item: item.get("ts") or 0)
        if not events:
            continue
        start = events[0].get("ts")
        end = events[-1].get("ts")
        network_rows.append({
            "requestId": record.get("requestId"),
            "url": record.get("url"),
            "statusCode": record.get("statusCode"),
            "mimeType": record.get("mimeType"),
            "encodedDataLength": record.get("encodedDataLength"),
            "decodedBodyLength": record.get("decodedBodyLength"),
            "startTs": start,
            "endTs": end,
            "durationMs": ((end - start) / 1000) if isinstance(start, (int, float)) and isinstance(end, (int, float)) else None,
            "eventNames": [item["name"] for item in events],
        })

    summary = {
        "inputBytes": input_path.stat().st_size,
        "eventCount": event_count,
        "invalidEventCount": invalid_count,
        "oversizedEvents": oversized_events,
        "traceDurationMs": ((max_ts - min_ts) / 1000) if min_ts < math.inf else 0,
        "processes": [
            {"pid": pid, "name": process_names.get(pid), "labels": process_labels.get(pid)}
            for pid in sorted(set(process_names) | set(process_labels))
        ],
        "threads": [
            {
                "pid": pid, "tid": tid, "name": name,
                "topDomains": [
                    {"domain": domain, "count": count}
                    for (epid, etid, domain), count in thread_domains.most_common()
                    if (epid, etid) == (pid, tid)
                ][:10],
            }
            for (pid, tid), name in sorted(thread_names.items())
        ],
        "frames": frames,
        "mainThread": None if main_thread is None else {
            "pid": main_thread[0], "tid": main_thread[1],
            "threadName": thread_names.get(main_thread),
            "processName": process_names.get(main_thread[0]),
            "processLabels": process_labels.get(main_thread[0]),
            "durationMs": (
                (thread_ts_bounds[main_thread][1] - thread_ts_bounds[main_thread][0]) / 1000
                if main_thread in thread_ts_bounds else 0
            ),
        },
        "topEventNames": names.most_common(200),
        "topCategories": categories.most_common(100),
        "phases": phases,
        "mainThreadTopDurations": top_names,
        "mainThreadLongTasks": long_tasks,
        "network": sorted(network_rows, key=lambda row: row.get("startTs") or 0),
        "console": console_events,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({
        "events": event_count,
        "durationMs": summary["traceDurationMs"],
        "mainThread": summary["mainThread"],
        "longTasks": len(long_tasks),
        "network": len(network_rows),
        "oversizedEvents": oversized_events,
        "output": str(output_path),
    }, ensure_ascii=False, indent=2))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("trace", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    analyze(args.trace, args.output)


if __name__ == "__main__":
    main()
