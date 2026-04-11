#!/usr/bin/env python3
"""
Contact Intelligence Engine
----------------------------
RocketReach-comparable contact finder using free public sources.

Core techniques:
1. Domain Discovery - finds websites/domains for LLCs via multi-engine search
2. Email Permutation - generates 12+ email pattern guesses per person
3. SMTP Verification - verifies if email addresses actually exist (no sending)
4. Catch-all Detection - avoids false positives on catch-all mail servers
5. Multi-Engine Deep Search - Bing, DuckDuckGo, Yahoo, Brave in parallel
6. Website Scraping - crawls contact/about/team pages for emails and phones
7. LinkedIn Discovery - finds LinkedIn profiles via search engine dorks
8. CA DRE Lookup - searches CA real estate license database

Usage:
    python3 contact_engine.py --progress progress.json --workers 8
    python3 contact_engine.py --progress progress.json --phase smtp   # just SMTP verify
    python3 contact_engine.py --progress progress.json --phase search # just web search

Requirements:
    pip install requests beautifulsoup4 dnspython
"""

import json, re, time, csv, os, sys, argparse, smtplib, socket, ssl
import threading, random, hashlib
import dns.resolver
import requests
from bs4 import BeautifulSoup
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import quote_plus, urlparse
from collections import defaultdict

# ─── Config ──────────────────────────────────────────────────────────
DEFAULT_WORKERS = 8
SMTP_TIMEOUT = 10
SEARCH_DELAY = 4       # seconds between searches per thread
VERIFY_DELAY = 0.3     # seconds between SMTP checks
MAX_PERMUTATIONS = 15   # email guesses per person per domain

UA_LIST = [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2.1 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
]

# Email domains that are generic (not useful for company pattern detection)
GENERIC_EMAIL_DOMAINS = {
    'gmail.com','yahoo.com','hotmail.com','outlook.com','aol.com','icloud.com',
    'mail.com','protonmail.com','live.com','msn.com','ymail.com','comcast.net',
    'att.net','sbcglobal.net','verizon.net','cox.net','charter.net','earthlink.net',
    'me.com','mac.com','rocketmail.com','aim.com','zoho.com','fastmail.com',
    'tutanota.com','pm.me','hey.com','proton.me',
}

# Junk email patterns
JUNK_EMAIL_PATTERNS = [
    'google','example','noreply','sentry','email.com','domain','w3.org','schema.org',
    'googleapis','gstatic','microsoft','bing.com','outlook.com','sampleemail',
    'facebook.com','twitter.com','instagram.com','yelp.com','.gov',
    'your@','user@','test@','name@','address@','feedback@','support@',
    'admin@','webmaster@','abuse@','spam@','mailer-daemon','no-reply','donotreply',
    'info@','contact@','sales@','service@','help@','hello@','team@','office@',
    'privacy@','legal@','compliance@','billing@','accounts@','hr@','jobs@',
    'press@','media@','marketing@','enquiries@','enquiry@','general@',
    'placeholder','wix.com','squarespace','wordpress','godaddy',
]

progress_lock = threading.Lock()
print_lock = threading.Lock()


# ═══════════════════════════════════════════════════════════════════════
# PHASE 1: Email Extraction & Validation
# ═══════════════════════════════════════════════════════════════════════

def extract_emails(text):
    """Extract emails from text, filtering obvious junk."""
    found = re.findall(r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}', text)
    return [e for e in set(found)
            if not any(x in e.lower() for x in JUNK_EMAIL_PATTERNS)
            and 5 < len(e) < 60
            and '..' not in e]


def extract_phones(text):
    """Extract phone numbers, filtering junk."""
    phones = re.findall(r'(?:\+?1[-.\s]?)?\(?(\d{3})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})', text)
    results = []
    for p in phones:
        num = ''.join(p)
        # Filter junk
        if len(set(num)) <= 2:
            continue
        if num[:2] == '20' and len(num) == 10:  # date-like
            continue
        if num[:3] in ('800','888','877','866','855','844','833'):  # toll-free
            continue
        if num[:3] == '999' or num[:3] == '000':
            continue
        if num == '0000000000':
            continue
        results.append(num)
    return list(set(results))


def score_email(email, first_name, last_name):
    """Score an email by how likely it belongs to the target person. Higher = better."""
    score = 0
    local = email.split('@')[0].lower()
    first = first_name.lower()
    last = last_name.lower()

    if first in local:
        score += 5
    if last in local:
        score += 5
    if first[0] in local and last in local:
        score += 3
    # Penalize generic patterns
    domain = email.split('@')[1].lower()
    if domain in GENERIC_EMAIL_DOMAINS:
        score += 1  # personal email is OK, just less confident
    else:
        score += 2  # company email = higher confidence

    return score


def best_email(emails, first_name, last_name):
    """Pick the best email from a list based on name matching."""
    if not emails:
        return None
    scored = [(score_email(e, first_name, last_name), e) for e in emails]
    scored.sort(reverse=True)
    # Only return if score > 0 (has some name relevance)
    if scored[0][0] > 0:
        return scored[0][1]
    return scored[0][1]  # return best even if no name match


# ═══════════════════════════════════════════════════════════════════════
# PHASE 2: SMTP Email Verification
# ═══════════════════════════════════════════════════════════════════════

