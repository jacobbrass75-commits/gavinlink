#!/usr/bin/env python3
"""
Second RocketReach pass for brokers missed on first attempt.

First pass uses {name, location, current_employer}. If RocketReach indexes
the company name differently than CoStar (e.g. "KW Commercial Beverly Hills"
vs "Keller Williams"), the exact-employer filter misses them.

This pass relaxes the filter:
1. Try {name, location=California} without employer — validate result against company
2. If that fails, try {name, current_employer=<first-word-of-company>} fuzzy
3. Only accept results where the returned title/employer reasonably matches

Run after broker_email_lookup.py and broker_pattern_fill.py finish.
"""
import json, re, time, os
import requests

RR_KEY = os.environ["ROCKETREACH_API_KEY"]
PROGRESS_PATH = "/Users/josephsullivan/Downloads/broker_lookup_progress.json"

PERSONAL_DOMAINS = {
    'gmail.com','yahoo.com','hotmail.com','aol.com','outlook.com',
    'sbcglobal.net','verizon.net','ca.rr.com','bellsouth.net',
    'earthlink.net','icloud.com','me.com','live.com','comcast.net',
    'msn.com','att.net','pacbell.net','cox.net','mac.com','mail.com',
    'protonmail.com','ymail.com','rocketmail.com',
}


def normalize_company(co):
    """Strip common suffixes for fuzzy matching."""
    co = re.sub(r'[^a-z0-9\s]', ' ', co.lower())
    stopwords = {'inc','llc','corp','the','of','and','real','estate','group','realty','commercial','properties','investments','co','company','llp','ltd','intl','international'}
    words = [w for w in co.split() if w and w not in stopwords]
    return ' '.join(words)


def company_matches(query_co, result_co):
    """Check if two company strings plausibly refer to the same firm."""
    if not query_co or not result_co:
        return False
    q = set(normalize_company(query_co).split())
    r = set(normalize_company(result_co).split())
    if not q or not r:
        return False
    overlap = q & r
    return len(overlap) >= 1 and any(len(w) >= 4 for w in overlap)


def email_matches_person(email, first, last, company):
    if not email or '@' not in email:
        return False
    email_low = email.lower()
    first_low = first.lower().split()[0] if first else ''
    last_low = last.lower().split()[-1] if last else ''
    if first_low and first_low in email_low:
        return True
    if last_low and last_low in email_low:
        return True
    if company:
        co_words = normalize_company(company).split()
        domain = email_low.split('@')[1] if '@' in email_low else ''
        for w in co_words:
            if len(w) >= 4 and w in domain:
                return True
    return False


def rr_search(query):
    headers = {"Api-Key": RR_KEY, "Content-Type": "application/json"}
    try:
        resp = requests.post("https://api.rocketreach.co/v2/api/search",
            headers=headers, json={"query": query}, timeout=15)
        if resp.status_code == 429:
            print("  [429 — waiting 60s]")
            time.sleep(60)
            resp = requests.post("https://api.rocketreach.co/v2/api/search",
                headers=headers, json={"query": query}, timeout=15)
        if resp.status_code in (200, 201):
            return resp.json().get('profiles', [])
    except Exception as e:
        print(f"  [search error: {e}]")
    return []


def rr_lookup(pid):
    headers = {"Api-Key": RR_KEY}
    try:
        r = requests.get("https://api.rocketreach.co/v2/api/person/lookup",
            headers=headers, params={"id": pid}, timeout=15)
        if r.status_code == 429:
            print("  [lookup 429 — waiting 60s]")
            time.sleep(60)
            r = requests.get("https://api.rocketreach.co/v2/api/person/lookup",
                headers=headers, params={"id": pid}, timeout=15)
        if r.status_code == 200:
            return r.json()
    except Exception as e:
        print(f"  [lookup error: {e}]")
    return None


def try_search_and_validate(query, fn, ln, co):
    """Search RR with a given query, then lookup top matching profile."""
    profiles = rr_search(query)
    if not profiles:
        return None
    # Filter to profiles that look like a match
    candidates = []
    for prof in profiles[:5]:
        result_co = prof.get('current_employer','') or ''
        result_title = prof.get('current_title','') or ''
        if company_matches(co, result_co) or company_matches(co, result_title):
            candidates.append(prof)
    if not candidates:
        # Fallback: if only 1 profile and name is unusual, trust it
        if len(profiles) == 1:
            candidates = [profiles[0]]
    if not candidates:
        return None
    pid = candidates[0].get('id')
    if not pid:
        return None
    time.sleep(2.5)
    d = rr_lookup(pid)
    if not d:
        return None
    emails = d.get('emails', [])
    valid = [e['email'] for e in emails if isinstance(e, dict) and e.get('smtp_valid') != 'invalid']
    email = valid[0] if valid else (emails[0]['email'] if emails and isinstance(emails[0], dict) else None)
    if not email:
        return None
    if not email_matches_person(email, fn, ln, co):
        return None
    phones = d.get('phones', [])
    phone = phones[0].get('number') if phones and isinstance(phones[0], dict) else None
    return {'email': email, 'phone': phone, 'linkedin': d.get('linkedin_url')}


def main():
    with open(PROGRESS_PATH) as f:
        progress = json.load(f)

    # Find brokers without emails
    to_retry = [(k, v) for k, v in progress.items() if not v.get('email') and v.get('first') and v.get('last')]
    print(f"Retrying {len(to_retry)} brokers with relaxed RR filters...\n")

    found = 0
    for i, (key, info) in enumerate(to_retry):
        fn = info['first']
        ln = info['last']
        co = info['company']
        name = f"{fn} {ln}"
        done = i + 1

        # Strategy 1: name + location only
        result = try_search_and_validate(
            {"name": [name], "location": ["California"]},
            fn, ln, co
        )

        if not result:
            time.sleep(2)
            # Strategy 2: name + simplified employer
            simple_co = normalize_company(co).split()
            if simple_co:
                result = try_search_and_validate(
                    {"name": [name], "current_employer": [simple_co[0]]},
                    fn, ln, co
                )

        if result and result.get('email'):
            progress[key]['email'] = result['email']
            progress[key]['phone'] = result.get('phone') or progress[key].get('phone')
            progress[key]['linkedin'] = result.get('linkedin') or progress[key].get('linkedin')
            progress[key]['source'] = 'RocketReach-Pass2'
            found += 1
            print(f"  [{done}/{len(to_retry)}] ✓ {name} ({co[:30]}) -> {result['email']}")
            if done % 20 == 0:
                with open(PROGRESS_PATH,'w') as f: json.dump(progress, f, indent=2)
        else:
            if done % 25 == 0:
                print(f"  [{done}/{len(to_retry)}] ... ({found} new this pass)")

        time.sleep(2.5)

    with open(PROGRESS_PATH,'w') as f:
        json.dump(progress, f, indent=2)

    total_with = sum(1 for v in progress.values() if v.get('email'))
    print(f"\nPass 2 complete: {found} new emails. Total: {total_with}/{len(progress)}")


if __name__ == '__main__':
    main()
