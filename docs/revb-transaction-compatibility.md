# REVB web compatibility audit — 2026-11-15

Compared the demo against `D:/Firmware-Develop/NHR-10-REVB`, branch `dev/adaptiveVerC-to-VerB`, including the integrated transaction layer. No firmware build or firmware source changes are part of this web commit.

| Area | Finding and web adaptation |
|---|---|
| Baseband presets | REVB SRP success is status-only, preceded by GLP. Accept its ACK and verify a fresh GRP instead of requiring nonexistent tuple/persisted fields. |
| Link Profile | Preserve U16 raw IDs and Format 1/2; STD 53/15, QUICK 11, DEEP 13. SLP retains matching persisted ACK plus GLP verification. |
| Region | Preserve US band 2, ETSI band 9, VN band 27, exact channels and Save/temporary semantics. Extend SF/GF budgets for the complete firmware transaction. |
| Configuration persistence | Remove unsupported global SAVE. TF is temporary; explicit Save Tag Focus sends STF. Other persistent setters retain read-back verification. |
| Query parameters | Expose raw dwell 0 and append 5; validate interval 0–60 ms in multiples of 10, dwell 0 or 2–255, append 0–5. |
| BLE/LCD contention | Serialize through terminal replies, budget competing LCD work, pause periodic GT and false-offline checks during settings, keep battery polling/protection. Busy never triggers repeated SET. |
| Transport uncertainty | Missing ACK, RFID transport fault or uncertain settings delivery requires a fresh UART read before further writes/RF starts. Write timeout/disconnect also requires recovery. BLE reconnect alone cannot reset module quarantine. |
| Writes and Find | Respect firmware buffers: EPC writes/target 60 hex, WD data 124 hex, pointer 0–255. Find is limited to 32 hex by the event/main buffers; reject longer targets instead of silently selecting a truncated EPC. TID is read-only; password 00000000 only. |
| Diagnostics | Treat DI name as read-only, permit actual legacy DI without Canonical ID, separate RFID module/controller versions, preserve unknown temperature. Validate POPUP as at most 15 UTF-8 bytes with no parser-unsupported characters. |

The web does not expose a generic module mode or Select-mask editor. Current BLE Region mode is template-only, and SMASK is not implemented by the REVB dispatcher. GMASK remains a firmware diagnostic read rather than an advertised web editing capability.

Validation uses TypeScript checks, the automated protocol/controller/transport suite, a production build and the development-only browser fixture. Browser checks exercise Settings, persistent STF and temporary VN Region with simulated BLE responses. They do not prove physical BLE delivery, RF performance or flash retention. Power-cycle and concurrent physical LCD/BLE acceptance remain device tests; see [settings acceptance](settings-firmware-contract.md#validation-and-hardware-acceptance).

BLE packets have no request IDs. Command matching and serialization cannot distinguish every same-command unsolicited LCD reply or late response during a new identical read. Exact correlation requires a matching firmware/API extension.

Release target: GitHub `mickeykhuongtran/NHR10-B`, branch `main`; existing Vercel production project `nhr10-b` at https://nhr10-b.vercel.app.
