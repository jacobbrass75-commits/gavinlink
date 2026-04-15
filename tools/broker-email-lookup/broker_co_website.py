#!/usr/bin/env python3
"""
Find company website via Bing search, then scrape team pages deeply.
Different from broker_company_scrape (domain guess) — uses search to find real URL.
"""
import json, re, time, threading, urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed
from collections import defaultdict
import requests
from bs4 import BeautifulSoup
from paths import PROGRESS_PATH

UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2.1 Safari/605.1.15'

BAD_EMAIL = ['noreply','no-reply','info@','support@','admin@','contact@','sales@',
             'hello@','office@','team@','webmaster@','privacy@','abuse@','spam@',
             'mailer-daemon','donotreply','sentry','cloudflare','recaptcha',
             'example.com','googleapis','gstatic','microsoft','wixpress','godaddy',
             'squarespace','wordpress','wix.com','weebly','domain.com','yourdomain',
             'yoursite','sampleemail','email@','name@','user@','test@','your@',
             'feedback@','herokuapp','sentry.io','w3.org','schema.org','gravatar']

SKIP_DOMAINS = ['linkedin.com','facebook.com','youtube.com','wikipedia.org',
                'yelp.com','rocketreach.co','zoominfo.com','contactout.com',
                'leadiq.com','signalhire.com','lusha.com','apollo.io',
                'crunchbase','bloomberg.com','loopnet.com','costar.com',
                'realtor.com','zillow.com','redfin.com','homes.com',
                'reddit.com','indeed.com','twitter.com','instagram.com',
                'google.com','bing.com','yahoo.com','whitepages.com',
                'spokeo.com','fastpeoplesearch.com','truepeoplesearch.com',
                'beenverified.com','mylife.com','yellowpages.com',
                'mapquest.com','businessweek.com','prnewswire.com',
                'businesswire.com','trulia.com','movoto.com']

TEAM_PATHS = ['/team','/our-team','/agents','/our-agents','/brokers',
              '/our-brokers','/advisors','/people','/staff','/meet-the-team',
              '/about','/about-us','/about/team','/contact']

progress_lock = threading.Lock()
stats_lock = threading.Lock()
stats = {'found': 0, 'checked': 0}


def extract_emails(text):
    found = set(re.findall(r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}', text))
    out = []
    for e in found:
        low = e.lower()
        if any(x in low for x in BAD_EMAIL):
            continue
        if len(e) < 6 or len(e) > 60:
            continue
        if len(e.split('.')[-1]) > 5:
            continue
        if low.endswith(('.jpg','.png','.gif','.css','.js','.ico','.pdf','.webp','.svg')):
            continue
        out.append(e)
    return out


def bing_search(query, timeout=10):
    try:
        url = f"https://www.bing.com/search?q={urllib.parse.quote(query)}"
        r = requests.get(url, headers={'User-Agent': UA}, timeout=timeout)
        if r.status_code != 200:
            return []
        soup = BeautifulSoup(r.text, 'html.parser')
        urls = []
        for li in soup.find_all('li', class_='b_algo'):
            a = li.find('a', href=True)
            if a and a['href'].startswith('http'):
                urls.append(a['href'])
        return urls
    except Exception:
        return []


def fetch(url, timeout=8):
    try:
        r = requests.get(url, headers={'User-Agent': UA}, timeout=timeout, allow_redirects=True)
        if r.status_code == 200:
            return r
    except Exception:
        pass
    return None


def find_company_site(company):
    """Use Bing to find the actual company website."""
    queries = [
        f'"{company}" official website real estate',
        f'{company} contact',
    ]
    for q in queries:
        urls = bing_search(q, timeout=8)
        for u in urls[:5]:
            low = u.lower()
            if any(s in low for s in SKIP_DOMAINS):
                continue
            # Get root domain
            m = re.match(r'(https?://[^/]+)', u)
            if m:
                return m.group(1)
    return None


def extract_name_email(html, brokers_to_match):
    """Given HTML and list of (key, first, last), return dict key->email."""
    results = {}
    if not html:
        return results
    lower = html.lower()
    for key, first, last in brokers_to_match:
        for search_name in [f"{first} {last}", f"{first[0]}. {last}", last]:
            idx = lower.find(search_name.lower())
            if idx < 0:
                continue
            window = html[max(0, idx-1500):idx+3000]
            emails = extract_emails(window)
            best_email, best_score = None, -1
            for e in emails:
                el = e.lower()
                fn = re.sub(r'[^a-z]', '', first.lower().split()[0])
                ln = re.sub(r'[^a-z]', '', last.lower().split()[-1])
                score = 0
                if fn and len(fn) >= 3 and fn in el: score += 5
                if ln and len(ln) >= 3 and ln in el: score += 10
                if score > best_score:
                    best_score = score
                    best_email = e
            if best_email and best_score >= 5:
                results[key] = best_email
                break
    return results


def process_company(company, brokers, total):
    base = find_company_site(company)
    if not base:
        with stats_lock:
            stats['checked'] += 1
            done = stats['checked']
            if done % 10 == 0:
                print(f"  [{done}/{total}] ... ({stats['found']} found)", flush=True)
        return

    found = {}
    # Home page
    r = fetch(base, timeout=8)
    if r:
        found.update(extract_name_email(r.text, brokers))

    remaining = [b for b in brokers if b[0] not in found]
    if remaining:
        for path in TEAM_PATHS[:8]:
            if not remaining:
                break
            r2 = fetch(base.rstrip('/') + path, timeout=8)
            if r2 and len(r2.text) > 500:
                new = extract_name_email(r2.text, remaining)
                found.update(new)
                remaining = [b for b in remaining if b[0] not in found]

    with stats_lock:
        stats['checked'] += 1
        done = stats['checked']

    if found:
        with progress_lock:
            with open(PROGRESS_PATH) as f:
                progress = json.load(f)
            for k, email in found.items():
                progress[k]['email'] = email
                progress[k]['source'] = 'CoSite-Search'
                with stats_lock:
                    stats['found'] += 1
            with open(PROGRESS_PATH, 'w') as f:
                json.dump(progress, f, indent=2)
            for k, email in found.items():
                p = progress[k]
                print(f"  [{done}/{total}] ✓ {p['first']} {p['last']} ({company[:30]}) -> {email} [{base}]", flush=True)
    else:
        if done % 10 == 0:
            print(f"  [{done}/{total}] ... ({stats['found']} found)", flush=True)


def main():
    with open(PROGRESS_PATH) as f:
        progress = json.load(f)

    miss = defaultdict(list)
    for k, v in progress.items():
        if not v.get('email') and v.get('first') and v.get('last'):
            co = (v.get('company') or '').strip()
            if co:
                miss[co].append((k, v['first'], v['last']))

    sorted_cos = sorted(miss.items(), key=lambda x: -len(x[1]))
    total = len(sorted_cos)
    total_brokers = sum(len(b) for _, b in sorted_cos)
    print(f"Co-site search: {total} companies, {total_brokers} missing brokers, 8 threads\n", flush=True)

    start = time.time()
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = [pool.submit(process_company, co, brs, total) for co, brs in sorted_cos]
        for f in as_completed(futures):
            pass

    elapsed = time.time() - start
    total_with = sum(1 for v in json.load(open(PROGRESS_PATH)).values() if v.get('email'))
    print(f"\n=== Done in {elapsed/60:.1f} min ===", flush=True)
    print(f"New this pass: {stats['found']}")
    print(f"Total with email: {total_with}/{len(progress)}")


if __name__ == '__main__':
    main()
