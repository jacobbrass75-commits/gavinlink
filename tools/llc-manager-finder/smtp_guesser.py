#!/usr/bin/env python3
"""
SMTP Email Guesser
-------------------
Finds emails by generating common email patterns and verifying they exist via SMTP.
No web scraping needed. Directly queries mail servers.

For uncommon names, this is extremely accurate.
For common names (John Smith), we flag results as lower confidence.

Usage:
    python3 smtp_guesser.py --progress progress.json --workers 8
"""

import json, re, time, smtplib, socket, threading, sys
import dns.resolver
from collections import Counter

PROGRESS_PATH = None
WORKERS = 8
VERIFY_TIMEOUT = 8

progress_lock = threading.Lock()
print_lock = threading.Lock()

# Common first names that produce false positives
COMMON_FIRST = {
    'james','john','robert','michael','david','william','richard','joseph','thomas',
    'charles','christopher','daniel','matthew','anthony','mark','donald','steven',
    'paul','andrew','joshua','kenneth','kevin','brian','george','timothy','ronald',
    'edward','jason','jeffrey','ryan','jacob','gary','nicholas','eric','jonathan',
    'stephen','larry','justin','scott','brandon','benjamin','samuel','raymond',
    'gregory','frank','alexander','patrick','jack','dennis','jerry','tyler',
    'mary','patricia','jennifer','linda','barbara','elizabeth','susan','jessica',
    'sarah','karen','lisa','nancy','betty','margaret','sandra','ashley','kimberly',
    'emily','donna','michelle','dorothy','carol','amanda','melissa','deborah',
    'stephanie','rebecca','sharon','laura','cynthia','kathleen','amy','angela',
    'shirley','anna','brenda','pamela','emma','nicole','helen','samantha','katherine',
    'christine','debra','rachel','carolyn','janet','catherine','maria','heather',
    'diane','ruth','julie','olivia','joyce','virginia','victoria','kelly','lauren',
}

COMMON_LAST = {
    'smith','johnson','williams','brown','jones','garcia','miller','davis','rodriguez',
    'martinez','hernandez','lopez','gonzalez','wilson','anderson','thomas','taylor',
    'moore','jackson','martin','lee','perez','thompson','white','harris','sanchez',
    'clark','ramirez','lewis','robinson','walker','young','allen','king','wright',
    'scott','torres','nguyen','hill','flores','green','adams','nelson','baker',
    'hall','rivera','campbell','mitchell','carter','roberts','gomez','phillips',
    'evans','turner','diaz','parker','cruz','edwards','collins','reyes','stewart',
    'morris','morales','murphy','cook','rogers','gutierrez','ortiz','morgan',
    'cooper','peterson','bailey','reed','kelly','howard','ramos','kim','cox',
    'ward','richardson','watson','brooks','chavez','wood','james','bennett',
    'gray','mendoza','ruiz','hughes','price','alvarez','castillo','sanders',
    'patel','myers','long','ross','foster','jimenez','powell','jenkins','perry',
    'russell','sullivan','bell','coleman','butler','henderson','barnes','gonzales',
    'fisher','vasquez','simmons','graham','murray','ford','castro',
}

# MX cache
mx_cache = {}
mx_lock = threading.Lock()
catchall_cache = {}


def get_mx(domain):
    with mx_lock:
        if domain in mx_cache:
            return mx_cache[domain]
    try:
        answers = dns.resolver.resolve(domain, 'MX')
        mx_records = sorted(answers, key=lambda x: x.preference)
        mx_host = str(mx_records[0].exchange).rstrip('.')
        with mx_lock:
            mx_cache[domain] = mx_host
        return mx_host
    except:
        with mx_lock:
            mx_cache[domain] = None
        return None


def is_catchall(domain):
    with mx_lock:
        if domain in catchall_cache:
            return catchall_cache[domain]
    mx = get_mx(domain)
    if not mx:
        with mx_lock:
            catchall_cache[domain] = True
        return True
    try:
        smtp = smtplib.SMTP(timeout=VERIFY_TIMEOUT)
        smtp.connect(mx, 25)
        smtp.helo('mail.google.com')
        smtp.mail('verify@gmail.com')
        code, _ = smtp.rcpt(f'zzxwqjkm99999@{domain}')
        smtp.quit()
        result = (code == 250)
        with mx_lock:
            catchall_cache[domain] = result
        return result
    except:
        with mx_lock:
            catchall_cache[domain] = True
        return True


def smtp_verify_batch(emails, domain):
    """Verify multiple emails on one SMTP connection. Returns {email: exists}."""
    mx = get_mx(domain)
    if not mx:
        return {}
    if is_catchall(domain):
        return {}  # can't distinguish on catch-all

    results = {}
    try:
        smtp = smtplib.SMTP(timeout=VERIFY_TIMEOUT)
        smtp.connect(mx, 25)
        smtp.helo('mail.google.com')
        smtp.mail('verify@gmail.com')
        for email in emails:
            try:
                code, _ = smtp.rcpt(email)
                results[email] = (code == 250)
            except:
                results[email] = None
            time.sleep(0.2)
        smtp.quit()
    except:
        pass
    return results


