#!/usr/bin/env python3
"""
Property Manager Finder
-----------------------
Standalone tool that takes a CSV of LLC property owners and finds:
1. Managing members from CA Secretary of State (Statement of Information PDFs)
2. Contact info (email, phone, LinkedIn) via free search engines

No paid APIs required. Uses Bing, Yahoo, DuckDuckGo, and optionally Google via Safari.

Usage:
    python3 finder.py --csv "5+ unit farm.csv"
    python3 finder.py --csv "5+ unit farm.csv" --step contacts   # skip SOS, just find contacts
    python3 finder.py --csv "5+ unit farm.csv" --step excel      # just regenerate Excel

Requirements:
    pip install requests beautifulsoup4 openpyxl pypdf

For SOS lookup (Safari mode - macOS only):
    No extra deps, uses Safari via AppleScript

For SOS lookup (server mode - Linux):
    pip install playwright
    playwright install chromium
    apt install xvfb
    Run with: xvfb-run python3 finder.py --csv data.csv --sos-mode playwright
"""
import json, re, time, csv, os, sys, argparse, base64, io, threading, subprocess
import requests, urllib.parse
from bs4 import BeautifulSoup
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

# ─── Config ──────────────────────────────────────────────────────────
SOS_URL = "https://bizfileonline.sos.ca.gov/search/business"
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2.1 Safari/605.1.15'
CONTACT_WORKERS = 4
SOS_WORKERS_SAFARI = 4
SOS_WORKERS_PLAYWRIGHT = 6

progress_lock = threading.Lock()
print_lock = threading.Lock()


# ─── Utilities ───────────────────────────────────────────────────────
def extract_emails(text):
    found = re.findall(r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}', text)
    bad = ['google','example','noreply','sentry','email.com','domain','w3.org','schema.org',
           'googleapis','gstatic','microsoft','bing','outlook.com','hotmail','yahoo.com',
           'aol.com','mail.com','protonmail','icloud','live.com','sampleemail',
           'facebook.com','twitter.com','instagram.com','yelp.com','.gov',
           'your@','user@','test@','name@','address@','feedback@','support@',
           'admin@','webmaster@','abuse@','spam@','mailer-daemon','no-reply','donotreply',
           'privacy@','info@bing','contact@bing']
    return [e for e in set(found) if not any(x in e.lower() for x in bad) and 5 < len(e) < 60]


def extract_phones(text):
    phones = re.findall(r'(?:\+?1[-.\s]?)?\(?(\d{3})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})', text)
    return list(set(''.join(p) for p in phones if len(set(''.join(p))) > 2 and ''.join(p) != '0000000000'))


def is_person_name(name):
    """Filter out company names from manager lists."""
    if not name or len(name) < 3:
        return False
    corp = ['llc','inc','corp','company','l.l.c','trust','l.p.','ltd','group','enterprise',
            'investment','properties','holdings','partners','associates','management']
    return (not any(x in name.lower() for x in corp)
            and re.match(r'^[A-Z]', name)
            and len(name.split()) >= 2)


