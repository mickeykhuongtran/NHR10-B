# Tag Insurance in the REVB demo

Available at **More / Advanced → Tag Insurance**. Requires the firmware from `feature/validate-tag`. This demo does not emulate the measurement on the host: the reader owns timing, counting, full EPC identity within each trial, and the final verdict.

## Client contract

Use the existing JSON command/notification characteristic:

```json
{"cmd":"GTI"}
{"cmd":"TI","val":1,"min":30,"bins":10,"gap":500}
{"cmd":"TI","val":0}
```

Query mode on each connection **before** normal RF settings/scan operations. Wait for device confirmation of a mode change; completion of the BLE write is not confirmation. On timeout, retain an unknown/locked state and query again. Disconnect does not disable the reader's mode. Mode and the last result are volatile; reboot restores normal operation after RF recovery.

Use **RF setup** on this page to Read/Apply power, profile (V2.25 or U16), Q/session, Tag Focus, query timing, and region before activation. Each Apply uses the existing ACK/readback confirmation. No preset is automatically applied. The reader reserves its current settings and verifies them before each trial; enabling/disabling Insurance does not write RF settings or revert settings chosen by the host. To change them, stop Insurance, apply the new setup, then enable again. Active EPC masks still prevent activation because they can hide competing tags.

New sessions do not write a recovery journal. Firmware retains one-time recovery of an old preset journal during upgrades; a recovery failure keeps RF locked. Read rate depends on session, Tag Focus, query timing and other RF conditions as well as the tag: calibrate thresholds against known samples for each reference setup.

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
| a | Reserved compatibility field: 1 while enabled, 0 off. No retry counter. |
| e | Full EPC, 0..32 hex characters. Show the last six on compact displays; compare full EPC. |
| n / t | Valid EPC report count / elapsed ms (0..3000). |
| b / g | Occupied time bins / max no-read gap in ms. Final gap includes start/end of the window. |
| r | 0 none, 1 RF, 2 data/overflow, 3 invalid EPC, 4 reserved (legacy retry EPC), 5 battery, 6 restore. |
| z | Device busy measuring/stopping/draining, 0/1. Disable mode change while 1, even when s is already more/cancelled/error. |

Error responses to commands use `{"cmd":"TI","status":"err","error":"busy"}` (also `invalid_params`, `invalid_or_battery`, `setup_or_recovery`, `booting`). They are separate from a measurement result with `s:"error"`.

Notifications arrive approximately 5 Hz during measurement. Query GTI to recover a missed final notification; the demo polls at 1.5 s while enabled/unknown. The maximum snapshot fits 182 bytes. This feature does not change the Live binary protocol, PHY, MTU, or add transport acknowledgements/replay.

## Operator flow

One trigger press checks the current RF configuration, then starts a fixed 3-second window. A changed configuration after reader reset invalidates the trial. A second press cancels. The timer does not restart on the first tag. Allow the RF stop/tail-drain period before the final verdict. Every trigger starts an independent trial; there is no enforced retry identity or replacement decision.

LCD: TAG INSURANCE header, scanning icon until the first EPC, then last six EPC characters, recent read/s, signal segments and elapsed-time bar. No TESTING/MORE TAG/Signal labels or footer instructions. Rate is calculated on the device over completed 100 ms bins in a trailing window up to one second; cumulative `n` remains unchanged in the BLE contract.

- TAG OK: green tick popup for 2 seconds and two beeps.
- CHECK TAG / NO READ: yellow popup for 2 seconds; no retry/replacement workflow.
- Second EPC: red ERROR popup for 1 second, stop and return to waiting. API `s` remains `more` so the app can explain the cause.
- Device/data errors: red ERROR popup; reason retained in `r`.
- Cancel: return to waiting without a verdict.

Popup timeout is local presentation only; GTI retains the last result. Repeated GTI must not reopen old LCD popups. A new trigger dismisses the popup immediately and starts the next trial if idle. An error popup may remain longer if RF is still draining; the next trial cannot begin before idle. The app retains its result card for review.
No host scan/start command is needed in this workflow. Use the physical trigger. Normal Scan/Find/Write/Settings controls are locked while Insurance owns RF. The panel is intentionally small and has no persistent product/history database; the service report includes the current result/configuration.

Count measures reader reports, not intrinsic tag quality or an independent RF timestamp. Verify good and bad samples under the same distance/orientation before selecting production thresholds. A single detected EPC cannot prove physical identity or absence of other tags that did not respond.

Validation: `npm run lint` (TypeScript without output), `npm run test`. Publication is handled separately by Vercel's Git integration. End-to-end BLE and RF calibration require the updated reader firmware on hardware.
