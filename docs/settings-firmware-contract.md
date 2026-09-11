# Device settings: frontend fixes and firmware response contract

RF Link Profile and Region contracts updated on 2026-09-11 from the device owner’s NHR-10 REVB specifications. See [Region integration](region-firmware-contract.md) for the implemented GF/SF behavior. This update changes only the web controller. The non-profile firmware observations below are historical: the previous investigation inspected `D:/Firmware-Develop/NHR-10-REVC` (firmware 2.8); they have not been reverified against the new REVB firmware.

## Fixed in the web controller

- Read/Apply buttons now have stable React component identities. BLE telemetry no longer remounts them and drops keyboard focus. Pending feedback occupies reserved space; it does not insert a banner or dim the entire settings form.
- A completed GATT write is only command delivery. Read waits for a valid reply. Apply waits for an acknowledgement, requests the corresponding GET, and compares the reported value with the submitted value. Each user operation emits one auto-dismiss notice and a retained diagnostic log.
- RF Profile SET acknowledgement timeout is 4 seconds; GET timeout is 5 seconds. Region Apply has a separate 5-second budget including SF acknowledgement and the web’s GF verification. SLP/SRP require the original SET command, `status: "ok"`, `persisted: true`, and a matching returned value before reporting “Đã lưu”. The web also reads GLP/GRP back and requires a match. A GLP/GRP response alone never proves persistence. Non-profile settings retain their existing read-back compatibility behavior.
- Connection initialization, Diagnostics refresh, Settings Apply and Scan presets use the same response-aware coordinator. Configuration requests are sequential through their replies, not merely through GATT writes. Busy responses wait for a previous configuration completion, or a full operation timeout when no completion event arrives, then retry at most twice. Disconnect/unmount cancels pending work. Scanning, tag writes and further settings commands cannot overlap a pending transaction.
- A status-only TF/STF acknowledgement no longer gets parsed as OFF. Only a valid `val: 0` or `val: 1` changes the displayed Tag Focus state.

## RF Link Profile: current REVB contract

| Product preset | Format 1 ID | Format 2 ID |
|---|---:|---:|
| STD — 640 kHz / Miller 4 | 53 | 15 |
| QUICK — 640 kHz / FM0 | 11 | 11 |
| DEEP — 160 kHz / Miller 8 | 13 | 13 |

Use only the firmware `format` field to choose the preset table. Missing or unrecognized format is unknown; no preset mapping is inferred from profile ID. The current raw ID remains visible and can be reapplied after a fresh read, but presets are unavailable until the format is known. IDs are unsigned 16-bit integers, `0…65535`, with no masking or truncation. Unsupported IDs are for the module to reject. These three presets are not a catalog of every supported module profile.

```json
{"cmd":"GLP"}
{"cmd":"GLP","val":15,"format":2}
{"cmd":"SLP","val":13}
{"cmd":"SLP","status":"ok","val":13,"format":2,"persisted":true}
{"cmd":"SLP","status":"err","error":"persist_failed"}
{"cmd":"GRP","val":"5185,6,255,0","format":2}
```

GRP/SRP use `profile,Q,session,target`; session `255` means Auto. Scan presets send SRP using the table above, await its saved ACK, verify GRP, then apply and verify Tag Focus. The entire sequence holds the configuration lock. The SRP saved ACK must echo the requested tuple in `val`, with `status: "ok"` and `persisted: true`.

After SLP/SRP failure, mismatched/incomplete acknowledgement, transport failure or timeout, read GLP/GRP before releasing the transaction. `persist_failed` or Q/Session failure can leave an already changed profile. If recovery itself fails, the profile remains unconfirmed and the next configuration write must first complete a recovery read. Read-back recovery never creates a success notice for the failed write.

Every connection/reconnection starts a new GLP read. Cached IDs are shown as unconfirmed until a current valid response arrives; the previous format is cleared. A read confirms current state, not survival through a power cycle.

