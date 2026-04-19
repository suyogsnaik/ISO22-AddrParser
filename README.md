# HSBC File Validator — Loqate Address Parsing
## Local Deployment Guide

---

### Prerequisites

- **Node.js 18+** — download from https://nodejs.org
- A terminal / command prompt

---

### Quick Start (3 steps)

**1. Install dependencies**
```bash
cd hsbc-file-validator-loqate
npm install
```

**2. (Optional) Set your Loqate API key**

Without a key, the server runs in **demo mode** — address parsing is simulated.

On macOS / Linux:
```bash
export LOQATE_API_KEY=your_actual_key_here
```

On Windows (Command Prompt):
```cmd
set LOQATE_API_KEY=your_actual_key_here
```

On Windows (PowerShell):
```powershell
$env:LOQATE_API_KEY="your_actual_key_here"
```

**3. Start the server**
```bash
npm start
```

Open your browser at **http://localhost:3000**

---

### Usage

1. Browse to http://localhost:3000
2. Upload a PAIN.001.001.03 XML file
3. The server validates the file, detects AdrLine, calls Loqate (or simulates), and returns the HTML report
4. In the report, expand any AdrLine instruction to see the parsed structured address
5. Switch to the **XML snippet** tab to get a ready-to-use `<PstlAdr>` block
6. Click **Copy XML** to copy it to your clipboard
7. Click **Download report** (top right of report) to save the full HTML locally

---

### File Structure

```
hsbc-file-validator-loqate/
├── server.js          ← Express server (validation + Loqate integration + report generation)
├── package.json       ← Dependencies
├── README.md          ← This file
└── public/
    └── index.html     ← Upload UI
```

---

### Configuration

| Environment variable | Default                | Description                          |
|---------------------|------------------------|--------------------------------------|
| `LOQATE_API_KEY`    | `YOUR_LOQATE_API_KEY`  | Your Loqate API key (leave blank for demo mode) |
| `PORT`              | `3000`                 | Port the server listens on           |

---

### Demo Mode

If `LOQATE_API_KEY` is not set or is left as `YOUR_LOQATE_API_KEY`, the server runs in **demo mode**.

In demo mode:
- Address parsing is performed by a local heuristic (regex-based postcode/city extraction)
- Results are labelled **DEMO** in the report footer
- All other functionality (filtering, XML snippet, download) works identically
- A yellow banner appears on the upload page and in the report

---

### Supported Input Format

- **File type:** PAIN.001.001.03 XML (`.xml`, `.txt`, or `.pain001`)
- **Max file size:** 10 MB
- **Encoding:** UTF-8

The server parses the XML, finds all `CdtTrfTxInf/Cdtr/PstlAdr` blocks, and checks for `AdrLine` elements in each.

---

### Stopping the Server

Press `Ctrl+C` in the terminal window.

---

### Troubleshooting

| Problem | Solution |
|---------|----------|
| `Error: Cannot find module 'express'` | Run `npm install` first |
| Port 3000 already in use | Set `PORT=3001 npm start` |
| XML parse error | Ensure file is valid PAIN.001.001.03 XML with UTF-8 encoding |
| Loqate returns no result | Check API key; confirm address text contains recognisable postal data |

---

### Security Notes for Production Deployment

- **Never commit** your `LOQATE_API_KEY` to source control
- Use a secrets manager (HashiCorp Vault, AWS Secrets Manager, Azure Key Vault) for the API key
- Enforce HTTPS with a reverse proxy (nginx / Caddy) in front of this Express server
- Add rate limiting (e.g. express-rate-limit) before exposing to external customers
- Complete the DTIA with GBG/Loqate before processing real customer payment data

---

*HSBC Holdings plc © 2026 — For internal use only*
