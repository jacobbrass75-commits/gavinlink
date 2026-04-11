"""
Import LLC manager contacts into RealNex CRM.
Skips contacts already in the CRM (by name or email).
Deduplicates managers that appear across multiple LLCs.
"""
import json
import sys
import os
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'realnex-crm'))
from realnex_client import RealNexClient

TOKEN = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI0ZDlkNDllZC1lNWUzLTQ2MmItOGFjMS04NTE0Y2YwYzY2NjE6N2VjYTEwYTEtZjI3MC00NTI5LTlkNGEtOWU2YmE3OGU5OGYxIiwiYWNjb3VudF9rZXkiOiI0ZDlkNDllZC1lNWUzLTQ2MmItOGFjMS04NTE0Y2YwYzY2NjEiLCJ1c2VyX2tleSI6IjdlY2ExMGExLWYyNzAtNDUyOS05ZDRhLTllNmJhNzhlOThmMSIsIm5hbWUiOiJNYXR0aGV3IFN1bGxpdmFuIiwiZW1haWwiOiJtYXR0aGV3LnN1bGxpdmFuQGxlZS1hc3NvY2lhdGVzLmNvbSIsImlhdCI6MTc3NTg0MDExMCwiZXhwIjoyMTQ3NDcyMDAwfQ.NL9ECmJlohYd-eqWn2jUBEW4gn_MSt8iSasnS-ZfRJ0"

PROGRESS_PATH = os.path.join(os.path.dirname(__file__), "llc_manager_progress.json")
CRM_DUMP_PATH = os.path.join(os.path.dirname(__file__), "..", "realnex-crm", "realnex_all_contacts.json")


def parse_name(full_name):
    """Split full name into first and last, handling middle names and suffixes."""
    parts = full_name.strip().split()
    if not parts:
        return "", ""
    if len(parts) == 1:
        return parts[0].title(), ""

    # Handle suffixes like II, III, Jr, Sr
    suffixes = {"ii", "iii", "iv", "jr", "jr.", "sr", "sr."}
    clean = [p for p in parts if p.lower() not in suffixes]
    if not clean:
        clean = parts

    first = clean[0].title()
    last = clean[-1].title() if len(clean) > 1 else ""
    return first, last


def format_phone(phone):
    """Format phone as +1 (xxx) xxx-xxxx."""
    digits = ''.join(c for c in str(phone) if c.isdigit())
    if len(digits) == 11 and digits[0] == '1':
        digits = digits[1:]
    if len(digits) == 10:
        return f"+1 ({digits[:3]}) {digits[3:6]}-{digits[6:]}"
    return phone


def main():
    # Load existing CRM contacts for dedup
    print("Loading existing CRM contacts...")
    with open(CRM_DUMP_PATH) as f:
        crm_contacts = json.load(f)

    crm_names = set()
    crm_emails = set()
    for c in crm_contacts:
        fn = (c.get('FullName') or '').strip().lower()
        if fn:
            crm_names.add(fn)
        em = (c.get('Email') or '').strip().lower()
        if em:
            crm_emails.add(em)
    print(f"  {len(crm_names)} names, {len(crm_emails)} emails in CRM")

    # Load managers from progress
    print("Loading manager progress...")
    with open(PROGRESS_PATH) as f:
        progress = json.load(f)

    # Build list of contacts to add (deduped)
    seen = set()
    to_add = []
    for llc, info in progress.items():
        for m in info.get('managers', []):
            name = m['name'].strip()
            name_lower = name.lower()
            email = (m.get('email') or '').strip().lower()
            phone = m.get('phone', '')
            email_source = m.get('email_source', '')

            if not email and not phone:
                continue
            if name_lower in crm_names or (email and email in crm_emails):
                continue
            if name_lower in seen:
                continue
            seen.add(name_lower)

            to_add.append({
                'name': name,
                'email': email,
                'phone': phone,
                'email_source': email_source,
                'llc': llc,
            })

    print(f"  {len(to_add)} new contacts to add")

    # Connect to CRM
    client = RealNexClient(TOKEN)
    # Quick auth check
    try:
        count = client.count_contacts()
        print(f"  CRM connected - {count} existing contacts")
    except Exception as e:
        print(f"  CRM auth failed: {e}")
        sys.exit(1)

    # Import contacts
    added = 0
    failed = 0
    for i, mgr in enumerate(to_add):
        first, last = parse_name(mgr['name'])
        if not first and not last:
            continue

        contact_data = {
            "FirstName": first,
            "LastName": last,
            "Prospect": True,
        }

        if mgr['email']:
            contact_data["Email"] = mgr['email']

        if mgr['phone']:
            contact_data["Work"] = format_phone(mgr['phone'])

        # Put LLC name in Title field so it's visible in CRM
        contact_data["Title"] = f"Manager - {mgr['llc']}"

        try:
            result = client.create_contact(contact_data)
            added += 1
            if (i + 1) % 25 == 0 or i == 0:
                print(f"  [{i+1}/{len(to_add)}] Added {first} {last} | {mgr['email']} | {added} total")
        except Exception as e:
            failed += 1
            err = str(e)
            if '429' in err or 'rate' in err.lower():
                print(f"  [{i+1}] Rate limited - waiting 10s...")
                time.sleep(10)
                try:
                    result = client.create_contact(contact_data)
                    added += 1
                    failed -= 1
                except Exception as e2:
                    print(f"  [{i+1}] Retry failed: {e2}")
            elif '401' in err:
                print(f"  AUTH EXPIRED at contact {i+1}. Added {added} so far.")
                sys.exit(1)
            else:
                print(f"  [{i+1}] Failed {first} {last}: {e}")

        # Small delay to avoid rate limits
        if (i + 1) % 50 == 0:
            time.sleep(1)

    print(f"\nDone! Added {added}, failed {failed}, total attempted {len(to_add)}")


if __name__ == "__main__":
    main()
