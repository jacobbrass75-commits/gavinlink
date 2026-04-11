# Property Manager Finder

Finds managing members of LLC property owners and their contact info using free public sources. No paid APIs required.

## Pipeline

1. **SOS Lookup** - Searches CA Secretary of State for each LLC, downloads Statement of Information PDFs, extracts Manager/Member names
2. **CRM Cross-Reference** (optional) - Matches managers against a RealNex CRM contact dump
3. **Contact Search** - Searches Bing, Yahoo, and scrapes result pages for email, phone, and LinkedIn
4. **Excel Export** - Generates a spreadsheet with contact info, properties, and mailing addresses

## Requirements

```bash
pip install requests beautifulsoup4 openpyxl pypdf dnspython
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

### SMTP Email Guesser (the big one)
```bash
# Find emails via SMTP verification - 98% hit rate
python3 smtp_guesser.py --progress progress.json --workers 8
```

### Contact Intelligence Engine
```bash
# Full pipeline: deep search + LinkedIn + SMTP + email hunt
python3 contact_engine.py --progress progress.json --workers 6

# Run specific phases
python3 contact_engine.py --progress progress.json --phase search   # 4-engine web search
python3 contact_engine.py --progress progress.json --phase emails   # email-focused hunt
python3 contact_engine.py --progress progress.json --phase linkedin # LinkedIn employer discovery
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

### Contact Search (finder.py)
- 6 Bing query variations per person (LinkedIn, Zillow, LoopNet, property records)
- Yahoo fallback
- Scrapes top result pages for emails and phone numbers
- Filters junk emails/phones (template numbers, generic addresses)

### Contact Intelligence Engine (contact_engine.py)
- Multi-phase pipeline comparable to RocketReach
- 4 search engines in parallel (Bing, DuckDuckGo, Yahoo, Brave)
- 8 query variations per person per engine
- LinkedIn profile discovery + employer extraction
- Website scraping (contact/about/team pages)
- Email scoring: prefers emails where local part contains person's name
- Junk filtering: date-like phones, toll-free numbers, template emails

### SMTP Email Guesser (smtp_guesser.py)
- **The killer feature**: generates email permutations and verifies via SMTP
- Connects to mail servers and checks if `firstname.lastname@gmail.com` etc. exist
- No mail is sent - just RCPT TO verification
- Catch-all domain detection to avoid false positives
- Name commonness filtering (flags common names like "John Smith" as low confidence)
- 98% hit rate on Gmail, finds ~600 emails in ~10 minutes
- 9 email patterns per person: first.last@, flast@, first@, f.last@, first_last@, etc.

### Anti-Detection
- **Safari mode**: Uses real Safari browser via AppleScript
- **Playwright mode**: Headed browser + xvfb virtual display bypasses Incapsula WAF on SOS site
- Removes `navigator.webdriver` flag
- Real browser user agents and viewports

## Performance

| Mode | Speed | Notes |
|------|-------|-------|
| Safari SOS (4 tabs) | ~15 LLCs/min | macOS only |
| Playwright SOS (6 browsers) | ~20 LLCs/min | Linux + xvfb |
| Contact search (4 threads) | ~30 managers/min | Bing/Yahoo |
| SMTP guesser (6 workers) | ~75 managers/min | Gmail/Yahoo/Outlook verify |
| Contact engine (6 threads) | ~10 managers/min | Full 4-engine deep search |

Tested on 1,735 LLCs: found managers for 988 (57%), contact info for 1,174/1,270 managers (92%).
