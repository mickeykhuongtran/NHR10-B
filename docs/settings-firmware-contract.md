# Device settings: current NHR10-B contract

Updated 2026-11-15 against `D:/Firmware-Develop/NHR-10-REVB/components/ble_service/ble_command_protocol.c` and `components/rfid_module/` on `dev/adaptiveVerC-to-VerB`, including its transaction-layer integration. This web update preserves REVB U16/V2.25 profile formats and frequency plans. See [Region integration](region-firmware-contract.md) and [compatibility audit](revb-transaction-compatibility.md).

## Response-aware coordination

Read waits for a valid reply. Apply waits for the originating SET acknowledgement, requests a fresh corresponding GET, and compares the reported value with the submitted value. GATT completion is delivery only. A missing SET acknowledgement never becomes a successful Apply based only on a GET. Settings buttons retain stable React identities, keyboard focus and reserved feedback space.

Initialization, Diagnostics refresh, Settings and scan presets share one coordinator through their terminal replies. Scan, Locate, writes and other settings cannot start during a pending configuration operation. Busy fails with an instruction to stop the active RF operation; the app never automatically repeats a SET. Disconnect and unmount cancel pending work. Unrelated LCD SET replies cannot finish or fail a GET.

Firmware permits 2 seconds per UART exchange and holds its mutex across complete multi-exchange transactions. Browser response budgets allow 8 seconds for an already running LCD/startup transaction plus 1 second for BLE delivery: ordinary GET/SET 11 s, GLP 13 s, GRP 15 s, SLP 17 s, SRP 19 s, SF 15 s. SF plus fresh GF allows at most 26 s. These are bounded browser budgets, not a guarantee of admission under continuous competing LCD work.

Periodic GT polling and the false-offline heartbeat check pause during configuration. Battery polling, stale marking and battery protection remain active. An RFID timeout, transport error or uncertain GATT delivery requires a successful fresh UART GET before another configuration write or RF start. DI does not clear recovery because it never accesses the RFID UART. Reconnecting BLE alone does not reset firmware quarantine. If a fresh read still fails, restart the reader module and controller together. No SET is retried automatically.

## RF Link Profile and baseband

| Product preset | Format 1 ID | Format 2 ID |
|---|---:|---:|
| STD — 640 kHz / Miller 4 | 53 | 15 |
| QUICK — 640 kHz / FM0 | 11 | 11 |
| DEEP — 160 kHz / Miller 8 | 13 | 13 |

Only the firmware `format` field selects the preset table. Missing or unrecognized format stays unknown; no format is inferred from profile ID. The raw ID remains visible and can be reapplied after a fresh read. IDs are unsigned 16-bit integers, 0–65535, without truncation. Unsupported IDs are for the module to reject; presets are not an exhaustive catalog.

```json
{"cmd":"GLP"}
{"cmd":"GLP","val":15,"format":2}
{"cmd":"SLP","val":13}
{"cmd":"SLP","status":"ok","val":13,"format":2,"persisted":true}
{"cmd":"SRP","val":"15,4,1,0"}
{"cmd":"GLP","val":15,"format":2}
{"cmd":"SRP","status":"ok"}
{"cmd":"GRP"}
{"cmd":"GRP","val":"15,4,1,0","format":2}
```

SLP requires its matching saved ACK with `persisted: true`, then matching GLP. SRP uses `profile,Q,session,target`, with session 255 meaning Auto. The current firmware sends a preceding GLP profile update and a status-only SRP success after profile persistence and Q/session acknowledgement. The web accepts that SRP ACK and requires a fresh matching GRP; it rejects an explicitly conflicting echoed tuple or `persisted: false`. A preceding GLP cannot finish SRP, and GRP alone cannot replace its ACK. SRP UI feedback is “Applied and verified”; no missing persistence field is invented.

Scan presets verify SRP/GRP before TF/GTF and hold the coordinator through both operations. After profile/baseband failure, a recovery GLP/GRP confirms actual state; the failed write remains failed. If recovery fails, the next configuration write must complete a recovery read first. Every reconnect requests fresh GLP, clears the previous format and leaves cached profiles unconfirmed until read. Read-back confirms current state, not retention through a power cycle.

## Other configuration commands

| Setting | GET | SET | Validation / persistence |
|---|---|---|---|
| RF power | GP | SP | Integer 0–30 dBm; persists on Apply |
| Q/session | GQS | SQS | Q 0–15; session 0–3 or 255; persists on Apply |
| Query parameters | GQP | SQP | Interval 0–60 ms, multiples of 10; dwell 0 (module default) or 2–255; append 0–5; persists on Apply |
| Tag Focus | GTF | TF / STF | TF temporary; explicit Save uses STF |
| Region | GF | SF | US/ETSI/VN; explicit save flag; see Region contract |

SET success can be status-only, so it never overwrites a current value with a default. In particular, TF/STF without `val` cannot mean OFF. Both TF and STF require their own ACK and matching GTF. GET errors use the originating command; GCFG remains a legacy error alias only for extended-parameter reads. A batch SAVE notification cannot acknowledge settings. There is no global configuration SAVE button or supported SAVE request.

## Bluetooth name and diagnostics

The Bluetooth name is read-only. Settings sends DI and displays its string `val` directly:

```json
{"cmd":"DI"}
{"cmd":"DI","val":"NHR-10"}
```

Current REVB supplies no Canonical ID or ESP32 firmware version. The transport accepts this DI reply for the recognized NHR-10 advertising family; optional canonical metadata on other firmware retains its validation. DI uses an 11-second browser budget and is refreshed on reconnect. GDN/SDN and name Apply are unsupported and rejected locally.

GRI `ver` is the RFID module version, separate from the controller firmware field; `power` updates RF power. Failed GT without a valid numeric value leaves temperature unknown instead of manufacturing 0 °C. POPUP content is limited to 15 UTF-8 bytes without quotes, backslashes or control characters, matching the firmware string parser.

## Validation and hardware acceptance

Automated tests exercise actual SRP status-only replies, strict SLP persistence acknowledgements, Format 1/2 and raw U16 IDs, STF, query limits, busy/timeout/error paths, late replies, disconnects, quarantine recovery, Region verification, battery polling and RF operation locking. The development-only browser fixture simulates responses; it does not connect to a reader.

Hardware checks still required:

1. Apply STD/QUICK/DEEP on the installed module; confirm Format 1 STD sends 53 and Format 2 STD sends 15.
2. Apply saved power/profile/Q/query/Tag Focus/Region, power off both module and controller, reconnect and compare fresh reads. Temporary TF and SF must follow their documented retention behavior.
3. Exercise concurrent LCD activity, externally started scan, missing reply, partial SET failure and disconnect. No incomplete operation may display a saved result or trigger an automatic repeated SET.
4. Verify RF performance and successful tag writes on hardware. A successful UART acknowledgement does not replace RF or power-cycle testing.

Firmware currently has no request identifiers echoed over BLE. The web correlates by command and serializes its operations. Same-command unsolicited LCD replies or old replies arriving during a new identical read cannot be distinguished perfectly; exact correlation requires an end-to-end firmware request-ID/capability extension.
