'use strict';

/* ============================================================
   1. Constants
   ============================================================ */

const IPV4_BITS = 32;
const IPV6_BITS = 128;
const IPV6_ALL = (1n << 128n) - 1n;
const THEME_KEY = 'subnet-calc:theme';
const HEXTET_RE = /^[0-9a-fA-F]{1,4}$/;

const COPY_ICON =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" ' +
  'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="9" y="9" width="12" height="12" rx="2"/>' +
  '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

/* ============================================================
   2. IPv4 helpers
   ============================================================ */

/** "192.168.1.10" -> 3232235786, or null when malformed. */
function parseIPv4(str) {
  const parts = String(str).trim().split('.');
  if (parts.length !== 4) return null;

  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

/** 3232235786 -> "192.168.1.10" */
function formatIPv4(value) {
  return [
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255
  ].join('.');
}

function prefixToMask32(prefix) {
  return prefix === 0 ? 0 : ((0xffffffff << (IPV4_BITS - prefix)) >>> 0);
}

function maskToPrefix32(mask) {
  let prefix = 0;
  for (let bit = IPV4_BITS - 1; bit >= 0; bit--) {
    if (((mask >>> bit) & 1) === 0) break;
    prefix++;
  }
  return prefix;
}

/** A real netmask is a single unbroken run of 1s: 255.255.0.0 yes, 255.255.0.255 no. */
function isContiguous32(mask) {
  return prefixToMask32(maskToPrefix32(mask)) === mask;
}

/* ============================================================
   3. IPv6 helpers
   ============================================================ */

/** "2001:db8::1" / "::ffff:1.2.3.4" -> 128-bit BigInt, or null when malformed. */
function parseIPv6(str) {
  let text = String(str).trim();
  if (text === '') return null;

  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);

  // Rewrite a trailing dotted-quad into the two hextets it stands for.
  const lastColon = text.lastIndexOf(':');
  if (lastColon !== -1 && text.slice(lastColon + 1).includes('.')) {
    const embedded = parseIPv4(text.slice(lastColon + 1));
    if (embedded === null) return null;
    text = text.slice(0, lastColon + 1)
      + ((embedded >>> 16) & 0xffff).toString(16)
      + ':' + (embedded & 0xffff).toString(16);
  }

  const doubleColon = text.indexOf('::');
  let head = [];
  let tail = [];

  if (doubleColon === -1) {
    head = text.split(':');
  } else {
    if (text.indexOf('::', doubleColon + 1) !== -1) return null;
    head = text.slice(0, doubleColon).split(':').filter((part) => part !== '');
    tail = text.slice(doubleColon + 2).split(':').filter((part) => part !== '');
  }

  for (const group of head.concat(tail)) {
    if (!HEXTET_RE.test(group)) return null;
  }

  const missing = 8 - head.length - tail.length;
  // Without "::" every group must be present; with it, "::" must cover at least one.
  if (doubleColon === -1 ? missing !== 0 : missing < 1) return null;

  // Splice the elided groups back in, then fold all eight into one 128-bit value.
  const groups = head.concat(new Array(missing).fill('0')).concat(tail);

  let value = 0n;
  for (const group of groups) value = (value << 16n) | BigInt(parseInt(group, 16));

  return value;
}

function ipv6Groups(value) {
  const groups = [];
  for (let index = 7; index >= 0; index--) {
    groups.push(Number((value >> BigInt(index * 16)) & 0xffffn));
  }
  return groups;
}

/** Compressed form, collapsing the longest run of zero groups (when 2 or more). */
function formatIPv6(value) {
  const groups = ipv6Groups(value).map((group) => group.toString(16));

  let bestStart = -1;
  let bestLength = 0;
  let runStart = -1;
  let runLength = 0;

  groups.forEach((group, index) => {
    if (group === '0') {
      if (runStart === -1) {
        runStart = index;
        runLength = 1;
      } else {
        runLength++;
      }
      if (runLength > bestLength) {
        bestStart = runStart;
        bestLength = runLength;
      }
    } else {
      runStart = -1;
      runLength = 0;
    }
  });

  if (bestLength < 2) return groups.join(':');
  return groups.slice(0, bestStart).join(':') + '::' + groups.slice(bestStart + bestLength).join(':');
}

