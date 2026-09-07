export const BLE_DEVICE_NAME_MIN_BYTES = 1;
export const BLE_DEVICE_NAME_MAX_BYTES = 14;

export type DeviceNameValidation = {
  valid: boolean;
  byteLength: number;
  error: string | null;
};

const hasUnpairedSurrogate = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);

    if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
      if (index + 1 >= value.length) return true;
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit < 0xDC00 || nextCodeUnit > 0xDFFF) return true;
      index += 1;
    } else if (codeUnit >= 0xDC00 && codeUnit <= 0xDFFF) {
      return true;
    }
  }

  return false;
};

/**
 * Validates the exact value sent in SDN. The byte limit applies to encoded
 * UTF-8 data only; the trailing firmware NUL is deliberately not counted.
 */
export const validateBleDeviceName = (value: string): DeviceNameValidation => {
  if (hasUnpairedSurrogate(value)) {
    return { valid: false, byteLength: 0, error: 'Name is not well-formed Unicode/UTF-8' };
  }

  const byteLength = new TextEncoder().encode(value).byteLength;

  if (byteLength < BLE_DEVICE_NAME_MIN_BYTES) {
    return { valid: false, byteLength, error: 'Name must contain at least 1 UTF-8 byte' };
  }

  // Unicode Cc controls consist of C0, DEL, and C1. This includes NUL even
  // when it reached the string through a JSON \u0000 escape.
  if (/[\u0000-\u001F\u007F-\u009F]/u.test(value)) {
    return { valid: false, byteLength, error: 'Control characters are not allowed' };
  }

  if (byteLength > BLE_DEVICE_NAME_MAX_BYTES) {
    return {
      valid: false,
      byteLength,
      error: `Name is ${byteLength} UTF-8 bytes; maximum is ${BLE_DEVICE_NAME_MAX_BYTES}`,
    };
  }

  return { valid: true, byteLength, error: null };
};

export const assertValidBleDeviceName = (value: string): void => {
  const validation = validateBleDeviceName(value);
  if (!validation.valid) {
    throw new Error(validation.error ?? 'Invalid Bluetooth device name');
  }
};
