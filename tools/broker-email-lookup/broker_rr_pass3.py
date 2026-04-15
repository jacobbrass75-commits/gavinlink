#!/usr/bin/env python3
"""
Parallel fast pass: 3 threads, single-strategy RR lookup, global rate limiter.
Strategy: name + California only (no employer filter, relies on email validation).
"""
import json, re, time, os, threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from collections import deque
import requests
from paths import PROGRESS_PATH

RR_KEY = os.environ["ROCKETREACH_API_KEY"]

PERSONAL = {'gmail.com','yahoo.com','hotmail.com','aol.com','outlook.com',
    'sbcglobal.net','verizon.net','ca.rr.com','bellsouth.net',
    'earthlink.net','icloud.com','me.com','live.com','comcast.net',
    'msn.com','att.net','pacbell.net','cox.net','mac.com','mail.com',
    'protonmail.com','ymail.com','rocketmail.com'}


class RateLimiter:
    """Token bucket: allow N calls per window seconds."""
    def __init__(self, max_calls, window):
        self.max_calls = max_calls
        self.window = window
        self.calls = deque()
        self.lock = threading.Lock()

    def acquire(self):
        while True:
            with self.lock:
                now = time.time()
                # Drop calls outside window
                while self.calls and self.calls[0] < now - self.window:
                    self.calls.popleft()
                if len(self.calls) < self.max_calls:
                    self.calls.append(now)
                    return
                # Wait for oldest call to age out
                wait = self.calls[0] + self.window - now
            time.sleep(max(wait, 0.1))


# RR limit is 30/min — stay conservative at 25/min
limiter = RateLimiter(25, 60)

progress_lock = threading.Lock()
stats = {'found': 0, 'checked': 0, 'errors': 0, 'not_found': 0}
stats_lock = threading.Lock()


def normalize_co(co):
    co = re.sub(r'[^a-z0-9\s]', ' ', co.lower())
    stopwords = {'inc','llc','corp','the','of','and','real','estate','group','realty','commercial','properties','investments','co','company','llp','ltd','intl','international'}
    return ' '.join(w for w in co.split() if w and w not in stopwords)


def company_matches(q, r):
    if not q or not r: return False
    qs = set(normalize_co(q).split())
    rs = set(normalize_co(r).split())
    overlap = qs & rs
    return any(len(w) >= 4 for w in overlap)


def email_matches(email, first, last, company):
    if not email or '@' not in email: return False
    el = email.lower()
    f = first.lower().split()[0] if first else ''
    l = last.lower().split()[-1] if last else ''
    if f and f in el: return True
    if l and l in el: return True
    if company:
        cw = normalize_co(company).split()
        d = el.split('@')[1]
        for w in cw:
            if len(w) >= 4 and w in d:
                return True
    return False


def rr_call(method, url, **kwargs):
    """Make a RR API call with global rate limiting."""
    limiter.acquire()
    try:
        if method == 'POST':
            return requests.post(url, timeout=15, **kwargs)
        else:
            return requests.get(url, timeout=15, **kwargs)
    except Exception as e:
        return None


def lookup_broker(key, info):
    """Lookup one broker. Returns (key, result_dict_or_None)."""
    fn = info['first']
    ln = info['last']
    co = info['company']
    name = f"{fn} {ln}"
    headers = {"Api-Key": RR_KEY, "Content-Type": "application/json"}

    # Strategy 1: name + California
    try:
        resp = rr_call('POST',
            "https://api.rocketreach.co/v2/api/search",
            headers=headers,
            json={"query": {"name": [name], "location": ["California"]}})
        if resp is None:
            with stats_lock: stats['errors'] += 1
            return key, None
        if resp.status_code == 429:
            time.sleep(30)
            return key, None
        if resp.status_code not in (200, 201):
            return key, None
        profiles = resp.json().get('profiles', [])
        if not profiles:
            return key, None

        # Pick best match: prefer company match, else take top
        best = None
        for prof in profiles[:5]:
            rc = prof.get('current_employer','') or ''
            rt = prof.get('current_title','') or ''
            if company_matches(co, rc) or company_matches(co, rt):
                best = prof
                break
        if not best and len(profiles) == 1:
            best = profiles[0]
        if not best:
            return key, None

        pid = best.get('id')
        if not pid:
            return key, None

        # Lookup full profile
        r2 = rr_call('GET',
            "https://api.rocketreach.co/v2/api/person/lookup",
            headers={"Api-Key": RR_KEY}, params={"id": pid})
        if r2 is None or r2.status_code != 200:
            return key, None

        d = r2.json()
        emails = d.get('emails', [])
        valid = [e['email'] for e in emails if isinstance(e, dict) and e.get('smtp_valid') != 'invalid']
        email = valid[0] if valid else (emails[0]['email'] if emails and isinstance(emails[0], dict) else None)
        if not email or not email_matches(email, fn, ln, co):
            return key, None

        phones = d.get('phones', [])
        phone = phones[0].get('number') if phones and isinstance(phones[0], dict) else None
        return key, {
            'email': email,
            'phone': phone,
            'linkedin': d.get('linkedin_url'),
            'source': 'RocketReach-Pass3'
        }
    except Exception as e:
        with stats_lock: stats['errors'] += 1
        return key, None


def worker_task(key, info, progress, total):
    key_out, result = lookup_broker(key, info)
    with stats_lock:
        stats['checked'] += 1
        done = stats['checked']
    if result and result.get('email'):
        with progress_lock:
            progress[key_out].update(result)
        with stats_lock:
            stats['found'] += 1
        print(f"  [{done}/{total}] ✓ {info['first']} {info['last']} ({info['company'][:30]}) -> {result['email']}", flush=True)
    else:
        with stats_lock:
            stats['not_found'] += 1
        if done % 25 == 0:
            print(f"  [{done}/{total}] ... ({stats['found']} found, {stats['errors']} errors)", flush=True)

    # Save progress every 20 found
    if done % 20 == 0:
        with progress_lock:
            with open(PROGRESS_PATH, 'w') as f:
                json.dump(progress, f, indent=2)


def main():
    with open(PROGRESS_PATH) as f:
        progress = json.load(f)

    to_retry = [(k, v) for k, v in progress.items()
                if not v.get('email') and v.get('first') and v.get('last')]
    total = len(to_retry)
    print(f"Parallel pass 3: {total} brokers, 3 threads, rate limit 25/min")
    print(f"Strategy: name + California (no employer filter), validate against company\n", flush=True)

    start = time.time()
    with ThreadPoolExecutor(max_workers=3) as pool:
        futures = [pool.submit(worker_task, k, v, progress, total) for k, v in to_retry]
        for f in as_completed(futures):
            pass

    # Final save
    with open(PROGRESS_PATH, 'w') as f:
        json.dump(progress, f, indent=2)

    elapsed = time.time() - start
    total_with = sum(1 for v in progress.values() if v.get('email'))
    print(f"\n=== Pass 3 complete in {elapsed/60:.1f} min ===", flush=True)
    print(f"Found: {stats['found']} new")
    print(f"Errors: {stats['errors']}")
    print(f"Total with email: {total_with}/{len(progress)}")


if __name__ == '__main__':
    main()
