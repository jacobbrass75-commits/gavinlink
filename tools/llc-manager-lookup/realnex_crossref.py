#!/usr/bin/env python3
"""
Cross-reference LLC managers against RealNex CRM contacts.
Pulls all contacts via OData pagination (50/page max) then fuzzy-matches
against manager names in the progress JSON.
"""
import urllib.request
import ssl
import json
import os
import time

PROGRESS_PATH = os.environ.get("PROGRESS_PATH", "llc_manager_progress.json")
REALNEX_TOKEN = os.environ.get("REALNEX_API_TOKEN", "")
REALNEX_BASE = os.environ.get("REALNEX_BASE_URL", "https://sync.realnex.com")
CONTACTS_CACHE = os.environ.get("CONTACTS_CACHE", "realnex_all_contacts.json")
PAGE_SIZE = 50  # RealNex OData max


def fetch_all_contacts(token, base_url=REALNEX_BASE):
    """Pull every contact from RealNex CRM via OData pagination."""
    ctx = ssl.create_default_context()
    all_contacts = []
    skip = 0

    # Get total count first
    count_url = f"{base_url}/api/v1/CrmOData/Contacts?$count=true&$top=0"
    req = urllib.request.Request(count_url, method="GET", headers={
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
    })
    resp = urllib.request.urlopen(req, timeout=30, context=ctx)
    data = json.loads(resp.read().decode())
    total = data.get("@odata.count", 0)
    print(f"RealNex CRM has {total} contacts")

    while skip < total:
        url = f"{base_url}/api/v1/CrmOData/Contacts?$top={PAGE_SIZE}&$skip={skip}"
        req = urllib.request.Request(url, method="GET", headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
        })
        for attempt in range(3):
            try:
                resp = urllib.request.urlopen(req, timeout=60, context=ctx)
                records = json.loads(resp.read().decode()).get("value", [])
                all_contacts.extend(records)
                break
            except Exception as e:
                if attempt < 2:
                    time.sleep(2)
                else:
                    print(f"  FAILED at skip={skip}: {e}")
                    records = []

        skip += PAGE_SIZE
        if len(all_contacts) % 500 == 0:
            print(f"  {len(all_contacts)}/{total}")

    print(f"Pulled {len(all_contacts)} contacts")
    return all_contacts


def build_name_index(contacts):
    """Index CRM contacts by last name for fuzzy matching."""
    by_last = {}
    for c in contacts:
        last = (c.get("LastName") or "").strip().lower()
        first = (c.get("FirstName") or "").strip().lower()
        full = (c.get("FullName") or "").strip().lower()
        email = (c.get("Email") or "").strip()
        phone = c.get("Work") or c.get("Mobile") or c.get("Home") or ""

        if not email and not phone:
            continue
        if not last:
            continue

        if last not in by_last:
            by_last[last] = []
        by_last[last].append({
            "first": first, "last": last, "full": full,
            "email": email, "phone": str(phone).strip(),
        })
    return by_last


def crossref_managers(progress, crm_index):
    """Match managers against CRM contacts by name similarity."""
    matches = 0
    updated = 0

    for llc_name, info in progress.items():
        for i, mgr in enumerate(info.get("managers", [])):
            if mgr.get("email") or mgr.get("phone"):
                continue

            mgr_name = (mgr.get("name") or "").strip()
            if not mgr_name or len(mgr_name.split()) < 2:
                continue

            parts = mgr_name.lower().split()
            mgr_last = parts[-1]
            mgr_first = parts[0]

            candidates = crm_index.get(mgr_last, [])
            for cand in candidates:
                if cand["first"] and mgr_first:
                    if (cand["first"] == mgr_first or
                        cand["first"].startswith(mgr_first[:3]) or
                        mgr_first.startswith(cand["first"][:3])):
                        matches += 1
                        if cand["email"] and not mgr.get("email"):
                            progress[llc_name]["managers"][i]["email"] = cand["email"]
                        if cand["phone"] and not mgr.get("phone"):
                            progress[llc_name]["managers"][i]["phone"] = cand["phone"]
                        updated += 1
                        print(f'  MATCH: {mgr_name} -> {cand["full"]} | {cand["email"]} | {cand["phone"]}')
                        break

    return matches, updated


def main():
    token = REALNEX_TOKEN
    if not token:
        print("Set REALNEX_API_TOKEN environment variable")
        return

    # Pull or load cached contacts
    if os.path.exists(CONTACTS_CACHE):
        print(f"Loading cached contacts from {CONTACTS_CACHE}")
        with open(CONTACTS_CACHE) as f:
            contacts = json.load(f)
        print(f"Loaded {len(contacts)} contacts from cache")
    else:
        contacts = fetch_all_contacts(token)
        with open(CONTACTS_CACHE, "w") as f:
            json.dump(contacts, f)
        print(f"Saved to {CONTACTS_CACHE}")

    # Build index and cross-reference
    crm_index = build_name_index(contacts)
    print(f"Indexed {sum(len(v) for v in crm_index.values())} contacts with contact info")

    with open(PROGRESS_PATH) as f:
        progress = json.load(f)

    print("\nCross-referencing managers...")
    matches, updated = crossref_managers(progress, crm_index)

    print(f"\nMatches: {matches}")
    print(f"Updated: {updated}")

    if updated > 0:
        with open(PROGRESS_PATH, "w") as f:
            json.dump(progress, f, indent=2)
        print("Progress saved.")


if __name__ == "__main__":
    main()
