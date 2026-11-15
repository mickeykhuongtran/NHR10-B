// NHR10-B: 2 s per UART exchange. Allow one competing LCD/startup profile
// transaction (up to 8 s), plus BLE delivery/scheduling margin.
const EXCHANGE_MS = 2000;
const ADMISSION_MS = 8000;
const DELIVERY_MS = 1000;
const EXCHANGES: Record<string, number> = { GLP: 2, GRP: 3, SLP: 4, SRP: 5, SF: 3 };
export const responseTimeoutMs = (command: string) => ADMISSION_MS + DELIVERY_MS + EXCHANGE_MS * (EXCHANGES[command] ?? 1);
const RF_COMMANDS = new Set(['GP', 'SP', 'GLP', 'SLP', 'GRP', 'SRP', 'GQS', 'SQS', 'GQP', 'SQP', 'GTF', 'TF', 'STF', 'GF', 'SF', 'GRI', 'GT', 'WE', 'WD', 'GMASK', 'SMASK']);
export const isRfTransportFault = (data: any) => RF_COMMANDS.has(data.cmd) && [data.error, data.code].some(value => ['timeout', 'transport_desynchronized', 'transport'].includes(String(value)));
export const recoveryMessage = 'RFID response is uncertain. Read a setting again before starting RF. If recovery fails, restart the reader and controller together; reconnecting Bluetooth alone does not reset the RFID transport.';
export const validPopupContent = (value: string) => value.trim().length > 0 && new TextEncoder().encode(value).length <= 15 && !/["\\\u0000-\u001f\u007f]/.test(value);

// Firmware command_data_t uses char epc[64], new_epc[64], data_hex[128].
// Keep complete 16-bit words within the usable bytes (excluding the NUL).
export const MAX_EPC_HEX = 60;
// EVENT_START_FIND and main's target buffer hold only 32 hex characters.
export const MAX_LOCATE_EPC_HEX = 32;
export const MAX_WRITE_DATA_HEX = 124;
export const validHexWords = (value: string, max = MAX_EPC_HEX) => /^[0-9A-F]+$/i.test(value) && value.length % 4 === 0 && value.length <= max;
export function validateRevbWrite(epc: string, data: string, bank: number, pointer: number, password: string, newEpc = false) {
  if ((!newEpc || epc !== '') && !validHexWords(epc)) throw new Error(`Target EPC must contain complete hexadecimal words, up to ${MAX_EPC_HEX} characters.`);
  if (!validHexWords(data, newEpc ? MAX_EPC_HEX : MAX_WRITE_DATA_HEX)) throw new Error(`Data must contain complete hexadecimal words, up to ${newEpc ? MAX_EPC_HEX : MAX_WRITE_DATA_HEX} characters.`);
  if (!Number.isInteger(bank) || ![0, 1, 3].includes(bank)) throw new Error('NHR10-B supports writing Reserved, EPC or User memory; TID is read-only.');
  if (!Number.isInteger(pointer) || pointer < 0 || pointer > 255) throw new Error('Word pointer must be an integer from 0 to 255.');
  if (password !== '00000000') throw new Error('This NHR10-B firmware supports only access password 00000000.');
}
