#!/usr/bin/env python3
"""
Contact finder using Google search via Playwright headed browsers + xvfb.
Fresh server IP = no CAPTCHA history.
6 parallel browsers, each searching Google for manager contact info.
"""
import json, re, time, threading
from playwright.sync_api import sync_playwright
from concurrent.futures import ThreadPoolExecutor
from bs4 import BeautifulSoup

PROGRESS_PATH = "/root/progress.json"
NUM_WORKERS = 6

progress_lock = threading.Lock()
print_lock = threading.Lock()


def extract_emails(text):
    found = re.findall(r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}', text)
    bad = ['google','example','noreply','sentry','email.com','domain','w3.org','schema.org',
           'googleapis','gstatic','microsoft','bing','outlook.com','hotmail','yahoo.com',
           'aol.com','mail.com','protonmail','icloud','live.com','sampleemail',
           'facebook.com','twitter.com','instagram.com','yelp.com','.gov',
           'your@','user@','test@','name@','address@','feedback@','support@',
           'admin@','webmaster@','abuse@','spam@','mailer-daemon','no-reply','donotreply']
    return [e for e in set(found) if not any(x in e.lower() for x in bad) and 5 < len(e) < 60]


def extract_phones(text):
    phones = re.findall(r'(?:\+?1[-.\s]?)?\(?(\d{3})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})', text)
    return list(set(''.join(p) for p in phones if len(set(''.join(p))) > 2))


def search_google(page, name, llc_name):
    """Search Google for a person's contact info."""
    contact = {'email': None, 'phone': None, 'linkedin': None}

    queries = [
        f'"{name}" "{llc_name}" email phone California',
        f'"{name}" property manager California email contact',
    ]

    for qi, query in enumerate(queries):
        try:
            url = f"https://www.google.com/search?q={query.replace(' ', '+')}&num=20&hl=en&gl=us"
            page.goto(url, wait_until='networkidle', timeout=20000)
            time.sleep(2)

            text = page.inner_text('body')

            # Check for CAPTCHA
            if 'unusual traffic' in text.lower() or 'captcha' in text.lower():
                time.sleep(30)
                page.goto(url, wait_until='networkidle', timeout=20000)
                time.sleep(2)
                text = page.inner_text('body')
                if 'unusual traffic' in text.lower():
                    return contact

            emails = extract_emails(text)
            phones = extract_phones(text)

            if emails and not contact['email']:
                contact['email'] = emails[0]
            if phones and not contact['phone']:
                contact['phone'] = phones[0]

            # LinkedIn from links
            links = page.evaluate("""
                Array.from(document.querySelectorAll('a'))
                    .map(a => a.href)
                    .filter(h => h.indexOf('linkedin.com/in/') >= 0)
            """)
            if links and not contact['linkedin']:
                contact['linkedin'] = links[0]

            # If found something, try clicking into result pages for more
            if not contact['email'] and not contact['phone']:
                result_urls = page.evaluate("""
                    var links = document.querySelectorAll('div.g a');
                    var urls = [];
                    links.forEach(function(a) {
                        var h = a.href;
                        if (h && !h.includes('google.com') && !h.includes('youtube.com') &&
                            !h.includes('wikipedia.org') && !h.includes('facebook.com') &&
                            !h.includes('linkedin.com') && !h.includes('yelp.com')) {
                            urls.push(h);
                        }
                    });
                    urls.slice(0, 4);
                """)
                for rurl in (result_urls or [])[:3]:
                    try:
                        page.goto(rurl, wait_until='networkidle', timeout=8000)
                        rtext = page.inner_text('body')
                        pe = extract_emails(rtext)
                        pp = extract_phones(rtext)
                        if pe and not contact['email']:
                            contact['email'] = pe[0]
                        if pp and not contact['phone']:
                            contact['phone'] = pp[0]
                        if contact['email'] or contact['phone']:
                            break
                    except:
                        pass
                    time.sleep(0.3)

            if contact['email'] or contact['phone']:
                return contact

        except Exception as e:
            pass

        time.sleep(3)

    return contact