class SMTPVerifier:
    """Verifies email addresses exist via SMTP protocol without sending mail."""

    def __init__(self):
        self.mx_cache = {}
        self.catchall_cache = {}
        self.lock = threading.Lock()

    def get_mx(self, domain):
        """Get MX server for a domain (cached)."""
        with self.lock:
            if domain in self.mx_cache:
                return self.mx_cache[domain]

        try:
            answers = dns.resolver.resolve(domain, 'MX')
            # Sort by priority, pick lowest (highest priority)
            mx_records = sorted(answers, key=lambda x: x.preference)
            mx_host = str(mx_records[0].exchange).rstrip('.')
            with self.lock:
                self.mx_cache[domain] = mx_host
            return mx_host
        except Exception:
            with self.lock:
                self.mx_cache[domain] = None
            return None

    def is_catchall(self, domain):
        """Check if domain is catch-all (accepts any email)."""
        with self.lock:
            if domain in self.catchall_cache:
                return self.catchall_cache[domain]

        mx_host = self.get_mx(domain)
        if not mx_host:
            with self.lock:
                self.catchall_cache[domain] = None  # can't determine
            return None

        # Try a random email that definitely doesn't exist
        random_local = f"zxqjkwmv{random.randint(10000,99999)}"
        fake_email = f"{random_local}@{domain}"

        result = self._smtp_check(mx_host, fake_email, domain)
        with self.lock:
            self.catchall_cache[domain] = result
        return result

    def verify(self, email):
        """
        Verify if an email exists via SMTP.
        Returns: True (exists), False (rejected), None (inconclusive)
        """
        domain = email.split('@')[1]
        mx_host = self.get_mx(domain)
        if not mx_host:
            return None

        # Check catch-all first
        catchall = self.is_catchall(domain)
        if catchall:
            return None  # can't distinguish real from fake on catch-all

        return self._smtp_check(mx_host, email, domain)

    def _smtp_check(self, mx_host, email, domain):
        """Low-level SMTP RCPT TO check."""
        try:
            smtp = smtplib.SMTP(timeout=SMTP_TIMEOUT)
            smtp.connect(mx_host, 25)
            smtp.helo('mail.google.com')
            smtp.mail(f'verify@gmail.com')
            code, msg = smtp.rcpt(email)
            smtp.quit()
            if code == 250:
                return True
            elif code == 550 or code == 551 or code == 553:
                return False
            else:
                return None  # inconclusive
        except smtplib.SMTPServerDisconnected:
            return None
        except smtplib.SMTPConnectError:
            return None
        except socket.timeout:
            return None
        except Exception:
            return None

    def verify_batch(self, emails):
        """Verify multiple emails for the same domain efficiently."""
        if not emails:
            return {}
        domain = emails[0].split('@')[1]
        mx_host = self.get_mx(domain)
        if not mx_host:
            return {e: None for e in emails}

        catchall = self.is_catchall(domain)
        if catchall:
            return {e: None for e in emails}

        results = {}
        try:
            smtp = smtplib.SMTP(timeout=SMTP_TIMEOUT)
            smtp.connect(mx_host, 25)
            smtp.helo('mail.google.com')
            smtp.mail('verify@gmail.com')
            for email in emails:
                try:
                    code, msg = smtp.rcpt(email)
                    results[email] = (code == 250)
                    time.sleep(VERIFY_DELAY)
                except Exception:
                    results[email] = None
            smtp.quit()
        except Exception:
            for email in emails:
                if email not in results:
                    results[email] = None
        return results


# ═══════════════════════════════════════════════════════════════════════
# PHASE 3: Email Permutation
# ═══════════════════════════════════════════════════════════════════════

def generate_email_permutations(first, last, domain):
    """Generate common email address patterns for a person at a domain."""
    f = first.lower().strip()
    l = last.lower().strip()
    fi = f[0] if f else ''
    li = l[0] if l else ''

    if not f or not l:
        return []

    perms = [
        f"{f}.{l}@{domain}",       # john.smith@
        f"{f}{l}@{domain}",         # johnsmith@
        f"{fi}{l}@{domain}",        # jsmith@
        f"{f}@{domain}",            # john@
        f"{l}@{domain}",            # smith@
        f"{fi}.{l}@{domain}",       # j.smith@
        f"{f}_{l}@{domain}",        # john_smith@
        f"{l}.{f}@{domain}",        # smith.john@
        f"{l}{fi}@{domain}",        # smithj@
        f"{f}{li}@{domain}",        # johns@
        f"{fi}{li}@{domain}",       # js@  (unlikely but common at small cos)
        f"{f}-{l}@{domain}",        # john-smith@
        f"{l}{f}@{domain}",         # smithjohn@
        f"{fi}_{l}@{domain}",       # j_smith@
        f"{f}.{li}@{domain}",       # john.s@
    ]
    return perms[:MAX_PERMUTATIONS]


def detect_email_pattern(known_emails, domain):
    """
    Given known emails at a domain, detect the naming pattern.
    Returns a pattern function that generates emails for new names.
    """
    domain_emails = [e for e in known_emails if e.split('@')[1].lower() == domain.lower()]
    if not domain_emails:
        return None

    # Analyze local parts
    patterns_seen = []
    for email in domain_emails:
        local = email.split('@')[0].lower()
        if '.' in local:
            parts = local.split('.')
            if len(parts) == 2:
                if len(parts[0]) == 1:
                    patterns_seen.append('fi.last')   # j.smith
                elif len(parts[1]) == 1:
                    patterns_seen.append('first.li')  # john.s
                else:
                    patterns_seen.append('first.last')  # john.smith
        elif '_' in local:
            patterns_seen.append('first_last')
        elif '-' in local:
            patterns_seen.append('first-last')
        else:
            # No separator - could be flast, firstl, first, last, firstlast
            patterns_seen.append('nosep')

    if not patterns_seen:
        return None

    # Return most common pattern
    from collections import Counter
    most_common = Counter(patterns_seen).most_common(1)[0][0]

    def pattern_func(first, last):
        f, l = first.lower(), last.lower()
        fi, li = f[0], l[0]
        templates = {
            'first.last': f"{f}.{l}@{domain}",
            'fi.last': f"{fi}.{l}@{domain}",
            'first.li': f"{f}.{li}@{domain}",
            'first_last': f"{f}_{l}@{domain}",
            'first-last': f"{f}-{l}@{domain}",
            'nosep': f"{fi}{l}@{domain}",
        }
        return templates.get(most_common, f"{f}.{l}@{domain}")

    return pattern_func


# ═══════════════════════════════════════════════════════════════════════
# PHASE 4: Domain Discovery
# ═══════════════════════════════════════════════════════════════════════