# ─── SOS PDF Parsing ────────────────────────────────────────────────
def extract_managers_from_pdf(b64_data):
    from pypdf import PdfReader
    try:
        pdf_bytes = base64.b64decode(b64_data)
        reader = PdfReader(io.BytesIO(pdf_bytes))
        full_text = ""
        for page in reader.pages:
            t = page.extract_text()
            if t:
                full_text += t + "\n"

        managers = []
        m = re.search(
            r'Manager or Member Name\s+Manager or Member Address\s*\n(.+?)(?=Agent for Service|Type of Business|Email Notification|Chief Executive|Labor Judgment|$)',
            full_text, re.DOTALL
        )
        if m:
            for line in [l.strip() for l in m.group(1).strip().split('\n') if l.strip()]:
                nm = re.match(r'^([A-Za-z][A-Za-z\s.,\'-]+?)\s+\d+', line)
                if nm:
                    name = nm.group(1).strip().rstrip('.,').strip()
                    if len(name) > 2 and 'none entered' not in name.lower():
                        managers.append(name)
                elif len(line) > 2 and re.match(r'^[A-Z]', line) and not re.search(r'\d{5}', line):
                    name = line.strip().rstrip('.,')
                    if not any(x in name.lower() for x in ['none entered', 'n/a', 'manager or']):
                        managers.append(name)

        agent = None
        am = re.search(r'Agent Name\s+(.+?)(?:\n|Agent Address)', full_text)
        if am:
            agent = am.group(1).strip()

        ceo = None
        cm = re.search(r'CEO Name\s+CEO Address\s*\n(.+?)(?=Labor|Electronic|$)', full_text, re.DOTALL)
        if cm and 'None Entered' not in cm.group(1):
            cn = re.match(r'^[+\s]*([A-Za-z][A-Za-z\s.,\'-]+?)\s+\d+', cm.group(1).strip())
            if cn:
                ceo = cn.group(1).strip().lstrip('+').strip()

        return {'managers': managers, 'agent': agent, 'ceo': ceo}
    except Exception as e:
        return {'managers': [], 'agent': None, 'ceo': None, 'error': str(e)}


# ─── SOS Lookup: Safari (macOS) ─────────────────────────────────────
def _osa(script):
    r = subprocess.run(['osascript'], input=script, capture_output=True, text=True, timeout=60)
    return r.stdout.strip()


def _sjs(tab_idx, js_code):
    with open(f'/tmp/_sjs_{tab_idx}.js', 'w') as f:
        f.write(js_code)
    r = subprocess.run(['osascript'], input=f'''
set f to POSIX file "/tmp/_sjs_{tab_idx}.js"
set c to read f as «class utf8»
tell application "Safari" to tell tab {tab_idx} of window 1 to do JavaScript c
''', capture_output=True, text=True, timeout=60)
    return r.stdout.strip()


def _set_input(tab_idx, selector, value):
    safe_val = value.replace("'", "\\'")
    _sjs(tab_idx, f"""
var el = document.querySelector('{selector}');
if (el) {{
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, '{safe_val}');
    el.dispatchEvent(new Event('input', {{bubbles: true}}));
    el.dispatchEvent(new Event('change', {{bubbles: true}}));
}}
""")


