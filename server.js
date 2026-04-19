/**
 * HSBC File Validator — Loqate Address Suggestion Server
 * Run locally: node server.js
 * Open: http://localhost:3000
 */

const express = require('express');
const multer  = require('multer');
const xml2js  = require('xml2js');
const axios   = require('axios');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');

const app    = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const PORT           = process.env.PORT || 3000;
const LOQATE_API_KEY = process.env.LOQATE_API_KEY || 'YOUR_LOQATE_API_KEY';
const LOQATE_BASE    = 'https://api.addressy.com/Capture/Interactive/Find/v1.10/json3.ws';
const LOQATE_RETRIEVE= 'https://api.addressy.com/Capture/Interactive/Retrieve/v1.20/json3.ws';
const CONCURRENCY    = 10;   // max parallel Loqate calls
const TIMEOUT_MS     = 3000; // per-call timeout

// ─── LOQATE FIELD MAP ────────────────────────────────────────────────────────
const LOQATE_TO_ISO = {
  BuildingNumber : 'BldgNb',
  BuildingName   : 'BldgNm',
  SubBuilding    : 'FlrId',
  Street         : 'StrtNm',
  PostalCode     : 'PstCd',
  City           : 'TwnNm',
  CountryIso2    : 'Ctry',
};

// ─── CONFIDENCE BANDS ────────────────────────────────────────────────────────
function confidenceBand(score) {
  if (score >= 85) return { band: 'High',   color: '#085041', dotClass: 'c-high' };
  if (score >= 65) return { band: 'Medium', color: '#633806', dotClass: 'c-med'  };
  return               { band: 'Low',    color: '#791F1F', dotClass: 'c-low'  };
}

// ─── PARSE PAIN.001 XML ──────────────────────────────────────────────────────
async function parsePain001(xmlBuffer) {
  const raw = xmlBuffer.toString('utf8');
  const result = await xml2js.parseStringPromise(raw, { explicitArray: false, ignoreAttrs: false });

  // navigate to CstmrCdtTrfInitn regardless of namespace prefix
  const root = result[Object.keys(result)[0]];
  const initn = root.CstmrCdtTrfInitn;
  const grpHdr = initn.GrpHdr;

  const fileRef   = grpHdr.MsgId || '';
  const creDtTm   = grpHdr.CreDtTm || '';
  const nbOfTxs   = grpHdr.NbOfTxs || '';
  const ctrlSum   = grpHdr.CtrlSum || '';

  const pmtInfRaw = initn.PmtInf;
  const pmtInfs   = Array.isArray(pmtInfRaw) ? pmtInfRaw : [pmtInfRaw];

  const instructions = [];

  for (const pmtInf of pmtInfs) {
    const pmtInfId  = pmtInf.PmtInfId || '';
    const dbtrNm    = pmtInf.Dbtr?.Nm || '';
    const cdtTxsRaw = pmtInf.CdtTrfTxInf;
    const cdtTxs    = Array.isArray(cdtTxsRaw) ? cdtTxsRaw : [cdtTxsRaw];

    for (const tx of cdtTxs) {
      const e2eId    = tx.PmtId?.EndToEndId || '';
      const ccy      = tx.Amt?.InstdAmt?.$?.Ccy || tx.Amt?.InstdAmt?.['_']?.Ccy || '';
      const amount   = tx.Amt?.InstdAmt?._ || tx.Amt?.InstdAmt || '';
      const cdtrNm   = tx.Cdtr?.Nm || '';
      const pstlAdr  = tx.Cdtr?.PstlAdr || {};

      // Collect AdrLine(s)
      const adrLineRaw = pstlAdr.AdrLine;
      const adrLines   = adrLineRaw
        ? (Array.isArray(adrLineRaw) ? adrLineRaw : [adrLineRaw])
        : [];

      const hasAdrLine = adrLines.length > 0;

      instructions.push({
        pmtInfId,
        e2eId,
        cdtrNm,
        dbtrNm,
        amount: `${ccy} ${parseFloat(amount).toLocaleString('en-GB', { minimumFractionDigits: 2 })}`,
        hasAdrLine,
        adrLines,
        originalFields: {
          AdrLine : adrLines,
          TwnNm   : pstlAdr.TwnNm   || null,
          Ctry    : pstlAdr.Ctry    || null,
          PstCd   : pstlAdr.PstCd   || null,
          StrtNm  : pstlAdr.StrtNm  || null,
          BldgNb  : pstlAdr.BldgNb  || null,
          BldgNm  : pstlAdr.BldgNm  || null,
          FlrId   : pstlAdr.FlrId   || null,
        },
        loqate: null
      });
    }
  }

  return { fileRef, creDtTm, nbOfTxs, ctrlSum, instructions, rawXml: raw };
}