/** Fully expanded form, every group padded to four digits. */
function formatIPv6Full(value) {
  return ipv6Groups(value)
    .map((group) => group.toString(16).padStart(4, '0'))
    .join(':');
}

function prefixToMask128(prefix) {
  return prefix === 0 ? 0n : (((1n << BigInt(prefix)) - 1n) << BigInt(IPV6_BITS - prefix));
}

function maskToPrefix128(mask) {
  let prefix = 0;
  for (let bit = IPV6_BITS - 1; bit >= 0; bit--) {
    if (((mask >> BigInt(bit)) & 1n) === 0n) break;
    prefix++;
  }
  return prefix;
}

/* ============================================================
   4. Input interpretation
   ============================================================ */

function parsePrefix(text, bits) {
  if (!/^\d{1,3}$/.test(text)) return null;
  const prefix = Number(text);
  return prefix <= bits ? prefix : null;
}

/**
 * Work out what the user typed. Returns { version, value, prefix } or { error }.
 */
function parseInput(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (text === '') return { error: 'Enter an IP address to calculate.' };

  let address = text;
  let maskText = null;

  const slash = text.indexOf('/');
  if (slash !== -1) {
    address = text.slice(0, slash).trim();
    maskText = text.slice(slash + 1).trim();
    if (maskText === '') return { error: 'Missing prefix length or netmask after the "/".' };
  } else {
    const parts = text.split(/[\s,]+/).filter(Boolean);
    if (parts.length > 2) {
      return { error: 'Give one address, optionally followed by a prefix length or netmask.' };
    }
    address = parts[0];
    maskText = parts.length === 2 ? parts[1] : null;
  }

  if (address === '') return { error: 'Missing IP address.' };

  if (address.includes(':')) {
    const value = parseIPv6(address);
    if (value === null) return { error: '"' + address + '" is not a valid IPv6 address.' };

    let prefix;
    if (maskText === null) {
      prefix = IPV6_BITS;
    } else if (maskText.includes(':')) {
      const mask = parseIPv6(maskText);
      if (mask === null) return { error: '"' + maskText + '" is not a valid IPv6 netmask.' };
      prefix = maskToPrefix128(mask);
      if (prefixToMask128(prefix) !== mask) {
        return { error: 'An IPv6 netmask must be contiguous, for example ffff:ffff:ffff:ffff:: for /64.' };
      }
    } else {
      prefix = parsePrefix(maskText, IPV6_BITS);
      if (prefix === null) return { error: '"' + maskText + '" is not a valid IPv6 prefix length (0-128).' };
    }
    return { version: 6, value, prefix, address };
  }

  const value = parseIPv4(address);
  if (value === null) return { error: '"' + address + '" is not a valid IPv4 address.' };

  let prefix;
  if (maskText === null) {
    prefix = IPV4_BITS;
  } else if (maskText.includes('.')) {
    const mask = parseIPv4(maskText);
    if (mask === null) return { error: '"' + maskText + '" is not a valid IPv4 netmask.' };
    if (!isContiguous32(mask)) {
      return { error: 'A netmask must be contiguous, so 255.255.252.0 works but 255.255.0.255 does not.' };
    }
    prefix = maskToPrefix32(mask);
  } else {
    prefix = parsePrefix(maskText, IPV4_BITS);
    if (prefix === null) return { error: '"' + maskText + '" is not a valid IPv4 prefix length (0-32).' };
  }
  return { version: 4, value, prefix, address };
}

/* ============================================================
   5. Subnet arithmetic
   ============================================================ */