def lookup_llc_safari(tab_idx, llc_name):
    """Look up an LLC on CA SOS via Safari tab."""
    try:
        _osa(f'tell application "Safari" to set URL of tab {tab_idx} of window 1 to "{SOS_URL}"')
        time.sleep(4)

        _set_input(tab_idx, '.search-input', llc_name)
        time.sleep(0.5)
        _sjs(tab_idx, "var b=document.querySelector('.search-button'); if(b) b.click();")
        time.sleep(4)

        cell_count = _sjs(tab_idx, "document.querySelectorAll('td.div-table-cell.interactive').length;")
        if not cell_count or cell_count == '0':
            return None

        # Find best match and click
        llc_core = re.sub(r'\s+LLC\s*$', '', re.sub(r'[,.\s]+', ' ', llc_name.upper())).strip()
        _sjs(tab_idx, f"""
var cells = document.querySelectorAll('td.div-table-cell.interactive');
var best = 0;
var target = '{llc_core.replace("'", "\\'")}';
for (var i = 0; i < cells.length; i++) {{
    var t = cells[i].innerText.toUpperCase().replace(/[,.\\s]+/g, ' ').replace(/\\s+LLC\\s*$/, '').replace(/\\s*\\(\\d+\\)\\s*$/, '').trim();
    if (t === target || target.indexOf(t) >= 0 || t.indexOf(target) >= 0) {{ best = i; break; }}
}}
cells[best].click();
""")
        time.sleep(4)

        # Click View History
        _sjs(tab_idx, "var b=document.querySelector(\"button[aria-label='View History']\"); if(b) b.click();")
        time.sleep(4)

        # Expand first Statement of Information
        _sjs(tab_idx, """
var modal = document.querySelector('.history-modal');
if (modal) {
    var wraps = modal.querySelectorAll('.amendment-wrapper');
    for (var i=0; i<wraps.length; i++) {
        var t = wraps[i].querySelector('button.title');
        if (t && t.innerText.indexOf('Statement of Information') >= 0) {
            if (t.classList.contains('collapsed')) t.click();
            break;
        }
    }
}
""")
        time.sleep(3)

        # Get PDF URL
        pdf_url = _sjs(tab_idx, """
var m = document.querySelector('.history-modal');
var links = m ? m.querySelectorAll('a[href*="GetImageByNum"]') : [];
links.length > 0 ? links[0].href : '';
""")
        if not pdf_url:
            _sjs(tab_idx, "var c=document.querySelector('.history-modal .close-button'); if(c) c.click();")
            return None

        pdf_path = pdf_url.replace('https://bizfileonline.sos.ca.gov', '')

        # Fetch PDF
        _sjs(tab_idx, f"""
fetch('{pdf_path}')
.then(r => r.arrayBuffer())
.then(buf => {{
    var bytes = new Uint8Array(buf);
    var bin = '';
    for(var i=0; i<bytes.length; i+=8192){{
        var ch = bytes.subarray(i, Math.min(i+8192, bytes.length));
        for(var j=0; j<ch.length; j++) bin += String.fromCharCode(ch[j]);
    }}
    window._pdfB64 = btoa(bin);
    document.title = 'PDF_READY';
}})
.catch(e => {{ document.title = 'PDF_ERROR:' + e.message; }});
""")

        for _ in range(20):
            time.sleep(1)
            title = _sjs(tab_idx, "document.title;")
            if 'PDF_READY' in (title or '') or 'PDF_ERROR' in (title or ''):
                break

        if 'PDF_ERROR' in (title or ''):
            _sjs(tab_idx, "var c=document.querySelector('.history-modal .close-button'); if(c) c.click();")
            return None

        b64 = _sjs(tab_idx, "window._pdfB64 || '';")
        _sjs(tab_idx, "var c=document.querySelector('.history-modal .close-button'); if(c) c.click();")

        if not b64 or len(b64) < 100:
            return None

        return extract_managers_from_pdf(b64)

    except Exception:
        return None