def discover_domain(llc_name, session):
    """Find the website domain for an LLC."""
    # Clean LLC name for searching
    clean = re.sub(r'\b(LLC|L\.L\.C\.?|INC|CORP|CORPORATION|COMPANY|CO|LTD|LP|L\.P\.)\b',
                   '', llc_name, flags=re.IGNORECASE).strip()
    clean = re.sub(r'[,.]', '', clean).strip()

    if not clean or len(clean) < 3:
        return None

    domains_found = []

    # Method 1: Bing search for website
    try:
        q = quote_plus(f'"{clean}" California property website')
        resp = session.get(f'https://www.bing.com/search?q={q}&count=10',
                          headers={'User-Agent': random.choice(UA_LIST)}, timeout=12)
        if resp.status_code == 200:
            soup = BeautifulSoup(resp.text, 'html.parser')
            for a in soup.select('li.b_algo h2 a'):
                href = a.get('href', '')
                if href.startswith('http'):
                    parsed = urlparse(href)
                    domain = parsed.netloc.lower().replace('www.', '')
                    if domain and domain not in GENERIC_EMAIL_DOMAINS and \
                       not any(x in domain for x in ['bing.','google.','yahoo.','facebook.',
                               'linkedin.','yelp.','yellowpages.','bbb.','wikipedia.',
                               'sos.ca.gov','bizfile','youtube.','twitter.','instagram.',
                               'zillow.','trulia.','realtor.com','apartments.','loopnet.']):
                        domains_found.append(domain)
    except Exception:
        pass

    # Method 2: DuckDuckGo
    try:
        q = quote_plus(f'{clean} California property management website')
        resp = session.get(f'https://html.duckduckgo.com/html/?q={q}',
                          headers={'User-Agent': random.choice(UA_LIST)}, timeout=12)
        if resp.status_code == 200:
            soup = BeautifulSoup(resp.text, 'html.parser')
            for a in soup.select('a.result__a'):
                href = a.get('href', '')
                if 'uddg=' in href:
                    # DDG wraps URLs
                    from urllib.parse import parse_qs
                    parsed_q = parse_qs(urlparse(href).query)
                    href = parsed_q.get('uddg', [href])[0]
                parsed = urlparse(href)
                domain = parsed.netloc.lower().replace('www.', '')
                if domain and domain not in GENERIC_EMAIL_DOMAINS and \
                   not any(x in domain for x in ['duckduckgo.','google.','bing.','yahoo.',
                           'facebook.','linkedin.','yelp.','wikipedia.','youtube.',
                           'twitter.','instagram.','zillow.','trulia.','realtor.com']):
                    domains_found.append(domain)
    except Exception:
        pass

    # Deduplicate, prefer shorter domains (more likely to be the main site)
    seen = []
    for d in domains_found:
        if d not in seen:
            seen.append(d)
    return seen[:5] if seen else None


def scrape_website_contacts(domain, session):
    """Crawl a website's contact-related pages for emails and phones."""
    emails = []
    phones = []
    pages_to_try = [
        f'https://{domain}/',
        f'https://{domain}/contact',
        f'https://{domain}/contact-us',
        f'https://{domain}/about',
        f'https://{domain}/about-us',
        f'https://{domain}/team',
        f'https://{domain}/our-team',
        f'https://{domain}/staff',
        f'https://www.{domain}/',
        f'https://www.{domain}/contact',
        f'https://www.{domain}/about',
    ]

    for url in pages_to_try:
        try:
            resp = session.get(url, headers={'User-Agent': random.choice(UA_LIST)},
                             timeout=8, allow_redirects=True)
            if resp.status_code == 200 and len(resp.text) > 500:
                text = resp.text
                pe = extract_emails(text)
                pp = extract_phones(text)
                emails.extend(pe)
                phones.extend(pp)
                # Also check for emails in mailto: links
                soup = BeautifulSoup(text, 'html.parser')
                for a in soup.select('a[href^="mailto:"]'):
                    href = a.get('href', '').replace('mailto:', '').split('?')[0].strip()
                    if '@' in href and href not in emails:
                        emails.append(href)
        except Exception:
            pass
        time.sleep(0.5)

    return list(set(emails)), list(set(phones))


# ═══════════════════════════════════════════════════════════════════════
# PHASE 5: Multi-Engine Web Search
# ═══════════════════════════════════════════════════════════════════════

def search_bing(session, query):
    """Search Bing and return text + URLs."""
    try:
        q = quote_plus(query)
        resp = session.get(f'https://www.bing.com/search?q={q}&count=20',
                          headers={'User-Agent': random.choice(UA_LIST)}, timeout=12)
        if resp.status_code == 200:
            soup = BeautifulSoup(resp.text, 'html.parser')
            text = soup.get_text(' ', strip=True)
            urls = []
            for a in soup.select('li.b_algo h2 a'):
                href = a.get('href', '')
                if href.startswith('http'):
                    urls.append(href)
            return text, urls
    except Exception:
        pass
    return '', []


def search_duckduckgo(session, query):
    """Search DuckDuckGo HTML version."""
    try:
        q = quote_plus(query)
        resp = session.get(f'https://html.duckduckgo.com/html/?q={q}',
                          headers={'User-Agent': random.choice(UA_LIST)}, timeout=12)
        if resp.status_code == 200:
            soup = BeautifulSoup(resp.text, 'html.parser')
            text = soup.get_text(' ', strip=True)
            urls = []
            for a in soup.select('a.result__a'):
                href = a.get('href', '')
                if 'uddg=' in href:
                    from urllib.parse import parse_qs
                    parsed_q = parse_qs(urlparse(href).query)
                    href = parsed_q.get('uddg', [href])[0]
                if href.startswith('http'):
                    urls.append(href)
            return text, urls
    except Exception:
        pass
    return '', []


def search_yahoo(session, query):
    """Search Yahoo."""
    try:
        q = quote_plus(query)
        resp = session.get(f'https://search.yahoo.com/search?p={q}&n=20',
                          headers={'User-Agent': random.choice(UA_LIST)}, timeout=12)
        if resp.status_code == 200:
            soup = BeautifulSoup(resp.text, 'html.parser')
            text = soup.get_text(' ', strip=True)
            urls = []
            for a in soup.select('h3 a'):
                href = a.get('href', '')
                if href.startswith('http'):
                    urls.append(href)
            return text, urls
    except Exception:
        pass
    return '', []


