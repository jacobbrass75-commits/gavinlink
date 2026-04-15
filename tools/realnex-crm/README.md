# RealNex CRM Client

Python client for the RealNex Sync API (`https://sync.realnex.com`).

Any bulk exports or contact dumps produced with this client should live under an ignored local artifact path such as `tools/realnex-crm/artifacts/`, not in the committed repo.

## Auth

Bearer JWT token from RealNex User Management. Set as environment variable:

```bash
export REALNEX_API_TOKEN="your_jwt_token"
```

## Important Notes

- **Must use `urllib.request`**, NOT the `requests` library. The `requests` library returns 401 on all RealNex endpoints due to header handling differences.
- OData pagination max is **50 records per page** (`$top=50`). Requesting `$top > 100` returns 400 Bad Request.
- The API returns 50 records even if you request `$top=100`.

## Endpoints

### OData (bulk read)
- `GET /api/v1/CrmOData/Contacts?$top=50&$skip=0`
- `GET /api/v1/CrmOData/Properties?$top=50&$skip=0`
- `GET /api/v1/CrmOData/Companies?$top=50&$skip=0`
- `GET /api/v1/CrmOData/Projects?$top=50&$skip=0`
- `GET /api/v1/CrmOData/SaleComps?$top=50&$skip=0`
- `GET /api/v1/CrmOData/LeaseComps?$top=50&$skip=0`
- `GET /api/v1/CrmOData/Spaces?$top=50&$skip=0`

Count: `GET /api/v1/CrmOData/Contacts?$count=true&$top=0`

### CRUD
- Contacts: `/api/v1/Crm/contact/{key}` (GET/PUT/POST/DELETE)
- Properties: `/api/v1/Crm/property/{key}` (GET/PUT/POST/DELETE)
- Companies: `/api/v1/Crm/company/{key}` (GET/PUT/POST)
- Projects: `/api/v1/Crm/project/{key}` (GET/PUT/POST)
- Events: `/api/v1/Crm/event/{key}` (GET/PUT/POST)

### Contact Fields
`Key`, `FullName`, `FirstName`, `LastName`, `Salutation`, `Greeting`, `Title`, `Investor`, `Tenant`, `Agent`, `Vendor`, `Personal`, `Prospect`, `Work`, `Fax`, `Mobile`, `Home`, `Email`, `WebSite`, `DoNotCall`, `DoNotEmail`, `DoNotFax`, `DoNotMail`, `UserKey`, `TeamKey`, `Address`, `MailingAddress`, `LastActivity`, `ObjectGroups`

## Usage

```python
import os
from realnex_client import RealNexClient

client = RealNexClient(token=os.environ["REALNEX_API_TOKEN"])

# Count
print(client.count_contacts())  # 33786

# Iterate all contacts
for contact in client.iter_all_contacts():
    print(contact["FullName"], contact["Email"])

# Single contact
contact = client.get_contact("some-uuid-key")
full = client.get_contact_full("some-uuid-key")
```
