# New capture diagnosis (before fixes)

This report contains only aggregate, redacted measurements.

## Summary

- Trace duration: `487315784.925 ms`
- Worst main-thread task: `24853.295 ms`
- Long tasks: `157`
- Initial conversation requests: `0`
- History requests: `0`
- Legacy full requests: `17`

## Findings

### main-thread-freeze (critical)

The freezes are main-thread stalls, so unrelated UI such as the sidebar cannot respond while they run.

```json
{
  "maxTaskMs": 24853.295,
  "longTaskCount": 157,
  "longTaskTotalMs": 53509.415
}
```

### layout-paint-pressure (high)

Style, layout, pre-paint, and paint form a material part of the blocked windows.

```json
{
  "layoutCoreInclusiveMs": 46509.875,
  "layoutPaintInclusiveMs": 47515.267
}
```

### script-pressure (high)

JavaScript execution is a major contributor, not just network latency.

```json
{
  "scriptInclusiveMs": 92270.425,
  "topScripts": [
    {
      "source": "2340486e-i20axdnmh5jcl165.js",
      "inclusiveMs": 30489.36
    },
    {
      "source": "chrome-extension://:extension",
      "inclusiveMs": 2310.445
    },
    {
      "source": "bcae0416-j0wb7gki96xrx9sq.js",
      "inclusiveMs": 1873.057
    },
    {
      "source": "8b34dbc2-h9xyg2koz689ttr1.js",
      "inclusiveMs": 60.803
    },
    {
      "source": "4813494d-l3iadyutom9ijssn.js",
      "inclusiveMs": 6.944
    },
    {
      "source": "0631b696-glw2xi0e51thcgtf.js",
      "inclusiveMs": 1.179
    },
    {
      "source": "https://chatgpt.com/c/:id",
      "inclusiveMs": 0.384
    },
    {
      "source": "conversation-small-k3kcucfbrrlc8z48.js",
      "inclusiveMs": 0.338
    },
    {
      "source": "https://chatgpt.com/g/:id/c/:id",
      "inclusiveMs": 0.169
    },
    {
      "source": "70025534-m8tlqo1dyi0mkzus.js",
      "inclusiveMs": 0.008
    },
    {
      "source": "LoadTimes",
      "inclusiveMs": 0.001
    },
    {
      "source": "f025431a-ehagpvg3m4e1cduv.js",
      "inclusiveMs": 0.001
    }
  ]
}
```

### gc-pressure (medium)

Garbage collection adds visible pauses and suggests large temporary allocations.

```json
{
  "gcInclusiveMs": 15299.899
}
```

### legacy-full-request (high)

The capture still contains legacy full-conversation traffic.

```json
{
  "count": 17,
  "maxBodyBytes": 9178663
}
```

## Recommended changes

- **remove-global-scroll-geometry-scan** — The current rich-text warmer listens to every captured scroll, including sidebar scrolling, and reads all cold-node geometry.
- **use-browser-managed-richtext-observation** — Use IntersectionObserver and idle queues instead of getBoundingClientRect loops on scroll.
- **offload-large-json-work** — Parse, merge, filter, and stringify paginated payloads in a Worker so the sidebar remains responsive.
- **bound-cursor-completion** — Reuse completed semantic-turn pages and avoid repeated exponential cursor probes for one manual click.
- **instrument-fix-overhead** — Add diagnostics for optimizer worker time, main-thread handoff, mutation scans, and rich-block activations.
