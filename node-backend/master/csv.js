// Small RFC-4180-style parser for broker instrument dumps. Both Kotak and
// Zerodha return large CSV files and some symbols/names are quoted, so splitting
// on commas is not safe. Kotak also has a legacy header named dStrikePrice;
// (the semicolon is part of the header, not the delimiter).

function delimiterFor(header) {
  let commas = 0;
  let semicolons = 0;
  let quoted = false;
  for (let i = 0; i < header.length; i += 1) {
    const ch = header[i];
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === ',') commas += 1;
    else if (!quoted && ch === ';') semicolons += 1;
  }
  return commas >= semicolons ? ',' : ';';
}

function parseRow(line, delimiter) {
  const values = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        value += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (ch === delimiter && !quoted) {
      values.push(value.trim());
      value = '';
    } else {
      value += ch;
    }
  }
  values.push(value.trim());
  return values;
}

export function parseBrokerCSV(text) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return [];
  const delimiter = delimiterFor(lines[0]);
  const headers = parseRow(lines[0], delimiter).map((header) => header.trim().replace(/;$/, ''));
  return lines.slice(1).map((line) => {
    const values = parseRow(line, delimiter);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']));
  });
}
