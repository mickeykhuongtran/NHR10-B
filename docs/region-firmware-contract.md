# Region: NHR-10 REVB web integration

Updated 2026-09-11 from the owner-provided firmware note `D:/Firmware-Develop/NHR-10-REVB-FINAL/docs/web-region-update-note.vi.md`. This is an integration contract, not a hardware qualification or regulatory compliance report. Firmware flashing is outside this web update.

## Product presets

| Web code and label | Band | Min/max channel | Actual centers | Step |
|---|---:|---|---|---:|
| US (902-928 MHz) | 2 | 0/49 | 50 channels, 902.75–927.25 MHz | 500 kHz |
| ETSI (865-868 MHz) | 9 (EU3) | 0/3 | 865.7, 866.3, 866.9, 867.5 MHz | 600 kHz |
| VN (918-923 MHz) | 27 | 0/7 | 8 channels, 918.75–922.25 MHz | 500 kHz |

Only these three presets can be written. Reference ranges in labels are not channel centers. Band 4 and band 18 are not this ETSI preset. No JP/KOR/Custom writes, custom channel calculation for transmission, or 125-kHz-unit spacing is exposed.

## Read actual state

```json
{"cmd":"GF"}
{"cmd":"GF","status":"ok","val":"VN","mode":"template","band":27,"min_ch":0,"max_ch":7,"start_khz":918750,"end_khz":922250,"count":8,"step_khz":500}
```

A complete, matching GF response establishes Region support and confirms the channel plan for the current connection. Validate numeric band, channel limits and the reported frequency/count/step relationship. Identify a full preset only when band and both limits match, independently of the `val` label. A subset of bands 2/9/27 stays CUSTOM/subset with actual channels, read-only. A different band stays UNKNOWN with raw band/min/max; it is a successful read and no frequencies are guessed. After either read-only state, the user can explicitly choose one supported preset.

Neither `GRI.freq` nor RF Link Profile `format` proves Region support or channel configuration. `GRI` extended-region markers are not decoded by this web into an ordinary Region. Reconnect invalidates cached confirmation and triggers a fresh GF through the shared settings coordinator. No preset is auto-applied or restored from browser storage.

Initial GF timeout/unsupported replies leave Apply and Save disabled with an unavailable-firmware message. The message also acknowledges that a missing response can be a communication failure. Automatic refreshes do not repeatedly issue an unavailable GF in the same connection; explicit Read can retry. An explicit unsupported SF remains unavailable for writes even if a recovery GF succeeds.

## Apply and save

```json
{"cmd":"SF","val":"VN","save":true}
{"cmd":"SF","status":"ok","val":"VN","band":27,"min_ch":0,"max_ch":7,"saved":true,"verified":true}
```

The web transmits only the preset code and a required JSON boolean `save`. Firmware owns the preflight GET, UART payload, module SET and verification. The web requires an SF success ACK with matching code/band/min/max, `verified: true`, and `saved` exactly equal to the requested boolean. It then issues GF and compares actual band/min/max again. The accepted SF attempt and this additional GF share a 5-second deadline; a standalone Read allows 5 seconds.

- `save: true` with matching confirmation: **Đã lưu**.
- `save: false` with matching confirmation: **Đã áp dụng tạm thời**.
- A successful BLE write, missing saved/verified fields, wrong limits, timeout or error cannot produce either success notice. GF alone cannot prove saving.

Region and RF Profile transactions share the same lock. Controls are disabled during scan. Busy replies, including legacy `msg: "busy"`, wait for the current configuration completion or a bounded timeout before retrying. After a Region error, wait at least one second before another GF/SF. A failed SF is not automatically repeated; read GF to recover actual state. If recovery fails, the next configuration write must first complete a recovery read. Retain the original failure in the log and mark cached state unconfirmed. A late/unsolicited SF/GF cannot confirm a timed-out transaction.

The web does not change RF power, Link Profile, Q or Session while applying Region. It does not write Region to ESP32 NVS or send an SF at startup.

## Verification

Automated tests cover all three presets, saved/temporary ACKs, 600-kHz ETSI spacing, full/subset/unknown configurations, malformed fields, mismatched confirmations, error codes, legacy busy replies, cooldown, five-second deadlines, recovery, unavailable firmware, reconnect, scan locking, and preservation of unrelated settings. UI testing uses simulated BLE responses.

Hardware acceptance remains required:

1. Load the corresponding firmware and verify actual module support for GET 0x9E, SET 0x22 Format 2 and band 27.
2. Apply each preset and inspect GF band/min/max plus all center frequencies; read tags afterward.
3. With Save checked, power off/on and reconnect; fresh GF must match the saved plan.
4. With Save unchecked, change the active plan, power off/on and confirm return to the previously saved plan.
5. Exercise module refusal, partial SET/verify failure, externally started scan, timeout and disconnect. Check actual state after recovery and confirm no false saved notice.
6. Compare RF power, profile, Q and Session before and after changing Region.

`saved: true` means the module acknowledged the persistence flag; it is not evidence that a physical power-cycle test has passed.
