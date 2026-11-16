# Tag Insurance web validation — 2026-11-16

Final automated checks passed: **331 tests / 16 files**, `tsc --noEmit`,
Vite production build and V8 coverage gates, rerun after simplifying the
Insurance page to visible test criteria, mode controls and results. RF controls
remain on Device settings. The application source was validated on
`feature/validate-tag` at `c613330`; its merge into `main` targets the production
demo at [nhr10-b.vercel.app](https://nhr10-b.vercel.app/).

## Coverage

| Scope | Lines | Branches |
| --- | ---: | ---: |
| All application components/hooks/services/utilities | 72.24% (1931/2673) | 71.88% (2099/2920) |
| Tag Insurance controller | 100% | 98.50% |
| Tag Insurance protocol/validation | 100% | 87.34% |
| Tag Insurance page | 93.75% | 93.84% |

The report includes untested source files. Global floors are 70% for lines,
statements, functions and branches; critical Insurance files have separate
floors in `vitest.config.ts`. These are regression gates, not a substitute for
device testing or a claim that all browser interactions are covered.

## Regression coverage

- Configurable 1–30-second timing, partial 250 ms windows, strict threshold
  bounds, legacy 3-second fallback and per-connection capability reset.
- Mode confirmation rather than write-success; stale OFF/duplicate requests,
  lost boot status, rejected query/write and old-connection failures.
- Reconnect during autonomous measurement, retained final result, busy locks,
  current RF setup, distinct warning/quality/transport result semantics.
- Existing Live/Find/settings/battery behavior and command coordination.
- NHRB binary history fixture (independent CRC), nonzero buffer offsets,
  malformed headers, truncation/trailing data, corrupt payload, bounded busy
  retries and cancellation on completion/error/clear/unmount.

## Reproduce

```powershell
npm ci
npm run test:coverage
npm run lint
npm run build
```

Open `coverage/index.html`; machine-readable summary is
`coverage/coverage-summary.json`. Coverage artifacts and `dist/` are ignored.
The runner/provider versions match at Vitest 5.0.0; Node 24 was used here.

Tests simulate BLE/browser events; they do not establish Android/iOS radio
compatibility, GATT throughput, physical RFID results or LCD behavior. Updated
firmware is needed for configurable `dur`; older firmware stays at 3000 ms.
Physical release acceptance follows the firmware `docs/RELEASE_VALIDATION.md`.
