# Device settings: frontend fixes and firmware response contract

Source checked: `D:/Firmware-Develop/NHR-10-REVC`, confirmed by the device owner as the firmware 2.8 project. Firmware was inspected only; this web change does not modify or flash it.

## Fixed in the web controller

- Read/Apply buttons now have stable React component identities. BLE telemetry no longer remounts them and drops keyboard focus. Pending feedback occupies reserved space; it does not insert a banner or dim the entire settings form.
- A completed GATT write is only command delivery. Read waits for a valid reply. Apply waits for an acknowledgement, requests the corresponding GET, and compares the reported value with the submitted value. Each user operation emits one auto-dismiss notice and a retained diagnostic log.
- A missing acknowledgement after 1.5 seconds triggers read-back verification, for compatibility with firmware that does not acknowledge a successful SLP. Explicit firmware rejection or transport failure does not use this fallback. GET confirmation times out after 5 seconds. Disconnect/unmount cancels pending work. Scanning, tag writes and further settings commands cannot overlap a pending settings transaction.
- A status-only TF/STF acknowledgement no longer gets parsed as OFF. Only a valid `val: 0` or `val: 1` changes the displayed Tag Focus state.

## Existing firmware support

| Setting | Read request / successful reply | Apply request / current acknowledgement |
|---|---|---|
| RF power | `GP` → `GP` with numeric `val` | `SP` → `SP`, `status: ok` (sometimes includes `val`) |
| RF link profile | `GLP` → `GLP` with numeric `val` | `SLP` uses the same module opcode; firmware may report `GLP` with `val`, or omit the success reply if no data byte exists |
| Q / Session | `GQS` → `GQS` with `q`, `session` | `SQS` → `SQS`, `status: ok` |
| Query parameters | `GQP` → `GQP` with `interval` in ms, `dwell`, `times` | `SQP` → `SQP`, `status: ok` |
| Tag Focus | `GTF` → `GTF` with `val: 0/1` | `TF` → `TF`, `status: ok`, without a value |
| Bluetooth name | `GDN` → `GDN` with string `val` | `SDN` → `SDN`, `status: ok`, string `val` |

The current GET extended-parameter error response is `GCFG`, not the originating `GQS/GQP/GTF`. The frontend accepts this error during its serialized extended-parameter transaction. The corresponding firmware handlers are in `components/ble_service/ble_command_protocol.c` and `components/rfid_module/rfid_module.c`.

No firmware addition is required for the UI stability fix or normal feedback for the settings above. RF profile and Q/Session setters currently save to module flash, Query Parameter also saves, while TF applies a temporary setting and STF saves Tag Focus. A blanket claim that all Apply operations are temporary would be inaccurate.

## Missing handlers required for Region and Save configuration

The inspected BLE command dispatcher does not handle `GF`, `SF`, or a configuration-save request `SAVE`. The `SAVE` JSON in `main/main.c` describes **batch inventory file progress**, not configuration persistence. Until firmware implements these operations, the web must report missing confirmation instead of success.

Required minimum contract (examples describe proposed firmware additions, not existing support):

```json
{"cmd":"GF"}
{"cmd":"GF","status":"ok","mode":"template","val":"US"}

{"cmd":"SF","val":"US","save":true}
{"cmd":"SF","status":"ok","mode":"template","val":"US","save":true}

{"cmd":"SF","mode":"custom","start_khz":918500,"count":9,"space_125khz":4,"save":true}
{"cmd":"SF","status":"ok","mode":"custom","val":"CUSTOM","start_khz":918500,"count":9,"space_125khz":4,"save":true}

{"cmd":"SAVE"}
{"cmd":"SAVE","status":"ok"}

{"cmd":"SF","status":"err","code":"invalid_region","msg":"Unsupported frequency plan"}
{"cmd":"SAVE","status":"err","code":"storage","msg":"Configuration was not saved"}
```

- GF must return the actual module configuration, including `start_khz`, `count`, `space_125khz` for custom plans. Template names expected by the web are US, ETSI, VN, JP and KOR; define their mappings explicitly in firmware.
- SF must validate the complete frequency plan, apply it to the module and report hardware errors. When `save: true`, success must also require successful persistence; report a persistence error separately if applying succeeded but saving failed.
- Define exactly which settings SAVE persists. Send its successful acknowledgement only after those writes finish. Do not reuse `mode: batch` progress messages as configuration success.
- Unsupported commands and invalid arguments should return `status: err` with the original `cmd` and an error code, instead of only logging internally and leaving the app to time out.

## Recommended protocol improvements

1. Give SET replies their original command name (`SLP`, not `GLP`), explicit success/error status and the effective value. Return the originating GET name on errors instead of the generic GCFG. Queue module transactions through their responses rather than relying only on the mutable `last_get_cfg_no` / `last_set_extended_cmd` globals.
2. Add a request identifier, echoed unchanged in the terminal reply. This requires a matching frontend update: the current implementation correlates by command and permits one user settings transaction at a time. Identifiers distinguish late replies from a retried request for the same command.
3. Advertise supported commands and persistence semantics in a capability response so the UI can disable unavailable features without guessing from the firmware version string.

Validation should include module rejection, invalid input, missing response, a read-back different from the requested value, disconnect during Apply, repeated reads, persistence failure, and batch SAVE notifications interleaved with configuration handling. UI tests use simulated replies; RF operation and persistence across a power cycle require hardware verification.
