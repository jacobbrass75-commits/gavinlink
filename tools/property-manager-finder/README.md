# Property Manager Finder

Finds managing members of LLC property owners and their contact info using free public sources. No paid APIs required.

## Pipeline

1. **SOS Lookup** - Searches CA Secretary of State for each LLC, downloads Statement of Information PDFs, extracts Manager/Member names
2. **CRM Cross-Reference** (optional) - Matches managers against a RealNex CRM contact dump
3. **Contact Search** - Searches Bing, Yahoo, and scrapes result pages for email, phone, and LinkedIn
4. **Excel Export** - Generates a spreadsheet with contact info, properties, and mailing addresses

## Requirements

```bash
pip install requests beautifulsoup4 openpyxl pypdf
```

**macOS (Safari mode):** No extra deps - uses Safari via AppleScript for SOS lookup.

**Linux server (Playwright mode):**
```bash
pip install playwright
playwright install chromium
apt install xvfb
```

## Usage

### Full pipeline
```bash
python3 finder.py --csv "5+ unit farm.csv"
```

### With CRM cross-reference
```bash
python3 finder.py --csv "5+ unit farm.csv" --crm realnex_contacts.json
```

### Server mode (Linux with Playwright)
```bash
xvfb-run python3 finder.py --csv data.csv --sos-mode playwright
```

### Run specific steps
```bash
# Just SOS lookup
python3 finder.py --csv data.csv --step sos

# Just contact search (skip SOS)
python3 finder.py --csv data.csv --step contacts

# Just regenerate Excel
python3 finder.py --csv data.csv --step excel
```

### Custom workers and output
```bash
python3 finder.py --csv data.csv --workers 6 --output results.xlsx
```

## Input CSV Format

Requires these columns:
- `Owner Name` - LLC entity name
- `Site Address`, `Site Address City` - Property location
- `Mail Address`, `Mail Address City` - Mailing address
- `Number of Units` - Unit count (optional)

## Output

- **Progress JSON** - Auto-saved alongside CSV, tracks all lookups and contacts. Resumable.
- **Excel** - Three sheets:
  - *With Contact Info* - Managers that have email or phone
  - *All Managers* - Every manager found
  - *No Managers Found* - LLCs with no SOS filing

## How It Works

### SOS Lookup
- Navigates to bizfileonline.sos.ca.gov
- Searches for LLC name, clicks best match
- Opens filing history, expands most recent Statement of Information
- Downloads the PDF via in-browser fetch, extracts manager names with pypdf
- Filters out corporate entities, keeps person names only

### Contact Search
- 6 Bing query variations per person (LinkedIn, Zillow, LoopNet, property records)
- Yahoo fallback
- Scrapes top result pages for emails and phone numbers
- Filters junk emails/phones (template numbers, generic addresses)

### Anti-Detection
- **Safari mode**: Uses real Safari browser via AppleScript
- **Playwright mode**: Headed browser + xvfb virtual display bypasses Incapsula WAF on SOS site
- Removes `navigator.webdriver` flag
- Real browser user agents and viewports

## Performance

| Mode | SOS Speed | Contact Speed |
|------|-----------|---------------|
| Safari (4 tabs) | ~15 LLCs/min | N/A |
| Playwright (6 browsers) | ~20 LLCs/min | N/A |
| Contact search (4 threads) | N/A | ~30 managers/min |

Tested on 1,735 LLCs: found managers for 988 (57%), contact info for 1,082/1,270 managers (85%).
