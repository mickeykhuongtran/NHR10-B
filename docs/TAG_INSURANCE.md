# Tag Insurance in the REVB demo

Available at **More / Advanced → Tag Insurance**. Requires the firmware from `feature/validate-tag`. This demo does not emulate the measurement on the host: the reader owns timing, counting, full EPC identity within each trial, and the final verdict.

## Client contract

Use the existing JSON command/notification characteristic:

```json
{"cmd":"GTI"}
{"cmd":"TI","val":1,"min":30,"bins":10,"gap":500,"dur":3000}
{"cmd":"TI","val":0}
```

Query mode on each connection **before** normal RF settings/scan operations. Wait for device confirmation of a mode change; completion of the BLE write is not confirmation. On timeout, retain an unknown/locked state and query again. Disconnect does not disable the reader's mode. Mode and the last result are volatile; reboot restores normal operation after RF recovery.

Use the separate **Device settings** page to Read/Apply power, profile (V2.25 or U16), Q/session, Tag Focus, query timing, and region before activation. Tag Insurance shows only its test criteria, mode controls and results; the RF configuration form is not duplicated. Each Apply uses the existing ACK/readback confirmation. No preset is automatically applied. The reader reserves its current settings and verifies them before each trial; enabling/disabling Insurance does not write RF settings or revert settings chosen by the host. To change them, stop Insurance, apply the new setup in Device settings, then enable again. Active EPC masks still prevent activation because they can hide competing tags.

New sessions do not write a recovery journal. Firmware retains one-time recovery of an old preset journal during upgrades; a recovery failure keeps RF locked. Read rate depends on session, Tag Focus, query timing and other RF conditions as well as the tag: calibrate thresholds against known samples for each reference setup.

Configure **Remain Time (ms)** and three pass thresholds before activation; values are **provisional until calibrated**. `dur` is an integer 1000..30000 ms, default 3000. `min` is 1..10000 reports, `bins` is 1..ceil(dur/250) occupied 250 ms windows, and `gap` is 100..dur ms. All three thresholds must pass within the chosen duration. Defaults are 3000/30/10/500. The final window may be shorter than 250 ms; it counts once if it contains a read. Invalid combinations are rejected rather than silently corrected. Repeating TI=1 while already enabled returns current settings; exit/re-enter to change them.

Legacy requests without `dur` keep the 3-second behavior. Firmware reports `dur` in both TIC and TI. The demo disables custom timing until a valid response confirms support; legacy TIC without dur is treated as fixed 3000 ms. Reconnect clears capability state. A result's progress uses its own TI.dur even if TIC was lost; it never uses the unconfirmed input draft.

```json
{"cmd":"TIC","min":30,"bins":10,"gap":500,"dur":3000}
{"cmd":"TI","on":1,"s":"ok","id":12,"a":1,"e":"1122334455667788AABBCCDD","n":60,"t":3000,"b":12,"g":50,"r":0,"z":0,"dur":3000}
```

| Field | Meaning |
| --- | --- |
| on | Mode enabled, numeric 0/1. |
| s | off / ready / preparing (CHECK RF) / running / ok / check / no_read / more / cancelled / error. |
| id | Run ID within this activation; not a durable record ID. |
| a | Reserved compatibility field: 1 while enabled, 0 off. No retry counter. |
| e | Full EPC, 0..32 hex characters. Show the last six on compact displays; compare full EPC. |
| n / t | Valid EPC report count / elapsed ms (0..dur). |
| dur | Configured observation duration, 1000..30000 ms. Missing on legacy firmware means 3000 ms. |
| b / g | Occupied time bins / max no-read gap in ms. Final gap includes start/end of the window. |
| r | 0 none, 1 RF, 2 data/overflow, 3 invalid EPC, 4 reserved (legacy retry EPC), 5 battery, 6 restore. |
| z | Device busy measuring/stopping/draining, 0/1. Disable mode change while 1, even when s is already more/cancelled/error. |

Error responses to commands use `{"cmd":"TI","status":"err","error":"busy"}` (also `invalid_params`, `invalid_or_battery`, `setup_or_recovery`, `booting`). They are separate from a measurement result with `s:"error"`.

Notifications arrive approximately 5 Hz during measurement. Query GTI to recover a missed final notification; the demo polls at 1.5 s while enabled/unknown. The maximum snapshot fits 182 bytes. This feature does not change the Live binary protocol, PHY, MTU, or add transport acknowledgements/replay.

## Operator flow

