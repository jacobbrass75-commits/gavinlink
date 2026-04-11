#!/usr/bin/env python3
"""
Build a clean mail-merge-ready contacts CSV from progress.json.
One row per unique broker with: name, email, company, phone, linkedin, source, roles.
"""
import json, csv
from collections import defaultdict

PROGRESS_PATH = "/Users/josephsullivan/Downloads/broker_lookup_progress.json"
INPUT_CSV = "/Users/josephsullivan/Downloads/CostarExport_MF Sales_2024-Present.xlsx - Export041026.csv"
OUTPUT_CSV = "/Users/josephsullivan/Downloads/CoStar_Broker_Contacts.csv"


def main():
    with open(PROGRESS_PATH) as f:
        progress = json.load(f)

    # Build broker → phones mapping from the original CSV
    broker_phones = defaultdict(set)
    broker_cities = defaultdict(set)
    broker_roles = defaultdict(set)
    broker_deals = defaultdict(int)
    with open(INPUT_CSV) as f:
        reader = csv.DictReader(f)
        for row in reader:
            fn = row.get('Listing Broker Agent First Name','').strip()
            ln = row.get('Listing Broker Agent Last Name','').strip()
            co = row.get('Listing Broker Company','').strip()
            if fn and ln:
                k = f"{fn}|{ln}|{co}"
                phone = row.get('Listing Broker Phone','').strip()
                if phone: broker_phones[k].add(phone)
                city = row.get('Listing Broker City','').strip()
                if city: broker_cities[k].add(city)
                broker_roles[k].add('Listing')
                broker_deals[k] += 1
            fn2 = row.get('Buyers Broker Agent First Name','').strip()
            ln2 = row.get('Buyers Broker Agent Last Name','').strip()
            co2 = row.get('Buyers Broker Company','').strip()
            if fn2 and ln2:
                k = f"{fn2}|{ln2}|{co2}"
                phone = row.get('Buyers Broker Phone','').strip()
                if phone: broker_phones[k].add(phone)
                city = row.get('Buyers Broker City','').strip()
                if city: broker_cities[k].add(city)
                broker_roles[k].add('Buyer')
                broker_deals[k] += 1

    # Write contacts CSV
    rows = []
    for key, info in progress.items():
        fn = info.get('first','')
        ln = info.get('last','')
        co = info.get('company','')
        email = info.get('email') or ''
        linkedin = info.get('linkedin') or ''
        rr_phone = info.get('phone') or ''
        csv_phones = ', '.join(sorted(broker_phones.get(key, set())))
        phone = rr_phone or csv_phones
        cities = ', '.join(sorted(broker_cities.get(key, set())))
        roles = ', '.join(sorted(broker_roles.get(key, set())))
        source = info.get('source') or ''
        deals = broker_deals.get(key, 0)
        rows.append({
            'First Name': fn,
            'Last Name': ln,
            'Full Name': f"{fn} {ln}",
            'Company': co,
            'Email': email,
            'Phone': phone,
            'LinkedIn': linkedin,
            'City': cities,
            'Role': roles,
            'Deals in Export': deals,
            'Email Source': source,
            'Has Email': 'Yes' if email else 'No',
        })

    # Sort: has-email first, then by deal count desc
    rows.sort(key=lambda r: (0 if r['Has Email'] == 'Yes' else 1, -r['Deals in Export'], r['Last Name']))

    with open(OUTPUT_CSV, 'w', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=[
            'First Name','Last Name','Full Name','Company','Email','Phone',
            'LinkedIn','City','Role','Deals in Export','Email Source','Has Email'
        ])
        writer.writeheader()
        for r in rows:
            writer.writerow(r)

    with_email = sum(1 for r in rows if r['Has Email'] == 'Yes')
    print(f"Wrote {len(rows)} unique brokers to {OUTPUT_CSV}")
    print(f"  With email:    {with_email}")
    print(f"  Without email: {len(rows) - with_email}")


if __name__ == '__main__':
    main()