def generate_perms(first, last, domain):
    """Generate email permutations for a person."""
    f, l = first.lower(), last.lower()
    fi, li = f[0], l[0]
    return [
        f"{f}.{l}@{domain}",
        f"{f}{l}@{domain}",
        f"{fi}{l}@{domain}",
        f"{f}@{domain}",
        f"{fi}.{l}@{domain}",
        f"{f}_{l}@{domain}",
        f"{l}.{f}@{domain}",
        f"{l}{fi}@{domain}",
        f"{f}{li}@{domain}",
    ]


def name_is_common(first, last):
    """Check if a name is too common for SMTP guessing to be reliable."""
    return first.lower() in COMMON_FIRST and last.lower() in COMMON_LAST


def process_manager(name, llc, domains_to_try):
    """Try SMTP verification for a person across multiple email domains."""
    parts = name.split()
    if len(parts) < 2:
        return None, None
    first = parts[0]
    last = parts[-1]

    # Skip very common name combinations for generic domains
    common = name_is_common(first, last)

    for domain in domains_to_try:
        # For common names on generic domains, only try first.last (most distinctive)
        if common and domain in ('gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com'):
            perms = [f"{first.lower()}.{last.lower()}@{domain}"]
        else:
            perms = generate_perms(first, last, domain)

        results = smtp_verify_batch(perms, domain)
        for email, exists in results.items():
            if exists:
                confidence = 'low' if common else 'high'
                return email, confidence

    return None, None


def worker(worker_id, work_queue, progress, counters, total):
    """Worker thread that processes managers from the queue."""
    # Domains to try in order of priority
    domains = ['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com']

    while True:
        with progress_lock:
            if not work_queue:
                break
            item = work_queue.pop(0)
            idx = total - len(work_queue)

        llc, mgr_idx, name = item

        email, confidence = process_manager(name, llc, domains)

        if email:
            with progress_lock:
                progress[llc]['managers'][mgr_idx]['email'] = email
                progress[llc]['managers'][mgr_idx]['email_source'] = f'smtp_guess_{confidence}'
                counters['found'] += 1

            with print_lock:
                tag = ' [LOW CONF]' if confidence == 'low' else ''
                print(f"[W{worker_id}][{idx}/{total}] {name} -> {email}{tag}", flush=True)

        with progress_lock:
            counters['processed'] += 1
            if counters['processed'] % 25 == 0:
                with open(PROGRESS_PATH, 'w') as f:
                    json.dump(progress, f, indent=2)
                with print_lock:
                    print(f"  --- saved | {counters['processed']}/{total} done | {counters['found']} found ---",
                          flush=True)


def main():
    global PROGRESS_PATH, WORKERS

    import argparse
    parser = argparse.ArgumentParser(description='SMTP Email Guesser')
    parser.add_argument('--progress', required=True)
    parser.add_argument('--workers', type=int, default=8)
    args = parser.parse_args()

    PROGRESS_PATH = args.progress
    WORKERS = args.workers

    with open(PROGRESS_PATH) as f:
        progress = json.load(f)

    # Build work queue: managers missing emails
    work_queue = []
    for llc, info in progress.items():
        for i, m in enumerate(info.get('managers', [])):
            if not m.get('email') and len(m.get('name', '').split()) >= 2:
                work_queue.append((llc, i, m['name']))

    total = len(work_queue)
    if not total:
        print("All managers have emails!")
        return

    # Check catchall status for common domains first
    print("Checking mail server capabilities...")
    for domain in ['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com']:
        ca = is_catchall(domain)
        mx = get_mx(domain)
        print(f"  {domain}: MX={mx}, catchall={'YES (skip)' if ca else 'NO (can verify)'}")

    print(f"\nManagers to check: {total}")
    print(f"Workers: {WORKERS}")
    print(f"Estimated checks: {total * 9 * 4}")
    print()

    counters = {'found': 0, 'processed': 0}

    threads = []
    for i in range(WORKERS):
        t = threading.Thread(target=worker, args=(i+1, work_queue, progress, counters, total))
        t.start()
        threads.append(t)
        time.sleep(0.5)

    for t in threads:
        t.join()

    with open(PROGRESS_PATH, 'w') as f:
        json.dump(progress, f, indent=2)

    # Stats
    tm = sum(len(v.get('managers', [])) for v in progress.values())
    we = sum(1 for v in progress.values() for m in v.get('managers', []) if m.get('email'))
    wc = sum(1 for v in progress.values() for m in v.get('managers', []) if m.get('email') or m.get('phone'))
    print(f"\n=== DONE ===")
    print(f"New emails found: {counters['found']}")
    print(f"Total with email: {we}/{tm} ({100*we/tm:.1f}%)")
    print(f"Total with contact: {wc}/{tm} ({100*wc/tm:.1f}%)")


if __name__ == '__main__':
    main()
