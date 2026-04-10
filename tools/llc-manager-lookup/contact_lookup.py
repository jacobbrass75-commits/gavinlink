#!/usr/bin/env python3
"""
Contact lookup for LLC managers.
Phase 1: RocketReach + DuckDuckGo in parallel (20 threads)
Phase 2: Google via Safari for remaining (serial)
"""

import json, re, time, os, sys, csv, subprocess
import requests, urllib.parse
from bs4 import BeautifulSoup
from concurrent.futures import ThreadPoolExecutor, as_completed
import threading

PROGRESS_PATH = "/Users/josephsullivan/Downloads/llc_manager_progress.json"
CSV_PATH = "/Users/josephsullivan/Downloads/5+ unit farm.csv"
OUTPUT_PATH = "/Users/josephsullivan/Downloads/LLC_Managers_Contact_Info.xlsx"
RR_KEY = os.environ.get("ROCKETREACH_API_KEY", "")
HEADERS = {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'}

progress_lock = threading.Lock()
print_lock = threading.Lock()
rr_limited = threading.Event()


def extract_emails(text):
    found = re.findall(r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}', text)
    return [e for e in set(found) if not any(x in e.lower() for x in ['google','example','noreply','info@','support@','admin@','email.com','domain','sentry'])]

def extract_phones(text):
    phones = re.findall(r'(?:\+?1[-.\s]?)?\(?(\d{3})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})', text)
    return list(set(''.join(p) for p in phones))


# ── 1. RocketReach ──

def rocketreach_lookup(name, llc_name=''):
    if rr_limited.is_set():
        return None
    try:
        resp = requests.post(
            "https://api.rocketreach.co/v2/api/search",
            headers={"Api-Key": RR_KEY, "Content-Type": "application/json"},
            json={"query": {"name": [name], "location": ["California"]}},
            timeout=15
        )
        if resp.status_code == 429:
            rr_limited.set()
            return None
        if resp.status_code in (200, 201):
            profiles = resp.json().get('profiles', [])
            if profiles:
                pid = profiles[0].get('id')
                if pid:
                    time.sleep(0.5)
                    r2 = requests.get(
                        "https://api.rocketreach.co/v2/api/person/lookup",
                        headers={"Api-Key": RR_KEY},
                        params={"id": pid}, timeout=15
                    )
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

        # Try with employer
        if llc_name and not rr_limited.is_set():
            time.sleep(0.5)
            resp2 = requests.post(
                "https://api.rocketreach.co/v2/api/search",
                headers={"Api-Key": RR_KEY, "Content-Type": "application/json"},
                json={"query": {"name": [name], "current_employer": [llc_name]}},
                timeout=15
            )
            if resp2.status_code == 429:
                rr_limited.set()
                return None
            if resp2.status_code in (200, 201):
                profiles = resp2.json().get('profiles', [])
                if profiles:
                    pid = profiles[0].get('id')
                    if pid:
                        time.sleep(0.5)
                        r3 = requests.get(
                            "https://api.rocketreach.co/v2/api/person/lookup",
                            headers={"Api-Key": RR_KEY},
                            params={"id": pid}, timeout=15
                        )
                        if r3.status_code == 200:
                            d = r3.json()
                            emails = d.get('emails', [])
                            valid = [e['email'] for e in emails if isinstance(e, dict) and e.get('smtp_valid') != 'invalid']
                            email = valid[0] if valid else (emails[0]['email'] if emails and isinstance(emails[0], dict) else None)
                            phones = d.get('phones', [])
                            phone = phones[0].get('number') if phones and isinstance(phones[0], dict) else None
                            if email or phone:
                                return {'email': email, 'phone': phone, 'linkedin': d.get('linkedin_url')}
    except:
        pass
    return None


# ── 2. DuckDuckGo ──

def ddg_search(name, llc_name='', city=''):
    contact = {'email': None, 'phone': None, 'linkedin': None}

    queries = [
        f'"{name}" "{llc_name}" email phone',
        f'"{name}" {city or "California"} email phone real estate property manager',
        f'"{name}" "{llc_name}" contact',
    ]

    for query in queries:
        try:
            resp = requests.get(
                f"https://html.duckduckgo.com/html/?q={urllib.parse.quote(query)}",
                headers=HEADERS, timeout=10
            )
            soup = BeautifulSoup(resp.text, 'html.parser')

            for s in soup.find_all('a', class_='result__snippet'):
                text = s.text
                if not contact['email']:
                    emails = extract_emails(text)
                    if emails:
                        contact['email'] = emails[0]
                if not contact['phone']:
                    phones = extract_phones(text)
                    if phones:
                        contact['phone'] = phones[0]

            for a in soup.find_all('a', class_='result__a'):
                href = a.get('href', '')
                if 'linkedin.com/in/' in href:
                    m = re.search(r'uddg=([^&]+)', href)
                    if m:
                        contact['linkedin'] = urllib.parse.unquote(m.group(1))

            # Check contact/about pages
            for a in soup.find_all('a', class_='result__a'):
                href = a.get('href', '')
                m = re.search(r'uddg=([^&]+)', href)
                if m:
                    url = urllib.parse.unquote(m.group(1))
                    if any(x in url.lower() for x in ['contact', 'about', 'team', 'staff']):
                        try:
                            page = requests.get(url, headers=HEADERS, timeout=8)
                            if page.status_code == 200:
                                emails = extract_emails(page.text)
                                phones = extract_phones(page.text)
                                if emails and not contact['email']:
                                    contact['email'] = emails[0]
                                if phones and not contact['phone']:
                                    contact['phone'] = phones[0]
                        except:
                            pass

        except:
            pass

        if contact['email'] or contact['phone']:
            return contact
        time.sleep(1)

    return contact


# ── 3. Google via Safari ──

def sjs(js_code):
    with open('/tmp/_sjs_contact.js', 'w') as f:
        f.write(js_code)
    r = subprocess.run(['osascript'], input='''
set f to POSIX file "/tmp/_sjs_contact.js"
set c to read f as «class utf8»
tell application "Safari" to tell document 1 to do JavaScript c
''', capture_output=True, text=True, timeout=60)
    return r.stdout.strip()

def osa(script):
    r = subprocess.run(['osascript'], input=script, capture_output=True, text=True, timeout=60)
    return r.stdout.strip()

def google_safari_search(name, llc_name='', city=''):
    contact = {'email': None, 'phone': None, 'linkedin': None}

    queries = [
        f'"{name}" "{llc_name}" email phone California',
        f'"{name}" {city or "California"} property manager contact email phone',
    ]

    for query in queries:
        try:
            encoded_q = urllib.parse.quote(query)
            osa(f'tell application "Safari" to set URL of document 1 to "https://www.google.com/search?q={encoded_q}"')
            time.sleep(4)

            page_text = sjs("document.body.innerText;") or ''

            if 'unusual traffic' in page_text.lower() or 'captcha' in page_text.lower():
                time.sleep(30)
                continue

            emails = extract_emails(page_text)
            phones = extract_phones(page_text)
            if emails and not contact['email']:
                contact['email'] = emails[0]
            if phones and not contact['phone']:
                contact['phone'] = phones[0]

            links = sjs("Array.from(document.querySelectorAll('a')).map(function(a){return a.href}).filter(function(h){return h.indexOf('linkedin.com/in/')>=0}).join('|||');")
            if links:
                for link in links.split('|||'):
                    if 'linkedin.com/in/' in link:
                        contact['linkedin'] = link
                        break

            # Click into top results if needed
            if not contact['email'] and not contact['phone']:
                result_urls = sjs("""
                    var links = document.querySelectorAll('div.g a');
                    var urls = [];
                    links.forEach(function(a) {
                        var h = a.href;
                        if (h && !h.includes('google.com') && !h.includes('youtube.com') && !h.includes('wikipedia.org')) {
                            urls.push(h);
                        }
                    });
                    urls.slice(0, 5).join('|||');
                """)
                if result_urls:
                    for rurl in result_urls.split('|||')[:3]:
                        if not rurl:
                            continue
                        try:
                            page = requests.get(rurl, headers=HEADERS, timeout=8)
                            if page.status_code == 200:
                                emails = extract_emails(page.text)
                                phones = extract_phones(page.text)
                                if emails and not contact['email']:
                                    contact['email'] = emails[0]
                                if phones and not contact['phone']:
                                    contact['phone'] = phones[0]
                                if contact['email'] or contact['phone']:
                                    break
                        except:
                            pass
                        time.sleep(1)

        except:
            pass

        if contact['email'] or contact['phone']:
            return contact
        time.sleep(3)

    return contact


# ── Parallel worker for Phase 1 ──

def http_lookup_worker(item, cities):
    """RocketReach + DuckDuckGo for one manager. Returns (llc_name, mgr_idx, contact_dict or None)."""
    llc_name, mgr_idx, name = item
    city = cities.get(llc_name, '')
    contact = None

    # RocketReach first
    rr = rocketreach_lookup(name, llc_name)
    if rr and (rr.get('email') or rr.get('phone')):
        return (llc_name, mgr_idx, rr, 'RR')

    # DuckDuckGo second
    ddg = ddg_search(name, llc_name, city)
    if ddg.get('email') or ddg.get('phone'):
        return (llc_name, mgr_idx, ddg, 'DDG')

    return (llc_name, mgr_idx, None, None)


# ── Excel ──

def generate_excel(progress):
    import openpyxl
    from openpyxl.styles import Font

    with open(CSV_PATH, 'r') as f:
        rows = list(csv.DictReader(f))
    llc_data = {}
    for r in rows:
        owner = r['Owner Name'].strip()
        if 'llc' not in owner.lower():
            continue
        if owner not in llc_data:
            llc_data[owner] = {
                'properties': [],
                'mail_address': r.get('Mail Address', '').strip(),
                'mail_city': r.get('Mail Address City', '').strip(),
            }
        addr = f"{r.get('Site Address','').strip()}, {r.get('Site Address City','').strip()}"
        units = r.get('Number of Units', '')
        prop = f"{addr} ({units} units)" if units else addr
        if prop not in llc_data[owner]['properties']:
            llc_data[owner]['properties'].append(prop)

    wb = openpyxl.Workbook()
    headers = ['LLC Name', 'Properties', '# Properties', 'Mail Address', 'Mail City',
               'Manager Name', 'Email', 'Phone', 'LinkedIn', 'Agent Name', 'CEO']

    ws = wb.active
    ws.title = "With Contact Info"
    ws.append(headers)
    for c in ws[1]: c.font = Font(bold=True)
    cr = 0
    for llc, d in llc_data.items():
        p = progress.get(llc, {})
        for m in [m for m in p.get('managers', []) if m.get('email') or m.get('phone')]:
            ws.append([llc, "; ".join(d['properties']), len(d['properties']),
                       d['mail_address'], d['mail_city'], m.get('name',''), m.get('email',''),
                       m.get('phone',''), m.get('linkedin',''), p.get('agent',''), p.get('ceo','')])
            cr += 1

    ws2 = wb.create_sheet("All Managers")
    ws2.append(headers)
    for c in ws2[1]: c.font = Font(bold=True)
    ar = 0
    for llc, d in llc_data.items():
        p = progress.get(llc, {})
        for m in p.get('managers', []):
            ws2.append([llc, "; ".join(d['properties']), len(d['properties']),
                        d['mail_address'], d['mail_city'], m.get('name',''), m.get('email',''),
                        m.get('phone',''), m.get('linkedin',''), p.get('agent',''), p.get('ceo','')])
            ar += 1

    for s in [ws, ws2]:
        for col in s.columns:
            ml = max(len(str(c.value or '')[:50]) for c in col)
            s.column_dimensions[col[0].column_letter].width = min(ml + 2, 50)
    wb.save(OUTPUT_PATH)
    print(f"\nExcel saved: {OUTPUT_PATH}")
    print(f"Sheet 1 (with contact): {cr} rows | Sheet 2 (all managers): {ar} rows")


# ── Main ──

def main():
    with open(PROGRESS_PATH, 'r') as f:
        progress = json.load(f)

    cities = {}
    with open(CSV_PATH, 'r') as f:
        for r in csv.DictReader(f):
            owner = r['Owner Name'].strip()
            if owner not in cities:
                cities[owner] = r.get('Mail Address City', '').strip()

    # Find managers needing contact info
    to_process = []
    for llc_name, info in progress.items():
        for i, mgr in enumerate(info.get('managers', [])):
            if not mgr.get('email') and not mgr.get('phone') and len(mgr.get('name', '').split()) >= 2:
                to_process.append((llc_name, i, mgr['name']))

    print(f"Managers needing contact info: {len(to_process)}")

    # ════════════════════════════════════════════════════════════════
    # PHASE 1: RocketReach + DuckDuckGo in parallel (20 threads)
    # ════════════════════════════════════════════════════════════════
    print(f"\n=== PHASE 1: RocketReach + DuckDuckGo (20 threads) ===\n")

    found_phase1 = 0
    still_need = []

    with ThreadPoolExecutor(max_workers=20) as executor:
        futures = {executor.submit(http_lookup_worker, item, cities): item for item in to_process}

        for i, future in enumerate(as_completed(futures)):
            item = futures[future]
            llc_name, mgr_idx, contact, source = future.result()
            name = item[2]

            if contact and (contact.get('email') or contact.get('phone')):
                with progress_lock:
                    progress[llc_name]['managers'][mgr_idx]['email'] = contact.get('email')
                    progress[llc_name]['managers'][mgr_idx]['phone'] = contact.get('phone')
                    progress[llc_name]['managers'][mgr_idx]['linkedin'] = contact.get('linkedin')
                found_phase1 += 1
                with print_lock:
                    print(f"[{i+1}/{len(to_process)}] {name} -> {source}: email={contact.get('email')} phone={contact.get('phone')}")
            else:
                still_need.append(item)

            if (i + 1) % 50 == 0:
                with progress_lock:
                    with open(PROGRESS_PATH, 'w') as f:
                        json.dump(progress, f, indent=2)
                with print_lock:
                    print(f"  --- Phase 1: {i+1}/{len(to_process)} checked, {found_phase1} found ---")

    with open(PROGRESS_PATH, 'w') as f:
        json.dump(progress, f, indent=2)

    print(f"\nPhase 1 complete: {found_phase1} contacts found via RocketReach/DuckDuckGo")
    print(f"Still need: {len(still_need)}")

    # ════════════════════════════════════════════════════════════════
    # PHASE 2: Google via Safari for remaining (serial)
    # ════════════════════════════════════════════════════════════════
    if still_need:
        print(f"\n=== PHASE 2: Google via Safari ({len(still_need)} remaining) ===\n")

        osa('''
tell application "Safari"
    activate
    if (count of documents) = 0 then
        make new document with properties {URL:"https://www.google.com"}
    end if
end tell
        ''')
        time.sleep(3)

        found_phase2 = 0
        for idx, (llc_name, mgr_idx, name) in enumerate(still_need):
            city = cities.get(llc_name, '')
            print(f"[{idx+1}/{len(still_need)}] {name} ({llc_name})...", end=' ', flush=True)

            goog = google_safari_search(name, llc_name, city)
            if goog.get('email') or goog.get('phone'):
                progress[llc_name]['managers'][mgr_idx]['email'] = goog.get('email')
                progress[llc_name]['managers'][mgr_idx]['phone'] = goog.get('phone')
                progress[llc_name]['managers'][mgr_idx]['linkedin'] = goog.get('linkedin')
                found_phase2 += 1
                print(f"GOOGLE: email={goog.get('email')} phone={goog.get('phone')}")
            else:
                print("nothing found")

            if (idx + 1) % 20 == 0:
                with open(PROGRESS_PATH, 'w') as f:
                    json.dump(progress, f, indent=2)
                print(f"  --- Phase 2: {idx+1}/{len(still_need)}, {found_phase2} found ---")

            time.sleep(1)

        print(f"\nPhase 2 complete: {found_phase2} more contacts found via Google")

    # Final save & Excel
    with open(PROGRESS_PATH, 'w') as f:
        json.dump(progress, f, indent=2)

    total_contacts = sum(1 for v in progress.values()
                         for m in v.get('managers', [])
                         if m.get('email') or m.get('phone'))
    total_managers = sum(len(v.get('managers', [])) for v in progress.values())
    print(f"\n=== CONTACT LOOKUP COMPLETE ===")
    print(f"Total contacts found: {total_contacts}/{total_managers}")
    print("\nGenerating Excel...")
    generate_excel(progress)


if __name__ == '__main__':
    main()