# ─── SOS Lookup: Playwright (server) ────────────────────────────────
def lookup_llc_playwright(page, llc_name):
    """Look up an LLC on CA SOS via Playwright browser."""
    try:
        page.goto(SOS_URL, wait_until='networkidle', timeout=30000)
        page.wait_for_selector('.search-input', timeout=15000)

        inp = page.query_selector('.search-input')
        inp.fill('')
        inp.fill(llc_name)
        time.sleep(0.3)
        btn = page.query_selector('.search-button')
        if btn:
            btn.click()
        time.sleep(3)
        page.wait_for_timeout(3000)

        cells = page.query_selector_all('td.div-table-cell.interactive')
        if not cells:
            return None

        llc_core = re.sub(r'\s+LLC\s*$', '', re.sub(r'[,.\s]+', ' ', llc_name.upper())).strip()
        best = 0
        for i, cell in enumerate(cells):
            text = cell.inner_text().strip()
            ec = re.sub(r'\s+LLC\s*$', '', re.sub(r'\s*\(\d+\)\s*$', '', re.sub(r'[,.\s]+', ' ', text.upper()))).strip()
            if ec == llc_core or llc_core in ec or ec in llc_core:
                best = i
                break

        cells[best].click()
        time.sleep(3)

        hist_btn = page.query_selector("button[aria-label='View History']")
        if not hist_btn:
            time.sleep(2)
            hist_btn = page.query_selector("button[aria-label='View History']")
        if not hist_btn:
            return None
        hist_btn.click()
        time.sleep(3)

        modal = page.query_selector('.history-modal')
        if not modal:
            time.sleep(3)
            modal = page.query_selector('.history-modal')
        if not modal:
            return None

        page.evaluate("""
            var modal = document.querySelector('.history-modal');
            var wraps = modal.querySelectorAll('.amendment-wrapper');
            for (var i=0; i<wraps.length; i++) {
                var t = wraps[i].querySelector('button.title');
                if (t && t.innerText.indexOf('Statement of Information') >= 0) {
                    if (t.classList.contains('collapsed')) t.click();
                    break;
                }
            }
        """)
        time.sleep(2)

        pdf_url = page.evaluate("""
            var m = document.querySelector('.history-modal');
            var links = m ? m.querySelectorAll('a[href*="GetImageByNum"]') : [];
            links.length > 0 ? links[0].href : null;
        """)
        if not pdf_url:
            page.evaluate("var c=document.querySelector('.history-modal .close-button'); if(c) c.click();")
            return None

        pdf_path = pdf_url.replace('https://bizfileonline.sos.ca.gov', '')

        page.evaluate(f"""
            fetch('{pdf_path}')
            .then(r => r.arrayBuffer())
            .then(buf => {{
                var bytes = new Uint8Array(buf);
                var bin = '';
                for(var i=0; i<bytes.length; i+=8192){{
                    var ch = bytes.subarray(i, Math.min(i+8192, bytes.length));
                    for(var j=0; j<ch.length; j++) bin += String.fromCharCode(ch[j]);
                }}
                window._pdfB64 = btoa(bin);
                document.title = 'PDF_READY';
            }})
            .catch(e => {{ document.title = 'PDF_ERROR:' + e.message; }});
        """)

        for _ in range(20):
            time.sleep(1)
            title = page.title()
            if 'PDF_READY' in title or 'PDF_ERROR' in title:
                break

        if 'PDF_ERROR' in (title or ''):
            page.evaluate("var c=document.querySelector('.history-modal .close-button'); if(c) c.click();")
            return None

        b64 = page.evaluate("window._pdfB64 || ''")
        page.evaluate("var c=document.querySelector('.history-modal .close-button'); if(c) c.click();")

        if not b64 or len(b64) < 100:
            return None

        return extract_managers_from_pdf(b64)

    except Exception:
        return None


