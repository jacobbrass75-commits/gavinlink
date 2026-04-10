# LLC Manager Lookup Tool

Automated pipeline to find **managing members** (not just registered agents) for California LLCs, then find their contact info.

## How It Works

### Step 1: Manager Lookup (`sos_manager_lookup.py`)
- Automates Safari to search the CA Secretary of State (bizfileonline.sos.ca.gov)
- For each LLC: searches → clicks entity → opens filing history → downloads Statement of Information PDF → extracts **Manager/Member names** from the PDF
- Uses 2 parallel Safari tabs
- Saves progress to JSON (resumable)

### Step 2: Contact Lookup

Multiple scripts for different strategies:

- `contact_lookup.py`: RocketReach API → DuckDuckGo → Google via Safari (3-tier)
- `contact_google.py`: Google via Safari only (when RocketReach is rate-limited)
- `contact_multi.py`: RocketReach → Bing → Yahoo (pure HTTP, no Safari needed, 4 threads)
- `realnex_crossref.py`: Cross-reference managers against RealNex CRM contacts (33k+ contacts)

### Step 3 (optional): RealNex CRM Cross-Reference (`realnex_crossref.py`)
- Pulls all contacts from RealNex CRM via OData pagination
- Fuzzy-matches manager names against CRM contacts
- Fills in email/phone from existing CRM data before doing external lookups

## Requirements

- macOS with Safari (for SOS lookup and Google fallback)
- Safari > Develop > Allow JavaScript from Apple Events (must be enabled)
- Python 3 with: `pypdf`, `requests`, `beautifulsoup4`, `openpyxl`
- Environment variables:
  - `ROCKETREACH_API_KEY` — for RocketReach lookups (~15 searches/day, 3600 credits/period)
  - `REALNEX_API_TOKEN` — for CRM cross-reference (JWT from RealNex User Management)

## RocketReach Limits

- **Credits**: 3,600 per billing period (each lookup uses 1 credit)
- **Daily search cap**: ~15-20 person searches per day (separate from credits)
- When rate limited (HTTP 429), scripts auto-switch to web search fallback

## Input

CSV file with columns: `Owner Name`, `Site Address`, `Site Address City`, `Mail Address`, `Mail Address City`, `Number of Units`

## Output

Excel file with two sheets:
- **With Contact Info**: Only managers where email or phone was found
- **All Managers**: Every manager extracted from SOS filings

## Usage

```bash
# Step 1: Collect all manager names
python3 sos_manager_lookup.py --no-contact

# Step 2a: Cross-reference against RealNex CRM first (fast, free)
REALNEX_API_TOKEN="your_jwt" python3 realnex_crossref.py

# Step 2b: Find remaining contacts via RocketReach + Bing (no Safari needed)
ROCKETREACH_API_KEY="your_key" python3 contact_multi.py

# Step 2c: Google via Safari fallback (when other methods exhausted)
python3 contact_google.py
```

Paths are configured via environment variables or at the top of each script.
