#!/usr/bin/env python3
"""
Second-pass pattern fill for brokers missed by RocketReach/Bing.

Strategy:
1. Group brokers by company
2. For companies with ≥1 verified corporate email (not gmail/yahoo/etc),
   detect the corporate email pattern (first.last, flast, first, etc)
3. Apply the pattern to other brokers at the same company
4. Only apply when pattern consistency ≥70% (if >1 sample) OR ≥1 sample with corporate domain
5. Mark source as 'Pattern:{domain}' so we can distinguish from API-verified

Run after broker_email_lookup.py finishes.
"""
import json, re, csv
from collections import defaultdict

PROGRESS_PATH = "/Users/josephsullivan/Downloads/broker_lookup_progress.json"
INPUT_CSV = "/Users/josephsullivan/Downloads/CostarExport_MF Sales_2024-Present.xlsx - Export041026.csv"
OUTPUT_CSV = "/Users/josephsullivan/Downloads/CoStar_Brokers_With_Emails.csv"

PERSONAL_DOMAINS = {
    'gmail.com','yahoo.com','hotmail.com','aol.com','outlook.com',
    'sbcglobal.net','verizon.net','ca.rr.com','bellsouth.net',
    'earthlink.net','icloud.com','me.com','live.com','comcast.net',
    'msn.com','att.net','pacbell.net','cox.net','mac.com','mail.com',
    'protonmail.com','ymail.com','rocketmail.com','sbglobal.net',
}


def detect_pattern(first, last, email):
    """Return pattern type if email local-part matches a known name format."""
    if not email or '@' not in email:
        return None
    local = email.split('@')[0].lower()
    f_parts = first.lower().split()
    l_parts = last.lower().split()
    if not f_parts or not l_parts:
        return None
    f = f_parts[0]
    l = l_parts[-1]
    # Strip common punctuation from name parts
    f = re.sub(r'[^a-z]', '', f)
    l = re.sub(r'[^a-z]', '', l)
    if not f or not l:
        return None
    if local == f'{f}.{l}': return 'first.last'
    if local == f'{f}{l}': return 'firstlast'
    if local == f'{f[0]}{l}': return 'flast'
    if local == f'{f}.{l[0]}': return 'first.l'
    if local == f'{l}.{f}': return 'last.first'
    if local == f'{l}{f[0]}': return 'lastf'
    if local == f: return 'first'
    if local == l: return 'last'
    if local == f'{f}_{l}': return 'first_last'
    if local == f'{f}-{l}': return 'first-last'
    return None


def apply_pattern(first, last, pattern, domain):
    """Generate email from pattern for a new broker."""
    f_parts = first.lower().split()
    l_parts = last.lower().split()
    if not f_parts or not l_parts:
        return None
    f = re.sub(r'[^a-z]', '', f_parts[0])
    l = re.sub(r'[^a-z]', '', l_parts[-1])
    if not f or not l:
        return None
    formulas = {
        'first.last':  f'{f}.{l}',
        'firstlast':   f'{f}{l}',
        'flast':       f'{f[0]}{l}',
        'first.l':     f'{f}.{l[0]}',
        'last.first':  f'{l}.{f}',
        'lastf':       f'{l}{f[0]}',
        'first':       f'{f}',
        'last':        f'{l}',
        'first_last':  f'{f}_{l}',
        'first-last':  f'{f}-{l}',
    }
    local = formulas.get(pattern)
    if not local:
        return None
    return f'{local}@{domain}'


