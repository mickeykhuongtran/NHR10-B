const sanitizeBleLabel = (value?: string | null): string => (
  (value ?? '')
    .normalize('NFKC')
    // GAP names produced by fixed-size firmware buffers can contain invisible
    // NULL/control bytes. Browsers preserve them even though the UI does not.
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
    .trim()
);

export const formatDeviceDisplayName = (
  advertisedName: string,
  displayId?: string,
  fallbackName?: string,
): string => {
  const advertised = sanitizeBleLabel(advertisedName);
  const normalizedDisplayId = sanitizeBleLabel(displayId).toUpperCase().replace(/^NHR10-/, '');
  const fallback = sanitizeBleLabel(fallbackName);

  const advertisedCanonicalMatch = advertised.match(/^NHR10-([0-9A-F]{12})$/i);
  if (advertisedCanonicalMatch) {
    return `NHR10-${advertisedCanonicalMatch[1].slice(-6).toUpperCase()}`;
  }

  const advertisedDisplayMatch = advertised.match(/^NHR10-([0-9A-F]{6})$/i);
  if (advertisedDisplayMatch) {
    return `NHR10-${advertisedDisplayMatch[1].toUpperCase()}`;
  }

  // A user-configured advertising name no longer encodes the display ID. Show
  // it as advertised while Canonical ID verification remains a separate DI
  // concern. Exact historical names still use the compact display-ID fallback.
  if (advertised && !/^(?:NHR-10|Nextwaves(?:_Scanner_V3)?)$/i.test(advertised)) {
    return advertised;
  }

  // A verified DI display_id is more trustworthy than an unrecognised or
  // padded advertising label and guarantees a compact, stable UI name.
  if (/^[0-9A-F]{6}$/.test(normalizedDisplayId)) {
    return `NHR10-${normalizedDisplayId}`;
  }

  const fallbackCanonicalMatch = fallback.match(/^NHR10-([0-9A-F]{12})$/i);
  if (fallbackCanonicalMatch) {
    return `NHR10-${fallbackCanonicalMatch[1].slice(-6).toUpperCase()}`;
  }

  const fallbackDisplayMatch = fallback.match(/^NHR10-([0-9A-F]{6})$/i);
  if (fallbackDisplayMatch) {
    return `NHR10-${fallbackDisplayMatch[1].toUpperCase()}`;
  }

  return advertised || fallback;
};