One trigger press checks the current RF configuration, then starts the configured observation window. Preflight and RF stop/tail-drain are outside it. A changed configuration after reader reset invalidates the trial. A second press cancels. The timer does not restart on the first tag; reports at or after the deadline are excluded. Allow stop/drain before the final verdict. Every trigger starts an independent trial; there is no enforced retry identity or replacement decision.

LCD: Bluetooth/battery status, TAG INSURANCE header, gray RF-wave icon when idle and blue while scanning until the first EPC, then last six EPC characters, recent read/s, signal segments and elapsed-time bar. No TESTING/MORE TAG/Signal labels or footer instructions. Rate is calculated on the device over completed 100 ms bins in a trailing window up to one second; cumulative `n` remains unchanged in the BLE contract.

- TAG OK: black overlay with a green tick inside a green circle and white TAG OK for 2 seconds and two beeps.
- CHECK TAG (`s:more`): yellow outlined warning triangle, white text on black for 1 second. A second EPC requires isolation or reader repositioning; it does not establish a defective tag. Shown while stopping too, with RF controls still locked.
- NO TAG FOUND (`s:no_read`): yellow warning triangle for 2 seconds; no tag detected in the configured observation window.
- TAG ERROR (`s:check`): red warning triangle for 2 seconds; a valid single-EPC measurement failed at least one configured read/coverage/gap threshold under this setup.
- TEST ERROR (`s:error`): red warning triangle for 1 second; RF/data/battery error, reason retained in `r`. The measurement is invalid and is not a tag-quality verdict.
- Cancel: return to waiting without a verdict.

Wire state names are unchanged. App teams supporting configurable timing must send `dur`, parse it from TIC/TI, use it for progress and accept t/g up to dur and b up to ceil(dur/250). Existing apps that omit dur continue with 3 seconds. Warning results use one attention beep, TAG OK two short beeps, and TAG ERROR/TEST ERROR three beeps. There is no retry/replacement workflow.

Popup timeout is local presentation only; GTI retains the last result. Repeated GTI must not reopen old LCD popups. A new trigger dismisses the popup immediately and starts the next trial if idle. An error popup may remain longer if RF is still draining; the next trial cannot begin before idle. The app retains its result card for review.
No host scan/start command is needed in this workflow. Use the physical trigger. Normal Scan/Find/Write/Settings controls are locked while Insurance owns RF. The panel is intentionally small and has no persistent product/history database; the service report includes the current result/configuration.

Count measures reader reports, not intrinsic tag quality or an independent RF timestamp. Verify good and bad samples under the same distance/orientation before selecting production thresholds. A single detected EPC cannot prove physical identity or absence of other tags that did not respond.

Validation: `npm run lint` (TypeScript without output), `npm run test`. Publication is handled separately by Vercel's Git integration. End-to-end BLE and RF calibration require the updated reader firmware on hardware.

## Threshold meaning and invalid results

- Remain Time: total inventory observation window, default 3000 ms; not a host countdown or a wait after the first read.
- Minimum reads: cumulative reports over the configured time; 30 is not 30 read/s.
- Active 250 ms windows: at least one read in each counted window, out of ceil(dur/250). This measures time coverage, not continuous RF-on duration.
- Longest silence: no-read interval including initial and final gaps as well as intervals between reads.

All three must pass with exactly one EPC and a valid measurement. `s:error,r:2` is a data-integrity/finalization error, even if count/bins/gap meet the thresholds. The UI now displays the specific reason and does not recommend lowering thresholds or replacing a tag on this error. Firmware fixes a reproducible 6-byte STOP ACK being left in a parser that previously waited for 7 bytes. Actual CRC errors/truncated data remain invalid. Other r=2 causes require the firmware's detailed `Insurance invalid` log.

Changing duration changes the interpretation of minimum reads and occupied windows. For example, 5000 ms has 20 windows; 17/20 is close to the old 10/12 coverage ratio, while keeping 10/20 relaxes it. Recalibrate counts with reference samples; do not silently rescale the three thresholds. RSSI remains visual feedback only.

## Reader messages

The existing `POPUP` command is a full-screen black message with centered text and an OK button, without any status icon. Example: `{"cmd":"POPUP","content":"Picked 12 of 12","time":2000,"beep":false}`. It closes on OK or the supplied timeout. The existing 15-byte UTF-8 text limit and beep option remain. Critical firmware alerts take priority; internal success/warning/error notices retain their green-circle/yellow-triangle/red-triangle icons.
