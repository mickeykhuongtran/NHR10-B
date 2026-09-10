# Battery BLE contract (GB v2)

Implemented from `NHR-10-REVB-FINAL/docs/BLE_BATTERY_WEB.md` (10 September 2026)
and its `docs/examples/battery-web.mjs` adapter. This updates the web client only.
`ver` refers to the GB payload, not the firmware release number.

## Data and display

- Write `{"cmd":"GB"}` to FF01 after subscribing to its notifications. Service:
  `000000ff-0000-1000-8000-00805f9b34fb`; FF01:
  `0000ff01-0000-1000-8000-00805f9b34fb`.
- Accept one JSON object per notification and dispatch by `cmd`. Settings and
  RFID packets retain their existing handlers. No read, terminator or reassembly
  is required for GB.
- `percent` is already scaled to 0–100; display one decimal place, including 0.0%
  and 99.9%. No web voltage conversion, RF offset or SOC filter remains.
- Accept the estimate only for v2 with `valid === true`, a finite numeric percent
  in range, integer `health` (0–255), and integer `age_ms` (0–4294967295). Outside
  latched shutdown, ADC age >3000 ms or health bit 2 invalidates it.
- A missing/invalid estimate clears the display to `—` and an unknown gray gauge.
  Boot voltage 0 and out-of-normal-range voltage remain inspectable diagnostics.
- Missing `ver` is legacy: retain voltage/protection diagnostics and prompt a
  firmware update. Other versions are unsupported; never calculate a fallback %.
- Status priority: SHUTDOWN, CRITICAL, HIGH VOLT (bit 0), CHG FAULT (bit 1),
  ADC CHECK (bit 2), BATTERY FAULT (unknown bits), WARNING, then ordinary status.
- FULL requires the firmware full flag, valid 100%, and no errors or higher
  priority protection condition. Percent 100 alone and STAT false never mean full.
  Charging is tri-state; unknown, stale or faulty telemetry never shows charging.
- `charging` describes debounced STAT, not charger attachment or measured current.
  `load` is the estimator's sampled load, not the immediate scan mode.

## Freshness and transport

Poll about every 5 s in idle, interactive scan, batch, batch saving and locate;
request again when the page becomes visible. One pending GB write is shared by
automatic and manual refreshes. FF02 file control and FF03 subscription also use
the command queue to avoid a GATT collision with the new polling schedule.

Use `performance.now()` for battery receipt/poll/expiry time. A 500 ms UI check
marks telemetry stale after 15 s without GB, or when the last valid ADC sample's
age plus local elapsed time exceeds 15 s. The no-sample sentinel 4294967295 shows
CHECKING/ADC CHECK initially and expires by notification receipt time. A successful
write does not refresh battery freshness. RFID traffic does not refresh it either.
Stale data hides percent, charging and full; new valid data restores the view.

Supported shutdown is latched at 0.0% until disconnect, including while file
saving delays power-off. This denotes zero usable capacity under protection.
Disconnect, connection failure and selection of another device clear the snapshot.

GB is not automatically notified periodically. Warning/shutdown events can be
lost, so polling remains necessary. The supplied firmware bounds GB to 176 bytes;
its preferred MTU is 185, and >=179 fits the entire current range. A link at MTU 23
cannot carry it. Browser/OS/adapter negotiation and hardware delivery require
physical verification; these automated tests do not measure or set the MTU.

## Verification

Run `npm run lint`, `npm test`, and `npm run build`.
Battery-specific suites cover parsing/display, hook timers/lifecycle, and a fake
GATT peripheral exercising the actual BLE transport and queue. No physical reader
is used by these tests. `tests/ui.html` contains a development-only UI fixture.

On a physical NHR-10 with the new firmware:

1. Connect and verify complete GB JSON arrives after notification subscription.
2. Compare the web percentage/fill with DEVICE STATUS, allowing polling latency.
3. Scan/stop RF and verify voltage changes do not recalculate web percentage.
4. Confirm 99.9%, invalid ADC, STAT false/null, confirmed full and health warnings.
5. Suppress GB while RFID continues: after ~15 s the web shows STALE with no full
   or charging indication. Restore GB and confirm recovery.
6. Return from a background tab and check that GB is requested; disconnect and
   connect another reader to verify no snapshot is carried over.
7. Check unsolicited warning/shutdown and sustained notification delivery during
   dense RFID traffic and saved-file transfer on the target browser/OS/adapter.

The firmware's 0.1-point resolution is display precision, not ±0.1% SOC accuracy.