### Hardware acceptance (still required)

1. With Format 2, apply STD, QUICK and DEEP and inspect TX IDs `15`, `11`, `13`; with Format 1, STD must send `53`.
2. For each chosen profile, wait for the matching saved ACK and successful GLP read-back, power the device fully off/on, reconnect and inspect the newly received GLP. Its ID and format must match the expected device configuration.
3. Exercise missing ACK, mismatched value, missing/false `persisted`, `status: "err"`, `persist_failed`, busy, and disconnect during Apply. None may generate a saved notice without the required ACK; recovery must show actual state.
4. Return custom IDs such as `5185` and `65535`, then Apply unchanged. Confirm exact TX IDs with no truncation. Return a profile without `format` and confirm unknown format and no STD mapping.
5. Force SRP failure at Q/Session. Confirm GRP recovery before another configuration write and no subsequent Tag Focus command from the failed preset sequence.

Automated tests simulate these reply paths and connection changes. They do not verify real RF behavior, flash writes or physical power-cycle retention.

## Historical non-profile firmware support

| Setting | Read request / successful reply | Apply request / current acknowledgement |
|---|---|---|
| RF power | `GP` → `GP` with numeric `val` | `SP` → `SP`, `status: ok` (sometimes includes `val`) |
| Q / Session | `GQS` → `GQS` with `q`, `session` | `SQS` → `SQS`, `status: ok` |
| Query parameters | `GQP` → `GQP` with `interval` in ms, `dwell`, `times` | `SQP` → `SQP`, `status: ok` |
| Tag Focus | `GTF` → `GTF` with `val: 0/1` | `TF` → `TF`, `status: ok`, without a value |
| Bluetooth name | `GDN` → `GDN` with string `val` | `SDN` → `SDN`, `status: ok`, string `val` |

In the previously inspected firmware, the GET extended-parameter error response is `GCFG`, not the originating `GQS/GQP/GTF`. The frontend accepts this error during its serialized extended-parameter transaction. The corresponding firmware handlers are in `components/ble_service/ble_command_protocol.c` and `components/rfid_module/rfid_module.c`.

In that historical inspection, Q/Session and Query Parameter setters saved to module flash, while TF applied a temporary setting and STF saved Tag Focus. The web does not infer RF profile persistence from these older observations; the current REVB contract above governs SLP/SRP.

## Region integration and configuration SAVE

The current REVB firmware implements GF/SF. The previous Region proposal is superseded by [the current Region contract](region-firmware-contract.md): only US/ETSI/VN, explicit band/channel verification, and `saved`/`verified` flags. JP, KOR, Custom writes and `space_125khz` are not part of this web API.

The older dispatcher inspection did not implement a global configuration `SAVE`; its `SAVE` notifications described batch inventory progress. The new Region note does not establish support for a global configuration save. The web continues to require a separate non-batch `SAVE`, `status: "ok"` reply for that existing button. Region saving uses `SF` with the JSON boolean `save`, not the global SAVE command or ESP32 NVS.

## Recommended protocol improvements

1. Give SET replies their original command name (`SLP`, not `GLP`), explicit success/error status and the effective value. Return the originating GET name on errors instead of the generic GCFG. Queue module transactions through their responses rather than relying only on the mutable `last_get_cfg_no` / `last_set_extended_cmd` globals.
2. Add a request identifier, echoed unchanged in the terminal reply. This requires a matching frontend update: the current implementation correlates by command and permits one user settings transaction at a time. Identifiers distinguish late replies from a retried request for the same command.
3. Advertise supported commands and persistence semantics in a capability response so the UI can disable unavailable features without guessing from the firmware version string.

Validation should include module rejection, invalid input, missing response, a read-back different from the requested value, disconnect during Apply, repeated reads, persistence failure, and batch SAVE notifications interleaved with configuration handling. UI tests use simulated replies; RF operation and persistence across a power cycle require hardware verification.