# ─── Contact Search: Bing Deep ──────────────────────────────────────
def search_bing_deep(name, llc='', city=''):
    contact = {'email': None, 'phone': None, 'linkedin': None}

    queries = [
        f'"{name}" email OR phone site:linkedin.com OR site:zillow.com OR site:loopnet.com',
        f'"{name}" "{llc}" contact',
        f'"{name}" {city} property owner email phone',
        f'"{name}" real estate California phone number',
        f'"{name}" "{city}" email address',
        f'site:linkedin.com/in "{name}" {city or "California"}',
    ]

    seen_urls = set()
    for q in queries:
        try:
            resp = requests.get(f"https://www.bing.com/search?q={urllib.parse.quote(q)}&count=30",
                headers={'User-Agent': UA}, timeout=10)
            if resp.status_code != 200:
                continue
            soup = BeautifulSoup(resp.text, 'html.parser')
            texts = [d.get_text(' ', strip=True) for d in soup.find_all(['li','div'], class_=re.compile(r'b_algo|b_ans'))]
            combined = ' '.join(texts)

            emails = extract_emails(combined)
            phones = extract_phones(combined)
            if emails and not contact['email']:
                contact['email'] = emails[0]
            if phones and not contact['phone']:
                contact['phone'] = phones[0]

            for a in soup.find_all('a', href=True):
                href = a['href']
                if 'linkedin.com/in/' in href and not contact['linkedin']:
                    m = re.match(r'(https?://(?:www\.)?linkedin\.com/in/[a-zA-Z0-9_-]+)', href)
                    if m:
                        contact['linkedin'] = m.group(1)

            if not contact['email'] and not contact['phone']:
                for a in soup.find_all('a', href=True):
                    href = a['href']
                    if href in seen_urls:
                        continue
                    seen_urls.add(href)
                    if not href.startswith('http'):
                        continue
                    if any(x in href for x in ['bing.com','microsoft.com','facebook.com','youtube.com','wikipedia.org','yelp.com','twitter.com','linkedin.com']):
                        continue
                    try:
                        p = requests.get(href, headers={'User-Agent': UA}, timeout=6)
                        if p.status_code == 200:
                            pe = extract_emails(p.text)
                            pp = extract_phones(p.text)
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
            time.sleep(2)
        except:
            pass

    # Yahoo fallback
    try:
        yq = f'"{name}" "{llc}" email phone California'
        resp = requests.get(f"https://search.yahoo.com/search?p={urllib.parse.quote(yq)}",
            headers={'User-Agent': UA}, timeout=10)
        if resp.status_code == 200:
            soup = BeautifulSoup(resp.text, 'html.parser')
            texts = [d.get_text(' ', strip=True) for d in soup.find_all(['div','li'], class_=re.compile(r'algo|result|compText'))]
            combined = ' '.join(texts)
            emails = extract_emails(combined)
            phones = extract_phones(combined)
            if emails and not contact['email']:
                contact['email'] = emails[0]
            if phones and not contact['phone']:
                contact['phone'] = phones[0]
    except:
        pass

    return contact


# ─── CRM Cross-Reference ────────────────────────────────────────────
def crossref_crm(progress, crm_path):
    """Cross-reference managers against a RealNex CRM JSON dump."""
    if not os.path.exists(crm_path):
        print(f"CRM file not found: {crm_path}")
        return 0

    crm = json.load(open(crm_path))

    def normalize(name):
        return re.sub(r'[^a-z ]', '', name.lower()).strip()

    crm_by_last = {}
    for c in crm:
        ln = (c.get('LastName') or '').strip().lower()
        if ln:
            crm_by_last.setdefault(ln, []).append(c)

    matched = 0
    for llc, info in progress.items():
        for m in info.get('managers', []):
            if m.get('email') or m.get('phone'):
                continue
            parts = normalize(m.get('name', '')).split()
            if len(parts) < 2:
                continue
            first, last = parts[0], parts[-1]
            for c in crm_by_last.get(last, []):
                cfirst = (c.get('FirstName') or '').strip().lower()
                if cfirst and (cfirst == first or cfirst.startswith(first[:3]) or first.startswith(cfirst[:3])):
                    email = c.get('Email') or c.get('Email2') or ''
                    phone = c.get('Phone') or c.get('Cell') or c.get('HomePhone') or ''
                    if email or phone:
                        if email:
                            m['email'] = email
                        if phone:
                            m['phone'] = phone
                        matched += 1
                    break
    return matched


