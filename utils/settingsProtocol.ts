import { RegionBandConfig, RegionBandSelection } from '../types';
import { assertValidBleDeviceName } from './deviceName';
import { assertProfileId, parseProfileFormat, parseProfileId } from './rfLinkProfile';
import { describeRegion, parseRegionReading, prepareRegionApply } from './regionBand';

export interface SettingValues {
  power: number;
  'device-name': string;
  profile: number;
  baseband: { profile: number; q: number; session: number; target: number };
  'q-session': { q: number; session: number };
  'query-params': { interval: number; dwell: number; append: number };
  'tag-focus': boolean;
  'region-band': { selection: RegionBandSelection; save: boolean };
}
export type SettingId = keyof SettingValues;
export type SettingsRequest = { id: SettingId; mode: 'read' }
  | { [K in SettingId]: { id: K; mode: 'apply'; value: SettingValues[K] } }[SettingId]
  | { id: 'config'; mode: 'save' };
export type SettingReading = Record<string, string | number | boolean | null>;
export type DeviceCommand = { cmd: string; [key: string]: unknown };
export const SETTING_META: Record<SettingId, { title: string; get: string; set: string; setReplies: string[] }> = {
  power: { title: 'RF power', get: 'GP', set: 'SP', setReplies: ['SP'] },
  'device-name': { title: 'Bluetooth device name', get: 'GDN', set: 'SDN', setReplies: ['SDN'] },
  profile: { title: 'RF link profile', get: 'GLP', set: 'SLP', setReplies: ['SLP'] },
  baseband: { title: 'RF preset', get: 'GRP', set: 'SRP', setReplies: ['SRP'] },
  'q-session': { title: 'EPC Gen2', get: 'GQS', set: 'SQS', setReplies: ['SQS'] },
  'query-params': { title: 'Query parameters', get: 'GQP', set: 'SQP', setReplies: ['SQP'] },
  'tag-focus': { title: 'Tag Focus', get: 'GTF', set: 'TF', setReplies: ['TF'] },
  'region-band': { title: 'RFID region band', get: 'GF', set: 'SF', setReplies: ['SF'] },
};
export const isSettingsError = (data: any) => ['err', 'error', 'failed'].includes(String(data.status ?? '').toLowerCase()) || data.ok === false;
export const isSettingsBusy = (data: any) => [data.status, data.error, data.msg, data.state, data.code].some(value => String(value).toLowerCase() === 'busy');
const number = (value: unknown): number | null => {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const integer = (value: unknown, min: number, max: number): number | null => {
  const parsed = number(value);
  return parsed !== null && Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
};

/** A status-only ACK is not a reading and must not overwrite a draft with defaults. */
export function parseSettingReading(id: SettingId, data: any): SettingReading | null {
  if (isSettingsError(data) || isSettingsBusy(data)) return null;
  switch (id) {
    case 'power': { const val = integer(data.val ?? data.power ?? data.pwr, 0, 33); return val === null ? null : { val }; }
    case 'profile': {
      const val = parseProfileId(data.val ?? data.profile ?? data.linkProfile ?? data.link_profile);
      return val === null ? null : { val, format: parseProfileFormat(data.format) };
    }
    case 'baseband': {
      const parts = typeof data.val === 'string' ? data.val.split(',') : [];
      const profile = parseProfileId(data.profile ?? parts[0]), q = integer(data.q ?? parts[1], 0, 15);
      const rawSession = integer(data.session ?? parts[2], 0, 255), target = integer(data.target ?? parts[3], 0, 1);
      const session = rawSession !== null && (rawSession <= 3 || rawSession === 255) ? rawSession : null;
      return profile === null || q === null || session === null || target === null ? null : { profile, q, session, target, format: parseProfileFormat(data.format) };
    }
    case 'device-name': {
      try { assertValidBleDeviceName(data.val); return { val: data.val }; } catch { return null; }
    }
    case 'tag-focus': { const val = integer(data.val, 0, 1); return val === null ? null : { val }; }
    case 'q-session': {
      const parts = typeof data.val === 'string' ? data.val.split(',') : [];
      const q = integer(data.q ?? parts[0], 0, 15), rawSession = integer(data.session ?? parts[1], 0, 255);
      const session = rawSession !== null && (rawSession <= 3 || rawSession === 255) ? rawSession : null;
      return q === null || session === null ? null : { q, session };
    }
    case 'query-params': {
      const parts = typeof data.val === 'string' ? data.val.split(',') : [];
      const interval = integer(data.interval ?? parts[0], 0, 2550), dwell = integer(data.dwell ?? parts[1], 0, 255), append = integer(data.times ?? data.append ?? parts[2], 0, 255);
      return interval === null || dwell === null || append === null ? null : { interval, dwell, append };
    }
    case 'region-band': {
      const reading = parseRegionReading(data);
      return reading ? { ...reading } : null;
    }
  }
}

export function describeSetting(id: SettingId, reading: SettingReading): string {
  switch (id) {
    case 'power': return `${reading.val} dBm`;
    case 'profile': return `profile ${reading.val}`;
    case 'baseband': return `profile ${reading.profile}, Q ${reading.q}, session ${reading.session === 255 ? 'Auto' : `S${reading.session}`}, target ${reading.target}`;
    case 'tag-focus': return reading.val === 1 ? 'On' : 'Off';
    case 'q-session': return `Q ${reading.q}, session ${reading.session === 255 ? 'Auto' : `S${reading.session}`}`;
    case 'query-params': return `interval ${reading.interval} ms, dwell ${reading.dwell}, append ${reading.append}`;
    case 'region-band': return describeRegion(reading as unknown as RegionBandConfig);
    default: return String(reading.val);
  }
}

export function prepareSettingApply(request: Extract<SettingsRequest, { mode: 'apply' }>): { command: DeviceCommand; expected: SettingReading } {
  const cmd = SETTING_META[request.id].set;
  switch (request.id) {
    case 'power': return { command: { cmd, val: request.value }, expected: { val: request.value } };
    case 'profile': assertProfileId(request.value); return { command: { cmd, val: request.value }, expected: { val: request.value } };
    case 'baseband': {
      const { profile, q, session, target } = request.value;
      assertProfileId(profile);
      if (integer(q, 0, 15) === null || ![0, 1, 2, 3, 255].includes(session) || ![0, 1].includes(target)) throw new Error('Invalid Q, session or target.');
      return { command: { cmd, val: `${profile},${q},${session},${target}` }, expected: request.value };
    }
    case 'device-name': assertValidBleDeviceName(request.value); return { command: { cmd, val: request.value }, expected: { val: request.value } };
    case 'tag-focus': return { command: { cmd, val: request.value ? 1 : 0 }, expected: { val: request.value ? 1 : 0 } };
    case 'q-session': return { command: { cmd, val: `${request.value.q},${request.value.session}` }, expected: request.value };
    case 'query-params': return { command: { cmd, val: `${request.value.interval},${request.value.dwell},${request.value.append}` }, expected: request.value };
    case 'region-band': {
      return prepareRegionApply(request.value.selection, request.value.save);
    }
  }
}