def search_brave(session, query):
    """Search Brave."""
    try:
        q = quote_plus(query)
        resp = session.get(f'https://search.brave.com/search?q={q}',
                          headers={'User-Agent': random.choice(UA_LIST),
                                   'Accept': 'text/html,application/xhtml+xml'},
                          timeout=12)
        if resp.status_code == 200:
            soup = BeautifulSoup(resp.text, 'html.parser')
            text = soup.get_text(' ', strip=True)
            urls = []
            for a in soup.select('a.result-header'):
                href = a.get('href', '')
                if href.startswith('http'):
                    urls.append(href)
            return text, urls
    except Exception:
        pass
    return '', []


def deep_search_person(name, llc_name, first, last, session):
    """
    Multi-engine deep search for a person's contact info.
    Returns dict with email, phone, linkedin.
    """
    contact = {'email': None, 'phone': None, 'linkedin': None}
    all_emails = []
    all_phones = []
    all_urls = []

    # Build diverse query list
    queries = [
        f'"{name}" email @ California',
        f'"{name}" "{llc_name}" email phone contact',
        f'"{name}" property manager California email',
        f'"{first}.{last}" OR "{first}{last}" OR "{first[0]}{last}" @',
        f'"{name}" real estate California contact',
        f'site:linkedin.com/in/ "{name}" California',
        f'"{name}" @gmail.com OR @yahoo.com California property',
        f'"{name}" "{llc_name}" phone',
    ]

    engines = [
        ('bing', search_bing),
        ('ddg', search_duckduckgo),
        ('yahoo', search_yahoo),
        ('brave', search_brave),
    ]

    queries_done = 0
    for query in queries:
        # Rotate engines
        engine_name, engine_func = engines[queries_done % len(engines)]
        text, urls = engine_func(session, query)
        queries_done += 1

        if text:
            pe = extract_emails(text)
            pp = extract_phones(text)
            all_emails.extend(pe)
            all_phones.extend(pp)

            # LinkedIn from search results
            if not contact['linkedin']:
                for url in urls:
                    if 'linkedin.com/in/' in url:
                        contact['linkedin'] = url
                        break

        all_urls.extend(urls)
        time.sleep(SEARCH_DELAY)

        # Early exit if we found good stuff
        if len(all_emails) >= 2 and len(all_phones) >= 1:
            break

    # Scrape promising result URLs for more contact info
    scraped = 0
    for url in all_urls[:6]:
        if any(x in url for x in ['google.','bing.','yahoo.','duckduckgo.',
                                   'youtube.','wikipedia.','facebook.',
                                   'twitter.','instagram.','brave.com']):
            continue
        try:
            resp = session.get(url, headers={'User-Agent': random.choice(UA_LIST)},
                             timeout=8, allow_redirects=True)
            if resp.status_code == 200 and len(resp.text) > 500:
                pe = extract_emails(resp.text)
                pp = extract_phones(resp.text)
                all_emails.extend(pe)
                all_phones.extend(pp)
                scraped += 1
                if scraped >= 3:
                    break
        except Exception:
            pass
        time.sleep(0.5)

    # Pick best email
    if all_emails:
        contact['email'] = best_email(list(set(all_emails)), first, last)

    # Pick first valid phone
    if all_phones:
        contact['phone'] = all_phones[0]

    return contact


# ═══════════════════════════════════════════════════════════════════════
# PHASE 6: CA DRE License Lookup
# ═══════════════════════════════════════════════════════════════════════

def search_dre(name, session):
    """Search CA Department of Real Estate for a person's license info."""
    try:
        parts = name.split()
        if len(parts) < 2:
            return None

        # DRE public license search - uses LICENSEE_NAME field
        url = 'https://www2.dre.ca.gov/PublicASP/pplinfo.asp'
        data = {
            'h_nextstep': 'SEARCH',
            'LICENSEE_NAME': name,
            'CITY_STATE': 'California',
            'LICENSE_ID': '',
        }
        resp = session.post(url, data=data,
                           headers={'User-Agent': random.choice(UA_LIST),
                                    'Referer': url},
                           timeout=15)
        if resp.status_code == 200:
            text = resp.text
            # Check if we got actual results (not just the search form)
            if 'ppldetail' in text.lower() or 'license type' in text.lower() or \
               'salesperson' in text.lower() or 'broker' in text.lower():
                emails = extract_emails(text)
                phones = extract_phones(text)
                # Try to follow detail links for more info
                soup = BeautifulSoup(text, 'html.parser')
                for a in soup.select('a[href*="ppldetail"]'):
                    try:
                        detail_url = 'https://www2.dre.ca.gov/PublicASP/' + a['href']
                        dresp = session.get(detail_url,
                                          headers={'User-Agent': random.choice(UA_LIST)},
                                          timeout=10)
                        if dresp.status_code == 200:
                            de = extract_emails(dresp.text)
                            dp = extract_phones(dresp.text)
                            emails.extend(de)
                            phones.extend(dp)
                    except:
                        pass
                if emails or phones:
                    return {'emails': emails, 'phones': phones, 'found': True}
    except Exception:
        pass
    return None


# ═══════════════════════════════════════════════════════════════════════
# MAIN ENGINE
# ═══════════════════════════════════════════════════════════════════════

