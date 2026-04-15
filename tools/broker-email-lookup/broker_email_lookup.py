#!/usr/bin/env python3
"""
Broker email lookup: RocketReach (throttled) + Bing fallback.
Adapted from SulliLink's contact_multi.py for CoStar broker CSV.
"""
import json, re, time, sys, csv, os
import requests, urllib.parse
from bs4 import BeautifulSoup
import threading
from paths import INPUT_CSV, OUTPUT_CSV, PROGRESS_PATH

RR_KEY = os.environ["ROCKETREACH_API_KEY"]
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2.1 Safari/605.1.15'


def extract_emails(text):
    found = re.findall(r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}', text)
    bad = ['google','example','noreply','sentry','email.com','domain','w3.org','schema.org',
           'googleapis','gstatic','microsoft','bing','outlook.com','hotmail','yahoo.com',
           'aol.com','mail.com','protonmail','icloud','me.com','live.com','sampleemail',
           'your@','user@','info@example','test@','name@','address@','e-mail@',
           'feedback@','support@','admin@','webmaster@','contact@bing','privacy@',
           'abuse@','spam@','mailer-daemon','no-reply','donotreply','noreply',
           '.gov','yelp.com','facebook.com','twitter.com','instagram.com',
           'craigslist','wixpress','sentry.io','cloudflare','recaptcha']
    result = []
    for e in set(found):
        low = e.lower()
        if any(x in low for x in bad):
            continue
        if len(e) < 6 or len(e) > 60:
            continue
        parts = e.split('.')
        if len(parts[-1]) > 5:
            continue
        result.append(e)
    return result


def email_matches_person(email, first, last, company):
    """Check if an email plausibly belongs to this person or their company."""
    email_low = email.lower()
    first_low = first.lower().split()[0]  # first word of first name
    last_low = last.lower().split()[-1]   # last word of last name

    # Direct name match in email
    if first_low in email_low or last_low in email_low:
        return True

    # Company domain match
    if company:
        # Simplify company name for domain matching
        co_words = re.sub(r'[^a-z0-9\s]', '', company.lower()).split()
        co_words = [w for w in co_words if w not in ('inc', 'llc', 'corp', 'the', 'of', 'and', 'real', 'estate', 'group', 'realty', 'commercial', 'properties', 'investments')]
        domain = email_low.split('@')[1] if '@' in email_low else ''
        for w in co_words:
            if len(w) >= 3 and w in domain:
                return True

    return False


def scrape_page(url, timeout=8):
    try:
        resp = requests.get(url, headers={'User-Agent': UA}, timeout=timeout, allow_redirects=True)
        if resp.status_code != 200:
            return [], None
        text = resp.text
        emails = extract_emails(text)
        linkedin = None
        li_matches = re.findall(r'https?://(?:www\.)?linkedin\.com/in/[a-zA-Z0-9_-]+', text)
        if li_matches:
            linkedin = li_matches[0]
        return emails, linkedin
    except:
        return [], None


def rocketreach_lookup(name, company=''):
    """Single RocketReach lookup with built-in throttle."""
    if not RR_KEY:
        return None
    headers = {"Api-Key": RR_KEY, "Content-Type": "application/json"}
    try:
        query = {"name": [name], "location": ["California"]}
        if company:
            query["current_employer"] = [company]

        resp = requests.post("https://api.rocketreach.co/v2/api/search",
            headers=headers,
            json={"query": query},
            timeout=15)

        if resp.status_code == 429:
            print("  [RocketReach 429 — waiting 60s before retry]")
            time.sleep(60)
            resp = requests.post("https://api.rocketreach.co/v2/api/search",
                headers=headers,
                json={"query": query},
                timeout=15)
            if resp.status_code == 429:
                print("  [RocketReach still 429 — skipping to Bing]")
                return None

        if resp.status_code in (200, 201):
            profiles = resp.json().get('profiles', [])
            if profiles:
                pid = profiles[0].get('id')
                if pid:
                    time.sleep(2.5)  # throttle between search and lookup
                    r2 = requests.get("https://api.rocketreach.co/v2/api/person/lookup",
                        headers={"Api-Key": RR_KEY}, params={"id": pid}, timeout=15)
                    if r2.status_code == 429:
                        print("  [RocketReach lookup 429 — waiting 60s]")
                        time.sleep(60)
                        r2 = requests.get("https://api.rocketreach.co/v2/api/person/lookup",
                            headers={"Api-Key": RR_KEY}, params={"id": pid}, timeout=15)
                    if r2.status_code == 200:
                        d = r2.json()
                        emails = d.get('emails', [])
                        valid = [e['email'] for e in emails if isinstance(e, dict) and e.get('smtp_valid') != 'invalid']
                        email = valid[0] if valid else (emails[0]['email'] if emails and isinstance(emails[0], dict) else None)
                        phones = d.get('phones', [])
                        phone = phones[0].get('number') if phones and isinstance(phones[0], dict) else None
                        linkedin = d.get('linkedin_url')
                        if email or phone:
                            return {'email': email, 'phone': phone, 'linkedin': linkedin}
    except Exception as ex:
        print(f"  [RocketReach error: {ex}]")
    return None


