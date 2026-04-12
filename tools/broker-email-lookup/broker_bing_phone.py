#!/usr/bin/env python3
"""
Phone-based Bing search for missing brokers.
Phones are unique — searching "phone" "name" usually lands on broker profile page.
"""
import json, re, time, threading, urllib.parse, csv
from concurrent.futures import ThreadPoolExecutor, as_completed
from collections import defaultdict
import requests
from bs4 import BeautifulSoup

PROGRESS_PATH = "/Users/josephsullivan/Downloads/broker_lookup_progress.json"
INPUT_CSV = "/Users/josephsullivan/Downloads/CostarExport_MF Sales_2024-Present.xlsx - Export041026.csv"
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2.1 Safari/605.1.15'

BAD = ['noreply','no-reply','info@','support@','admin@','contact@','sales@',
       'hello@','office@','team@','webmaster@','privacy@','abuse@','spam@',
       'mailer-daemon','donotreply','sentry','cloudflare','recaptcha',
       'example.com','googleapis','gstatic','microsoft','wixpress','godaddy',
       'squarespace','wordpress','wix.com','weebly','domain.com','yourdomain',
       'yoursite','sampleemail','email@','name@','user@','test@','your@',
       'feedback@','herokuapp','sentry.io','w3.org','schema.org']

SKIP_DOMAINS = ['facebook.com','youtube.com','wikipedia.org',
                'yelp.com','rocketreach.co','zoominfo.com','contactout.com',
                'leadiq.com','signalhire.com','lusha.com','saleshandy.com',
                'apollo.io','lead411','crunchbase','bloomberg.com',
                'reddit.com','indeed.com','glassdoor.com','salary.com',
                'twitter.com','instagram.com','tiktok.com','pinterest.com',
                'google.com','bing.com','duckduckgo.com','yahoo.com',
                'mapquest.com','whitepages.com','spokeo.com',
                'fastpeoplesearch.com','truepeoplesearch.com',
                'beenverified.com','mylife.com','rocketreach.com']

progress_lock = threading.Lock()
stats_lock = threading.Lock()
stats = {'found': 0, 'checked': 0}


def load_phones():
    phones = defaultdict(set)
    with open(INPUT_CSV) as f:
        r = csv.DictReader(f)
        for row in r:
            fn = row.get('Listing Broker Agent First Name','').strip()
            ln = row.get('Listing Broker Agent Last Name','').strip()
            co = row.get('Listing Broker Company','').strip()
            if fn and ln:
                k = f"{fn}|{ln}|{co}"
                ph = row.get('Listing Broker Phone','').strip()
                if ph: phones[k].add(ph)
            fn2 = row.get('Buyers Broker Agent First Name','').strip()
            ln2 = row.get('Buyers Broker Agent Last Name','').strip()
            co2 = row.get('Buyers Broker Company','').strip()
            if fn2 and ln2:
                k = f"{fn2}|{ln2}|{co2}"
                ph = row.get('Buyers Broker Phone','').strip()
                if ph: phones[k].add(ph)
    return phones


