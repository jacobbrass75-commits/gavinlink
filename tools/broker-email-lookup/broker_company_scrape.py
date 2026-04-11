#!/usr/bin/env python3
"""
Parallel company-website scraper for missing brokers.
10 threads, early domain termination, proximity-based name→email matching.
"""
import json, re, time, urllib.parse, threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from collections import defaultdict
import requests

PROGRESS_PATH = "/Users/josephsullivan/Downloads/broker_lookup_progress.json"
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2.1 Safari/605.1.15'

BAD_EMAIL_PATTERNS = ['noreply','no-reply','info@','support@','admin@','contact@',
                     'sales@','hello@','office@','team@','webmaster@','privacy@',
                     'abuse@','spam@','mailer-daemon','.jpg','.png','.css','.js',
                     'sentry','cloudflare','recaptcha','example.com','googleapis',
                     'gstatic','microsoft','wixpress','godaddy','squarespace',
                     'wordpress','wix.com','weebly','domain.com','yourdomain',
                     'yoursite','sampleemail','email@','name@']

TEAM_URL_PATHS = [
    '/team', '/our-team', '/agents', '/brokers', '/advisors',
    '/about', '/meet-the-team', '/people', '/staff', '/our-agents',
]

progress_lock = threading.Lock()
stats_lock = threading.Lock()
stats = {'found': 0, 'checked': 0}


def domain_guess_from_company(co):
    if not co: return []
    cleaned = re.sub(r'[^a-z0-9\s]', ' ', co.lower())
    cleaned = re.sub(r'\b(inc|llc|corp|the|of|and|real|estate|group|realty|commercial|properties|investments|co|company|llp|ltd|intl|international|advisors|partners|capital|holdings)\b', '', cleaned)
    words = [w for w in cleaned.split() if len(w) >= 2]
    if not words: return []
    guesses = []
    if len(words) >= 2:
        guesses.append(''.join(words[:3]))
        guesses.append(''.join(words[:2]))
    guesses.append(words[0])
    if len(words) >= 2:
        guesses.append(f"{words[0]}{words[1][0]}")
        guesses.append(f"{words[0]}-{words[1]}")
    return list(dict.fromkeys([g for g in guesses if len(g) >= 4]))


def fetch(url, timeout=7):
    try:
        r = requests.get(url, headers={'User-Agent': UA}, timeout=timeout, allow_redirects=True)
        return r if r.status_code == 200 else None
    except Exception:
        return None


def extract_name_email_pairs(html, brokers_to_match):
    results = {}
    all_emails = set(re.findall(r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}', html))
    if not all_emails:
        return results
    lower_html = html.lower()
    for key, first, last in brokers_to_match:
        full = f"{first} {last}"
        for search_name in [full, f"{first[0]}. {last}", last]:
            idx = lower_html.find(search_name.lower())
            if idx < 0: continue
            window = html[max(0, idx-1500):idx+3000]
            window_emails = re.findall(r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}', window)
            best_email = None
            best_score = -1
            for e in window_emails:
                el = e.lower()
                if any(p in el for p in BAD_EMAIL_PATTERNS): continue
                if len(e) < 6 or len(e) > 60: continue
                parts = e.split('.')
                if len(parts[-1]) > 5: continue
                if e.lower().endswith(('.jpg','.png','.css','.js','.ico','.gif','.webp','.svg')): continue
                score = 0
                fn_clean = re.sub(r'[^a-z]', '', first.lower().split()[0])
                ln_clean = re.sub(r'[^a-z]', '', last.lower().split()[-1])
                if fn_clean and len(fn_clean) >= 3 and fn_clean in el: score += 5
                if ln_clean and len(ln_clean) >= 3 and ln_clean in el: score += 10
                if fn_clean and len(fn_clean) >= 1 and len(el) > 0 and fn_clean[0] == el[0]: score += 1
                if score > best_score:
                    best_score = score
                    best_email = e
            if best_email and best_score >= 5:
                results[key] = best_email
                break
    return results


def process_company(company, brokers):
    """Try to scrape emails at a company. Returns dict of key → email."""
    if not company or not brokers:
        return {}

    found = {}
    guesses = domain_guess_from_company(company)
    if not guesses:
        return {}

    candidate_sites = []
    for g in guesses[:4]:
        candidate_sites.append(f"https://www.{g}.com")
        candidate_sites.append(f"https://{g}.com")

    site_found = False
    for base in candidate_sites:
        r = fetch(base, timeout=6)
        if not r:
            continue
        if len(r.text) < 500:
            continue

        # This domain works. Extract from home page first.
        site_found = True
        home_hits = extract_name_email_pairs(r.text, brokers)
        found.update(home_hits)

        remaining = [b for b in brokers if b[0] not in found]
        if remaining:
            for team_url in [base.rstrip('/') + p for p in TEAM_URL_PATHS[:6]]:
                if not remaining:
                    break
                r2 = fetch(team_url, timeout=6)
                if r2 and r2.status_code == 200 and len(r2.text) > 500:
                    new_hits = extract_name_email_pairs(r2.text, remaining)
                    for k, e in new_hits.items():
                        found[k] = e
                    remaining = [b for b in remaining if b[0] not in found]
        break  # Stop trying alternate domains once one works

    return found


def worker(company, brokers, total_companies):
    try:
        result = process_company(company, brokers)
    except Exception as e:
        result = {}

    with stats_lock:
        stats['checked'] += 1
        done = stats['checked']

    if result:
        with progress_lock:
            with open(PROGRESS_PATH) as f:
                progress = json.load(f)
            for k, email in result.items():
                progress[k]['email'] = email
                progress[k]['source'] = 'CompanySite'
                with stats_lock:
                    stats['found'] += 1
            with open(PROGRESS_PATH, 'w') as f:
                json.dump(progress, f, indent=2)
            for k, email in result.items():
                p = progress[k]
                print(f"  [{done}/{total_companies}] ✓ {p['first']} {p['last']} ({company[:30]}) -> {email}", flush=True)
    else:
        if done % 15 == 0:
            print(f"  [{done}/{total_companies}] ... ({stats['found']} found)", flush=True)


def main():
    with open(PROGRESS_PATH) as f:
        progress = json.load(f)

    missing_by_co = defaultdict(list)
    for key, info in progress.items():
        if not info.get('email') and info.get('first') and info.get('last'):
            co = info.get('company', '').strip()
            if co:  # skip empty-company rows
                missing_by_co[co].append((key, info['first'], info['last']))

    sorted_cos = sorted(missing_by_co.items(), key=lambda x: -len(x[1]))
    total = len(sorted_cos)
    total_brokers = sum(len(b) for _, b in sorted_cos)
    print(f"Parallel scrape: {total} companies, {total_brokers} missing brokers, 10 threads\n", flush=True)

    start = time.time()
    with ThreadPoolExecutor(max_workers=10) as pool:
        futures = [pool.submit(worker, co, brs, total) for co, brs in sorted_cos]
        for f in as_completed(futures):
            pass

    elapsed = time.time() - start
    total_with = sum(1 for v in json.load(open(PROGRESS_PATH)).values() if v.get('email'))
    print(f"\n=== Done in {elapsed/60:.1f} min ===", flush=True)
    print(f"New this pass: {stats['found']}")
    print(f"Total with email: {total_with}/{len(progress)}")


if __name__ == '__main__':
    main()