function calculateIPv4(value, prefix) {
  const mask = prefixToMask32(prefix);
  const network = (value & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  const total = Math.pow(2, IPV4_BITS - prefix);
  const hostBits = IPV4_BITS - prefix;

  let first;
  let last;
  let usable;

  if (hostBits === 0) {
    // /32 — a host route, not a subnet.
    first = network;
    last = network;
    usable = 1;
  } else if (hostBits === 1) {
    // /31 — RFC 3021 keeps both addresses usable on a point-to-point link.
    first = network;
    last = broadcast;
    usable = 2;
  } else {
    first = (network + 1) >>> 0;
    last = (broadcast - 1) >>> 0;
    usable = total - 2;
  }

  return { mask, network, broadcast, first, last, total, usable, hostBits };
}

function calculateIPv6(value, prefix) {
  const mask = prefixToMask128(prefix);
  const network = value & mask;
  const wildcard = IPV6_ALL & ~mask;
  const total = 1n << BigInt(IPV6_BITS - prefix);
  return { mask, network, last: network | wildcard, total, wildcard, hostBits: IPV6_BITS - prefix };
}

/* ============================================================
   6. Classification
   ============================================================ */

function ipv4Class(value) {
  const first = (value >>> 24) & 255;
  if (first < 128) return 'A';
  if (first < 192) return 'B';
  if (first < 224) return 'C';
  if (first < 240) return 'D (multicast)';
  return 'E (reserved)';
}

function ipv4Type(value) {
  const a = (value >>> 24) & 255;
  const b = (value >>> 16) & 255;
  if (a === 0) return 'This network (RFC 1122)';
  if (a === 10) return 'Private (RFC 1918)';
  if (a === 127) return 'Loopback (RFC 1122)';
  if (a === 100 && b >= 64 && b <= 127) return 'Carrier-grade NAT (RFC 6598)';
  if (a === 169 && b === 254) return 'Link-local, APIPA (RFC 3927)';
  if (a === 172 && b >= 16 && b <= 31) return 'Private (RFC 1918)';
  if (a === 192 && b === 168) return 'Private (RFC 1918)';
  if (a === 224) return 'Multicast (RFC 5771)';
  if (a >= 240) return 'Reserved (RFC 1112)';
  return 'Public unicast';
}

function ipv6Type(value) {
  if (value === 0n) return 'Unspecified';
  if (value === 1n) return 'Loopback';

  const firstByte = Number((value >> 120n) & 0xffn);
  const secondByte = Number((value >> 112n) & 0xffn);

  if (firstByte === 0xff) return 'Multicast (ff00::/8)';
  if (firstByte === 0xfe && (secondByte & 0xc0) === 0x80) return 'Link-local (fe80::/10)';
  if ((firstByte & 0xfe) === 0xfc) return 'Unique local (fc00::/7)';
  if ((value >> 96n) === 0x20010db8n) return 'Documentation (2001:db8::/32)';
  if ((firstByte & 0xe0) === 0x20) return 'Global unicast (2000::/3)';
  return 'Reserved or special-purpose';
}

/* ============================================================
   7. Display helpers
   ============================================================ */

function formatCount(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Counts above 9 digits get a "1.8447e+19" style hint beside the exact figure. */
function approximate(value) {
  const digits = String(value);
  if (digits.length <= 9) return null;
  return Number(digits).toExponential(4);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ============================================================
   8. Result assembly
   ============================================================ */

function buildIPv4Rows(parsed) {
  const result = calculateIPv4(parsed.value, parsed.prefix);
  const edgeTag = result.hostBits === 1 ? 'RFC 3021' : (result.hostBits === 0 ? 'Host route' : null);

  const rows = [
    { label: 'Network address', value: formatIPv4(result.network) },
    { label: 'Broadcast address', value: formatIPv4(result.broadcast) },
    { label: 'First usable host', value: formatIPv4(result.first), tag: edgeTag },
    { label: 'Last usable host', value: formatIPv4(result.last), tag: edgeTag },
    { label: 'Usable hosts', value: formatCount(result.usable), tag: edgeTag },
    { label: 'Total addresses', value: formatCount(result.total) },
    { label: 'Subnet mask', value: formatIPv4(result.mask) },
    { label: 'Wildcard mask', value: formatIPv4((~result.mask) >>> 0) },
    { label: 'Prefix length', value: '/' + parsed.prefix },
    { label: 'IP class', value: ipv4Class(parsed.value) },
    { label: 'Address type', value: ipv4Type(parsed.value) }
  ];

  const notes = [];
  if (result.hostBits === 0) {
    notes.push('A /32 describes a single host route, so there is no separate network or broadcast address.');
  }
  if (result.hostBits === 1) {
    notes.push('A /31 follows RFC 3021: both addresses are usable on a point-to-point link, which is why the usable count is 2 rather than 0.');
  }
  if (parsed.prefix === 0) {
    notes.push('0.0.0.0/0 is the default route and covers the whole IPv4 address space.');
  } else if (parsed.prefix < 24) {
    // A block shorter than a /24 holds 2^(24 - prefix) whole /24 LANs.
    notes.push('At /' + parsed.prefix + ' this block holds ' + formatCount(result.total)
      + ' addresses, so it splits into ' + formatCount(Math.pow(2, 24 - parsed.prefix)) + ' separate /24 LANs.');
  } else if (parsed.prefix === 24) {
    notes.push('/24 is the most common LAN size: 256 addresses, 254 of them assignable to hosts.');
  }

  return { rows, notes, canonical: formatIPv4(parsed.value) + '/' + parsed.prefix };
}

function buildIPv6Rows(parsed) {
  const result = calculateIPv6(parsed.value, parsed.prefix);
  const approx = approximate(result.total);

  const rows = [
    { label: 'Network (CIDR)', value: formatIPv6(result.network) + '/' + parsed.prefix },
    { label: 'Network address', value: formatIPv6(result.network) },
    { label: 'Expanded form', value: formatIPv6Full(result.network) },
    { label: 'First address', value: formatIPv6(result.network) },
    { label: 'Last address', value: formatIPv6(result.last) },
    { label: 'Total addresses', value: formatCount(result.total), tag: approx ? '≈ ' + approx : null },
    { label: 'Usable addresses', value: formatCount(result.total), tag: 'nothing reserved' },
    { label: 'Host mask', value: formatIPv6(result.wildcard) },
    { label: 'Prefix length', value: '/' + parsed.prefix },
    { label: 'Address type', value: ipv6Type(result.network) }
  ];

  const notes = ['IPv6 has no broadcast address and reserves nothing, so every address in the range is usable.'];
  if (parsed.prefix === 0) {
    notes.push('::/0 is the default route and covers the whole IPv6 address space.');
  } else if (parsed.prefix < 64) {
    notes.push('Prefixes shorter than /64 hand out more than 18,446,744,073,709,551,616 addresses per subnet. /64 is the conventional size for one network.');
  } else if (parsed.prefix === 64) {
    notes.push('/64 is the standard subnet size for a single IPv6 network, so this is the shape most allocations are built around.');
  } else {
    notes.push('Prefixes longer than /64 split an existing /64 into smaller pieces, which suits point-to-point links (/127) and loopbacks (/128).');
  }

  return { rows, notes, canonical: formatIPv6(parsed.value) + '/' + parsed.prefix };
}

function buildResult(parsed) {
  return parsed.version === 4 ? buildIPv4Rows(parsed) : buildIPv6Rows(parsed);
}

/* ============================================================
   9. Bit breakdown
   ============================================================ */

function buildIPv4Bits(value, prefix) {
  const cells = [];
  for (let index = 0; index < IPV4_BITS; index++) {
    cells.push({
      text: String((value >>> (IPV4_BITS - 1 - index)) & 1),
      state: index < prefix ? 'net' : 'host'
    });
  }
  return { cells, groupSize: 8 };
}

function buildIPv6Bits(value, prefix) {
  const cells = [];
  for (let index = 0; index < 32; index++) {
    const nibble = Number((value >> BigInt((31 - index) * 4)) & 0x0fn);
    const first = index * 4;

    if (first + 4 <= prefix) {
      cells.push({ text: nibble.toString(16), state: 'net' });
    } else if (first >= prefix) {
      cells.push({ text: nibble.toString(16), state: 'host' });
    } else {
      // The prefix cuts through this nibble, so shade the two halves differently.
      const split = Math.round(((prefix - first) / 4) * 100);
      cells.push({
        text: nibble.toString(16),
        state: 'mix',
        style: 'background:linear-gradient(90deg,var(--net) 0 ' + split + '%,var(--host) ' + split + '% 100%)'
      });
    }
  }
  return { cells, groupSize: 4 };
}

function renderBits(bitData, prefix, totalBits) {
  const cells = bitData.cells.map((cell, index) => {
    // Skip index 0 so the gutter is not added to the left edge of the grid.
    const separator = index > 0 && index % bitData.groupSize === 0 ? ' group-start' : '';
    const classes = 'bit ' + cell.state + separator;
    const style = cell.style ? ' style="' + cell.style + '"' : '';
    return '<span class="' + classes + '"' + style + '>' + escapeHtml(cell.text) + '</span>';
  }).join('');

  return '<div class="bit-scroll"><div class="bit-grid">' + cells + '</div></div>'
    + '<div class="bit-legend">'
    + '<span><i class="swatch net"></i>Network — ' + prefix + ' bits</span>'
    + '<span><i class="swatch host"></i>Host — ' + (totalBits - prefix) + ' bits</span>'
    + '</div>';
}

/* ============================================================
   10. DOM
   ============================================================ */

const form = document.getElementById('calc-form');
const input = document.getElementById('ip-input');
const errorBox = document.getElementById('error');
const results = document.getElementById('results');
const resultTitle = document.getElementById('result-title');
const resultGrid = document.getElementById('result-grid');
const breakdownLabel = document.getElementById('breakdown-label');
const breakdown = document.getElementById('breakdown');
const notesBlock = document.getElementById('notes-block');
const notesList = document.getElementById('notes');
const emptyState = document.getElementById('empty-state');
const copyAllButton = document.getElementById('copy-all');
const themeToggle = document.getElementById('theme-toggle');

let currentRows = [];

function rowHtml(row) {
  const tag = row.tag ? '<span class="tag">' + escapeHtml(row.tag) + '</span>' : '';
  const value = escapeHtml(row.value);
  return '<div class="row">'
    + '<dt class="row-label">' + escapeHtml(row.label) + '</dt>'
    + '<dd class="row-value">'
    + '<span class="value-text">' + value + '</span>'
    + tag
    + '<button type="button" class="copy" data-copy="' + value + '" '
    + 'aria-label="Copy ' + escapeHtml(row.label) + '" title="Copy">' + COPY_ICON + '</button>'
    + '</dd>'
    + '</div>';
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
  input.setAttribute('aria-invalid', 'true');
  results.hidden = true;
  emptyState.hidden = true;
  currentRows = [];
  clearHash();
}

function showResult(parsed) {
  const built = buildResult(parsed);
  currentRows = built.rows;

  errorBox.hidden = true;
  input.setAttribute('aria-invalid', 'false');
  results.hidden = false;
  emptyState.hidden = true;

  resultTitle.textContent = (parsed.version === 4 ? 'IPv4' : 'IPv6') + ' · ' + built.canonical;
  resultGrid.innerHTML = built.rows.map(rowHtml).join('');

  breakdownLabel.textContent = parsed.version === 4
    ? formatIPv4(parsed.value) + '  (grouped by octet)'
    : formatIPv6(parsed.value) + '  (grouped by hextet)';
  breakdown.innerHTML = renderBits(
    parsed.version === 4 ? buildIPv4Bits(parsed.value, parsed.prefix) : buildIPv6Bits(parsed.value, parsed.prefix),
    parsed.prefix,
    parsed.version === 4 ? IPV4_BITS : IPV6_BITS
  );

  notesBlock.hidden = built.notes.length === 0;
  notesList.innerHTML = built.notes.map((note) => '<li>' + escapeHtml(note) + '</li>').join('');

  writeHash(built.canonical);
}

function calculate() {
  const parsed = parseInput(input.value);
  if (parsed.error) showError(parsed.error);
  else showResult(parsed);
}

/* ============================================================
   11. Clipboard
   ============================================================ */

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (error) { /* permission or unsupported — fall through to the legacy path */ }

  try {
    const scratch = document.createElement('textarea');
    scratch.value = text;
    scratch.setAttribute('readonly', '');
    scratch.style.position = 'fixed';
    scratch.style.top = '-1000px';
    document.body.appendChild(scratch);
    scratch.select();
    const copied = document.execCommand('copy');
    document.body.removeChild(scratch);
    return copied;
  } catch (error) {
    return false;
  }
}

function flashCopied(button) {
  if (button.dataset.copied === 'yes') return;
  button.dataset.copied = 'yes';
  button.classList.add('done');
  button.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" '
    + 'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M4.5 12.5l5 5 10-11"/></svg>';

  window.setTimeout(() => {
    delete button.dataset.copied;
    button.classList.remove('done');
    button.innerHTML = COPY_ICON;
  }, 1200);
}

/* ============================================================
   12. URL hash
   ============================================================ */

function writeHash(value) {
  const next = '#' + value;
  if (window.location.hash !== next) history.replaceState(null, '', next);
}

function clearHash() {
  if (window.location.hash) history.replaceState(null, '', window.location.pathname + window.location.search);
}

function readHash() {
  const raw = window.location.hash.replace(/^#/, '');
  return raw === '' ? '' : decodeURIComponent(raw);
}

/* ============================================================
   13. Theme
   ============================================================ */

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  themeToggle.setAttribute('aria-label', 'Switch to ' + (theme === 'dark' ? 'light' : 'dark') + ' theme');
  try {
    if (theme === null) localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch (error) { /* storage blocked, the choice just will not persist */ }
}

/* ============================================================
   14. Wiring
   ============================================================ */

form.addEventListener('submit', (event) => {
  event.preventDefault();
  calculate();
});

input.addEventListener('input', () => {
  if (!errorBox.hidden) {
    errorBox.hidden = true;
    input.setAttribute('aria-invalid', 'false');
  }
});

document.querySelectorAll('[data-example]').forEach((chip) => {
  chip.addEventListener('click', () => {
    input.value = chip.dataset.example;
    calculate();
    input.focus();
  });
});

resultGrid.addEventListener('click', async (event) => {
  const button = event.target.closest('.copy');
  if (!button) return;
  if (await copyText(button.dataset.copy)) flashCopied(button);
});

copyAllButton.addEventListener('click', async () => {
  if (currentRows.length === 0) return;
  const text = currentRows.map((row) => row.label + ': ' + row.value).join('\n');
  if (await copyText(text)) {
    const original = copyAllButton.textContent;
    copyAllButton.textContent = 'Copied';
    window.setTimeout(() => { copyAllButton.textContent = original; }, 1200);
  }
});

themeToggle.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  setTheme(current === 'dark' ? 'light' : 'dark');
});

// Follow the OS preference, but only while the user has not chosen a theme by hand.
if (window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (event) => {
    let stored = null;
    try {
      stored = localStorage.getItem(THEME_KEY);
    } catch (error) { /* storage blocked, the stored choice simply wins */ }
    if (stored !== 'light' && stored !== 'dark') setTheme(event.matches ? 'dark' : 'light');
  });
}

window.addEventListener('hashchange', () => {
  const value = readHash();
  if (value && value !== input.value.trim()) {
    input.value = value;
    calculate();
  }
});

/* ============================================================
   15. Boot
   ============================================================ */

(function init() {
  const fromHash = readHash();
  if (fromHash) input.value = fromHash;

  // Nothing typed yet means nothing to report, so leave the empty state alone
  // rather than greeting a first-time visitor with a validation error. Focus is
  // only taken when there is genuinely nothing to read yet.
  if (input.value.trim() === '') input.focus();
  else calculate();
})();