class ContactEngine:
    """Orchestrates all contact-finding phases."""

    def __init__(self, progress_path, workers=DEFAULT_WORKERS):
        self.progress_path = progress_path
        self.workers = workers
        self.verifier = SMTPVerifier()
        self.domain_cache = {}      # LLC -> [domains]
        self.pattern_cache = {}     # domain -> pattern_func
        self.known_emails = defaultdict(list)  # domain -> [emails]

        with open(progress_path) as f:
            self.progress = json.load(f)

        # Build known email index
        for llc, info in self.progress.items():
            for m in info.get('managers', []):
                if m.get('email'):
                    domain = m['email'].split('@')[1].lower()
                    self.known_emails[domain].append(m['email'])

    def save(self):
        """Save progress to disk."""
        with open(self.progress_path, 'w') as f:
            json.dump(self.progress, f, indent=2)

    def get_targets(self, need_email=False, need_any=False):
        """Get list of managers that still need contact info."""
        targets = []
        for llc, info in self.progress.items():
            for i, m in enumerate(info.get('managers', [])):
                name = m.get('name', '')
                if len(name.split()) < 2:
                    continue
                if need_email and not m.get('email'):
                    targets.append((llc, i, m))
                elif need_any and not m.get('email') and not m.get('phone'):
                    targets.append((llc, i, m))
                elif not need_email and not need_any and (not m.get('email') or not m.get('phone')):
                    targets.append((llc, i, m))
        return targets

    def stats(self):
        """Print current contact statistics."""
        tm = sum(len(v.get('managers', [])) for v in self.progress.values())
        we = sum(1 for v in self.progress.values() for m in v.get('managers', []) if m.get('email'))
        wp = sum(1 for v in self.progress.values() for m in v.get('managers', []) if m.get('phone'))
        wc = sum(1 for v in self.progress.values() for m in v.get('managers', []) if m.get('email') or m.get('phone'))
        wl = sum(1 for v in self.progress.values() for m in v.get('managers', []) if m.get('linkedin'))
        print(f"\n{'='*50}")
        print(f"  Total managers:     {tm}")
        print(f"  With email:         {we} ({100*we/tm:.1f}%)")
        print(f"  With phone:         {wp} ({100*wp/tm:.1f}%)")
        print(f"  With either:        {wc} ({100*wc/tm:.1f}%)")
        print(f"  With LinkedIn:      {wl}")
        print(f"  With nothing:       {tm-wc}")
        print(f"{'='*50}\n")

    # ─── Phase: LinkedIn Employer Discovery ────────────────────────

    def run_linkedin_discovery(self):
        """
        Find LinkedIn profiles via search engines, extract employer/company
        from snippets, then discover company domains for SMTP verification.
        This is the core RocketReach technique.
        """
        targets = self.get_targets(need_email=True)
        if not targets:
            print("[LINKEDIN DISCOVERY] All managers have emails!")
            return

        print(f"\n[LINKEDIN DISCOVERY] Finding employers for {len(targets)} managers via LinkedIn...")
        total = len(targets)
        counters = {'found_profile': 0, 'found_domain': 0, 'processed': 0}

        def worker(items):
            session = requests.Session()
            for llc, mgr_idx, mgr in items:
                name = mgr['name']
                parts = name.split()
                first, last = parts[0], parts[-1]

                # Step 1: Find LinkedIn profile and extract employer from snippet
                employer, linkedin_url, snippet_emails = self._find_linkedin_employer(
                    name, first, last, llc, session)

                with progress_lock:
                    counters['processed'] += 1
                    idx = counters['processed']

                    if linkedin_url and not self.progress[llc]['managers'][mgr_idx].get('linkedin'):
                        self.progress[llc]['managers'][mgr_idx]['linkedin'] = linkedin_url
                        counters['found_profile'] += 1

                    # If we found emails in snippets, grab them
                    if snippet_emails and not self.progress[llc]['managers'][mgr_idx].get('email'):
                        be = best_email(snippet_emails, first, last)
                        if be:
                            self.progress[llc]['managers'][mgr_idx]['email'] = be
                            self.progress[llc]['managers'][mgr_idx]['email_source'] = 'linkedin_snippet'

                    # Step 2: If we found an employer, discover their domain
                    if employer:
                        domain = self._discover_employer_domain(employer, session)
                        if domain:
                            # Cache for SMTP verification phase
                            mgr_key = f"{llc}:{mgr_idx}"
                            self.domain_cache[mgr_key] = [domain]
                            counters['found_domain'] += 1
                            with print_lock:
                                print(f"  [{idx}/{total}] {name} -> {employer} -> {domain}", flush=True)
                        else:
                            with print_lock:
                                print(f"  [{idx}/{total}] {name} -> {employer} (no domain)", flush=True)
                    else:
                        if idx % 20 == 0:
                            with print_lock:
                                print(f"  [{idx}/{total}] profiles={counters['found_profile']} domains={counters['found_domain']}", flush=True)

                    if idx % 100 == 0:
                        self.save()

                time.sleep(3)

        chunk_size = max(1, len(targets) // self.workers)
        chunks = [targets[i:i+chunk_size] for i in range(0, len(targets), chunk_size)]

        threads = []
        for chunk in chunks:
            t = threading.Thread(target=worker, args=(chunk,))
            t.start()
            threads.append(t)
            time.sleep(1)
        for t in threads:
            t.join()

        self.save()
        print(f"[LINKEDIN DISCOVERY] Profiles: {counters['found_profile']}, Domains: {counters['found_domain']}")

    def _find_linkedin_employer(self, name, first, last, llc, session):
        """Search for person's LinkedIn profile, extract employer from snippets AND profile page."""
        employer = None
        linkedin_url = None
        snippet_emails = []

        # Junk employer names to filter
        junk_employers = {
            'linkedin','california','los angeles','property','people','sign in',
            'will access','access','full profile','view profile','connect',
            'see all','join now','log in','more','professional','results',
            'profiles','experience','education','skills','see who','members',
            'united states','greater','area','metropolitan','summary',
        }

        queries = [
            (search_bing, f'site:linkedin.com/in "{name}" California'),
            (search_duckduckgo, f'site:linkedin.com/in "{name}" California property'),
            (search_bing, f'"{name}" property manager California company'),
        ]

        for engine_func, query in queries:
            text, urls = engine_func(session, query)

            # Extract LinkedIn URL
            if not linkedin_url:
                for url in urls:
                    if 'linkedin.com/in/' in url:
                        linkedin_url = url.split('?')[0]
                        break

            # Extract employer from snippet text
            if text and not employer:
                # Pattern: "Name - Title at Company"
                matches = re.findall(
                    r'(?:at|@)\s+([A-Z][A-Za-z0-9 &,.\'-]{2,40}?)(?:\s*[\|·\-–]|\s+LinkedIn|\s+California|\.\s)',
                    text)
                for emp in matches:
                    emp = emp.strip().rstrip('.')
                    if len(emp) > 2 and emp.lower() not in junk_employers and \
                       not any(j in emp.lower() for j in junk_employers):
                        employer = emp
                        break

                # Pattern: "Name | Title | Company | LinkedIn"
                if not employer:
                    pipe_parts = re.findall(r'\|\s*([A-Za-z0-9 &,.\'-]+?)\s*\|', text)
                    for part in pipe_parts:
                        part = part.strip()
                        if len(part) > 3 and part.lower() not in junk_employers and \
                           not any(j in part.lower() for j in junk_employers) and \
                           part[0].isupper():
                            employer = part
                            break

            # Grab emails from search results
            pe = extract_emails(text) if text else []
            snippet_emails.extend(pe)

            if linkedin_url and employer:
                break
            time.sleep(3)

        # If we found a LinkedIn URL but no employer, try scraping the public profile
        if linkedin_url and not employer:
            try:
                resp = session.get(linkedin_url,
                                  headers={'User-Agent': random.choice(UA_LIST)},
                                  timeout=10, allow_redirects=True)
                if resp.status_code == 200:
                    # LinkedIn public profiles show headline in page title and meta tags
                    soup = BeautifulSoup(resp.text, 'html.parser')
                    # Title: "Name - Title - Company | LinkedIn"
                    title = soup.title.string if soup.title else ''
                    if title:
                        # "John Smith - Property Manager - ABC Company | LinkedIn"
                        parts_t = [p.strip() for p in re.split(r'[\|–\-]', title)]
                        for part in parts_t[1:]:  # skip the name
                            if part.lower() not in junk_employers and \
                               not any(j in part.lower() for j in junk_employers) and \
                               len(part) > 3:
                                employer = part
                                break
                    # Also check og:title meta
                    og = soup.find('meta', property='og:title')
                    if og and not employer:
                        og_parts = [p.strip() for p in re.split(r'[\|–\-]', og.get('content', ''))]
                        for part in og_parts[1:]:
                            if part.lower() not in junk_employers and \
                               not any(j in part.lower() for j in junk_employers) and \
                               len(part) > 3:
                                employer = part
                                break
                    # Grab emails from profile page
                    pe = extract_emails(resp.text)
                    snippet_emails.extend(pe)
            except Exception:
                pass

        # Fallback: search for person + "property manager" to find their company
        if not employer:
            try:
                text2, urls2 = search_bing(session, f'"{name}" property manager company California')
                if text2:
                    pe = extract_emails(text2)
                    snippet_emails.extend(pe)
                    # Try to extract company from results
                    matches = re.findall(
                        r'(?:at|with|of|for)\s+([A-Z][A-Za-z0-9 &,.\'-]{3,35}?)(?:\s*[\|·\-,.]|\s+in\b|\s+California|\s*$)',
                        text2)
                    for emp in matches:
                        emp = emp.strip().rstrip('.')
                        if len(emp) > 3 and emp.lower() not in junk_employers and \
                           not any(j in emp.lower() for j in junk_employers):
                            employer = emp
                            break
            except:
                pass

        return employer, linkedin_url, snippet_emails

    def _discover_employer_domain(self, employer, session):
        """Find website domain for an employer/company name."""
        clean = re.sub(r'\b(LLC|Inc|Corp|Ltd|LP|Group|Company|Co)\b', '', employer,
                       flags=re.IGNORECASE).strip()
        if not clean or len(clean) < 3:
            return None

        # Try Bing
        try:
            text, urls = search_bing(session, f'"{clean}" official website')
            for url in urls[:5]:
                parsed = urlparse(url)
                domain = parsed.netloc.lower().replace('www.', '')
                if domain and domain not in GENERIC_EMAIL_DOMAINS and \
                   not any(x in domain for x in ['bing.','google.','yahoo.','linkedin.',
                           'facebook.','yelp.','wikipedia.','youtube.','zillow.',
                           'glassdoor.','indeed.','twitter.']):
                    return domain
        except:
            pass

        return None

    # ─── Phase: Website Scraping (for discovered employer domains) ──

    def run_website_scraping(self):
        """Scrape discovered employer websites for contact info."""
        if not self.domain_cache:
            print("[WEBSITE SCRAPING] No domains discovered, skipping.")
            return

        unique_domains = list(set(d for domains in self.domain_cache.values() for d in domains))
        print(f"\n[WEBSITE SCRAPING] Scraping {len(unique_domains)} employer websites...")
        session = requests.Session()
        scraped_contacts = {}

        for i, domain in enumerate(unique_domains):
            if domain in scraped_contacts:
                continue
            emails, phones = scrape_website_contacts(domain, session)
            if emails or phones:
                scraped_contacts[domain] = {'emails': emails, 'phones': phones}
                for e in emails:
                    d = e.split('@')[1].lower()
                    self.known_emails[d].append(e)
                with print_lock:
                    print(f"  [{i+1}/{len(unique_domains)}] {domain} -> {len(emails)} emails, {len(phones)} phones", flush=True)

        # Match scraped contacts to managers
        matched = 0
        for key, domains in self.domain_cache.items():
            if ':' not in key:
                continue
            llc, mgr_idx_str = key.rsplit(':', 1)
            mgr_idx = int(mgr_idx_str)
            if llc not in self.progress:
                continue
            mgrs = self.progress[llc].get('managers', [])
            if mgr_idx >= len(mgrs):
                continue
            m = mgrs[mgr_idx]
            if m.get('email'):
                continue
            parts = m.get('name', '').split()
            if len(parts) < 2:
                continue
            first, last = parts[0].lower(), parts[-1].lower()
            for domain in domains:
                if domain not in scraped_contacts:
                    continue
                sc = scraped_contacts[domain]
                for email in sc['emails']:
                    local = email.split('@')[0].lower()
                    if first in local or last in local:
                        m['email'] = email
                        m['email_source'] = 'employer_website'
                        matched += 1
                        break
                if not m.get('phone') and sc['phones']:
                    m['phone'] = sc['phones'][0]

        self.save()
        print(f"[WEBSITE SCRAPING] Matched {matched} contacts from employer websites")

    # ─── Phase: SMTP Verification ───────────────────────────────────

    def run_smtp_verification(self):
        """Generate email permutations and verify via SMTP on employer domains."""
        targets = self.get_targets(need_email=True)
        if not targets:
            print("[SMTP VERIFY] All managers have emails!")
            return

        # Count how many have employer domains
        with_domain = sum(1 for llc, idx, _ in targets if f"{llc}:{idx}" in self.domain_cache)
        print(f"\n[SMTP VERIFY] Verifying emails for {len(targets)} managers...")
        print(f"  {with_domain} have employer domains from LinkedIn discovery")
        print(f"  Known email patterns for {len(self.known_emails)} domains")

        verified = 0
        checked = 0

        for idx, (llc, mgr_idx, mgr) in enumerate(targets):
            name = mgr['name']
            parts = name.split()
            first, last = parts[0], parts[-1]

            # Get domains to try
            domains_to_try = []

            # 1. Employer domain from LinkedIn discovery
            mgr_key = f"{llc}:{mgr_idx}"
            if mgr_key in self.domain_cache:
                domains_to_try.extend(self.domain_cache[mgr_key])

            if not domains_to_try:
                # No employer domain found, skip SMTP for this person
                if (idx + 1) % 100 == 0:
                    with print_lock:
                        print(f"  [{idx+1}/{len(targets)}] {checked} checked, {verified} verified", flush=True)
                continue

            found_email = None
            for domain in domains_to_try:
                # Check if we know the pattern for this domain
                if domain in self.known_emails and self.known_emails[domain]:
                    pattern_func = detect_email_pattern(self.known_emails[domain], domain)
                    if pattern_func:
                        patterned = pattern_func(first, last)
                        result = self.verifier.verify(patterned)
                        checked += 1
                        if result is True:
                            found_email = patterned
                            break

                # Try permutations via SMTP
                perms = generate_email_permutations(first, last, domain)
                results = self.verifier.verify_batch(perms[:10])
                checked += len(results)
                for email, exists in results.items():
                    if exists is True:
                        found_email = email
                        break
                if found_email:
                    break

            if found_email:
                with progress_lock:
                    self.progress[llc]['managers'][mgr_idx]['email'] = found_email
                    self.progress[llc]['managers'][mgr_idx]['email_source'] = 'smtp_verified'
                verified += 1
                with print_lock:
                    print(f"  [{idx+1}/{len(targets)}] {name} -> {found_email} (SMTP VERIFIED)", flush=True)
            else:
                if (idx + 1) % 50 == 0:
                    with print_lock:
                        print(f"  [{idx+1}/{len(targets)}] {checked} checked, {verified} verified", flush=True)

            if (idx + 1) % 100 == 0:
                self.save()

        self.save()
        print(f"[SMTP VERIFY] Verified {verified} emails ({checked} addresses checked)")

    # ─── Phase: Multi-Engine Search ─────────────────────────────────

    def run_deep_search(self):
        """Run multi-engine deep search for remaining managers."""
        targets = self.get_targets(need_any=True)
        if not targets:
            print("[DEEP SEARCH] All managers have contact info!")
            return

        print(f"\n[DEEP SEARCH] Searching {len(targets)} managers across 4 engines...")
        total = len(targets)
        counters = {'found': 0, 'processed': 0}

        def worker(items):
            session = requests.Session()
            for llc, mgr_idx, mgr in items:
                name = mgr['name']
                parts = name.split()
                first, last = parts[0], parts[-1]

                contact = deep_search_person(name, llc, first, last, session)

                if contact.get('email') or contact.get('phone'):
                    with progress_lock:
                        if contact.get('email') and not self.progress[llc]['managers'][mgr_idx].get('email'):
                            self.progress[llc]['managers'][mgr_idx]['email'] = contact['email']
                            self.progress[llc]['managers'][mgr_idx]['email_source'] = 'web_search'
                        if contact.get('phone') and not self.progress[llc]['managers'][mgr_idx].get('phone'):
                            self.progress[llc]['managers'][mgr_idx]['phone'] = contact['phone']
                        if contact.get('linkedin') and not self.progress[llc]['managers'][mgr_idx].get('linkedin'):
                            self.progress[llc]['managers'][mgr_idx]['linkedin'] = contact['linkedin']
                        counters['found'] += 1

                    with print_lock:
                        idx = counters['processed'] + 1
                        print(f"  [{idx}/{total}] {name} -> e={contact.get('email')} p={contact.get('phone')}", flush=True)

                with progress_lock:
                    counters['processed'] += 1
                    if counters['processed'] % 50 == 0:
                        self.save()
                        with print_lock:
                            print(f"  --- saved | {counters['processed']}/{total} | {counters['found']} found ---", flush=True)

        # Split work across threads
        chunk_size = max(1, len(targets) // self.workers)
        chunks = [targets[i:i+chunk_size] for i in range(0, len(targets), chunk_size)]

        threads = []
        for chunk in chunks:
            t = threading.Thread(target=worker, args=(chunk,))
            t.start()
            threads.append(t)
            time.sleep(1)

        for t in threads:
            t.join()

        self.save()
        print(f"[DEEP SEARCH] Found {counters['found']}/{total} contacts")

    # ─── Phase: DRE Lookup ──────────────────────────────────────────

    def run_dre_lookup(self):
        """Check CA DRE for licensed real estate professionals."""
        targets = self.get_targets(need_email=True)
        if not targets:
            print("[DRE LOOKUP] No targets need email.")
            return

        print(f"\n[DRE LOOKUP] Checking {len(targets)} managers in CA DRE database...")
        session = requests.Session()
        found = 0

        for idx, (llc, mgr_idx, mgr) in enumerate(targets):
            name = mgr['name']
            result = search_dre(name, session)

            if result and result.get('found'):
                parts = name.split()
                first, last = parts[0], parts[-1]

                if result.get('emails'):
                    be = best_email(result['emails'], first, last)
                    if be and not mgr.get('email'):
                        with progress_lock:
                            self.progress[llc]['managers'][mgr_idx]['email'] = be
                            self.progress[llc]['managers'][mgr_idx]['email_source'] = 'ca_dre'
                        found += 1
                        with print_lock:
                            print(f"  [{idx+1}] {name} -> {be} (DRE)", flush=True)

                if result.get('phones') and not mgr.get('phone'):
                    with progress_lock:
                        self.progress[llc]['managers'][mgr_idx]['phone'] = result['phones'][0]

            if (idx + 1) % 25 == 0:
                with print_lock:
                    print(f"  --- {idx+1}/{len(targets)} checked, {found} found ---")
            time.sleep(2)

        self.save()
        print(f"[DRE LOOKUP] Found {found} emails from DRE database")

    # ─── Phase: Email-focused search ────────────────────────────────

    def run_email_hunt(self):
        """Targeted email search using name-specific queries."""
        targets = self.get_targets(need_email=True)
        if not targets:
            print("[EMAIL HUNT] All managers have emails!")
            return

        print(f"\n[EMAIL HUNT] Hunting emails for {len(targets)} managers...")
        total = len(targets)
        counters = {'found': 0, 'processed': 0}

        def worker(items):
            session = requests.Session()
            for llc, mgr_idx, mgr in items:
                name = mgr['name']
                parts = name.split()
                first, last = parts[0], parts[-1]

                email = self._hunt_email(name, first, last, llc, session)

                if email:
                    with progress_lock:
                        self.progress[llc]['managers'][mgr_idx]['email'] = email
                        self.progress[llc]['managers'][mgr_idx]['email_source'] = 'email_hunt'
                        counters['found'] += 1

                    with print_lock:
                        idx = counters['processed'] + 1
                        print(f"  [{idx}/{total}] {name} -> {email}", flush=True)

                with progress_lock:
                    counters['processed'] += 1
                    if counters['processed'] % 50 == 0:
                        self.save()

        chunk_size = max(1, len(targets) // self.workers)
        chunks = [targets[i:i+chunk_size] for i in range(0, len(targets), chunk_size)]

        threads = []
        for chunk in chunks:
            t = threading.Thread(target=worker, args=(chunk,))
            t.start()
            threads.append(t)
            time.sleep(1)

        for t in threads:
            t.join()

        self.save()
        print(f"[EMAIL HUNT] Found {counters['found']}/{total} emails")

    def _hunt_email(self, name, first, last, llc_name, session):
        """Focused email search with 8 query variations and name scoring."""
        queries = [
            f'"{name}" email @',
            f'"{first}.{last}" OR "{first}{last}" OR "{first[0]}{last}" @ email',
            f'"{name}" @gmail.com OR @yahoo.com OR @outlook.com',
            f'"{name}" "{llc_name}" email',
            f'"{name}" property manager email California',
            f'"{name}" real estate agent email',
            f'"{name}" contact email address California',
            f'"{name}" LinkedIn email',
        ]

        all_emails = []
        engines = [search_bing, search_duckduckgo, search_yahoo, search_brave]

        for qi, query in enumerate(queries):
            engine = engines[qi % len(engines)]
            text, urls = engine(session, query)

            if text:
                pe = extract_emails(text)
                all_emails.extend(pe)

            # Scrape top result page if no emails yet
            if not all_emails and urls:
                for url in urls[:2]:
                    if any(x in url for x in ['google.','bing.','yahoo.','duckduckgo.',
                                               'youtube.','wikipedia.','brave.com']):
                        continue
                    try:
                        resp = session.get(url, headers={'User-Agent': random.choice(UA_LIST)},
                                         timeout=8)
                        if resp.status_code == 200:
                            pe = extract_emails(resp.text)
                            all_emails.extend(pe)
                    except:
                        pass
                    time.sleep(0.3)

            if all_emails:
                break  # found something, stop querying
            time.sleep(SEARCH_DELAY)

        if all_emails:
            return best_email(list(set(all_emails)), first, last)
        return None

    # ─── Run all phases ─────────────────────────────────────────────

    def run_all(self):
        """Run the full contact intelligence pipeline."""
        print("\n" + "="*60)
        print("  CONTACT INTELLIGENCE ENGINE")
        print("  RocketReach-comparable, zero cost")
        print("="*60)

        self.stats()

        # Phase 1: Multi-Engine Deep Search (4 engines x 8 queries per person)
        # This is the most productive phase - searches Bing, DDG, Yahoo, Brave
        self.run_deep_search()
        self.stats()

        # Phase 2: LinkedIn -> Employer -> Domain (the RocketReach pipeline)
        self.run_linkedin_discovery()
        self.stats()

        # Phase 3: Scrape employer websites for contact pages
        self.run_website_scraping()
        self.stats()

        # Phase 4: Email Permutation + SMTP Verification on employer domains
        self.run_smtp_verification()
        self.stats()

        # Phase 5: Targeted Email Hunt (email-specific queries for remaining)
        self.run_email_hunt()

        print("\n" + "="*60)
        print("  FINAL RESULTS")
        print("="*60)
        self.stats()
        self.save()


# ═══════════════════════════════════════════════════════════════════════
# CLI
# ═══════════════════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(description='Contact Intelligence Engine')
    parser.add_argument('--progress', required=True, help='Path to progress JSON file')
    parser.add_argument('--workers', type=int, default=DEFAULT_WORKERS, help='Parallel workers')
    parser.add_argument('--phase', choices=['linkedin','websites','smtp','dre','search','emails','all'],
                       default='all', help='Run specific phase')
    args = parser.parse_args()

    engine = ContactEngine(args.progress, workers=args.workers)

    if args.phase == 'all':
        engine.run_all()
    elif args.phase == 'linkedin':
        engine.run_linkedin_discovery()
        engine.stats()
    elif args.phase == 'websites':
        engine.run_linkedin_discovery()
        engine.run_website_scraping()
        engine.stats()
    elif args.phase == 'smtp':
        engine.run_linkedin_discovery()
        engine.run_smtp_verification()
        engine.stats()
    elif args.phase == 'dre':
        engine.run_dre_lookup()
        engine.stats()
    elif args.phase == 'search':
        engine.run_deep_search()
        engine.stats()
    elif args.phase == 'emails':
        engine.run_linkedin_discovery()
        engine.run_smtp_verification()
        engine.run_email_hunt()
        engine.stats()

    engine.save()


if __name__ == '__main__':
    main()