# ─── Excel Generation ───────────────────────────────────────────────
def generate_excel(progress, csv_path, output_path):
    import openpyxl
    from openpyxl.styles import Font

    with open(csv_path, 'r') as f:
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
    ws.title = 'With Contact Info'
    ws.append(headers)
    for c in ws[1]:
        c.font = Font(bold=True)
    cr = 0
    for llc, d in llc_data.items():
        p = progress.get(llc, {})
        for m in p.get('managers', []):
            if m.get('email') or m.get('phone'):
                ws.append([llc, '; '.join(d['properties']), len(d['properties']),
                           d['mail_address'], d['mail_city'], m.get('name', ''),
                           m.get('email', ''), m.get('phone', ''), m.get('linkedin', ''),
                           p.get('agent', ''), p.get('ceo', '')])
                cr += 1

    ws2 = wb.create_sheet('All Managers')
    ws2.append(headers)
    for c in ws2[1]:
        c.font = Font(bold=True)
    ar = 0
    for llc, d in llc_data.items():
        p = progress.get(llc, {})
        for m in p.get('managers', []):
            ws2.append([llc, '; '.join(d['properties']), len(d['properties']),
                        d['mail_address'], d['mail_city'], m.get('name', ''),
                        m.get('email', ''), m.get('phone', ''), m.get('linkedin', ''),
                        p.get('agent', ''), p.get('ceo', '')])
            ar += 1

    ws3 = wb.create_sheet('No Managers Found')
    ws3.append(['LLC Name', 'Properties', '# Properties', 'Mail Address', 'Mail City'])
    for c in ws3[1]:
        c.font = Font(bold=True)
    nr = 0
    for llc, d in llc_data.items():
        if not progress.get(llc, {}).get('managers'):
            ws3.append([llc, '; '.join(d['properties']), len(d['properties']),
                        d['mail_address'], d['mail_city']])
            nr += 1

    for s in [ws, ws2, ws3]:
        for col in s.columns:
            ml = max(len(str(c.value or '')[:50]) for c in col)
            s.column_dimensions[col[0].column_letter].width = min(ml + 2, 50)

    wb.save(output_path)
    return cr, ar, nr


# ─── Workers ────────────────────────────────────────────────────────
def sos_worker_safari(worker_id, work_queue, progress, counters, total):
    tab_idx = worker_id
    while True:
        with progress_lock:
            llc_name = None
            while work_queue:
                candidate = work_queue.pop(0)
                if candidate not in progress or not progress[candidate].get('done'):
                    llc_name = candidate
                    break
            if llc_name is None:
                break
            idx = total - len(work_queue)

        result = lookup_llc_safari(tab_idx, llc_name)
        _process_sos_result(llc_name, result, progress, counters, idx, total, worker_id)


def sos_worker_playwright(worker_id, work_queue, progress, counters, total):
    from playwright.sync_api import sync_playwright
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

        while True:
            with progress_lock:
                llc_name = None
                while work_queue:
                    candidate = work_queue.pop(0)
                    if candidate not in progress or not progress[candidate].get('done'):
                        llc_name = candidate
                        break
                if llc_name is None:
                    break
                idx = total - len(work_queue)

            result = lookup_llc_playwright(page, llc_name)
            _process_sos_result(llc_name, result, progress, counters, idx, total, worker_id)

        browser.close()


def _process_sos_result(llc_name, result, progress, counters, idx, total, worker_id):
    if result and (result.get('managers') or result.get('agent')):
        raw = result.get('managers', [])
        persons = [n for n in raw if is_person_name(n)]

        if not persons and result.get('agent'):
            ac = result['agent'].strip()
            if is_person_name(ac):
                persons = [ac.title() if ac == ac.upper() else ac]

        mgr_list = []
        for name in persons:
            if name == name.upper() and len(name) > 2:
                name = name.title()
            mgr_list.append({'name': name, 'role': 'Manager/Member'})

        with progress_lock:
            existing = progress.get(llc_name, {})
            existing_by_name = {}
            for m in existing.get('managers', []):
                existing_by_name[m.get('name', '').strip().lower()] = m
            for m in mgr_list:
                key = m['name'].strip().lower()
                if key in existing_by_name:
                    old = existing_by_name[key]
                    if old.get('email'): m['email'] = old['email']
                    if old.get('phone'): m['phone'] = old['phone']
                    if old.get('linkedin'): m['linkedin'] = old['linkedin']

            entry = {'done': True, 'managers': mgr_list,
                     'agent': result.get('agent'), 'ceo': result.get('ceo')}
            progress[llc_name] = entry
            counters['found'] += 1

        names = ', '.join(m['name'] for m in mgr_list)
        with print_lock:
            print(f"[W{worker_id}][{idx}/{total}] {llc_name} -> {names}", flush=True)
    else:
        with progress_lock:
            existing = progress.get(llc_name, {})
            existing['done'] = True
            progress[llc_name] = existing
        with print_lock:
            print(f"[W{worker_id}][{idx}/{total}] {llc_name} -> NOT FOUND", flush=True)

    with progress_lock:
        counters['processed'] += 1
        if counters['processed'] % 25 == 0:
            with open(progress_path_global, 'w') as f:
                json.dump(progress, f, indent=2)
            with print_lock:
                print(f"  --- saved | {counters['processed']} done | {counters['found']} found ---", flush=True)