def main():
    with open(PROGRESS_PATH) as f:
        progress = json.load(f)

    # Group by company
    by_company = defaultdict(list)
    for key, info in progress.items():
        co = info.get('company', '').strip()
        if co:
            by_company[co].append((key, info))

    # For each company, detect pattern from verified emails
    company_patterns = {}  # company -> (domain, pattern, confidence)
    for co, entries in by_company.items():
        domain_patterns = defaultdict(list)
        for key, info in entries:
            email = info.get('email')
            if not email or '@' not in email:
                continue
            domain = email.split('@')[1].lower()
            if domain in PERSONAL_DOMAINS:
                continue
            pat = detect_pattern(info['first'], info['last'], email)
            if pat:
                domain_patterns[domain].append(pat)

        if not domain_patterns:
            continue

        # Pick best domain (most verified samples)
        best_domain = max(domain_patterns, key=lambda d: len(domain_patterns[d]))
        patlist = domain_patterns[best_domain]
        most_common = max(set(patlist), key=patlist.count)
        consistency = patlist.count(most_common) / len(patlist)

        # Require consistency: if >1 sample, need ≥70%; if 1 sample, accept if domain is the company's own
        if len(patlist) >= 2 and consistency >= 0.7:
            company_patterns[co] = (best_domain, most_common, len(patlist))
        elif len(patlist) == 1:
            # Only trust single-sample pattern if domain contains company words
            co_words = re.sub(r'[^a-z0-9\s]', '', co.lower()).split()
            co_words = [w for w in co_words if w not in ('inc','llc','corp','the','of','and','real','estate','group','realty','commercial','properties','investments','co','company','llp')]
            if any(len(w) >= 4 and w in best_domain for w in co_words):
                company_patterns[co] = (best_domain, most_common, 1)

    # Apply patterns to unfilled brokers
    filled = 0
    filled_details = []
    for co, (domain, pattern, samples) in company_patterns.items():
        for key, info in by_company[co]:
            if info.get('email'):
                continue
            generated = apply_pattern(info['first'], info['last'], pattern, domain)
            if generated:
                progress[key]['email'] = generated
                progress[key]['source'] = f'Pattern:{domain}({pattern},n={samples})'
                filled += 1
                filled_details.append((f"{info['first']} {info['last']}", co, generated, samples))

    # Sort details for display
    filled_details.sort(key=lambda x: -x[3])
    print(f"Pattern-filled {filled} new brokers:\n")
    for name, co, email, n in filled_details:
        marker = '***' if n >= 3 else ('**' if n == 2 else '*')
        print(f"  {marker} {name:30s} | {co[:35]:35s} | {email}  (n={n})")

    # Save updated progress
    with open(PROGRESS_PATH, 'w') as f:
        json.dump(progress, f, indent=2)
    print(f"\nProgress saved. Regenerating output CSV...")

    # Regenerate output CSV
    with open(INPUT_CSV, 'r') as fin:
        reader = csv.DictReader(fin)
        fieldnames = list(reader.fieldnames) + [
            'Listing Broker Email', 'Listing Broker LinkedIn',
            'Buyers Broker Email', 'Buyers Broker LinkedIn'
        ]
        fin.seek(0)
        reader = csv.DictReader(fin)

        with open(OUTPUT_CSV, 'w', newline='') as fout:
            writer = csv.DictWriter(fout, fieldnames=fieldnames)
            writer.writeheader()
            for row in reader:
                fn = row.get('Listing Broker Agent First Name', '').strip()
                ln = row.get('Listing Broker Agent Last Name', '').strip()
                co = row.get('Listing Broker Company', '').strip()
                lkey = f"{fn}|{ln}|{co}"
                linfo = progress.get(lkey, {})
                row['Listing Broker Email'] = linfo.get('email', '') or ''
                row['Listing Broker LinkedIn'] = linfo.get('linkedin', '') or ''

                fn2 = row.get('Buyers Broker Agent First Name', '').strip()
                ln2 = row.get('Buyers Broker Agent Last Name', '').strip()
                co2 = row.get('Buyers Broker Company', '').strip()
                bkey = f"{fn2}|{ln2}|{co2}"
                binfo = progress.get(bkey, {})
                row['Buyers Broker Email'] = binfo.get('email', '') or ''
                row['Buyers Broker LinkedIn'] = binfo.get('linkedin', '') or ''

                writer.writerow(row)

    total_with = sum(1 for v in progress.values() if v.get('email'))
    rr = sum(1 for v in progress.values() if v.get('source') == 'RocketReach')
    bing = sum(1 for v in progress.values() if v.get('source') == 'Bing')
    pat = sum(1 for v in progress.values() if (v.get('source') or '').startswith('Pattern:'))
    print(f"\n=== Final ===")
    print(f"Total with email: {total_with}/{len(progress)}")
    print(f"  RocketReach:    {rr}")
    print(f"  Bing:           {bing}")
    print(f"  Pattern-filled: {pat}")
    print(f"Output: {OUTPUT_CSV}")


if __name__ == '__main__':
    main()
