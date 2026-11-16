# REV-B firmware upgrade over Bluetooth

Open **Upgrade firmware** in the desktop sidebar, or **More → Upgrade firmware**
on a phone. This integrates the BLE protocol-v1 updater from the supplied VER-C
web project with the REVB firmware in `D:/Firmware-Develop/NHR-10-REVB`.
It uses the controller's existing Bluetooth connection. No USB updater is included.

## Using the demo

1. Start the app with `npm run dev` and open the printed localhost URL in a browser
   with Web Bluetooth. A deployed copy requires HTTPS.
2. Connect the reader normally. Stop inventory/find, finish tag writes, settings,
   batch saving and file downloads. Turn off Tag Insurance and wait for its status.
3. Open **Upgrade firmware** and select a REV-B `.nhrota` file. The app validates
   its hardware code, lengths, SHA-256 and ESP32-S3 application descriptor before
   enabling preparation. Raw BIN, merged factory images, ZIP and REV-C packages
   are rejected. Firmware files are read locally; they are not uploaded to a server.
4. Click **Prepare & review**. The controller pauses device controls, polling and
   automatic reconnect, drains the current GATT write, and reads fresh OTA Info.
   Review the reader ID and installed → target firmware version.
5. Confirm the checkbox and click **Install firmware**. Keep the reader powered,
   this page open and the browser in the foreground. The app requests a screen
   wake lock where available.
6. Wait for **Update confirmed**. At 100%, the device still has to verify the image,
   reboot and pass startup checks. The client verifies the same device ID, REV-B
   model/hardware/project, exact target version, `ready=true` and `pending=false`.
   The normal controller then reconnects and refreshes Insurance/configuration.

Cancel is available until FINISH could select the new boot slot. Cancelling the
review sends no OTA frames and resumes the controller connection. Cancelling a
healthy transfer sends ABORT; an uncertain connection is retired. Reconnect before
retrying a failed/cancelled transfer. A lost FINISH response is resolved by reading
the running firmware after reconnect, never by issuing ABORT after possible commit.

Same-version installation is rejected. **Engineering options** can explicitly
allow an older local package; an approved online release cannot downgrade.

## First installation

Older REVB firmware does not expose the OTA service. It needs a one-time initial
installation of the OTA-enabled application **and rollback-enabled bootloader**
through the existing programming connection. The firmware workspace's
`docs/OTA_BLE.md` documents this bootstrap and the unchanged A/B partition table.
After installing `1.2.0-dev.1` as the baseline, build a distinct candidate such as
`1.2.0-dev.2` to exercise an actual upgrade.

If a browser's previous permission grant omitted the OTA service, disconnect and
select the reader again with **Connect device**. Both normal and compatibility
device pickers now request the OTA UUID in `optionalServices`.

## REVB contract and coordination

- Product `NHR10-B`, hardware `REV-B`, manifest hardware code **2**. REV-C code 3
  is rejected even though the UUID family is shared.
- Package: 108-byte `NHR1` manifest plus the exact application BIN, maximum 3 MiB
  image. Image and outer package hashes are computed with Web Crypto.
- Service `4e485200-10c0-4a01-8a01-000000000001`; prefixes `201` Control, `202`
  Status, `203` Info and `205` ACK. The client uses acknowledged DATA, window 1;
  at the preferred MTU 185, payload is 170 bytes. MTU 23 is also supported.
- An ATT write response only confirms queue admission. Every DATA needs a durable
  ACK or Status confirmation before the next DATA; uncertain DATA is not retried.
- REVB's legacy `DI` response contains only the name. OTA identity/version comes
  from **OTA Info on the same borrowed GATT device**, then remains pinned through
  review and post-boot verification. If DI does supply a canonical ID, it must
  match. RFID `GRI` remains the reader-module version, not handheld firmware.
- `bleService.acquireOtaSession()` provides exclusive connection ownership. It
  rejects new FF01/file operations, cancels queued writes, waits for the physical
  active write, suspends live tag delivery and disables normal reconnect.
- The app blocks preparation while Insurance is enabled/unknown, a settings or
  tag-write response is pending, scanning/finding is active, or a file is saving
  or downloading. All operation entry points recheck the active update immediately.
- REVB firmware BEGIN owns the final stop/save and RFID-reservation transaction.
  This is the final protection against physical activity started after web review;
  an ATT-only temperature request is not treated as proof of an idle reader.
- Battery qualification is enforced by the firmware using the calibrated, fresh
  pack ADC throughout the transfer. The web battery percentage or charging flag
  cannot override a power rejection.
- Progress is coalesced for React; the transport continues checking every ACK.
  Polling and the ordinary connection watchdog stay paused until OTA releases the
  connection. Firmware is not considered successful just because transfer ends.

The package checks integrity and target compatibility; protocol v1 does not carry
a vendor digital signature. Use packages supplied by the firmware team. This web
change does not add secure boot, flash encryption or an anti-downgrade mechanism.

## Optional approved release service

Local files work without server configuration. To enable **Check approved release**,
set public `VITE_FIRMWARE_RELEASE_URL` in `.env.local` to your controlled HTTPS
endpoint, then restart/rebuild Vite. No endpoint or firmware binary is bundled.
The endpoint and package URL must allow the browser's origin through CORS.

```json
{
  "schema": 1,
  "product": "NHR10-B",
  "hardware": "REV-B",
  "version": "1.2.0-dev.2",
  "url": "https://your-firmware-host.example/NHR10-B-1.2.0-dev.2.nhrota",
  "package_sha256": "64 hexadecimal characters identifying the complete package",
  "size": 1253548,
  "release_notes": "Describe this specific build."
}
```

The example size is illustrative; use the exact package's size/hash. Requests omit
credentials, reject redirects, bypass cache and enforce time/size limits. The
record must match the actual package's hardware, version and complete-file hash.
Environment values are public build configuration; do not put credentials in them.

## Verification

```powershell
npm run lint
npm test
npm run build

# Optional real-built-package parser test:
$env:NHR_OTA_PACKAGE = 'D:\Firmware-Develop\NHR-10-REVB\artifacts\ota-ble\NHR10-B-1.2.0-dev.1.nhrota'
npm test

# Browser regression with a simulated peripheral; start Vite in another terminal:
npm run dev -- --host 127.0.0.1 --port 3187 --strictPort
# In the test terminal, retain NHR_OTA_PACKAGE and run:
npm run test:ota-browser
```

The browser runner uses installed Chrome by default; set `PLAYWRIGHT_CHANNEL=msedge`
to use Edge. `OTA_TEST_URL` can override the test server URL. The fixture replaces
Web Bluetooth only in the automated test browser: no device is selected or flashed.
It runs the production App/services, transfers the real package, verifies every
offset and complete image SHA-256, and checks recovery/error paths. Screenshots
and its JSON report are written to ignored `test-results/ota/`.

Automated coverage includes package corruption/target/semver, ACK loss and timeout,
exclusive GATT ownership, legacy DI, cancellation, uncertain FINISH, rollback,
polling/reconnect suspension, UI consent and mobile navigation. Downloadable OTA
diagnostics contain update identity/version/hash/state events, not RFID tag data.

Physical acceptance is still required: repeated app0↔app1 BLE updates, low-power
rejection, disconnect/cancel, controlled failed-boot rollback, battery-only reset
continuity, actual throughput, and normal scan/settings/Insurance/file transfer
after updating. Browser mocks establish application behavior, not radio or power
characteristics. See [the validation record](firmware-upgrade-validation.md) for
this implementation's recorded results.