def contact_worker(item, cities):
    llc, idx, name = item
    city = cities.get(llc, '')
    c = search_bing_deep(name, llc, city)
    if c.get('email') or c.get('phone'):
        return (llc, idx, name, c)
    return (llc, idx, name, None)


# ─── Main Pipeline ──────────────────────────────────────────────────
progress_path_global = ""


def main():
    global progress_path_global

    parser = argparse.ArgumentParser(description='Property Manager Finder')
    parser.add_argument('--csv', required=True, help='Input CSV with LLC property owners')
    parser.add_argument('--progress', default=None, help='Progress JSON file (auto-created if missing)')
    parser.add_argument('--output', default=None, help='Output Excel path')
    parser.add_argument('--step', choices=['all', 'sos', 'contacts', 'excel'], default='all',
                        help='Which step to run (default: all)')
    parser.add_argument('--sos-mode', choices=['safari', 'playwright'], default='safari',
                        help='SOS lookup mode: safari (macOS) or playwright (Linux server)')
    parser.add_argument('--crm', default=None, help='RealNex CRM JSON dump for cross-reference')
    parser.add_argument('--workers', type=int, default=None, help='Number of parallel workers')
    args = parser.parse_args()

    csv_path = os.path.abspath(args.csv)
    csv_dir = os.path.dirname(csv_path)
    csv_stem = Path(csv_path).stem

    progress_path = args.progress or os.path.join(csv_dir, f'{csv_stem}_progress.json')
    output_path = args.output or os.path.join(csv_dir, f'{csv_stem}_Contact_Info.xlsx')
    progress_path_global = progress_path

    # Load or initialize progress
    if os.path.exists(progress_path):
        with open(progress_path) as f:
            progress = json.load(f)
        print(f"Loaded progress: {len(progress)} LLCs")
    else:
        progress = {}

    # Parse CSV for LLC names
    with open(csv_path, 'r') as f:
        csv_rows = list(csv.DictReader(f))

    cities = {}
    llc_names = []
    for r in csv_rows:
        owner = r['Owner Name'].strip()
        if 'llc' not in owner.lower():
            continue
        if owner not in cities:
            cities[owner] = r.get('Mail Address City', '').strip()
        if owner not in progress:
            progress[owner] = {}
        if owner not in llc_names:
            llc_names.append(owner)

    print(f"Total LLCs: {len(llc_names)}")

    # ── Step 1: SOS Lookup ───────────────────────────────────────────
    if args.step in ('all', 'sos'):
        work_queue = [k for k in llc_names if not progress.get(k, {}).get('done')]
        total = len(work_queue)

        if total == 0:
            print("All LLCs already processed on SOS.")
        else:
            num_workers = args.workers or (SOS_WORKERS_SAFARI if args.sos_mode == 'safari' else SOS_WORKERS_PLAYWRIGHT)
            print(f"\nSOS Lookup: {total} LLCs, {num_workers} workers ({args.sos_mode} mode)\n")

            counters = {'found': 0, 'processed': 0}

            if args.sos_mode == 'safari':
                # Open Safari tabs
                _osa(f'''
tell application "Safari"
    activate
    if (count of documents) = 0 then make new document with properties {{URL:"{SOS_URL}"}}
    repeat {num_workers - 1} times
        tell window 1 to make new tab with properties {{URL:"{SOS_URL}"}}
    end repeat
end tell
''')
                time.sleep(5)
                worker_fn = sos_worker_safari
            else:
                worker_fn = sos_worker_playwright

            threads = []
            for i in range(num_workers):
                t = threading.Thread(target=worker_fn, args=(i+1, work_queue, progress, counters, total))
                t.start()
                threads.append(t)
                time.sleep(2)

            for t in threads:
                t.join()

            with open(progress_path, 'w') as f:
                json.dump(progress, f, indent=2)

            with_mgr = sum(1 for v in progress.values() if v.get('managers'))
            print(f"\nSOS done: {with_mgr} LLCs with managers")

    # ── Step 2: CRM Cross-Reference ──────────────────────────────────
    if args.step in ('all', 'contacts') and args.crm:
        print(f"\nCross-referencing CRM...")
        matched = crossref_crm(progress, args.crm)
        print(f"CRM matches: {matched}")
        with open(progress_path, 'w') as f:
            json.dump(progress, f, indent=2)

    # ── Step 3: Contact Search ───────────────────────────────────────
    if args.step in ('all', 'contacts'):
        to_process = []
        for llc, info in progress.items():
            for i, m in enumerate(info.get('managers', [])):
                if not m.get('email') and not m.get('phone') and len(m.get('name', '').split()) >= 2:
                    to_process.append((llc, i, m['name']))

        total = len(to_process)
        if total == 0:
            print("All managers already have contacts.")
        else:
            num_workers = args.workers or CONTACT_WORKERS
            print(f"\nContact Search: {total} managers, {num_workers} threads (Bing + Yahoo)\n")

            found = 0
            done = 0
            with ThreadPoolExecutor(max_workers=num_workers) as ex:
                futs = {ex.submit(contact_worker, item, cities): item for item in to_process}
                for f in as_completed(futs):
                    llc, idx, name, c = f.result()
                    done += 1
                    if c:
                        with progress_lock:
                            progress[llc]['managers'][idx]['email'] = c.get('email')
                            progress[llc]['managers'][idx]['phone'] = c.get('phone')
                            progress[llc]['managers'][idx]['linkedin'] = c.get('linkedin')
                        found += 1
                        print(f"[{done}/{total}] {name} -> email={c.get('email')} phone={c.get('phone')}", flush=True)
                    if done % 50 == 0:
                        with progress_lock:
                            json.dump(progress, open(progress_path, 'w'), indent=2)
                        print(f"  --- saved | {found}/{done} ---", flush=True)

            with open(progress_path, 'w') as f:
                json.dump(progress, f, indent=2)
            print(f"\nContacts done: {found}/{total} new")

    # ── Step 4: Excel ────────────────────────────────────────────────
    if args.step in ('all', 'excel', 'contacts'):
        print(f"\nGenerating Excel...")
        cr, ar, nr = generate_excel(progress, csv_path, output_path)
        print(f"Excel saved: {output_path}")
        print(f"  Sheet 1 (With Contact Info): {cr} rows")
        print(f"  Sheet 2 (All Managers): {ar} rows")
        print(f"  Sheet 3 (No Managers Found): {nr} LLCs")

    # ── Final Stats ──────────────────────────────────────────────────
    total_mgrs = sum(len(v.get('managers', [])) for v in progress.values())
    with_contact = sum(1 for v in progress.values() for m in v.get('managers', []) if m.get('email') or m.get('phone'))
    with_mgr = sum(1 for v in progress.values() if v.get('managers'))
    print(f"\n{'='*50}")
    print(f"Total LLCs: {len(llc_names)}")
    print(f"LLCs with managers: {with_mgr}")
    print(f"Total managers: {total_mgrs}")
    print(f"With contact info: {with_contact} ({100*with_contact/total_mgrs:.0f}%)" if total_mgrs else "")


if __name__ == '__main__':
    main()
