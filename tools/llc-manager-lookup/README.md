# LLC Manager Lookup Tool

Automated pipeline to find **managing members** (not just registered agents) for California LLCs, then find their contact info.

## How It Works

### Step 1: Manager Lookup (`sos_manager_lookup.py`)
- Automates Safari to search the CA Secretary of State (bizfileonline.sos.ca.gov)
- For each LLC: searches → clicks entity → opens filing history → downloads Statement of Information PDF → extracts **Manager/Member names** from the PDF
- Uses 2 parallel Safari tabs
- Saves progress to JSON (resumable)

### Step 2: Contact Lookup (`contact_lookup.py` / `contact_google.py`)
- `contact_lookup.py`: RocketReach API → DuckDuckGo → Google via Safari (3-tier)
- `contact_google.py`: Google via Safari only (when RocketReach is rate-limited)
- Finds email, phone, LinkedIn for each manager

## Requirements

- macOS with Safari
- Safari > Develop > Allow JavaScript from Apple Events (must be enabled)
- Python 3 with: `pypdf`, `requests`, `beautifulsoup4`, `openpyxl`
- Environment variable: `ROCKETREACH_API_KEY` (for RocketReach lookups)

## Input

CSV file with columns: `Owner Name`, `Site Address`, `Site Address City`, `Mail Address`, `Mail Address City`, `Number of Units`

## Output

Excel file with two sheets:
- **With Contact Info**: Only managers where email or phone was found
- **All Managers**: Every manager extracted from SOS filings

## Usage

```bash
# Step 1: Collect all manager names (no contact lookup)
python3 sos_manager_lookup.py --no-contact

# Step 2: Find contacts
python3 contact_google.py

# Or with RocketReach + DDG + Google:
python3 contact_lookup.py
```

Paths are configured at the top of each script.