def extract_emails(text):
    found = set(re.findall(r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}', text))
    out = []
    for e in found:
        low = e.lower()
        if any(x in low for x in BAD):
            continue
        if len(e) < 6 or len(e) > 60:
            continue
        if len(e.split('.')[-1]) > 5:
            continue
        if low.endswith(('.jpg','.png','.gif','.css','.js','.ico','.pdf','.webp','.svg')):
            continue
        out.append(e)
    return out


def email_matches(email, first, last):
    if not email or '@' not in email: return False
    el = email.lower()
    f = re.sub(r'[^a-z]', '', first.lower().split()[0]) if first else ''
    l = re.sub(r'[^a-z]', '', last.lower().split()[-1]) if last else ''
    if f and len(f) >= 3 and f in el: return True
    if l and len(l) >= 3 and l in el: return True
    return False


def bing_search(query, timeout=10):
    try:
        url = f"https://www.bing.com/search?q={urllib.parse.quote(query)}"
        r = requests.get(url, headers={'User-Agent': UA}, timeout=timeout)
        if r.status_code != 200:
            return [], ''
        soup = BeautifulSoup(r.text, 'html.parser')
        urls = []
        for li in soup.find_all('li', class_='b_algo'):
            a = li.find('a', href=True)
            if a and a['href'].startswith('http'):
                urls.append(a['href'])
        snippet_text = soup.get_text(' ', strip=True)[:30000]
        return urls, snippet_text
    except Exception:
        return [], ''


def fetch_page(url, timeout=8):
    try:
        r = requests.get(url, headers={'User-Agent': UA}, timeout=timeout, allow_redirects=True)
        if r.status_code != 200:
            return ''
        return r.text
    except Exception:
        return ''


def lookup_broker(key, info, phones_list, total):
    fn = info['first']
    ln = info['last']
    co = info.get('company', '')
    name = f"{fn} {ln}"
    found_email = None

    # Try each phone number
    for phone in phones_list[:2]:  # at most 2 phones
        if found_email: break
        # Clean phone: digits only, then format as xxx-xxx-xxxx
        digits = re.sub(r'\D', '', phone)
        if len(digits) == 10:
            phone_variants = [
                f'{digits[:3]}-{digits[3:6]}-{digits[6:]}',
                f'({digits[:3]}) {digits[3:6]}-{digits[6:]}',
                f'{digits[:3]}.{digits[3:6]}.{digits[6:]}',
                digits,
            ]
        else:
            phone_variants = [phone, digits]

        for pv in phone_variants[:2]:
            if found_email: break
            q = f'"{pv}" "{name}" email'
            urls, snippet = bing_search(q, timeout=10)
            if not urls and not snippet:
                continue

            # Check snippet
            for e in extract_emails(snippet):
                if email_matches(e, fn, ln):
                    found_email = e
                    break
            if found_email: break

            # Fetch top 3 results
            filtered = []
            for u in urls:
                low = u.lower()
                if any(s in low for s in SKIP_DOMAINS): continue
                filtered.append(u)

            for u in filtered[:3]:
                html = fetch_page(u, timeout=8)
                if not html: continue
                # Must contain broker name AND phone digits to validate
                if name.lower() not in html.lower() and ln.lower() not in html.lower():
                    continue
                if digits not in re.sub(r'\D', '', html[:200000]):
                    continue
                for e in extract_emails(html):
                    if email_matches(e, fn, ln):
                        found_email = e
                        break
                if found_email: break

    with stats_lock:
        stats['checked'] += 1
        done = stats['checked']
        if found_email:
            stats['found'] += 1

    if found_email:
        with progress_lock:
            with open(PROGRESS_PATH) as f:
                progress = json.load(f)
            progress[key]['email'] = found_email
            progress[key]['source'] = 'Bing-Phone'
            with open(PROGRESS_PATH, 'w') as f:
                json.dump(progress, f, indent=2)
        print(f"  [{done}/{total}] ✓ {name} ({co[:30]}) -> {found_email}", flush=True)
    else:
        if done % 20 == 0:
            print(f"  [{done}/{total}] ... ({stats['found']} found)", flush=True)


def main():
    phones = load_phones()

    with open(PROGRESS_PATH) as f:
        progress = json.load(f)

    to_retry = []
    for k, v in progress.items():
        if v.get('email'): continue
        if not v.get('first') or not v.get('last'): continue
        phones_list = sorted(phones.get(k, set()))
        if phones_list:
            to_retry.append((k, v, phones_list))

    total = len(to_retry)
    print(f"Phone-based Bing pass: {total} brokers with phones, 8 threads\n", flush=True)

    start = time.time()
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = [pool.submit(lookup_broker, k, v, ph, total) for k, v, ph in to_retry]
        for f in as_completed(futures):
            pass

    elapsed = time.time() - start
    total_with = sum(1 for v in json.load(open(PROGRESS_PATH)).values() if v.get('email'))
    print(f"\n=== Done in {elapsed/60:.1f} min ===", flush=True)
    print(f"New this pass: {stats['found']}")
    print(f"Total with email: {total_with}/{len(progress)}")


if __name__ == '__main__':
    main()