// ─── CALL LOQATE ─────────────────────────────────────────────────────────────
async function callLoqate(adrLines, countryHint) {
  const searchText = adrLines.join(', ') + (countryHint ? `, ${countryHint}` : '');
  const inputHash  = crypto.createHash('sha256').update(searchText).digest('hex').slice(0, 16);

  try {
    // Step 1: Find
    const findResp = await axios.get(LOQATE_BASE, {
      timeout: TIMEOUT_MS,
      params : {
        Key    : LOQATE_API_KEY,
        Text   : searchText,
        Limit  : 1,
        Countries: countryHint || '',
      }
    });

    const items = findResp.data?.Items;
    if (!items || items.length === 0) return { status: 'no_result', inputHash };

    // If first item has Type=Address, retrieve; else take the first address sub-item
    const firstItem = items[0];
    if (firstItem.Error) return { status: 'error', message: firstItem.Description, inputHash };

    // Step 2: Retrieve
    const retrieveResp = await axios.get(LOQATE_RETRIEVE, {
      timeout: TIMEOUT_MS,
      params : { Key: LOQATE_API_KEY, Id: firstItem.Id }
    });

    const addr = retrieveResp.data?.Items?.[0];
    if (!addr) return { status: 'no_result', inputHash };

    // Map fields
    const parsed = {};
    for (const [loqField, isoField] of Object.entries(LOQATE_TO_ISO)) {
      if (addr[loqField]) parsed[isoField] = addr[loqField];
    }

    // Confidence: Loqate uses AQI (A=100, B=80, C=60, D=40)
    const aqiMap = { A: 95, B: 80, C: 65, D: 40 };
    const score  = aqiMap[addr.AQI] ?? 50;

    const refId = `LQT-${Date.now()}-${inputHash.slice(0, 8).toUpperCase()}`;

    return { status: 'success', parsed, score, refId, inputHash };

  } catch (err) {
    if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
      return { status: 'timeout', inputHash };
    }
    return { status: 'error', message: err.message, inputHash };
  }
}

// ─── DEMO MODE (no real API key) ─────────────────────────────────────────────
function demoLoqate(adrLines, countryHint) {
  const text = adrLines.join(' ').toLowerCase();
  const inputHash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
  const refId = `LQT-DEMO-${inputHash.slice(0, 8).toUpperCase()}`;

  // Simple heuristic demo parser
  const postcode = text.match(/([a-z]{1,2}\d[\d a-z]?\s*\d[a-z]{2})/i)?.[1]?.toUpperCase().replace(/(\S+)\s*(\d[A-Z]{2})$/, '$1 $2') || null;
  const buildingNb = text.match(/^(\d+[a-z]?)\b/i)?.[1]?.toUpperCase() || null;
  const cityMatch = text.match(/\b(london|manchester|uxbridge|birmingham|leeds|bristol|glasgow|edinburgh|liverpool)\b/i)?.[1];
  const city = cityMatch ? cityMatch.charAt(0).toUpperCase() + cityMatch.slice(1).toLowerCase() : null;

  const parsed = {};
  if (buildingNb) parsed['BldgNb'] = buildingNb;
  if (postcode)   parsed['PstCd']  = postcode;
  if (city)       parsed['TwnNm']  = city;
  parsed['Ctry'] = countryHint || 'GB';

  // guess street name
  const streetMatch = text.match(/\b(\d+[a-z]?)\s+(.+?)\s+(road|street|lane|avenue|close|way|drive|square)\b/i);
  if (streetMatch) {
    parsed['StrtNm'] = (streetMatch[2] + ' ' + streetMatch[3]).replace(/\b\w/g, c => c.toUpperCase());
  }

  const score = (parsed['TwnNm'] && parsed['PstCd']) ? 89 : (parsed['TwnNm'] ? 72 : 55);

  return { status: 'success', parsed, score, refId, inputHash, demo: true };
}

// ─── CONCURRENT LOQATE CALLS ─────────────────────────────────────────────────
async function enrichInstructions(instructions) {
  const isDemoMode = LOQATE_API_KEY === 'YOUR_LOQATE_API_KEY';

  async function processOne(instr) {
    if (!instr.hasAdrLine) return;
    const countryHint = instr.originalFields.Ctry || 'GB';
    const result = isDemoMode
      ? demoLoqate(instr.adrLines, countryHint)
      : await callLoqate(instr.adrLines, countryHint);
    instr.loqate = result;
  }

  // Process in batches of CONCURRENCY
  for (let i = 0; i < instructions.length; i += CONCURRENCY) {
    const batch = instructions.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(processOne));
  }
}