def bing_search(name, company, first, last):
    """Bing search with name/company validation on results."""
    contact = {'email': None, 'phone': None, 'linkedin': None}
    queries = [
        f'"{name}" "{company}" email' if company else f'"{name}" real estate broker email',
        f'"{name}" {company or "real estate"} contact email California',
    ]
    for query in queries:
        try:
            resp = requests.get(
                f"https://www.bing.com/search?q={urllib.parse.quote(query)}&count=20",
                headers={'User-Agent': UA}, timeout=10)
            if resp.status_code != 200:
                continue
            soup = BeautifulSoup(resp.text, 'html.parser')
            result_texts = []
            for div in soup.find_all(['li', 'div'], class_=re.compile(r'b_algo|b_ans')):
                result_texts.append(div.get_text(' ', strip=True))
            combined_text = ' '.join(result_texts)
            emails = extract_emails(combined_text)

            # Filter to emails that match the person or company
            for e in emails:
                if email_matches_person(e, first, last, company):
                    contact['email'] = e
                    break

            for a in soup.find_all('a', href=True):
                href = a['href']
                if 'linkedin.com/in/' in href and not contact['linkedin']:
                    clean = re.match(r'(https?://(?:www\.)?linkedin\.com/in/[a-zA-Z0-9_-]+)', href)
                    if clean:
                        contact['linkedin'] = clean.group(1)

            # Scrape top results if no email yet
            if not contact['email']:
                for a in soup.find_all('a', href=True)[:5]:
                    href = a['href']
                    if href.startswith('http') and 'bing.com' not in href and 'microsoft.com' not in href:
                        skip = ['linkedin.com', 'facebook.com', 'youtube.com', 'wikipedia.org',
                                'yelp.com', 'rocketreach.co', 'zoominfo.com', 'contactout.com',
                                'leadiq.com', 'signalhire.com', 'lusha.com', 'saleshandy.com']
                        if any(x in href.lower() for x in skip):
                            continue
                        pe, pli = scrape_page(href)
                        for e in pe:
                            if email_matches_person(e, first, last, company):
                                contact['email'] = e
                                break
                        if pli and not contact['linkedin']:
                            contact['linkedin'] = pli
                        if contact['email']:
                            break
                        time.sleep(0.5)
        except:
            pass
        if contact['email']:
            return contact
        time.sleep(1.5)
    return contact


def load_progress():
    if os.path.exists(PROGRESS_PATH):
        with open(PROGRESS_PATH) as f:
            return json.load(f)
    return {}


def save_progress(progress):
    with open(PROGRESS_PATH, 'w') as f:
        json.dump(progress, f, indent=2)


def generate_csv(progress):
    """Write output CSV with broker emails merged in."""
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
    print(f"Output saved: {OUTPUT_CSV}")


