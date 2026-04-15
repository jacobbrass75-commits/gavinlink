#!/usr/bin/env python3
"""
DuckDuckGo + company-page scraper for missing brokers.
No RocketReach. Validates every email against broker name/company.
"""
import json, re, time, os, threading, urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed
import requests
from bs4 import BeautifulSoup
from paths import PROGRESS_PATH

UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2.1 Safari/605.1.15'

BAD = ['google','example','noreply','sentry','email.com','domain','w3.org','schema.org',
       'googleapis','gstatic','microsoft','bing','duckduckgo','outlook.com','hotmail.com',
       'yahoo.com','aol.com','mail.com','protonmail','icloud','me.com','live.com',
       'sampleemail','your@','user@','info@example','test@','name@','address@',
       'feedback@','support@','admin@','webmaster@','privacy@','abuse@','spam@',
       'mailer-daemon','no-reply','donotreply','noreply','.gov','yelp.com',
       'facebook.com','twitter.com','instagram.com','craigslist','wixpress',
       'sentry.io','cloudflare','recaptcha','wixsite','godaddy','wordpress',
       'squarespace','sitebuilder','.jpg','.png','.gif','.css','.js',
       'loopnet','costar.com','realtor.com','zillow','redfin','mls',
       'sentry-next.io','herokuapp']

progress_lock = threading.Lock()
stats_lock = threading.Lock()
stats = {'found': 0, 'checked': 0}


def extract_emails(text):
    found = re.findall(r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}', text)
    result = []
    for e in set(found):
        low = e.lower()
        if any(x in low for x in BAD):
            continue
        if len(e) < 6 or len(e) > 60:
            continue
        parts = e.split('.')
        if len(parts[-1]) > 5:
            continue
        # Skip image/css filename masquerading as email
        if any(low.endswith(ext) for ext in ('.jpg','.png','.gif','.css','.js','.ico','.pdf')):
            continue
        result.append(e)
    return result


def normalize_co(co):
    co = re.sub(r'[^a-z0-9\s]', ' ', co.lower())
    stopwords = {'inc','llc','corp','the','of','and','real','estate','group','realty','commercial','properties','investments','co','company','llp','ltd','intl','international'}
    return [w for w in co.split() if w and w not in stopwords]


def email_matches(email, first, last, company):
    if not email or '@' not in email: return False
    el = email.lower()
    f = first.lower().split()[0] if first else ''
    l = last.lower().split()[-1] if last else ''
    # Strip punctuation from name parts for comparison
    f = re.sub(r'[^a-z]', '', f)
    l = re.sub(r'[^a-z]', '', l)
    if f and len(f) >= 3 and f in el: return True
    if l and len(l) >= 3 and l in el: return True
    if company:
        cw = normalize_co(company)
        d = el.split('@')[1]
        for w in cw:
            if len(w) >= 4 and w in d:
                return True
    return False


def ddg_search(query, timeout=10):
    """DuckDuckGo HTML search via POST (GET returns empty results)."""
    try:
        resp = requests.post(
            "https://html.duckduckgo.com/html/",
            data={"q": query},
            headers={'User-Agent': UA, 'Referer': 'https://html.duckduckgo.com/'},
            timeout=timeout)
        if resp.status_code != 200:
            return None
        return BeautifulSoup(resp.text, 'html.parser')
    except Exception:
        return None


def scrape_page(url, timeout=8):
    try:
        resp = requests.get(url, headers={'User-Agent': UA}, timeout=timeout, allow_redirects=True)
        if resp.status_code != 200:
            return []
        return extract_emails(resp.text)
    except Exception:
        return []


def lookup_broker(key, info, total):
    fn = info['first']
    ln = info['last']
    co = info['company']
    name = f"{fn} {ln}"
    found_email = None

    queries = [
        f'"{name}" "{co}" email' if co else f'"{name}" real estate email',
        f'"{name}" {co} contact',
    ]

    for q in queries:
        if found_email: break
        soup = ddg_search(q)
        if not soup: continue

        # Extract text from DDG result containers
        snippets = []
        for div in soup.find_all(class_=re.compile(r'result__body|web-result|results_links')):
            snippets.append(div.get_text(' ', strip=True))
        combined = ' '.join(snippets) or soup.get_text(' ', strip=True)[:30000]

        emails = extract_emails(combined)
        for e in emails:
            if email_matches(e, fn, ln, co):
                found_email = e
                break

        # If not in snippets, visit top 3 result URLs
        if not found_email:
            result_urls = []
            # DDG result__a links contain real URLs directly
            for a in soup.find_all('a', class_='result__a', href=True):
                href = a['href']
                # Handle DDG redirect //duckduckgo.com/l/?uddg=<encoded>
                if href.startswith('//duckduckgo.com/l/') or href.startswith('/l/'):
                    m = re.search(r'uddg=([^&]+)', href)
                    if m:
                        real = urllib.parse.unquote(m.group(1))
                        if real.startswith('http'):
                            result_urls.append(real)
                elif href.startswith('http'):
                    result_urls.append(href)

            # Filter out junk sites
            skip = ['linkedin.com','facebook.com','youtube.com','wikipedia.org',
                    'yelp.com','rocketreach.co','zoominfo.com','contactout.com',
                    'leadiq.com','signalhire.com','lusha.com','saleshandy.com',
                    'apollo.io','lead411','crunchbase','bloomberg.com',
                    'loopnet.com','costar.com','realtor.com','zillow.com']
            filtered = []
            for u in result_urls:
                low = u.lower()
                if any(s in low for s in skip): continue
                filtered.append(u)

            for u in filtered[:4]:
                page_emails = scrape_page(u)
                for e in page_emails:
                    if email_matches(e, fn, ln, co):
                        found_email = e
                        break
                if found_email: break
                time.sleep(0.3)

        time.sleep(1)

    # Update stats
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
            progress[key]['source'] = 'DDG'
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
    print(f"DuckDuckGo pass: {total} missing brokers, 4 threads\n", flush=True)

    start = time.time()
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = [pool.submit(lookup_broker, k, v, total) for k, v in to_retry]
        for f in as_completed(futures):
            pass

    elapsed = time.time() - start
    total_with = sum(1 for v in json.load(open(PROGRESS_PATH)).values() if v.get('email'))
    print(f"\n=== DDG pass done in {elapsed/60:.1f} min ===", flush=True)
    print(f"New this pass: {stats['found']}")
    print(f"Total with email: {total_with}/{len(progress)}")


if __name__ == '__main__':
    main()