def worker(worker_id, work_queue, progress, counters, total):
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=False,
            args=['--disable-blink-features=AutomationControlled', '--no-sandbox']
        )
        context = browser.new_context(
            user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            viewport={'width': 1920, 'height': 1080},
            locale='en-US',
        )
        page = context.new_page()
        page.add_init_script("""
Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
window.chrome = {runtime: {}};
""")

        # Accept Google cookie consent
        try:
            page.goto('https://www.google.com', wait_until='networkidle', timeout=15000)
            time.sleep(2)
            # Try clicking accept buttons (various languages)
            for sel in ['button#L2AGLb', 'button[id="L2AGLb"]', 'button:has-text("Accept")',
                        'button:has-text("Akzeptieren")', 'button:has-text("Accept all")',
                        'button:has-text("Alle akzeptieren")', 'button:has-text("I agree")']:
                try:
                    btn = page.query_selector(sel)
                    if btn:
                        btn.click()
                        time.sleep(2)
                        break
                except:
                    pass
            with print_lock:
                print(f"[W{worker_id}] Google cookies accepted", flush=True)
        except:
            pass

        while True:
            with progress_lock:
                item = None
                while work_queue:
                    candidate = work_queue.pop(0)
                    llc, mgr_idx, name = candidate
                    mgr = progress[llc]['managers'][mgr_idx]
                    if not mgr.get('email') and not mgr.get('phone'):
                        item = candidate
                        break
                if item is None:
                    break
                idx = total - len(work_queue)

            llc, mgr_idx, name = item

            try:
                contact = search_google(page, name, llc)

                if contact.get('email') or contact.get('phone'):
                    with progress_lock:
                        progress[llc]['managers'][mgr_idx]['email'] = contact.get('email')
                        progress[llc]['managers'][mgr_idx]['phone'] = contact.get('phone')
                        progress[llc]['managers'][mgr_idx]['linkedin'] = contact.get('linkedin')
                        counters['found'] += 1

                    with print_lock:
                        print(f"[W{worker_id}][{idx}/{total}] {name} -> email={contact.get('email')} phone={contact.get('phone')}", flush=True)
                else:
                    with print_lock:
                        print(f"[W{worker_id}][{idx}/{total}] {name} -> nothing", flush=True)

            except Exception as e:
                with print_lock:
                    print(f"[W{worker_id}][{idx}/{total}] {name} -> ERROR: {e}", flush=True)

            with progress_lock:
                counters['processed'] += 1
                if counters['processed'] % 25 == 0:
                    with open(PROGRESS_PATH, 'w') as f:
                        json.dump(progress, f, indent=2)
                    with print_lock:
                        print(f"  --- saved | {counters['processed']} done | {counters['found']} found ---", flush=True)

            time.sleep(8)  # 8s between searches per worker, x6 workers = high throughput

        browser.close()


def main():
    with open(PROGRESS_PATH) as f:
        progress = json.load(f)

    work_queue = []
    for llc, info in progress.items():
        for i, m in enumerate(info.get('managers', [])):
            if not m.get('email') and not m.get('phone') and len(m.get('name', '').split()) >= 2:
                work_queue.append((llc, i, m['name']))

    total = len(work_queue)
    if total == 0:
        print("All managers already have contacts!")
        return

    print(f"Managers to search: {total}")
    print(f"Running {NUM_WORKERS} parallel Google searches\n")

    counters = {'found': 0, 'processed': 0}

    threads = []
    for i in range(NUM_WORKERS):
        t = threading.Thread(target=worker, args=(i+1, work_queue, progress, counters, total))
        t.start()
        threads.append(t)
        time.sleep(3)

    for t in threads:
        t.join()

    with open(PROGRESS_PATH, 'w') as f:
        json.dump(progress, f, indent=2)

    wc = sum(1 for v in progress.values() for m in v.get('managers', []) if m.get('email') or m.get('phone'))
    tm = sum(len(v.get('managers', [])) for v in progress.values())
    print(f"\n=== DONE ===")
    print(f"New contacts: {counters['found']}")
    print(f"Total with contacts: {wc}/{tm}")


if __name__ == '__main__':
    main()