def main():
    progress = load_progress()

    # Clear out junk emails from prior run
    junk_domains = ['craigslist', 'bethanylutheran', 'gabrielny.com', 'cesehsa.com']
    for key, info in progress.items():
        if info.get('email'):
            if any(j in info['email'].lower() for j in junk_domains):
                print(f"  Removing junk email for {info.get('first','')} {info.get('last','')}: {info['email']}")
                info['email'] = None
                info['source'] = None

    # Extract unique brokers from CSV
    brokers = {}
    with open(INPUT_CSV, 'r') as f:
        reader = csv.DictReader(f)
        for row in reader:
            fn = row.get('Listing Broker Agent First Name', '').strip()
            ln = row.get('Listing Broker Agent Last Name', '').strip()
            co = row.get('Listing Broker Company', '').strip()
            if fn and ln:
                key = f"{fn}|{ln}|{co}"
                if key not in brokers:
                    brokers[key] = (fn, ln, co)
            fn2 = row.get('Buyers Broker Agent First Name', '').strip()
            ln2 = row.get('Buyers Broker Agent Last Name', '').strip()
            co2 = row.get('Buyers Broker Company', '').strip()
            if fn2 and ln2:
                key2 = f"{fn2}|{ln2}|{co2}"
                if key2 not in brokers:
                    brokers[key2] = (fn2, ln2, co2)

    # Filter to brokers without emails
    to_process = []
    already_found = 0
    for key, (fn, ln, co) in brokers.items():
        if key in progress and progress[key].get('email'):
            already_found += 1
        else:
            to_process.append((key, fn, ln, co))

    total = len(to_process)
    print(f"Total unique brokers: {len(brokers)}")
    print(f"Already have emails: {already_found}")
    print(f"Need to search: {total}")
    print(f"\nRunning sequentially (RocketReach → Bing) with throttle...\n")

    found = 0
    rr_count = 0

    for i, (key, fn, ln, co) in enumerate(to_process):
        name = f"{fn} {ln}"
        done = i + 1

        # RocketReach first (with 2.5s gap between calls)
        rr = rocketreach_lookup(name, co)
        if rr and rr.get('email'):
            # Validate the email matches the person
            if email_matches_person(rr['email'], fn, ln, co):
                progress[key] = {
                    'first': fn, 'last': ln, 'company': co,
                    'email': rr.get('email'), 'phone': rr.get('phone'),
                    'linkedin': rr.get('linkedin'), 'source': 'RocketReach'
                }
                found += 1
                rr_count += 1
                print(f"  [{done}/{total}] ✓ {name} ({co}) -> {rr['email']} [RocketReach]")
                time.sleep(2.5)  # throttle
                if done % 25 == 0:
                    save_progress(progress)
                continue
            else:
                print(f"  [{done}/{total}] RR email {rr['email']} doesn't match {name} — trying Bing")

        time.sleep(2)  # gap before Bing

        # Bing fallback
        contact = bing_search(name, co, fn, ln)
        if contact.get('email'):
            progress[key] = {
                'first': fn, 'last': ln, 'company': co,
                'email': contact.get('email'), 'phone': contact.get('phone'),
                'linkedin': contact.get('linkedin'), 'source': 'Bing'
            }
            found += 1
            print(f"  [{done}/{total}] ✓ {name} ({co}) -> {contact['email']} [Bing]")
        else:
            if key not in progress:
                progress[key] = {
                    'first': fn, 'last': ln, 'company': co,
                    'email': None, 'phone': None,
                    'linkedin': contact.get('linkedin') if contact else None,
                    'source': None
                }
            if done % 20 == 0:
                print(f"  [{done}/{total}] ... ({found + already_found} emails total)")

        if done % 25 == 0:
            save_progress(progress)

        time.sleep(1)

    save_progress(progress)

    print(f"\n{'='*60}")
    total_with = sum(1 for v in progress.values() if v.get('email'))
    total_without = sum(1 for v in progress.values() if not v.get('email'))
    print(f"Search complete: {total_with}/{len(brokers)} brokers have verified emails")
    print(f"  RocketReach: {rr_count} new this run")
    print(f"  Bing: {found - rr_count} new this run")
    print(f"  Previously found: {already_found}")
    print(f"  Still missing: {total_without}")
    print(f"\nGenerating output CSV...")
    generate_csv(progress)

    with_email = sum(1 for v in progress.values() if v.get('email'))
    print(f"\nFinal: {with_email}/{len(progress)} brokers have emails")


if __name__ == '__main__':
    main()