// ─── GENERATE XML SNIPPET ────────────────────────────────────────────────────
function xmlSnippet(parsed) {
  const order = ['FlrId','BldgNb','BldgNm','StrtNm','PstCd','TwnNm','Ctry'];
  let xml = '<PstlAdr>\n';
  for (const field of order) {
    if (parsed[field]) xml += `  <${field}>${escHtml(parsed[field])}</${field}>\n`;
  }
  xml += '</PstlAdr>';
  return xml;
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ─── RENDER REPORT ───────────────────────────────────────────────────────────
function renderReport(fileInfo, instructions, fileName, submitDt) {
  const adrlineCount = instructions.filter(i => i.hasAdrLine).length;
  const accepted     = instructions.filter(i => !i.hasAdrLine).length;
  const rejected     = adrlineCount;
  const total        = instructions.length;
  const highCount    = instructions.filter(i => i.loqate?.score >= 85).length;
  const medCount     = instructions.filter(i => i.loqate?.score >= 65 && i.loqate?.score < 85).length;

  const isDemoMode = LOQATE_API_KEY === 'YOUR_LOQATE_API_KEY';
  const demoBanner = isDemoMode ? `
    <div style="background:#FFF3CD;border-left:4px solid #ffc107;padding:10px 16px;margin:12px 40px;font-size:12px;color:#856404">
      <strong>Demo mode:</strong> Running without a real Loqate API key. Address parsing results are simulated.
      Set the <code>LOQATE_API_KEY</code> environment variable to enable live Loqate parsing.
    </div>` : '';

  // Build instruction cards
  let cards = '';
  instructions.forEach((instr, idx) => {
    const cardId = `c${idx + 1}`;
    const isOpen = instr.hasAdrLine;
    const conf   = instr.loqate?.score != null ? confidenceBand(instr.loqate.score) : null;
    const loqOk  = instr.loqate?.status === 'success';

    const leftFields = instr.hasAdrLine ? `
      ${instr.adrLines.map((l,li) => `<div class="arow"><span class="atag">AdrLine${instr.adrLines.length > 1 ? ' '+(li+1) : ''}</span><span class="aval">${escHtml(l)}</span></div>`).join('')}
      ${['TwnNm','Ctry','PstCd','StrtNm','BldgNb'].map(f => `<div class="arow"><span class="atag">${f}</span><span class="aval ${instr.originalFields[f] ? '' : 'miss'}">${instr.originalFields[f] || 'not provided'}</span></div>`).join('')}
    ` : Object.entries(instr.originalFields).filter(([k,v]) => k !== 'AdrLine' && v).map(([k,v]) => `<div class="arow"><span class="atag">${k}</span><span class="aval parsed">${escHtml(v)}</span></div>`).join('');

    let rightCol = '';
    if (!instr.hasAdrLine) {
      rightCol = `<div class="compliant-center">
        <svg width="28" height="28" viewBox="0 0 18 18"><circle cx="9" cy="9" r="9" fill="#00847f"/><polygon points="7.22 13.55 3.59 9.92 4.86 8.65 7.22 11.01 13.14 5.08 14.41 6.36 7.22 13.55" fill="#fff"/></svg>
        ISO 20022 compliant</div>`;
    } else if (instr.loqate?.status === 'timeout') {
      rightCol = `<div style="padding:14px;font-size:12px;color:#A32D2D">Loqate service timed out. Please verify address manually.</div>`;
    } else if (instr.loqate?.status === 'no_result' || instr.loqate?.status === 'error') {
      rightCol = `<div style="padding:14px;font-size:12px;color:#A32D2D">Address could not be parsed. Please verify manually.</div>`;
    } else if (loqOk) {
      const parsed = instr.loqate.parsed;
      const warn = conf.band === 'Medium' ? `<div class="warn-box">&#9888; Medium confidence &mdash; please verify before use</div>` :
                   conf.band === 'Low'    ? `<div class="warn-box" style="background:#FCEBEB;color:#791F1F">&#9888; Low confidence &mdash; manual verification strongly recommended</div>` : '';
      rightCol = `
        <div class="col-title parsed">Loqate parsed (structured)</div>
        ${warn}
        <div class="arow"><span class="atag removed">AdrLine</span><span class="aval" style="color:#A32D2D;font-size:11px">Remove</span></div>
        ${['FlrId','BldgNb','BldgNm','StrtNm','PstCd','TwnNm','Ctry'].filter(f => parsed[f]).map(f => `<div class="arow"><span class="atag">${f}</span><span class="aval parsed">${escHtml(parsed[f])}</span></div>`).join('')}
      `;
    }

    const snippet = loqOk ? xmlSnippet(instr.loqate.parsed) : '';
    const snippetDisplay = snippet
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/&lt;(\/?[A-Za-z]+)&gt;/g, '<span class="xml-tag">&lt;$1&gt;</span>')
      .replace(/&gt;([^&<]+)&lt;\//g, '&gt;<span class="xml-green">$1</span>&lt;/');

    const headerIcon = instr.hasAdrLine
      ? `<svg width="14" height="14" viewBox="0 0 18 18"><path fill="#a8000b" d="M8.31,1.68.11,15.8A.8.8,0,0,0,.8,17H17.2a.8.8,0,0,0,.69-1.2L9.69,1.68A.8.8,0,0,0,8.31,1.68Z"/><path fill="#fff" d="M8.1,5H9.9v6H8.1Zm-.35,8.58A1.25,1.25,0,1,0,9,12.33,1.25,1.25,0,0,0,7.75,13.58Z"/></svg>`
      : `<svg width="14" height="14" viewBox="0 0 18 18"><circle cx="9" cy="9" r="9" fill="#00847f"/><polygon points="7.22 13.55 3.59 9.92 4.86 8.65 7.22 11.01 13.14 5.08 14.41 6.36 7.22 13.55" fill="#fff"/></svg>`;

    const badge = instr.hasAdrLine
      ? `<span class="badge b-adr">AdrLine detected</span>`
      : `<span class="badge b-ok">Structured address</span>`;

    const confPill = conf ? `<span class="conf-pill"><span class="cdot ${conf.dotClass}"></span><span style="color:${conf.color};font-weight:600">${conf.band} ${instr.loqate.score}%</span></span>` : '';
    const loqRef  = instr.loqate?.refId ? `Loqate Ref: ${instr.loqate.refId} &nbsp;&middot;&nbsp; ` : '';
    const demoTag = instr.loqate?.demo  ? ' <span style="font-size:10px;background:#FFF3CD;color:#856404;padding:1px 6px;border-radius:3px;font-weight:600">DEMO</span>' : '';

    cards += `
  <div class="instr-card" data-type="${instr.hasAdrLine ? 'adrline' : 'clean'}">
    <div class="ic-header" onclick="toggleCard('${cardId}')">
      <div class="ic-left">
        ${headerIcon}
        <span class="ic-id">E2E: ${escHtml(instr.e2eId)}</span>
        <span class="ic-creditor">${escHtml(instr.cdtrNm)} &nbsp;&middot;&nbsp; ${escHtml(instr.amount)}</span>
      </div>
      <div class="ic-right">
        ${badge}${confPill}
        <span class="chevron ${isOpen ? 'open' : ''}" id="chev-${cardId}">&#9660;</span>
      </div>
    </div>
    <div id="body-${cardId}" ${isOpen ? '' : 'style="display:none"'}>
      ${!instr.hasAdrLine ? `
      <div class="no-loqate">
        <svg width="14" height="14" viewBox="0 0 18 18"><circle cx="9" cy="9" r="9" fill="#00847f"/><polygon points="7.22 13.55 3.59 9.92 4.86 8.65 7.22 11.01 13.14 5.08 14.41 6.36 7.22 13.55" fill="#fff"/></svg>
        Fully structured address provided. No Loqate parsing required.
      </div>` : `
      <div class="tab-row">
        <div class="tab active" id="tab-${cardId}-cmp" onclick="switchTab('${cardId}','cmp')">Address comparison</div>
        ${loqOk ? `<div class="tab" id="tab-${cardId}-xml" onclick="switchTab('${cardId}','xml')">XML snippet</div>` : ''}
      </div>`}
      <div id="pane-${cardId}-cmp" class="ic-body" ${!instr.hasAdrLine ? 'style="border-top:1px solid #eee"' : ''}>
        <div class="ic-col">
          <div class="col-title">${instr.hasAdrLine ? 'Original (unstructured)' : 'Structured address'}</div>
          ${leftFields}
        </div>
        <div class="ic-col">${rightCol}</div>
      </div>
      ${loqOk ? `
      <div id="pane-${cardId}-xml" style="display:none">
        <div class="xml-block">${snippetDisplay}</div>
      </div>` : ''}
      <div class="ic-foot">
        <div class="ic-foot-msg">${loqRef}Batch: ${escHtml(instr.pmtInfId)}${demoTag}</div>
        <div class="btn-row">
          ${loqOk ? `<button class="cbtn" onclick="doCopy(this,'${cardId}-xml-raw')">Copy XML</button>` : ''}
        </div>
      </div>
      ${loqOk ? `<textarea id="${cardId}-xml-raw" style="display:none">${snippet}</textarea>` : ''}
    </div>
  </div>`;
  });

  const filterBar = total > 1 ? `
  <div class="filter-bar">
    <span style="font-size:12px;color:#666">Filter:</span>
    <button class="filt-btn active" onclick="filterCards('all',this)">All instructions (${total})</button>
    <button class="filt-btn" onclick="filterCards('adrline',this)">AdrLine detected (${adrlineCount})</button>
    <button class="filt-btn" onclick="filterCards('clean',this)">No issues (${accepted})</button>
    <div class="stat-chips">
      ${highCount > 0 ? `<span class="chip chip-h">High confidence: ${highCount}</span>` : ''}
      ${medCount  > 0 ? `<span class="chip chip-m">Medium: ${medCount}</span>` : ''}
    </div>
  </div>` : '';

  const loqateSection = adrlineCount > 0 ? `
  <div class="loqate-title">
    <svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="8" fill="#185FA5"/><text x="8" y="12" text-anchor="middle" fill="white" font-size="10" font-weight="bold" font-family="Arial">L</text></svg>
    Loqate address suggestions
    <span class="new-badge">New</span>
    <span class="count-note">${adrlineCount} of ${total} instruction${total > 1 ? 's' : ''} contain AdrLine</span>
  </div>
  <div class="loq-banner">
    <svg width="16" height="16" viewBox="0 0 18 18" style="flex-shrink:0;margin-top:1px"><circle cx="9" cy="9" r="9" fill="#185FA5"/><text x="9" y="13" text-anchor="middle" fill="white" font-size="10" font-weight="bold" font-family="Arial">i</text></svg>
    <div class="loq-banner-text">
      <strong>${adrlineCount} instruction${adrlineCount > 1 ? 's' : ''} flagged for unstructured address</strong>
      HSBC has automatically parsed each AdrLine using Loqate. Review the suggested structured fields &mdash; expand each instruction to see the comparison and copy the corrected XML before resubmitting.
    </div>
  </div>
  ${filterBar}` : `
  <div style="width:calc(100% - 80px);margin:0 40px;background:#E1F5EE;border-left:4px solid #00847f;padding:11px 14px;font-size:13px;color:#085041">
    <strong>No AdrLine detected.</strong> All instructions use structured creditor addresses. No Loqate parsing required.
  </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/><title>HSBC Validation Report &mdash; ${escHtml(fileInfo.fileRef)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,sans-serif;background:#fff;color:#1a1a1a;font-size:14px}
.page{width:900px;margin:0 auto;padding:40px 0 60px}
.header-band{background:#DB0011;padding:14px 40px;display:flex;align-items:center;justify-content:space-between;margin-bottom:32px}
.header-band .brand{color:white;font-size:20px;font-weight:700;letter-spacing:1px}
.header-band .rl{color:rgba(255,255,255,0.85);font-size:12px;display:flex;align-items:center;gap:12px}
.dl-btn{background:white;color:#DB0011;border:none;padding:5px 14px;font-size:12px;font-weight:700;border-radius:4px;cursor:pointer}
.dl-btn:hover{background:#f0f0f0}
.status-bar{display:flex;align-items:center;gap:14px;padding:0 40px;margin-bottom:20px}
.status-title{font-size:18px;font-weight:700}
.status-sub{font-size:13px;color:#555;margin-top:3px}
.levels{padding:0 40px 0 54px;margin-bottom:20px;border-left:4px solid #ddd;margin-left:40px}
.level-row{display:flex;align-items:center;gap:8px;font-size:15px;font-weight:600;margin-bottom:5px}
hr.divider{border:none;border-top:1px solid #ddd;margin:20px 40px}
.section-title{font-size:13px;font-weight:600;color:#555;text-transform:uppercase;letter-spacing:0.05em;margin:24px 40px 12px}
.gen-table{width:calc(100% - 80px);margin:0 40px;border-collapse:collapse}
.gen-table td{padding:5px 20px 5px 0;font-size:13px;vertical-align:top}
.gen-label{font-weight:600;color:#222;white-space:nowrap;width:180px}
.gen-val{color:#444}
.info-grid{width:calc(100% - 80px);margin:0 40px;display:grid;grid-template-columns:1fr 1fr}
.info-head{background:#E4E8EA;padding:9px 14px;font-weight:600;font-size:13px}
.info-head:first-child{border-right:1px solid white}
.info-cell{padding:9px 14px;font-size:13px;border-bottom:1px solid #ddd}
.info-cell:first-child{border-right:1px solid #ddd}
.sum-bar{width:calc(100% - 80px);margin:0 40px;background:#EDEDED;padding:12px 16px;font-size:14px;font-weight:600;display:flex;gap:40px}
.sum-pair span:last-child{font-weight:400;color:#555;margin-left:6px}
table.err{width:calc(100% - 80px);margin:10px 40px 0;border-collapse:collapse;font-size:12px}
table.err th{background:#E4E8EA;padding:9px 10px;font-weight:600;text-align:left;border-bottom:1px solid #ccc}
table.err td{padding:9px 10px;border-bottom:1px solid #ddd;vertical-align:top}
.loqate-title{font-size:13px;font-weight:700;color:#185FA5;margin:24px 40px 10px;display:flex;align-items:center;gap:8px}
.new-badge{font-size:10px;font-weight:600;background:#E6F1FB;color:#0C447C;border-radius:4px;padding:2px 8px}
.count-note{font-size:11px;font-weight:400;color:#666}
.loq-banner{width:calc(100% - 80px);margin:0 40px 14px;background:#E6F1FB;border-left:4px solid #185FA5;padding:11px 14px;display:flex;gap:10px}
.loq-banner-text{font-size:12px;color:#0C447C;line-height:1.55}
.loq-banner-text strong{display:block;font-size:13px;margin-bottom:2px}
.filter-bar{width:calc(100% - 80px);margin:0 40px 12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.filt-btn{font-size:11px;padding:4px 12px;border-radius:4px;border:1px solid #bbb;background:white;color:#555;cursor:pointer}
.filt-btn.active{background:#185FA5;color:white;border-color:#185FA5}
.stat-chips{display:flex;gap:8px;margin-left:auto}
.chip{font-size:10px;padding:3px 9px;border-radius:10px;font-weight:600}
.chip-h{background:#E1F5EE;color:#085041}
.chip-m{background:#FAEEDA;color:#633806}
.instr-card{width:calc(100% - 80px);margin:0 40px 12px;border:1px solid #ddd;border-radius:8px;overflow:hidden;background:white}
.ic-header{background:#F5F7F8;padding:11px 14px;display:flex;align-items:center;justify-content:space-between;cursor:pointer;user-select:none;border-bottom:1px solid #eee}
.ic-header:hover{background:#ECEEF0}
.ic-left{display:flex;align-items:center;gap:10px}
.ic-id{font-size:13px;font-weight:700;color:#222}
.ic-creditor{font-size:12px;color:#666}
.ic-right{display:flex;align-items:center;gap:10px}
.badge{font-size:10px;padding:2px 8px;border-radius:4px;font-weight:600}
.b-adr{background:#FAEEDA;color:#633806}
.b-ok{background:#E1F5EE;color:#085041}
.conf-pill{font-size:11px;display:flex;align-items:center;gap:4px}
.cdot{width:8px;height:8px;border-radius:50%;display:inline-block}
.c-high{background:#1D9E75}.c-med{background:#EF9F27}.c-low{background:#E24B4A}
.chevron{font-size:11px;color:#888;transition:transform 0.2s;display:inline-block}
.chevron.open{transform:rotate(180deg)}
.tab-row{display:flex;border-bottom:1px solid #ddd;padding:0 14px}
.tab{padding:8px 14px;font-size:12px;cursor:pointer;border-bottom:2px solid transparent;color:#777}
.tab.active{border-bottom-color:#185FA5;color:#185FA5;font-weight:600}
.ic-body{display:grid;grid-template-columns:1fr 1fr}
.ic-col{padding:14px}
.ic-col:first-child{border-right:1px solid #eee}
.col-title{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#888;margin-bottom:8px}
.col-title.parsed{color:#085041}
.arow{display:flex;gap:8px;margin-bottom:5px;font-size:12px}
.atag{flex-shrink:0;min-width:72px;color:#888;font-size:11px;font-family:monospace}
.aval{color:#222}.aval.miss{color:#A32D2D;font-style:italic}.aval.parsed{color:#0F6E56;font-weight:600}
.atag.removed{text-decoration:line-through;color:#A32D2D}
.warn-box{background:#FAEEDA;border-radius:4px;padding:6px 8px;margin-bottom:8px;font-size:11px;color:#633806}
.xml-block{padding:14px;background:#F5F7F8;font-family:monospace;white-space:pre;overflow-x:auto;border-top:1px solid #eee;line-height:1.6;font-size:11px;color:#222}
.xml-tag{color:#185FA5;font-weight:700}.xml-green{color:#0F6E56}
.ic-foot{border-top:1px solid #eee;padding:9px 14px;display:flex;align-items:center;justify-content:space-between;background:#FAFAFA}
.ic-foot-msg{font-size:11px;color:#888}
.btn-row{display:flex;gap:6px}
.cbtn{font-size:11px;border:1px solid #bbb;background:white;color:#222;padding:4px 12px;border-radius:4px;cursor:pointer}
.cbtn:hover{background:#f0f0f0}
.no-loqate{padding:12px 14px;font-size:12px;color:#555;display:flex;align-items:center;gap:8px;background:#F9FFF9;border-bottom:1px solid #eee}
.compliant-center{display:flex;align-items:center;justify-content:center;flex-direction:column;gap:6px;color:#555;font-size:12px}
.disclaimer{width:calc(100% - 80px);margin:8px 40px;font-size:10px;color:#888;line-height:1.5}
.footer-band{background:#F5F7F8;border-top:1px solid #ddd;padding:14px 40px;display:flex;justify-content:space-between;align-items:center}
.footer-band span{font-size:11px;color:#888}
@media print{.filt-btn,.cbtn,.dl-btn{-webkit-print-color-adjust:exact;print-color-adjust:exact}[id^="body-"]{display:block!important}.ic-body{display:grid!important}}
</style>
</head>
<body>
<div class="header-band">
  <div class="brand">HSBC</div>
  <div class="rl">
    <span>File Validation Report &nbsp;|&nbsp; develop.hsbc.com &nbsp;|&nbsp; Generated: ${new Date().toISOString().replace('T',' ').slice(0,19)} UTC</span>
    <button class="dl-btn" onclick="downloadReport()">&#8595; Download report</button>
  </div>
</div>
<div class="page">
  <div class="status-bar">
    <svg width="36" height="36" viewBox="0 0 18 18"><circle cx="9" cy="9" r="9" fill="#fb3"/><path d="M9,11.8A1.2,1.2,0,1,1,7.8,13,1.2,1.2,0,0,1,9,11.8Zm-.9-2H9.9v-6H8.1Z"/></svg>
    <div><div class="status-title">File validation report &mdash; including future ISO validation</div><div class="status-sub">Validation completed successfully</div></div>
  </div>
  <div class="levels">
    <div class="level-row"><svg width="15" height="15" viewBox="0 0 18 18"><circle cx="9" cy="9" r="9" fill="#00847f"/><polygon points="7.22 13.55 3.59 9.92 4.86 8.65 7.22 11.01 13.14 5.08 14.41 6.36 7.22 13.55" fill="#fff"/></svg>File level &mdash; Accepted</div>
    <div class="level-row"><svg width="15" height="15" viewBox="0 0 18 18"><path fill="#a8000b" d="M8.31,1.68.11,15.8A.8.8,0,0,0,.8,17H17.2a.8.8,0,0,0,.69-1.2L9.69,1.68A.8.8,0,0,0,8.31,1.68Z"/><path fill="#fff" d="M8.1,5H9.9v6H8.1Zm-.35,8.58A1.25,1.25,0,1,0,9,12.33,1.25,1.25,0,0,0,7.75,13.58Z"/></svg>Instruction level &mdash; ${rejected > 0 ? (accepted > 0 ? 'Partially rejected' : 'Rejected') : 'Accepted'}</div>
  </div>
  <hr class="divider"/>
  <div class="section-title">General information</div>
  <table class="gen-table">
    <tr><td class="gen-label">File name</td><td class="gen-val">${escHtml(fileName)}</td><td class="gen-label">Submission date time</td><td class="gen-val">${escHtml(submitDt)}</td></tr>
    <tr><td class="gen-label">File format</td><td class="gen-val">XML V3 &ndash; PAIN.001.001.03</td><td class="gen-label">File reference</td><td class="gen-val">${escHtml(fileInfo.fileRef)}</td></tr>
    <tr><td class="gen-label">Total transactions</td><td class="gen-val">${escHtml(fileInfo.nbOfTxs)}</td><td class="gen-label">Control sum</td><td class="gen-val">${escHtml(fileInfo.ctrlSum)}</td></tr>
  </table>
  <hr class="divider"/>
  <div class="section-title">Validation summary</div>
  <div class="sum-bar">
    <div class="sum-pair"><span>Total instructions</span><span>${total}</span></div>
    <div class="sum-pair"><span>Accepted</span><span>${accepted}</span></div>
    <div class="sum-pair"><span>Rejected</span><span>${rejected}</span></div>
  </div>
  ${adrlineCount > 0 ? `
  <table class="err">
    <thead><tr><th style="width:13%">Error code</th><th style="width:53%">Error message</th><th style="width:18%">ISO error code (v3)</th><th style="width:10%">Count</th></tr></thead>
    <tr><td>071203 <span style="color:orange;font-weight:700">*</span></td><td>Town-Name, Country-Code are mandatory to be provided for Creditor</td><td>N/A</td><td>${adrlineCount * 2}</td></tr>
    <tr><td colspan="4" style="font-size:11px;color:orange;font-weight:600;border:none">* Future ISO validation, currently not in live environment.</td></tr>
  </table>` : ''}
  <hr class="divider"/>
  ${loqateSection}
  ${cards}
  ${adrlineCount > 0 ? `<div class="disclaimer">Parsed by Loqate &middot; Powered by GBG &middot; Always verify suggestions before resubmitting. HSBC is not liable for parsed address accuracy.</div>` : ''}
</div>
<div class="footer-band">
  <span>HSBC File Validator &middot; develop.hsbc.com</span>
  <span>Report generated: ${new Date().toISOString().replace('T',' ').slice(0,19)} UTC &middot; File ref: ${escHtml(fileInfo.fileRef)}</span>
  <span>&copy; HSBC Holdings plc. Confidential.</span>
</div>
${demoBanner}
<script>
function toggleCard(id){var b=document.getElementById('body-'+id),c=document.getElementById('chev-'+id),h=b.style.display==='none'||b.style.display==='';b.style.display=h?'block':'none';c.className='chevron'+(h?' open':'');}
function switchTab(card,pane){var cmp=document.getElementById('pane-'+card+'-cmp'),xml=document.getElementById('pane-'+card+'-xml'),tc=document.getElementById('tab-'+card+'-cmp'),tx=document.getElementById('tab-'+card+'-xml');if(pane==='cmp'){cmp.style.display='grid';xml.style.display='none';tc.className='tab active';tx.className='tab';}else{cmp.style.display='none';xml.style.display='block';tc.className='tab';tx.className='tab active';}}
function filterCards(type,btn){document.querySelectorAll('.filt-btn').forEach(b=>b.classList.remove('active'));btn.classList.add('active');document.querySelectorAll('.instr-card').forEach(card=>{card.style.display=(type==='all'||card.dataset.type===type)?'':'none';});}
function doCopy(btn,id){var t=document.getElementById(id);navigator.clipboard.writeText(t.value).then(function(){btn.textContent='\u2713 Copied';setTimeout(function(){btn.textContent='Copy XML';},1500);});}
function downloadReport(){var html=document.documentElement.outerHTML,blob=new Blob([html],{type:'text/html'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='HSBC_Validation_${escHtml(fileInfo.fileRef)}_${new Date().toISOString().slice(0,10).replace(/-/g,'')}.html';a.click();}
</script>
</body>
</html>`;
}

// ─── ROUTES ──────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.send(fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8'));
});

app.post('/validate', upload.single('paymentFile'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).send('No file uploaded.');

    const fileName = req.file.originalname;
    const submitDt = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

    const { fileRef, creDtTm, nbOfTxs, ctrlSum, instructions } = await parsePain001(req.file.buffer);
    await enrichInstructions(instructions);

    const html = renderReport({ fileRef, creDtTm, nbOfTxs, ctrlSum }, instructions, fileName, submitDt);
    res.send(html);

  } catch (err) {
    console.error(err);
    res.status(500).send(`<pre style="font-family:monospace;padding:20px">Error processing file:\n${err.message}\n\n${err.stack}</pre>`);
  }
});

app.listen(PORT, () => {
  const isDemoMode = LOQATE_API_KEY === 'YOUR_LOQATE_API_KEY';
  console.log(`\nHSBC File Validator running at http://localhost:${PORT}`);
  if (isDemoMode) {
    console.log('Running in DEMO mode (no Loqate API key set).');
    console.log('Set LOQATE_API_KEY=your_key to enable live Loqate parsing.\n');
  } else {
    console.log('Loqate API key configured. Live parsing enabled.\n');
  }
});
