# Tag Insurance in the REVB demo

Available at **More / Advanced → Tag Insurance**. Requires the firmware from `feature/validate-tag`. This demo does not emulate the measurement on the host: the reader owns timing, counting, retry identity, and the final verdict.

## Client contract

Use the existing JSON command/notification characteristic:

```json
{"cmd":"GTI"}
{"cmd":"TI","val":1,"min":30,"bins":10,"gap":500}
{"cmd":"TI","val":0}
```

Query mode on each connection **before** normal RF settings/scan operations. Wait for device confirmation of a mode change; completion of the BLE write is not confirmation. On timeout, retain an unknown/locked state and query again. Disconnect does not disable the reader's mode. Mode and the last result are volatile; reboot restores normal operation after RF recovery.

Activation uses a temporary preset: 10 dBm, profile 11 / 640 kHz FM0, S0, Q2, Target A, TagFocus off, query interval 0. Frequency is retained. Active EPC masks prevent activation. The reader journals/restores its normal RF settings, including a U16 profile. If restoration fails it stays locked with TEST ERROR; do not assume normal mode.

Thresholds are configurable before activation and **provisional until calibrated**: `min` integer 1..10000 reports, `bins` integer 1..12 occupied 250 ms bins, `gap` integer 100..3000 ms. All three must pass. Defaults 30/10/500. Repeating TI=1 while already enabled returns current settings; exit/re-enter to change thresholds.

```json
{"cmd":"TIC","min":30,"bins":10,"gap":500}
{"cmd":"TI","on":1,"s":"ok","id":12,"a":1,"e":"1122334455667788AABBCCDD","n":60,"t":3000,"b":12,"g":50,"r":0,"z":0}
```

| Field | Meaning |
| --- | --- |
| on | Mode enabled, numeric 0/1. |
| s | off / ready / preparing (CHECK RF) / running / ok / check / no_read / more / cancelled / error. |
| id | Run ID within this activation; not a durable record ID. |
| a | Attempt 1/2; off has 0. |
| e | Full EPC, 0..32 hex characters. Show the last six on compact displays; compare full EPC. |
| n / t | Valid EPC report count / elapsed ms (0..3000). |
| b / g | Occupied time bins / max no-read gap in ms. Final gap includes start/end of the window. |
| r | 0 none, 1 RF, 2 data/overflow, 3 invalid EPC, 4 wrong retry EPC, 5 battery, 6 restore. |
| z | Device busy measuring/stopping/draining, 0/1. Disable mode change while 1, even when s is already more/cancelled/error. |

Error responses to commands use `{"cmd":"TI","status":"err","error":"busy"}` (also `invalid_params`, `invalid_or_battery`, `preset_or_restore`, `booting`). They are separate from a measurement result with `s:"error"`.

Notifications arrive approximately 5 Hz during measurement. Query GTI to recover a missed final notification; the demo polls at 1.5 s while enabled/unknown. The maximum snapshot fits 182 bytes. This feature does not change the Live binary protocol, PHY, MTU, or add transport acknowledgements/replay.

## Operator flow

One trigger press verifies the preset (CHECK RF: power/profile/Q/session/TagFocus/query/mask), then starts a fixed 3-second window. A reader-only reset that loses the temporary preset invalidates the test. A second press cancels, including a press queued during preflight. The timer does not restart on the first tag. Allow a short tail-drain period after 3 seconds before the final result. The reader continues autonomously without BLE.

- TAG-OK: one EPC, all thresholds met. Next trigger starts a new product.
- CHECK TAG / NO READ on attempt 1: retry the same product **once at the same marked position**.
- CHECK TAG / NO READ on attempt 2: replace with a QC-approved tag and recheck. The next trigger starts attempt 1.
- MORE TAG: isolate the product and retry. Cancel, multiple tags and device/data errors do not consume the pending retry.
- A known EPC from attempt 1 is enforced on retry. After NO READ there is no known identity; the operator must retain the same product.

No host scan/start command is needed in this workflow. Use the physical trigger. Normal Scan/Find/Write/Settings controls are locked while Insurance owns RF. The panel is intentionally small and has no persistent product/history database; the service report includes the current result/configuration.

Count measures reader reports, not intrinsic tag quality or an independent RF timestamp. Verify good and bad samples under the same distance/orientation before selecting production thresholds. A single detected EPC cannot prove physical identity or absence of other tags that did not respond.

Validation: `npm run lint` (TypeScript without output), `npm run test`. Publication is handled separately by Vercel's Git integration. End-to-end BLE and RF calibration require the updated reader firmware on hardware.
