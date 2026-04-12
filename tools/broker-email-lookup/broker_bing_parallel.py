#!/usr/bin/env python3
"""
Parallel Bing HTML scraper for missing brokers.
For each broker, search Bing, extract result URLs, fetch top results,
extract emails, validate against broker name/company.
"""
import json, re, time, threading, urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed
import requests
from bs4 import BeautifulSoup

PROGRESS_PATH = "/Users/josephsullivan/Downloads/broker_lookup_progress.json"
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2.1 Safari/605.1.15'

BAD = ['noreply','no-reply','info@','support@','admin@','contact@','sales@',
       'hello@','office@','team@','webmaster@','privacy@','abuse@','spam@',
       'mailer-daemon','donotreply','sentry','cloudflare','recaptcha',
       'example.com','googleapis','gstatic','microsoft','wixpress','godaddy',
       'squarespace','wordpress','wix.com','weebly','domain.com','yourdomain',
       'yoursite','sampleemail','email@','name@','user@','test@','your@',
       'feedback@','herokuapp','sentry.io','w3.org','schema.org']

SKIP_DOMAINS = ['linkedin.com','facebook.com','youtube.com','wikipedia.org',
                'yelp.com','rocketreach.co','zoominfo.com','contactout.com',
                'leadiq.com','signalhire.com','lusha.com','saleshandy.com',
                'apollo.io','lead411','crunchbase','bloomberg.com',
                'loopnet.com','costar.com','realtor.com','zillow.com',
                'redfin.com','trulia.com','homes.com','reddit.com',
                'indeed.com','glassdoor.com','salary.com','twitter.com',
                'instagram.com','tiktok.com','pinterest.com','google.com',
                'bing.com','duckduckgo.com','yahoo.com','mapquest.com',
                'whitepages.com','spokeo.com','fastpeoplesearch.com',
                'truepeoplesearch.com','beenverified.com','mylife.com',
                'rocketreach.com','prnewswire.com','businesswire.com']

progress_lock = threading.Lock()
stats_lock = threading.Lock()
stats = {'found': 0, 'checked': 0, 'errors': 0}


def extract_emails(text):
    found = set(re.findall(r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}', text))
    out = []
    for e in found:
        low = e.lower()
        if any(x in low for x in BAD):
            continue
        if len(e) < 6 or len(e) > 60:
            continue
        parts = e.split('.')
        if len(parts[-1]) > 5:
            continue
        if low.endswith(('.jpg','.png','.gif','.css','.js','.ico','.pdf','.webp','.svg')):
            continue
        out.append(e)
    return out


def normalize_co(co):
    co = re.sub(r'[^a-z0-9\s]', ' ', co.lower())
    stopwords = {'inc','llc','corp','the','of','and','real','estate','group',
                 'realty','commercial','properties','investments','co','company',
                 'llp','ltd','intl','international','advisors','partners',
                 'capital','holdings'}
    return [w for w in co.split() if w and w not in stopwords]


def email_matches(email, first, last, company):
    if not email or '@' not in email: return False
    el = email.lower()
    f = re.sub(r'[^a-z]', '', first.lower().split()[0]) if first else ''
    l = re.sub(r'[^a-z]', '', last.lower().split()[-1]) if last else ''
    if f and len(f) >= 3 and f in el: return True
    if l and len(l) >= 3 and l in el: return True
    if company:
        cw = normalize_co(company)
        domain = el.split('@')[1]
        for w in cw:
            if len(w) >= 4 and w in domain:
                return True
    return False


def bing_search(query, timeout=10):
    """Scrape Bing HTML search results. Returns list of URLs."""
    try:
        url = f"https://www.bing.com/search?q={urllib.parse.quote(query)}"
        r = requests.get(url, headers={'User-Agent': UA}, timeout=timeout)
        if r.status_code != 200:
            return [], ''
        soup = BeautifulSoup(r.text, 'html.parser')
        urls = []
        # Bing result links are under <li class="b_algo"> with <h2><a href="...">
        for li in soup.find_all('li', class_='b_algo'):
            a = li.find('a', href=True)
            if a and a['href'].startswith('http'):
                urls.append(a['href'])
        # Also grab from snippets in case
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


def lookup_broker(key, info, total):
    fn = info['first']
    ln = info['last']
    co = info.get('company', '')
    name = f"{fn} {ln}"
    found_email = None

    # Strip franchise brand to get the specific office (e.g. "KW Commercial Beverly Hills" -> "Beverly Hills")
    co_stripped = re.sub(r'^(KW |Keller Williams |RE/MAX |RE\\MAX |Coldwell Banker |Berkshire Hathaway |Century 21 |Sotheby\'s )', '', co or '', flags=re.I).strip()
    queries = [
        f'"{name}" California real estate agent email',
        f'"{name}" {co_stripped} email' if co_stripped and co_stripped != co else f'"{name}" broker email contact',
        f'"{name}" loopnet OR costar email' if co else f'"{name}" multifamily broker',
    ]

    for q in queries:
        if found_email: break
        urls, snippet = bing_search(q, timeout=10)
        if not urls and not snippet:
            continue

        # Check snippet first
        for e in extract_emails(snippet):
            if email_matches(e, fn, ln, co):
                found_email = e
                break

        if found_email: break

        # Filter result URLs
        filtered = []
        for u in urls:
            low = u.lower()
            if any(s in low for s in SKIP_DOMAINS): continue
            filtered.append(u)

        # Fetch top 4 results
        for u in filtered[:4]:
            html = fetch_page(u, timeout=8)
            if not html: continue
            for e in extract_emails(html):
                if email_matches(e, fn, ln, co):
                    found_email = e
                    break
            if found_email: break

        if not found_email:
            time.sleep(0.5)

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
            progress[key]['source'] = 'Bing-Parallel'
            with open(PROGRESS_PATH, 'w') as f:
                json.dump(progress, f, indent=2)
        print(f"  [{done}/{total}] ✓ {name} ({co[:30]}) -> {found_email}", flush=True)
    else:
        if done % 20 == 0:
            print(f"  [{done}/{total}] ... ({stats['found']} found)", flush=True)


def main():
    with open(PROGRESS_PATH) as f:
        progress = json.load(f)

    to_retry = [(k, v) for k, v in progress.items()
                if not v.get('email') and v.get('first') and v.get('last')]
    total = len(to_retry)
    print(f"Bing parallel pass: {total} brokers, 8 threads\n", flush=True)

    start = time.time()
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = [pool.submit(lookup_broker, k, v, total) for k, v in to_retry]
        for f in as_completed(futures):
            pass

    elapsed = time.time() - start
    total_with = sum(1 for v in json.load(open(PROGRESS_PATH)).values() if v.get('email'))
    print(f"\n=== Done in {elapsed/60:.1f} min ===", flush=True)
    print(f"New this pass: {stats['found']}")
    print(f"Total with email: {total_with}/{len(progress)}")


if __name__ == '__main__':
    main()
