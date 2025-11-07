import { google } from 'googleapis';

export function sheetsClientFromB64(b64) {
  const json = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  const auth = new google.auth.JWT(
    json.client_email,
    null,
    json.private_key,
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  return google.sheets({ version: 'v4', auth });
}

export async function appendRow(sheets, spreadsheetId, sheetName, values) {
  return sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${sheetName}!A:Z`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [values] }
  });
}

export async function readRange(sheets, spreadsheetId, rangeA1) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: rangeA1 });
  return res.data.values ?? [];
}
